import { createHash } from "node:crypto";
import path from "node:path";

import * as vscode from "vscode";

import {
  BridgeError,
  type BreakpointSpec,
  type BreakpointSummary,
  type ControlDebugSessionParams,
  type ControlDebugSessionResult,
  type DebugConfigurationSummary,
  type DebugSessionSummary,
  type EvaluateDebugExpressionParams,
  type EvaluateDebugExpressionResult,
  type GetDebugStateParams,
  type GetDebugStateResult,
  type ListBreakpointsParams,
  type ListBreakpointsResult,
  type ListDebugConfigurationsParams,
  type ListDebugConfigurationsResult,
  type ListDebugSessionsParams,
  type ListDebugSessionsResult,
  type SetDebugVariableParams,
  type SetDebugVariableResult,
  type StartDebugSessionParams,
  type StartDebugSessionResult,
  type UpdateBreakpointsParams,
  type UpdateBreakpointsResult,
} from "@vscode-agent-bridge/protocol";

import { AgentActivityTracker } from "./agent-activity.js";
import { ExperimentManager } from "./experiment-manager.js";
import { WorkspaceConfigurationManager } from "./workspace-configuration-manager.js";

interface TrackedDebugSession {
  readonly session: vscode.DebugSession;
  summary: DebugSessionSummary;
  generation: number;
  readonly threadGenerations: Map<number, number>;
  readonly frameGenerations: Map<number, number>;
  readonly variableGenerations: Map<number, number>;
}

export class DebugManager implements vscode.Disposable {
  readonly #instanceId: string;
  readonly #experiments: ExperimentManager;
  readonly #activity: AgentActivityTracker;
  readonly #configurations: WorkspaceConfigurationManager;
  readonly #sessions = new Map<string, TrackedDebugSession>();
  readonly #disposables: vscode.Disposable[];

  constructor(
    instanceId: string,
    experiments: ExperimentManager,
    activity: AgentActivityTracker,
    configurations: WorkspaceConfigurationManager,
  ) {
    this.#instanceId = instanceId;
    this.#experiments = experiments;
    this.#activity = activity;
    this.#configurations = configurations;
    this.#disposables = [
      vscode.debug.onDidStartDebugSession((session) => this.#startSession(session)),
      vscode.debug.onDidTerminateDebugSession((session) => this.#terminateSession(session)),
      vscode.debug.registerDebugAdapterTrackerFactory("*", {
        createDebugAdapterTracker: (session) => ({
          onDidSendMessage: (message) => this.#observeAdapterMessage(session, message),
        }),
      }),
    ];
    if (vscode.debug.activeDebugSession) {
      this.#startSession(vscode.debug.activeDebugSession);
    }
  }

  async listConfigurations(
    params: ListDebugConfigurationsParams,
  ): Promise<ListDebugConfigurationsResult> {
    const root = resolveRoot(params.rootUri);
    const launch = vscode.workspace.getConfiguration("launch", root.uri);
    const configurations = launch.get<unknown[]>("configurations", []);
    const compounds = launch.get<unknown[]>("compounds", []);
    const summaries: DebugConfigurationSummary[] = [];
    for (const candidate of configurations) {
      if (!isRecord(candidate) || typeof candidate.name !== "string") continue;
      summaries.push({
        name: candidate.name.slice(0, 1_000),
        type: typeof candidate.type === "string" ? candidate.type.slice(0, 200) : null,
        request: candidate.request === "launch" || candidate.request === "attach" ? candidate.request : null,
        compound: false,
        fingerprint: fingerprint(candidate),
      });
    }
    for (const candidate of compounds) {
      if (!isRecord(candidate) || typeof candidate.name !== "string") continue;
      summaries.push({
        name: candidate.name.slice(0, 1_000),
        type: null,
        request: null,
        compound: true,
        fingerprint: fingerprint(candidate),
      });
    }
    const inspected = await Promise.all([
      this.#configurations.getConfiguration({ rootUri: params.rootUri, target: "launch" }),
      this.#configurations.getConfiguration({ rootUri: params.rootUri, target: "workspace" }),
    ]);
    return {
      instanceId: this.#instanceId,
      rootUri: params.rootUri,
      configurations: summaries.sort((left, right) => left.name.localeCompare(right.name)).slice(0, 500),
      parseErrors: inspected.flatMap((result) => result.parseErrors).slice(0, 100),
    };
  }

  async startSession(params: StartDebugSessionParams): Promise<StartDebugSessionResult> {
    const experiment = await this.#experiments.assertResourceChangesAllowed(params.sessionId);
    if (experiment.rootUri !== params.rootUri) {
      throw new BridgeError("EXPERIMENT_NOT_OWNED", "The debug configuration is outside the active experiment root.");
    }
    const root = resolveRoot(params.rootUri);
    const configuration = (await this.listConfigurations(params)).configurations.find(
      (candidate) => candidate.name === params.configurationName && candidate.fingerprint === params.expectedFingerprint,
    );
    if (!configuration) {
      throw new BridgeError("DEBUG_CONFIGURATION_NOT_FOUND", "The named debug configuration or fingerprint no longer matches.");
    }
    let started: boolean;
    try {
      started = await vscode.debug.startDebugging(root, params.configurationName);
    } catch {
      throw new BridgeError("DEBUG_START_FAILED", "VS Code could not start the selected debug configuration.");
    }
    if (!started) {
      throw new BridgeError("DEBUG_START_FAILED", "The selected debug configuration did not start.");
    }
    const tracked = [...this.#sessions.values()]
      .filter((candidate) => candidate.summary.name === params.configurationName && candidate.summary.rootUri === params.rootUri)
      .sort((left, right) => right.summary.startedAt.localeCompare(left.summary.startedAt))[0];
    return {
      instanceId: this.#instanceId,
      sessionId: params.sessionId,
      started: true,
      debugSession: tracked?.summary ?? null,
    };
  }

  listSessions(params: ListDebugSessionsParams): ListDebugSessionsResult {
    const sessions = [...this.#sessions.values()]
      .map(({ summary }) => summary)
      .filter((summary) => summary.rootUri === params.rootUri)
      .filter((summary) => params.includeTerminated || summary.endedAt === null)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, 200);
    return { instanceId: this.#instanceId, rootUri: params.rootUri, sessions };
  }

  async getState(params: GetDebugStateParams): Promise<GetDebugStateResult> {
    const tracked = this.#requireLiveSession(params.debugSessionId);
    const experiment = await this.#experiments.getActiveExperiment();
    if (tracked.summary.rootUri !== experiment.rootUri) {
      throw new BridgeError("EXPERIMENT_NOT_OWNED", "The debug session is outside the active experiment root.");
    }
    const empty = {
      instanceId: this.#instanceId,
      debugSessionId: params.debugSessionId,
      query: params.query,
      threads: [],
      stackFrames: [],
      scopes: [],
      variables: [],
    };
    if (params.query === "threads") {
      const response = await dapRequest(tracked.session, "threads");
      const threads = arrayBody(response, "threads")
        .map((thread) => ({ id: integer(thread.id), name: boundedString(thread.name, 2_000) }))
        .filter((thread) => thread.id !== null)
        .map((thread) => ({ id: thread.id!, name: thread.name }));
      for (const thread of threads) tracked.threadGenerations.set(thread.id, tracked.generation);
      const page = threads.slice(params.offset, params.offset + params.limit);
      return { ...empty, threads: page, returnedCount: page.length, totalCount: threads.length, truncated: params.offset + page.length < threads.length };
    }
    if (params.query === "stackTrace") {
      assertIssued(tracked.threadGenerations, params.threadId!, tracked.generation);
      const response = await dapRequest(tracked.session, "stackTrace", {
        threadId: params.threadId,
        startFrame: params.offset,
        levels: params.limit,
      });
      const frames = arrayBody(response, "stackFrames").map((frame) => {
        const id = integer(frame.id) ?? 0;
        tracked.frameGenerations.set(id, tracked.generation);
        return {
          id,
          name: boundedString(frame.name, 4_000),
          sourceUri: sourceUri(frame.source),
          line: positiveInteger(frame.line),
          character: positiveInteger(frame.column),
        };
      });
      const total = bodyNumber(response, "totalFrames");
      return { ...empty, stackFrames: frames, returnedCount: frames.length, totalCount: total, truncated: total !== null ? params.offset + frames.length < total : frames.length === params.limit };
    }
    if (params.query === "scopes") {
      assertIssued(tracked.frameGenerations, params.frameId!, tracked.generation);
      const response = await dapRequest(tracked.session, "scopes", { frameId: params.frameId });
      const all = arrayBody(response, "scopes").map((scope) => {
        const variablesReference = integer(scope.variablesReference) ?? 0;
        if (variablesReference > 0) tracked.variableGenerations.set(variablesReference, tracked.generation);
        return {
          name: boundedString(scope.name, 4_000),
          variablesReference,
          expensive: scope.expensive === true,
        };
      });
      const page = all.slice(params.offset, params.offset + params.limit);
      return { ...empty, scopes: page, returnedCount: page.length, totalCount: all.length, truncated: params.offset + page.length < all.length };
    }
    assertIssued(tracked.variableGenerations, params.variablesReference!, tracked.generation);
    const response = await dapRequest(tracked.session, "variables", {
      variablesReference: params.variablesReference,
      start: params.offset,
      count: params.limit,
    });
    const variables = arrayBody(response, "variables").map((variable) => {
      const variablesReference = integer(variable.variablesReference) ?? 0;
      if (variablesReference > 0) tracked.variableGenerations.set(variablesReference, tracked.generation);
      return {
        name: boundedString(variable.name, 10_000),
        value: boundedString(variable.value, 100_000),
        type: nullableString(variable.type, 10_000),
        evaluateName: nullableString(variable.evaluateName, 10_000),
        variablesReference,
        namedVariables: integer(variable.namedVariables),
        indexedVariables: integer(variable.indexedVariables),
      };
    });
    return { ...empty, variables, returnedCount: variables.length, totalCount: null, truncated: variables.length === params.limit };
  }

  async control(params: ControlDebugSessionParams): Promise<ControlDebugSessionResult> {
    const tracked = await this.#assertSessionWrite(params.sessionId, params.debugSessionId);
    if (params.action === "terminate") {
      await vscode.debug.stopDebugging(tracked.session);
    } else if (params.action === "restart") {
      await dapRequest(tracked.session, "restart");
    } else {
      assertIssued(tracked.threadGenerations, params.threadId!, tracked.generation);
      await dapRequest(tracked.session, params.action, {
        threadId: params.threadId,
        singleThread: params.singleThread,
      });
    }
    if (["continue", "next", "stepIn", "stepOut", "restart"].includes(params.action)) {
      invalidateDebugState(tracked);
    }
    return { instanceId: this.#instanceId, sessionId: params.sessionId, debugSessionId: params.debugSessionId, action: params.action, accepted: true };
  }

  listBreakpoints(params: ListBreakpointsParams): ListBreakpointsResult {
    const root = resolveRoot(params.rootUri);
    const breakpoints = vscode.debug.breakpoints
      .map(toBreakpointSummary)
      .filter((summary): summary is BreakpointSummary => summary !== null)
      .filter((summary) => summary.spec.kind === "function" || isUriInRoot(summary.spec.uri, root.uri));
    return { instanceId: this.#instanceId, rootUri: params.rootUri, revision: breakpointRevision(breakpoints), breakpoints: breakpoints.slice(0, 500) };
  }

  async updateBreakpoints(params: UpdateBreakpointsParams): Promise<UpdateBreakpointsResult> {
    const experiment = await this.#experiments.assertResourceChangesAllowed(params.sessionId);
    if (experiment.rootUri !== params.rootUri) throw new BridgeError("EXPERIMENT_NOT_OWNED", "Breakpoint root does not match the active experiment.");
    const root = resolveRoot(params.rootUri);
    const current = this.listBreakpoints(params);
    if (current.revision !== params.expectedRevision) throw new BridgeError("DEBUG_STATE_STALE", "Breakpoints changed after they were listed.");
    for (const spec of params.breakpoints) {
      if (spec.kind === "source" && !isUriInRoot(spec.uri, root.uri)) {
        throw new BridgeError("BREAKPOINT_OUT_OF_SCOPE", "Source breakpoints must remain inside the experiment root.");
      }
    }
    const removable = vscode.debug.breakpoints.filter((breakpoint) => {
      if (breakpoint instanceof vscode.FunctionBreakpoint) return true;
      return breakpoint instanceof vscode.SourceBreakpoint && isUriInRoot(breakpoint.location.uri.toString(true), root.uri);
    });
    vscode.debug.removeBreakpoints(removable);
    vscode.debug.addBreakpoints(params.breakpoints.map(toVsCodeBreakpoint));
    const updated = this.listBreakpoints(params);
    return {
      instanceId: this.#instanceId,
      sessionId: params.sessionId,
      rootUri: params.rootUri,
      revision: updated.revision,
      breakpoints: updated.breakpoints,
    };
  }

  async evaluate(params: EvaluateDebugExpressionParams): Promise<EvaluateDebugExpressionResult> {
    const tracked = await this.#assertSessionWrite(params.sessionId, params.debugSessionId);
    if (params.frameId !== undefined) assertIssued(tracked.frameGenerations, params.frameId, tracked.generation);
    const response = await dapRequest(tracked.session, "evaluate", {
      expression: params.expression,
      frameId: params.frameId,
      context: params.context,
    });
    const body = responseBody(response);
    const variablesReference = integer(body.variablesReference) ?? 0;
    if (variablesReference > 0) tracked.variableGenerations.set(variablesReference, tracked.generation);
    return {
      instanceId: this.#instanceId,
      sessionId: params.sessionId,
      debugSessionId: params.debugSessionId,
      result: boundedString(body.result, 200_000),
      type: nullableString(body.type, 10_000),
      variablesReference,
      namedVariables: integer(body.namedVariables),
      indexedVariables: integer(body.indexedVariables),
    };
  }

  async setVariable(params: SetDebugVariableParams): Promise<SetDebugVariableResult> {
    const tracked = await this.#assertSessionWrite(params.sessionId, params.debugSessionId);
    assertIssued(tracked.variableGenerations, params.variablesReference, tracked.generation);
    const response = await dapRequest(tracked.session, "setVariable", {
      variablesReference: params.variablesReference,
      name: params.name,
      value: params.value,
    });
    const body = responseBody(response);
    const variablesReference = integer(body.variablesReference) ?? 0;
    if (variablesReference > 0) tracked.variableGenerations.set(variablesReference, tracked.generation);
    return {
      instanceId: this.#instanceId,
      sessionId: params.sessionId,
      debugSessionId: params.debugSessionId,
      value: boundedString(body.value, 200_000),
      type: nullableString(body.type, 10_000),
      variablesReference,
    };
  }

  get activeCount(): number {
    return [...this.#sessions.values()].filter(({ summary }) => !summary.endedAt).length;
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
  }

  async #assertSessionWrite(sessionId: string, debugSessionId: string): Promise<TrackedDebugSession> {
    const experiment = await this.#experiments.assertResourceChangesAllowed(sessionId);
    const tracked = this.#requireLiveSession(debugSessionId);
    if (tracked.summary.rootUri !== experiment.rootUri) {
      throw new BridgeError("EXPERIMENT_NOT_OWNED", "The debug session belongs to another workspace root.");
    }
    return tracked;
  }

  #requireLiveSession(debugSessionId: string): TrackedDebugSession {
    const tracked = this.#sessions.get(debugSessionId);
    if (!tracked || tracked.summary.endedAt) throw new BridgeError("DEBUG_SESSION_NOT_FOUND", "The debug session is not active.");
    return tracked;
  }

  #startSession(session: vscode.DebugSession): void {
    const rootUri = session.workspaceFolder?.uri.toString(true) ?? null;
    const existing = this.#sessions.get(session.id);
    if (existing) {
      existing.summary = { ...existing.summary, status: "running", endedAt: null };
      return;
    }
    this.#sessions.set(session.id, {
      session,
      summary: {
        debugSessionId: session.id,
        name: session.name.slice(0, 1_000),
        type: session.type.slice(0, 200),
        status: "running",
        rootUri,
        startedAt: new Date().toISOString(),
        endedAt: null,
        stoppedReason: null,
      },
      generation: 0,
      threadGenerations: new Map(),
      frameGenerations: new Map(),
      variableGenerations: new Map(),
    });
    this.#activity.record({ toolName: "vscode_start_debug_session", title: `Debug started: ${session.name}` }, "succeeded");
  }

  #terminateSession(session: vscode.DebugSession): void {
    const tracked = this.#sessions.get(session.id);
    if (!tracked) return;
    tracked.summary = { ...tracked.summary, status: "terminated", endedAt: new Date().toISOString() };
    invalidateDebugState(tracked);
    this.#activity.record({ toolName: "vscode_control_debug_session", title: `Debug ended: ${session.name}` }, "succeeded");
    void this.#experiments.createExplicitCheckpoint(`Debug ended: ${session.name}`).catch(() => undefined);
  }

  #observeAdapterMessage(session: vscode.DebugSession, message: unknown): void {
    const tracked = this.#sessions.get(session.id);
    if (!tracked || !isRecord(message) || message.type !== "event" || typeof message.event !== "string") return;
    if (message.event === "stopped") {
      invalidateDebugState(tracked);
      const body = isRecord(message.body) ? message.body : {};
      tracked.summary = { ...tracked.summary, status: "stopped", stoppedReason: nullableString(body.reason, 500) };
      this.#activity.record({ toolName: "vscode_get_debug_state", title: `Debug stopped: ${session.name}` }, "succeeded");
    } else if (message.event === "continued") {
      invalidateDebugState(tracked);
      tracked.summary = { ...tracked.summary, status: "running", stoppedReason: null };
    } else if (message.event === "terminated" || message.event === "exited") {
      tracked.summary = { ...tracked.summary, status: "terminated" };
    }
  }
}

async function dapRequest(session: vscode.DebugSession, command: "threads" | "stackTrace" | "scopes" | "variables" | "pause" | "continue" | "next" | "stepIn" | "stepOut" | "restart" | "evaluate" | "setVariable", args?: Record<string, unknown>): Promise<unknown> {
  try {
    return await session.customRequest(command, args);
  } catch {
    throw new BridgeError("DEBUG_REQUEST_FAILED", `The debug adapter rejected the fixed ${command} request.`);
  }
}

function invalidateDebugState(tracked: TrackedDebugSession): void {
  tracked.generation += 1;
  tracked.threadGenerations.clear();
  tracked.frameGenerations.clear();
  tracked.variableGenerations.clear();
}

function assertIssued(references: ReadonlyMap<number, number>, id: number, generation: number): void {
  if (references.get(id) !== generation) throw new BridgeError("DEBUG_STATE_STALE", "The debug state reference is stale; query its parent state again.");
}

function resolveRoot(rootUri: string): vscode.WorkspaceFolder {
  const root = (vscode.workspace.workspaceFolders ?? []).find((folder) => folder.uri.toString(true) === rootUri);
  if (!root || root.uri.scheme !== "file") throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The debug root is not a local workspace folder.");
  return root;
}

function toBreakpointSummary(breakpoint: vscode.Breakpoint): BreakpointSummary | null {
  if (breakpoint instanceof vscode.SourceBreakpoint) {
    return {
      id: breakpoint.id,
      verified: null,
      spec: {
        kind: "source",
        uri: breakpoint.location.uri.toString(true),
        line: breakpoint.location.range.start.line,
        character: breakpoint.location.range.start.character,
        enabled: breakpoint.enabled,
        condition: breakpoint.condition ?? null,
        hitCondition: breakpoint.hitCondition ?? null,
        logMessage: breakpoint.logMessage ?? null,
      },
    };
  }
  if (breakpoint instanceof vscode.FunctionBreakpoint) {
    return {
      id: breakpoint.id,
      verified: null,
      spec: {
        kind: "function",
        functionName: breakpoint.functionName,
        enabled: breakpoint.enabled,
        condition: breakpoint.condition ?? null,
        hitCondition: breakpoint.hitCondition ?? null,
        logMessage: breakpoint.logMessage ?? null,
      },
    };
  }
  return null;
}

function toVsCodeBreakpoint(spec: BreakpointSpec): vscode.Breakpoint {
  if (spec.kind === "function") {
    return new vscode.FunctionBreakpoint(spec.functionName, spec.enabled, spec.condition ?? undefined, spec.hitCondition ?? undefined, spec.logMessage ?? undefined);
  }
  const position = new vscode.Position(spec.line, spec.character);
  return new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.parse(spec.uri, true), position), spec.enabled, spec.condition ?? undefined, spec.hitCondition ?? undefined, spec.logMessage ?? undefined);
}

function breakpointRevision(breakpoints: readonly BreakpointSummary[]): string {
  return fingerprint(breakpoints.map(({ id: _id, verified: _verified, spec }) => spec).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function isUriInRoot(rawUri: string, root: vscode.Uri): boolean {
  let uri: vscode.Uri;
  try { uri = vscode.Uri.parse(rawUri, true); } catch { return false; }
  if (uri.scheme !== "file") return false;
  const relative = path.relative(path.resolve(root.fsPath), path.resolve(uri.fsPath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.split(path.sep).some((segment) => segment.toLowerCase() === ".git");
}

function sourceUri(source: unknown): string | null {
  if (!isRecord(source) || typeof source.path !== "string") return null;
  try { return vscode.Uri.file(source.path).toString(true); } catch { return null; }
}

function responseBody(response: unknown): Record<string, unknown> {
  return isRecord(response) && isRecord(response.body) ? response.body : isRecord(response) ? response : {};
}

function arrayBody(response: unknown, key: string): Record<string, unknown>[] {
  const body = responseBody(response);
  return Array.isArray(body[key]) ? body[key].filter(isRecord) : [];
}

function bodyNumber(response: unknown, key: string): number | null {
  return integer(responseBody(response)[key]);
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const result = integer(value);
  return result === null ? null : Math.max(0, result - 1);
}

function boundedString(value: unknown, limit: number): string {
  return (typeof value === "string" ? value : "").slice(0, limit);
}

function nullableString(value: unknown, limit: number): string | null {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
