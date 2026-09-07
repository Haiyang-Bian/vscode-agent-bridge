import { randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { InitializeRequestSchema, JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  BRIDGE_PROTOCOL_VERSION, BRIDGE_RELEASE_VERSION, BridgeError, MAX_RPC_MESSAGE_BYTES,
  SERVICE_CONTRACT_VERSION, SERVICE_LIMITS, type ServiceIdentity, type ServiceStatus,
} from "@vscode-agent-bridge/protocol";
import { createBridgeMcpServer, type McpSessionHooks } from "./mcp-session.js";
import { UsageInsightStore } from "./usage-insights.js";

type RequestId = string | number;
type Limits = { [Key in keyof typeof SERVICE_LIMITS]: number };
interface RequestWork {
  readonly id: RequestId;
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  entered: boolean;
  operationFinished: boolean;
  responseFinished: boolean;
  counted: boolean;
}
interface Session {
  readonly id: string;
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly controller: AbortController;
  readonly requests: Map<RequestId, RequestWork>;
  lastActivity: number;
  active: number;
  closed: boolean;
}
export interface HttpRuntimeOptions {
  readonly identity: Pick<ServiceIdentity, "serviceId" | "mcpToken" | "port">;
  readonly usageInsights?: UsageInsightStore;
  readonly limits?: Partial<Limits>;
  readonly now?: () => number;
  readonly createSession?: (usage: UsageInsightStore, hooks: McpSessionHooks) => McpServer;
}

/** The process owns admission and cancellation; each session owns its MCP SDK state. */
export class HttpMcpRuntime {
  readonly #options: HttpRuntimeOptions;
  readonly #limits: Limits;
  readonly #usage: UsageInsightStore;
  readonly #now: () => number;
  readonly #sessions = new Map<string, Session>();
  readonly #bootId = randomUUID();
  readonly #startedAt = new Date().toISOString();
  #state: ServiceStatus["state"] = "starting";
  #active = 0;
  #listener: Bun.Server<undefined> | undefined;
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  #shutdown: Promise<void> | undefined;

  constructor(options: HttpRuntimeOptions) {
    this.#options = options;
    this.#limits = { ...SERVICE_LIMITS, ...options.limits };
    this.#usage = options.usageInsights ?? new UsageInsightStore();
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    if (this.#listener || this.#state !== "starting") throw new Error("HTTP runtime cannot be started twice.");
    this.#listener = Bun.serve({
      hostname: "127.0.0.1", port: this.#options.identity.port,
      maxRequestBodySize: MAX_RPC_MESSAGE_BYTES, idleTimeout: 0,
      fetch: (request) => this.handle(request),
      error: () => failure(500, "The service could not handle the request."),
    });
    this.#state = "ready";
    this.#sweepTimer = setInterval(() => { void this.sweepIdleSessions(); }, 30_000);
    this.#sweepTimer.unref();
  }

  get status(): ServiceStatus {
    return {
      contractVersion: SERVICE_CONTRACT_VERSION, serviceId: this.#options.identity.serviceId,
      bootId: this.#bootId, pid: process.pid, version: BRIDGE_RELEASE_VERSION,
      protocolVersion: BRIDGE_PROTOCOL_VERSION, state: this.#state,
      port: this.#listener?.port ?? this.#options.identity.port,
      sessions: this.#sessions.size, activeRequests: this.#active, startedAt: this.#startedAt,
    };
  }

  get url(): string { return `http://127.0.0.1:${this.status.port}/mcp`; }

  async handle(request: Request): Promise<Response> {
    const authority = `127.0.0.1:${this.status.port}`;
    if (!secretEquals(request.headers.get("authorization") ?? "", `Bearer ${this.#options.identity.mcpToken}`)) {
      return failure(401, "Authentication required.");
    }
    if (request.headers.get("host") !== authority) return failure(403, "Host is not allowed.");
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== `http://${authority}`) return failure(403, "Origin is not allowed.");
    if (this.#state !== "ready") return failure(503, "The service is not ready.");
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET" && !url.search) {
      return Response.json(this.status, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname !== "/mcp" || url.search) return failure(404, "Endpoint not found.");
    if (request.headers.has("last-event-id")) return failure(400, "Response replay is not supported.");
    if (!["POST", "GET", "DELETE"].includes(request.method)) return failure(405, "Method not allowed.");

    let message: JSONRPCMessage | undefined;
    if (request.method === "POST") {
      try {
        const raw = await request.text();
        if (Buffer.byteLength(raw) > MAX_RPC_MESSAGE_BYTES) return failure(413, "Request is too large.");
        message = JSONRPCMessageSchema.parse(JSON.parse(raw)); // Batches have no single admission/cancellation identity.
      } catch { return failure(400, "Invalid JSON-RPC message."); }
    }
    // Body parsing is asynchronous: shutdown may have started while it was read.
    if (this.#state !== "ready") return failure(503, "The service is stopping.");
    const sessionId = request.headers.get("mcp-session-id");
    let session = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (sessionId && (!session || session.closed)) return failure(404, "Session not found.");
    if (!session) {
      if (!message || !InitializeRequestSchema.safeParse(message).success) return failure(400, "Initialize a session first.");
      if (this.#sessions.size >= this.#limits.sessions || this.#active >= this.#limits.requestsGlobal) {
        return failure(429, "Service capacity reached.");
      }
      session = await this.#createSession();
    }
    if (this.#state !== "ready") { await this.#closeSession(session); return failure(503, "The service is stopping."); }
    if (session.closed) return failure(404, "Session not found.");
    session.lastActivity = this.#now();

    let work: RequestWork | undefined;
    if (message && "method" in message && "id" in message) {
      if (session.requests.has(message.id)) return failure(409, "Request ID is already active.");
      if (session.active >= this.#limits.requestsPerSession || this.#active >= this.#limits.requestsGlobal) {
        return failure(429, "Request capacity reached.");
      }
      const owner = session;
      const id = message.id;
      work = {
        id, controller: new AbortController(), entered: false, operationFinished: false,
        responseFinished: false, counted: true,
        timer: setTimeout(() => { void this.#cancel(owner, id, "Request timed out."); }, this.#limits.requestTimeoutMs),
      };
      work.timer.unref();
      session.requests.set(id, work);
      session.active++;
      this.#active++;
    }
    try {
      if (message && "method" in message && message.method === "notifications/cancelled") {
        const id = message.params?.requestId;
        if (typeof id === "string" || typeof id === "number") await this.#cancel(session, id, "Request cancelled.");
      }
      const response = await session.transport.handleRequest(request, message ? { parsedBody: message } : undefined);
      if (response.status >= 400 && work) {
        work.operationFinished = true;
        work.responseFinished = true;
        this.#settle(session, work);
        if (!sessionId) await this.#closeSession(session);
      }
      return response;
    } catch {
      if (work) await this.#cancel(session, work.id, "Request failed.");
      if (!sessionId) await this.#closeSession(session);
      return failure(500, "The service could not handle the request.");
    }
  }

  async #createSession(): Promise<Session> {
    const id = randomUUID();
    let session: Session;
    // SSE mode cleans the SDK's stream map on response completion. No event store,
    // reconnect replay or disconnect-to-cancellation coupling is installed.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessionclosed: async () => { await this.#closeSession(session); },
    });
    const hooks: McpSessionHooks = {
      runTool: async (requestId, signal, operation) => {
        const work = session.requests.get(requestId);
        if (!work || session.closed || work.controller.signal.aborted) {
          throw new BridgeError("REQUEST_CANCELLED", "The bridge request was cancelled.");
        }
        work.entered = true;
        try {
          return await operation(AbortSignal.any([signal, work.controller.signal, session.controller.signal]));
        } finally {
          work.operationFinished = true;
          this.#settle(session, work);
        }
      },
    };
    const server = (this.#options.createSession ?? createBridgeMcpServer)(this.#usage, hooks);
    session = { id, server, transport, controller: new AbortController(), requests: new Map(), active: 0, lastActivity: this.#now(), closed: false };
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if ("id" in message && ("result" in message || "error" in message) && (typeof message.id === "string" || typeof message.id === "number")) {
        const work = session.requests.get(message.id);
        if (!work || work.responseFinished) return; // Suppress a late completion after cancellation.
        work.responseFinished = true;
        try { await send(message, options); }
        finally {
          if (!work.entered) work.operationFinished = true;
          this.#settle(session, work);
        }
      } else await send(message, options);
    };
    this.#sessions.set(id, session); // Reserve capacity before the asynchronous SDK connect.
    try { await server.connect(transport); }
    catch { await this.#closeSession(session); throw new Error("MCP session initialization failed."); }
    return session;
  }

  #settle(session: Session, work: RequestWork): void {
    if (work.operationFinished && work.counted) {
      work.counted = false;
      session.active--;
      this.#active--;
      session.lastActivity = this.#now();
    }
    if (work.operationFinished && work.responseFinished) {
      clearTimeout(work.timer);
      session.requests.delete(work.id);
    }
  }

  async #cancel(session: Session, id: RequestId, message: string): Promise<void> {
    const work = session.requests.get(id);
    if (!work) return;
    work.controller.abort();
    // SDK cancellation suppresses the ordinary response. Explicitly finish its
    // stream while retaining admission until the actual IDE operation settles.
    await session.transport.send({ jsonrpc: "2.0", id, error: { code: -32800, message } }).catch(() => undefined);
  }

  async #closeSession(session: Session): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    session.controller.abort();
    this.#sessions.delete(session.id);
    await Promise.all([...session.requests.keys()].map(id => this.#cancel(session, id, "Session closed.")));
    await session.server.close().catch(() => undefined);
  }

  async sweepIdleSessions(): Promise<void> {
    const cutoff = this.#now() - this.#limits.sessionIdleMs;
    await Promise.all([...this.#sessions.values()]
      .filter(session => session.active === 0 && session.lastActivity <= cutoff)
      .map(session => this.#closeSession(session)));
  }

  stop(): Promise<void> {
    this.#shutdown ??= this.#stop();
    return this.#shutdown;
  }

  async #stop(): Promise<void> {
    this.#state = "stopping";
    clearInterval(this.#sweepTimer);
    const deadline = Date.now() + Math.min(this.#limits.shutdownGraceMs, SERVICE_LIMITS.shutdownGraceMs);
    while (this.#active > 0 && Date.now() < deadline) await Bun.sleep(20);
    await Promise.all([...this.#sessions.values()].map(session => this.#closeSession(session)));
    await this.#listener?.stop(true);
    // Socket cancellation completes asynchronously; allow its finally blocks to
    // enqueue usage before flushing, with a bound independent of IDE interaction.
    const cancellationDeadline = Date.now() + 1000;
    while (this.#active > 0 && Date.now() < cancellationDeadline) await Bun.sleep(10);
    await this.#usage.flush();
  }
}

export function secretEquals(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function failure(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}
