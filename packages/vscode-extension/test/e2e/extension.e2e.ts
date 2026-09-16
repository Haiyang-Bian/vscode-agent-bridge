import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, writeFile } from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import * as vscode from "vscode";

import {
  BRIDGE_METHODS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RELEASE_VERSION,
  InstanceDescriptorSchema,
  MCP_TOOL_NAMES,
  resolveRegistryDirectories,
  type DocumentSnapshot,
  type InstanceDescriptor,
  type PreparedChangeSet,
  type WorkspaceSetupResult,
} from "@vscode-agent-bridge/protocol";

import { E2E_SCENARIOS, type E2EScenario } from "../../../../scripts/lib/test-impact.js";
import { HttpE2EClient } from "./http-client.js";

const UNSAVED_MARKER = "UNSAVED_VSCODE_AGENT_BRIDGE_E2E";
const AGENT_MARKER = "DIRECT_AGENT_CHANGE_E2E";
const TASK_MARKER = "TASK_OUTPUT_VSCODE_AGENT_BRIDGE_E2E";
const execFileAsync = promisify(execFile);
const requestedScenarios = resolveRequestedScenarios();
const actualScenarios = new Set<E2EScenario>();

suite("VS Code Agent Bridge direct IDE host", function () {
  this.timeout(150_000);

  test("runs selected direct Bridge scenarios", async () => {
    if (!(await isPrimaryTestWindow())) return;
    const extension = vscode.extensions.getExtension("alicelin.vscode-agent-bridge");
    assert.ok(extension, "the extension under development should be installed");
    const configuration = vscode.workspace.getConfiguration("vscodeAgentBridge");
    const previous = captureGlobalConfiguration(configuration, ["enabled", "enableAcceptanceFixtures"]);
    await configuration.update("enabled", true, vscode.ConfigurationTarget.Global);
    await configuration.update("enableAcceptanceFixtures", true, vscode.ConfigurationTarget.Global);
    await extension.activate();

    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root, "the isolated fixture workspace should be open");
    const sourceUri = vscode.Uri.joinPath(root.uri, "bridge.ts");
    const source = await vscode.workspace.openTextDocument(sourceUri);
    const editor = await vscode.window.showTextDocument(source, { preview: false });
    assert.equal(await editor.edit((builder) => {
      builder.insert(source.positionAt(source.getText().length), `\n// ${UNSAVED_MARKER}\n`);
    }), true);

    const descriptor = await waitForDescriptor("ready");
    assert.equal(descriptor.protocolVersion, BRIDGE_PROTOCOL_VERSION);
    assert.equal(descriptor.extensionVersion, BRIDGE_RELEASE_VERSION);
    await assertAuthenticationBoundary(descriptor);
    const client = await BridgeRpcClient.connect(descriptor.transport.endpoint);
    try {
      await client.request(BRIDGE_METHODS.initialize, {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        authToken: descriptor.authToken,
        client: { name: "direct-extension-e2e", version: BRIDGE_RELEASE_VERSION },
      });

      if (isScenarioRequested("lifecycle")) {
        const setup = await client.request<WorkspaceSetupResult>(BRIDGE_METHODS.getWorkspaceSetup, {
          rootUri: root.uri.toString(true),
        });
        assert.equal(setup.trusted, true);
        assert.equal(Object.hasOwn(setup, "onboarding"), false);
        assert.equal(Object.hasOwn(setup, "editVisibility"), false);
        assert.equal(await vscode.commands.executeCommand("vscodeAgentBridge.e2eHasLegacyExperimentData"), false);
        actualScenarios.add("lifecycle");
      }
      if (isScenarioRequested("core-language")) {
        await exerciseLanguageState(client, source);
        actualScenarios.add("core-language");
      }
      if (isScenarioRequested("http-bridge")) {
        await exerciseHttpBridge(descriptor);
        actualScenarios.add("http-bridge");
      }
      if (isScenarioRequested("direct-ide")) {
        await exerciseDirectIde(client, root, source);
        actualScenarios.add("direct-ide");
      }
      if (isScenarioRequested("task-terminal")) {
        await exerciseTask(client, root.uri);
        actualScenarios.add("task-terminal");
      }
      if (isScenarioRequested("debug")) {
        await exerciseDebug(client, root.uri);
        actualScenarios.add("debug");
      }
      if (isScenarioRequested("extension-ecosystem")) {
        await exerciseExtensionEcosystem(client, root.uri);
        actualScenarios.add("extension-ecosystem");
      }
      if (isScenarioRequested("master-switch")) {
        await exerciseMasterSwitch(client);
        actualScenarios.add("master-switch");
      }
    } finally {
      client.close();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd: root.uri.fsPath, windowsHide: true });
      await execFileAsync("git", ["clean", "-fd"], { cwd: root.uri.fsPath, windowsHide: true });
      await restoreGlobalConfiguration(configuration, previous);
    }
    await writePrimaryCompletionMarker();
  });
});

async function exerciseLanguageState(client: BridgeRpcClient, document: vscode.TextDocument): Promise<void> {
  const snapshot = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {});
  assert.equal(snapshot.uri, document.uri.toString(true));
  assert.equal(snapshot.isDirty, true);
  assert.ok(snapshot.text.includes(UNSAVED_MARKER));
  assert.ok(!(await readFile(document.uri.fsPath, "utf8")).includes(UNSAVED_MARKER));
  const diagnostics = await waitFor(async () => {
    const result = await client.request<{ diagnostics: Array<{ severity: string }> }>(BRIDGE_METHODS.getDiagnostics, {
      scope: "document", uri: document.uri.toString(true), limit: 20,
    });
    return result.diagnostics.some((item) => item.severity === "error") ? result : undefined;
  }, "TypeScript diagnostics");
  assert.ok(diagnostics.diagnostics.length > 0);
  const symbols = await client.request<{ symbols: Array<{ name: string }> }>(BRIDGE_METHODS.getDocumentSymbols, {
    uri: document.uri.toString(true), limit: 20,
  });
  assert.ok(symbols.symbols.some((symbol) => symbol.name === "bridgeGreeting"));
}

async function exerciseHttpBridge(descriptor: InstanceDescriptor): Promise<void> {
  const first = new HttpE2EClient();
  const second = new HttpE2EClient();
  await first.connect();
  await second.connect();
  try {
    const [left, right] = await Promise.all([first.health(), second.health()]);
    assert.equal(left.pid, right.pid);
    assert.equal(left.pid, Number(process.env.VSCODE_AGENT_BRIDGE_E2E_HTTP_PID));
    const instances = await first.call<{ instances: Array<{ instanceId: string; compatibility: string; releaseAlignment: string }> }>("vscode_list_instances");
    const current = instances.instances.find((instance) => instance.instanceId === descriptor.instanceId);
    assert.deepEqual(current, { instanceId: descriptor.instanceId, compatibility: "current", releaseAlignment: "current" });
    const document = await second.call<{ text: string; isDirty: boolean }>("vscode_read_document", {
      instanceId: descriptor.instanceId,
    });
    assert.equal(document.isDirty, true);
    assert.ok(document.text.includes(UNSAVED_MARKER));
  } finally {
    await first.close();
    await second.close();
  }
}

async function exerciseDirectIde(client: BridgeRpcClient, root: vscode.WorkspaceFolder, source: vscode.TextDocument): Promise<void> {
  const rootUri = root.uri.toString(true);
  const activeUri = vscode.window.activeTextEditor?.document.uri.toString(true);
  const before = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, { uri: source.uri.toString(true) });
  await assert.rejects(() => client.request(BRIDGE_METHODS.prepareTextEdits, {
    rootUri: vscode.Uri.file(path.dirname(root.uri.fsPath)).toString(true),
    documents: [{
      uri: source.uri.toString(true), expectedVersion: before.documentVersion, expectedSha256: before.contentSha256,
      edits: [{ range: pointRange(0, 0), newText: "// denied\n" }],
    }],
  }), isBridgeError("RESOURCE_OUT_OF_SCOPE"));
  const prepared = await client.request<PreparedChangeSet>(BRIDGE_METHODS.prepareTextEdits, {
    rootUri,
    documents: [{
      uri: source.uri.toString(true), expectedVersion: before.documentVersion, expectedSha256: before.contentSha256,
      edits: [{ range: pointRange(0, 0), newText: `// ${AGENT_MARKER}\n` }],
    }],
  });
  const applied = await client.request<{ documents: Array<{ isDirty: boolean }> }>(BRIDGE_METHODS.applyChangeSet, {
    changeSetId: prepared.changeSetId,
  });
  assert.equal(applied.documents[0]?.isDirty, true);
  assert.ok(source.getText().includes(AGENT_MARKER));
  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(true), activeUri);
  await assert.rejects(
    () => client.request(BRIDGE_METHODS.applyChangeSet, { changeSetId: prepared.changeSetId }),
    isBridgeError("CHANGE_SET_ALREADY_APPLIED"),
  );

  const formatUri = vscode.Uri.joinPath(root.uri, "format.bridgeformat");
  const formatDocument = await vscode.workspace.openTextDocument(formatUri);
  const formatBefore = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, { uri: formatUri.toString(true) });
  const formatted = await client.request<{ applied: boolean; editCount: number }>(BRIDGE_METHODS.formatDocument, {
    rootUri, uri: formatUri.toString(true), expectedVersion: formatBefore.documentVersion,
    expectedSha256: formatBefore.contentSha256, reason: "Verify direct focus-neutral formatting",
  });
  assert.equal(formatted.applied, true);
  assert.ok(formatted.editCount > 0);
  assert.equal(formatDocument.getText(), "export const formattedValue = 42;\n");
  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(true), activeUri);
  const formatAfter = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, { uri: formatUri.toString(true) });
  const saved = await client.request<{ saved: boolean; isDirty: boolean }>(BRIDGE_METHODS.saveDocument, {
    rootUri, uri: formatUri.toString(true), expectedVersion: formatAfter.documentVersion,
    expectedSha256: formatAfter.contentSha256, reason: "Save the guarded formatted document",
  });
  assert.equal(saved.saved, true);
  assert.equal(saved.isDirty, false);

  const actionUri = vscode.Uri.joinPath(root.uri, "action.bridgeaction");
  const actionDocument = await vscode.workspace.openTextDocument(actionUri);
  const actionBefore = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, { uri: actionUri.toString(true) });
  const actions = await client.request<{ actions: Array<{ actionId: string; applicable: boolean }> }>(BRIDGE_METHODS.listCodeActions, {
    rootUri, uri: actionUri.toString(true),
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
    expectedVersion: actionBefore.documentVersion, expectedSha256: actionBefore.contentSha256,
    kinds: ["quickfix"], limit: 20,
  });
  const action = actions.actions.find((candidate) => candidate.applicable);
  assert.ok(action);
  await client.request(BRIDGE_METHODS.applyCodeAction, { actionId: action.actionId, reason: "Apply a bounded provider text edit" });
  assert.ok(actionDocument.getText().includes("FIXED_E2E"));
  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(true), activeUri);

  const settings = await client.request<{ exists: boolean; contentSha256: string | null }>(BRIDGE_METHODS.getWorkspaceConfiguration, {
    rootUri, target: "settings",
  });
  await client.request(BRIDGE_METHODS.updateWorkspaceConfiguration, {
    rootUri, target: "settings", expectedExists: settings.exists, expectedSha256: settings.contentSha256,
    operations: [{ operation: "add", path: "/vscodeAgentBridge.e2eMarker", value: true }],
    reason: "Verify direct atomic workspace configuration",
  });

  const createdUri = vscode.Uri.joinPath(root.uri, "direct-resource-e2e.txt");
  const text = "direct resource\n";
  const created = await client.request<PreparedChangeSet>(BRIDGE_METHODS.prepareResourceChanges, {
    rootUri, operations: [{ operation: "create", uri: createdUri.toString(true), kind: "file", content: text }],
  });
  await client.request(BRIDGE_METHODS.applyChangeSet, { changeSetId: created.changeSetId });
  assert.equal(await readFile(createdUri.fsPath, "utf8"), text);
  const deleted = await client.request<PreparedChangeSet>(BRIDGE_METHODS.prepareResourceChanges, {
    rootUri,
    operations: [{ operation: "delete", uri: createdUri.toString(true), kind: "file",
      expectedSha256: createHash("sha256").update(text).digest("hex"), recursive: false }],
  });
  await client.request(BRIDGE_METHODS.applyChangeSet, { changeSetId: deleted.changeSetId });

  const activity = await vscode.commands.executeCommand<Array<{ toolName: string }>>("vscodeAgentBridge.e2eGetAgentActivity");
  assert.ok(activity);
  assert.ok(activity.some((entry) => entry.toolName === "vscode_apply_change_set"));
  assert.ok(activity.some((entry) => entry.toolName === "vscode_format_document"));
  assert.ok(activity.every((entry) => entry.toolName !== "vscode_read_document"));
}

async function exerciseTask(client: BridgeRpcClient, workspaceUri: vscode.Uri): Promise<void> {
  const rootUri = workspaceUri.toString(true);
  const prepared = await client.request<{ task: { taskId: string; fingerprint: string } }>(BRIDGE_METHODS.prepareTask, {
    rootUri, label: "Bridge direct E2E task",
    execution: { kind: "process", process: "powershell.exe", args: ["-NoProfile", "-Command", `Write-Output '${TASK_MARKER}'`], options: { cwd: ".", env: {} } },
    group: "test", isBackground: false, problemMatchers: [], detail: "Direct Task E2E", reason: "Run a bounded VS Code Task",
  });
  const started = await client.request<{ execution: { executionId: string } }>(BRIDGE_METHODS.runTask, {
    rootUri, taskId: prepared.task.taskId, expectedFingerprint: prepared.task.fingerprint, reason: "Run the prepared Task",
  });
  const finished = await waitFor(async () => {
    const result = await client.request<{ executions: Array<{ executionId: string; status: string; exitCode: number | null; terminalExecutionId: string | null }> }>(
      BRIDGE_METHODS.listTaskExecutions, { rootUri, activeOnly: false, offset: 0, limit: 20 },
    );
    return result.executions.find((item) => item.executionId === started.execution.executionId && item.status === "exited");
  }, "direct Task completion", 30_000);
  assert.equal(finished.exitCode, 0);
  assert.ok(finished.terminalExecutionId);
  const output = await waitFor(async () => {
    const result = await client.request<{ text: string }>(BRIDGE_METHODS.readTerminalOutput, {
      executionId: finished.terminalExecutionId, cursor: 0, maxChars: 65_536,
    });
    return result.text.includes(TASK_MARKER) ? result : undefined;
  }, "Task terminal output");
  assert.ok(output.text.includes(TASK_MARKER));
}

async function exerciseDebug(client: BridgeRpcClient, workspaceUri: vscode.Uri): Promise<void> {
  const rootUri = workspaceUri.toString(true);
  const prepared = await client.request<{ configuration: { configurationId: string; fingerprint: string } }>(
    BRIDGE_METHODS.prepareDebugConfiguration,
    { rootUri, configuration: { name: "Bridge direct E2E debug", type: "vscode-agent-bridge-e2e", request: "launch" }, reason: "Prepare a bounded Debug configuration" },
  );
  const listed = await client.request<{ revision: string }>(BRIDGE_METHODS.listBreakpoints, { rootUri });
  const updated = await client.request<{ breakpoints: unknown[] }>(BRIDGE_METHODS.updateBreakpoints, {
    rootUri, expectedRevision: listed.revision,
    breakpoints: [{ kind: "source", uri: vscode.Uri.joinPath(workspaceUri, "bridge.ts").toString(true), line: 0, character: 0,
      enabled: true, condition: null, hitCondition: null, logMessage: null }],
    reason: "Verify direct breakpoint mutation",
  });
  assert.equal(updated.breakpoints.length, 1);
  await client.request(BRIDGE_METHODS.startDebugSession, {
    rootUri, configurationId: prepared.configuration.configurationId,
    expectedFingerprint: prepared.configuration.fingerprint, reason: "Start the prepared Debug configuration",
  });
  const stopped = await waitFor(async () => {
    const result = await client.request<{ sessions: Array<{ debugSessionId: string; status: string }> }>(
      BRIDGE_METHODS.listDebugSessions, { rootUri, includeTerminated: false },
    );
    return result.sessions.find((session) => session.status === "stopped");
  }, "direct Debug stop");
  const threads = await client.request<{ threads: Array<{ id: number }> }>(BRIDGE_METHODS.getDebugState, {
    debugSessionId: stopped.debugSessionId, query: "threads", offset: 0, limit: 20,
  });
  assert.ok(threads.threads.length > 0);
  await client.request(BRIDGE_METHODS.controlDebugSession, {
    debugSessionId: stopped.debugSessionId, action: "terminate", reason: "Terminate the bounded Debug session",
  });
}

async function exerciseExtensionEcosystem(client: BridgeRpcClient, workspaceUri: vscode.Uri): Promise<void> {
  const listed = await client.request<{ extensions: Array<{ extensionId: string }> }>(BRIDGE_METHODS.listExtensions, { offset: 0, limit: 1_000 });
  assert.ok(listed.extensions.some((extension) => extension.extensionId.toLowerCase() === "alicelin.vscode-agent-bridge"));
  const profile = await client.request<{ profileName: string | null; stableApiCoverage: string }>(BRIDGE_METHODS.getProfileContext, {});
  assert.equal(profile.profileName, null);
  assert.equal(profile.stableApiCoverage, "unavailable");
  const before = await client.request<{ targetValueSha256: string }>(BRIDGE_METHODS.getExtensionConfiguration, {
    extensionId: "alicelin.vscode-agent-bridge", key: "vscodeAgentBridge.enableAcceptanceFixtures", target: "global",
  });
  const changed = await client.request<{ changed: boolean; recoverability: string }>(BRIDGE_METHODS.updateExtensionConfiguration, {
    rootUri: workspaceUri.toString(true), extensionId: "alicelin.vscode-agent-bridge",
    key: "vscodeAgentBridge.enableAcceptanceFixtures", target: "global", expectedValueSha256: before.targetValueSha256,
    newValue: false, reason: "Verify journaled global extension configuration",
  });
  assert.equal(changed.changed, true);
  assert.equal(changed.recoverability, "globalJournal");
  assert.equal(await vscode.commands.executeCommand("vscodeAgentBridge.e2eUndoLastProfileChange"), true);
}

async function exerciseMasterSwitch(client: BridgeRpcClient): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("vscodeAgentBridge");
  await configuration.update("enabled", false, vscode.ConfigurationTarget.Global);
  await waitFor(async () => (await listDescriptors()).length === 0 ? true : undefined, "descriptor removal");
  await assert.rejects(() => client.request(BRIDGE_METHODS.getEditorContext, {}));
  await configuration.update("enabled", true, vscode.ConfigurationTarget.Global);
  const descriptor = await waitForDescriptor("ready");
  const reconnected = await BridgeRpcClient.connect(descriptor.transport.endpoint);
  try {
    await reconnected.request(BRIDGE_METHODS.initialize, {
      protocolVersion: BRIDGE_PROTOCOL_VERSION, authToken: descriptor.authToken,
      client: { name: "master-switch-e2e", version: BRIDGE_RELEASE_VERSION },
    });
    await reconnected.request(BRIDGE_METHODS.getEditorContext, {});
  } finally {
    reconnected.close();
  }
}

async function assertAuthenticationBoundary(descriptor: InstanceDescriptor): Promise<void> {
  const wrong = await BridgeRpcClient.connect(descriptor.transport.endpoint);
  await assert.rejects(() => wrong.request(BRIDGE_METHODS.initialize, {
    protocolVersion: BRIDGE_PROTOCOL_VERSION, authToken: `${descriptor.authToken.slice(0, -1)}x`,
    client: { name: "wrong-token-e2e", version: BRIDGE_RELEASE_VERSION },
  }), isBridgeError("AUTHENTICATION_FAILED"));
  wrong.close();
}

function pointRange(line: number, character: number) {
  return { start: { line, character }, end: { line, character } };
}

async function isPrimaryTestWindow(): Promise<boolean> {
  const expected = process.env.VSCODE_AGENT_BRIDGE_E2E_WORKSPACE;
  const actual = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return Boolean(expected && actual && path.resolve(expected).toLowerCase() === path.resolve(actual).toLowerCase());
}

async function writePrimaryCompletionMarker(): Promise<void> {
  const registry = process.env.VSCODE_AGENT_BRIDGE_REGISTRY_DIR;
  assert.ok(registry);
  await writeFile(path.join(registry, "primary-e2e-passed.json"), `${JSON.stringify({
    protocolVersion: BRIDGE_PROTOCOL_VERSION, toolCount: MCP_TOOL_NAMES.length,
    requestedScenarios, actualScenarios: [...actualScenarios], cleanupStatus: "workspace-restored",
  })}\n`, "utf8");
}

function resolveRequestedScenarios(): E2EScenario[] {
  const values = (process.env.VSCODE_AGENT_BRIDGE_E2E_SCENARIOS ?? "full").split(",").filter(Boolean);
  if (values.includes("full")) return [...E2E_SCENARIOS];
  for (const value of values) assert.ok(E2E_SCENARIOS.includes(value as E2EScenario));
  return [...new Set(values as E2EScenario[])];
}

function isScenarioRequested(scenario: E2EScenario): boolean { return requestedScenarios.includes(scenario); }

function captureGlobalConfiguration(configuration: vscode.WorkspaceConfiguration, keys: readonly string[]): Map<string, unknown> {
  return new Map(keys.map((key) => [key, configuration.inspect(key)?.globalValue]));
}

async function restoreGlobalConfiguration(configuration: vscode.WorkspaceConfiguration, snapshot: ReadonlyMap<string, unknown>): Promise<void> {
  for (const [key, value] of snapshot) await configuration.update(key, value, vscode.ConfigurationTarget.Global);
}

function isBridgeError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof BridgeRpcError && error.bridgeCode === code;
}

async function waitForDescriptor(lifecycle?: InstanceDescriptor["lifecycle"]): Promise<InstanceDescriptor> {
  return waitFor(async () => (await listDescriptors()).find((descriptor) => !lifecycle || descriptor.lifecycle === lifecycle), "Bridge descriptor", 30_000);
}

async function listDescriptors(): Promise<InstanceDescriptor[]> {
  const descriptors: InstanceDescriptor[] = [];
  for (const directory of [resolveRegistryDirectories().instances]) {
    let entries: string[];
    try { entries = await readdir(directory); } catch { continue; }
    for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
      try { descriptors.push(InstanceDescriptorSchema.parse(JSON.parse(await readFile(path.join(directory, entry), "utf8")))); } catch {}
    }
  }
  return descriptors;
}

async function waitFor<T>(callback: () => T | undefined | Promise<T | undefined>, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await callback();
      if (result !== undefined && result !== false) return result as T;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}.`, { cause: lastError });
}

class BridgeRpcError extends Error {
  constructor(readonly bridgeCode: string, message: string) { super(message); this.name = "BridgeRpcError"; }
}

class BridgeRpcClient {
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  readonly #socket: Socket;
  #buffer = "";
  #nextRequestId = 1;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#acceptData(chunk));
    socket.on("error", (error) => this.#rejectPending(error));
    socket.on("close", () => this.#rejectPending(new Error("Bridge socket closed.")));
  }

  static async connect(endpoint: string): Promise<BridgeRpcClient> {
    const socket = net.createConnection(endpoint);
    await once(socket, "connect");
    return new BridgeRpcClient(socket);
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.#socket.destroyed) return Promise.reject(new Error("Bridge socket is already closed."));
    const id = this.#nextRequestId++;
    const result = new Promise<T>((resolve, reject) => this.#pending.set(id, { resolve: (value) => resolve(value as T), reject }));
    this.#socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  }

  close(): void { this.#socket.destroy(); }

  #acceptData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line) as { id: number; result?: unknown; error?: { message: string; data?: { bridgeCode?: string } } };
      const pending = this.#pending.get(response.id);
      if (!pending) continue;
      this.#pending.delete(response.id);
      if (response.error) pending.reject(new BridgeRpcError(response.error.data?.bridgeCode ?? "UNKNOWN", response.error.message));
      else pending.resolve(response.result);
    }
  }

  #rejectPending(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
