import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { SERVICE_LIMITS, ServiceManagementResponseSchema, ServiceStatusSchema, type ServiceIdentity, type ServiceStatus } from "@vscode-agent-bridge/protocol";
import { managementProof, validManagementProof } from "./service-auth.js";
import { ServiceError } from "./service-errors.js";
import type { ServicePaths } from "./service-state.js";

export async function controlRequest(paths: ServicePaths, identity: ServiceIdentity, command: "status" | "stop", expectedBootId?: string): Promise<ServiceStatus> {
  const payload = { contractVersion: 1, serviceId: identity.serviceId, nonce: randomBytes(16).toString("hex"), timestamp: Date.now(), command,
    ...(expectedBootId ? { expectedBootId } : {}) };
  const raw = await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(paths.endpoint);
    let incoming = Buffer.alloc(0);
    const timer = setTimeout(() => fail(), 2500);
    function finish() { clearTimeout(timer); socket.destroy(); }
    function fail() { finish(); reject(new ServiceError("SERVICE_IDENTITY_UNVERIFIED", "The existing service identity could not be verified.")); }
    socket.once("error", fail);
    socket.once("end", fail);
    socket.once("connect", () => socket.write(JSON.stringify({ ...payload, proof: managementProof(identity.managementToken, "request", payload) }) + "\n"));
    socket.on("data", bytes => {
      incoming = Buffer.concat([incoming, typeof bytes === "string" ? Buffer.from(bytes) : bytes]);
      if (incoming.length > SERVICE_LIMITS.managementMessageBytes) { fail(); return; }
      if (!incoming.includes(10)) return;
      try { const value: unknown = JSON.parse(incoming.toString("utf8")); finish(); resolve(value); }
      catch { fail(); }
    });
  });
  const response = ServiceManagementResponseSchema.safeParse(raw);
  if (!response.success || response.data.nonce !== payload.nonce || !validManagementProof(response.data.proof,
    managementProof(identity.managementToken, "response", { nonce: payload.nonce, status: response.data.status }))) {
    throw new ServiceError("SERVICE_IDENTITY_UNVERIFIED", "The existing service identity could not be verified.");
  }
  const parsed = ServiceStatusSchema.safeParse(response.data.status);
  if (!parsed.success || parsed.data.serviceId !== identity.serviceId || parsed.data.port !== identity.port ||
    (expectedBootId && parsed.data.bootId !== expectedBootId)) {
    throw new ServiceError("SERVICE_IDENTITY_UNVERIFIED", "The existing service identity could not be verified.");
  }
  return parsed.data;
}

export async function verifyHttpHealth(identity: ServiceIdentity, expected: ServiceStatus): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${identity.port}/health`, {
      headers: { Authorization: `Bearer ${identity.mcpToken}` }, signal: AbortSignal.timeout(2500), redirect: "error",
    });
    const status = ServiceStatusSchema.parse(await response.json());
    if (!response.ok || status.state !== "ready" || status.serviceId !== identity.serviceId ||
      status.bootId !== expected.bootId || status.pid !== expected.pid || status.version !== expected.version) throw new Error();
  } catch { throw new ServiceError("SERVICE_AUTHENTICATION_FAILED", "The shared HTTP service did not pass authenticated health verification."); }
}

export async function waitForReady(paths: ServicePaths, identity: ServiceIdentity, timeoutMs = 15_000): Promise<ServiceStatus> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const status = await controlRequest(paths, identity, "status");
      if (status.state === "ready") { await verifyHttpHealth(identity, status); return status; }
    } catch { /* Named-pipe races are verified by identity and health, never by error code. */ }
    await Bun.sleep(50 + Math.random() * 100);
  } while (Date.now() < deadline);
  throw new ServiceError("SERVICE_IDENTITY_UNVERIFIED", "No healthy shared service could be verified within the startup deadline.");
}

export async function stopVerifiedService(paths: ServicePaths, identity: ServiceIdentity, status: ServiceStatus): Promise<void> {
  await controlRequest(paths, identity, "stop", status.bootId);
  const deadline = Date.now() + SERVICE_LIMITS.shutdownGraceMs + 5000;
  while (Date.now() < deadline) {
    // A dead PID proves that this boot released its OS handles. Never kill an
    // unknown process, or treat one failed IPC connection as successful shutdown.
    try { process.kill(status.pid, 0); } catch { return; }
    await Bun.sleep(100);
  }
  throw new ServiceError("SERVICE_STOP_TIMEOUT", "The verified service did not stop within the shutdown deadline.");
}
