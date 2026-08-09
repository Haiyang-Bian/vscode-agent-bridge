import assert from "node:assert/strict";
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
  resolveRegistryDirectories,
  type AppliedChangeSet,
  type DocumentSnapshot,
  type ExperimentCheckpointsResult,
  type ExperimentInfo,
  type InstanceDescriptor,
  type PreparedChangeSet,
} from "@vscode-agent-bridge/protocol";

const UNSAVED_MARKER = "UNSAVED_VSCODE_AGENT_BRIDGE_E2E";
const AGENT_MARKER = "AGENT_CHANGE_SET_E2E";
const STALE_MARKER = "STALE_CHANGE_SET_MUST_NOT_APPLY";
const execFileAsync = promisify(execFile);

suite("VS Code Agent Bridge Extension Host", function () {
  this.timeout(90_000);

  test("serves unsaved text, diagnostics, symbols, navigation, and hover", async () => {
    if (!(await isPrimaryTestWindow())) {
      return;
    }
    const extension = vscode.extensions.all.find(
      (candidate) => candidate.id.toLowerCase() === "alicelin.vscode-agent-bridge",
    );
    assert.ok(extension, "the extension under development should be installed");
    if (process.env.VSCODE_AGENT_BRIDGE_EXPECT_PACKAGED === "1") {
      assert.match(extension.extensionPath.replaceAll("\\", "/"), /\.vscode-test\/extensions\//iu);
      assert.equal(extension.packageJSON.version, BRIDGE_RELEASE_VERSION);
    }
    await extension.activate();

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "the TypeScript fixture workspace should be open");
    const documentUri = vscode.Uri.joinPath(workspaceFolder.uri, "bridge.ts");
    const onDiskBeforeEdit = Buffer.from(await vscode.workspace.fs.readFile(documentUri)).toString(
      "utf8",
    );
    assert.ok(!onDiskBeforeEdit.includes(UNSAVED_MARKER));

    const document = await vscode.workspace.openTextDocument(documentUri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const edited = await editor.edit((builder) => {
      builder.insert(document.positionAt(document.getText().length), `\n// ${UNSAVED_MARKER}\n`);
    });
    assert.equal(edited, true);
    assert.equal(document.isDirty, true);

    await waitFor(
      () => vscode.languages.getDiagnostics(documentUri).some((item) => item.severity === 0),
      "TypeScript diagnostics",
    );

    const descriptor = await waitForDescriptor();
    await assertAuthenticationBoundary(descriptor);
    const client = await BridgeRpcClient.connect(descriptor.transport.endpoint);
    try {
      await client.request(BRIDGE_METHODS.initialize, {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        authToken: descriptor.authToken,
        client: { name: "extension-host-e2e", version: BRIDGE_RELEASE_VERSION },
      });

      const snapshot = await client.request<Record<string, unknown>>(BRIDGE_METHODS.readDocument, {});
      assert.equal(snapshot.isDirty, true);
      assert.match(String(snapshot.text), new RegExp(UNSAVED_MARKER));
      assert.ok(!(await readFile(documentUri.fsPath, "utf8")).includes(UNSAVED_MARKER));

      const diagnostics = await waitFor(
        async () => {
          const result = await client.request<{
            diagnostics: Array<{ severity: string; message: string }>;
          }>(BRIDGE_METHODS.getDiagnostics, {
            scope: "document",
            uri: documentUri.toString(true),
            limit: 20,
          });
          return result.diagnostics.some((item) => item.severity === "error") ? result : undefined;
        },
        "bridged TypeScript diagnostics",
      );
      assert.ok(diagnostics.diagnostics.some((item) => item.message.includes("string")));

      const symbols = await waitFor(
        async () => {
          const result = await client.request<{ symbols: Array<{ name: string }> }>(
            BRIDGE_METHODS.getDocumentSymbols,
            { uri: documentUri.toString(true), limit: 20 },
          );
          return result.symbols.some((item) => item.name === "bridgeGreeting")
            ? result
            : undefined;
        },
        "document symbols",
      );
      assert.ok(symbols.symbols.some((item) => item.name === "bridgeGreeting"));

      const positionedRequest = {
        uri: documentUri.toString(true),
        position: { line: 4, character: 27 },
        limit: 20,
      };
      const definitions = await client.request<{ locations: Array<{ range: unknown }> }>(
        BRIDGE_METHODS.getDefinitions,
        positionedRequest,
      );
      assert.ok(definitions.locations.length >= 1);

      const references = await client.request<{ locations: unknown[] }>(
        BRIDGE_METHODS.getReferences,
        positionedRequest,
      );
      assert.ok(references.locations.length >= 3);

      const hover = await client.request<{ contents: string[] }>(BRIDGE_METHODS.getHover, {
        uri: documentUri.toString(true),
        position: positionedRequest.position,
        maxChars: 4_000,
      });
      assert.ok(hover.contents.join("\n").includes("bridgeGreeting"));
      assert.ok(!hover.contents.join("\n").match(/command:(?!\[redacted\])/iu));

      await exerciseExperimentWorkflow(client, descriptor, workspaceFolder.uri, document);

      const plainDocument = await vscode.workspace.openTextDocument({
        language: "plaintext",
        content: "plain text has no definition provider",
      });
      await vscode.window.showTextDocument(plainDocument, { preview: false });
      const noDefinitions = await client.request<{ locations: unknown[] }>(
        BRIDGE_METHODS.getDefinitions,
        {
          uri: plainDocument.uri.toString(true),
          position: { line: 0, character: 0 },
          limit: 20,
        },
      );
      assert.deepEqual(noDefinitions.locations, []);

      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await assert.rejects(
        () => client.request(BRIDGE_METHODS.readDocument, {}),
        (error: unknown) => error instanceof BridgeRpcError && error.bridgeCode === "NO_ACTIVE_EDITOR",
      );
      await execGit(workspaceFolder.uri.fsPath, ["restore", "--staged", "--worktree", "--", "."]);
    } finally {
      client.close();
    }
  });

  test("isolates ten private commits and promotes one target commit", async () => {
    if (!(await isPrimaryTestWindow())) {
      await waitForManagedCompletionMarker();
      return;
    }
    const extension = vscode.extensions.getExtension("AliceLin.vscode-agent-bridge");
    assert.ok(extension);
    await extension.activate();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const targetHead = await readGitHead(workspaceFolder.uri.fsPath);

    const experiment = await vscode.commands.executeCommand<ExperimentInfo>(
      "vscodeAgentBridge.e2eStartManagedExperiment",
      "E2E managed worktree",
    );
    assert.ok(experiment?.managed);
    const worktreePath = await findWorktreePath(
      workspaceFolder.uri.fsPath,
      experiment.managed.experimentBranch,
    );
    const descriptor = await waitForDescriptorForWorkspace(worktreePath);
    const worktreeClient = await BridgeRpcClient.connect(descriptor.transport.endpoint);
    try {
      await worktreeClient.request(BRIDGE_METHODS.initialize, {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        authToken: descriptor.authToken,
        client: { name: "managed-extension-host-e2e", version: BRIDGE_RELEASE_VERSION },
      });
      const resumed = await waitFor(
        async () => {
          const active = await worktreeClient.request<ExperimentInfo>(BRIDGE_METHODS.getExperiment, {});
          return active.mode === "worktree" ? active : undefined;
        },
        "managed worktree experiment lease",
      );
      assert.equal(resumed.sessionId, experiment.sessionId);

      for (let index = 1; index <= 10; index += 1) {
        await writeFile(
          path.join(worktreePath, "app.ts"),
          `export const acceptedValue = ${index};\n`,
          "utf8",
        );
        await execGit(worktreePath, ["add", "app.ts"]);
        await execGit(worktreePath, ["commit", "-m", `private attempt ${index}`]);
      }
      let acceptedCommit = await readGitHead(worktreePath);
      assert.equal(
        (await readGitOutput(worktreePath, ["rev-list", "--count", `${targetHead}..HEAD`])).trim(),
        "10",
      );
      await waitFor(
        async () => {
          const active = await worktreeClient.request<ExperimentInfo>(BRIDGE_METHODS.getExperiment, {});
          return active.managed?.experimentHead === acceptedCommit ? active : undefined;
        },
        "managed Git checkpoint capture",
        20_000,
      );
      await writeFile(
        path.join(workspaceFolder.uri.fsPath, "target-drift.ts"),
        "export const targetDrift = true;\n",
        "utf8",
      );
      await execGit(workspaceFolder.uri.fsPath, ["add", "target-drift.ts"]);
      await execGit(workspaceFolder.uri.fsPath, ["commit", "-m", "target drift"]);
      const movedTargetHead = await readGitHead(workspaceFolder.uri.fsPath);
      await vscode.commands.executeCommand(
        "vscodeAgentBridge.e2eSetManagedAcceptedCommit",
        experiment.sessionId,
        acceptedCommit,
      );
      await assert.rejects(
        async () =>
          await vscode.commands.executeCommand(
            "vscodeAgentBridge.e2ePreviewManagedPromotion",
            experiment.sessionId,
          ),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "TARGET_MOVED",
      );
      await execGit(worktreePath, ["rebase", movedTargetHead]);
      acceptedCommit = await readGitHead(worktreePath);
      await vscode.commands.executeCommand(
        "vscodeAgentBridge.e2eUpdateManagedMetadata",
        experiment.sessionId,
        {
          baseHead: movedTargetHead,
          experimentHead: acceptedCommit,
          acceptedCommit,
        },
      );
      const preview = await vscode.commands.executeCommand<{
        sessionId: string;
        targetHead: string;
        acceptedCommit: string;
        files: string[];
        stat: string;
      }>("vscodeAgentBridge.e2ePreviewManagedPromotion", experiment.sessionId);
      assert.ok(preview);
      const formalCommit = await vscode.commands.executeCommand<string>(
        "vscodeAgentBridge.e2ePromoteManagedExperiment",
        preview,
        "formal managed delivery",
      );
      assert.ok(formalCommit);
      assert.equal(await readGitHead(workspaceFolder.uri.fsPath), formalCommit);
      assert.equal(
        (await readGitOutput(workspaceFolder.uri.fsPath, ["rev-list", "--count", `${movedTargetHead}..HEAD`])).trim(),
        "1",
      );
      assert.equal(
        (await readGitOutput(workspaceFolder.uri.fsPath, ["rev-list", "--count", `${targetHead}..HEAD`])).trim(),
        "2",
      );
      assert.equal(
        (await readGitOutput(workspaceFolder.uri.fsPath, ["rev-parse", `${formalCommit}^{tree}`])).trim(),
        (await readGitOutput(worktreePath, ["rev-parse", `${acceptedCommit}^{tree}`])).trim(),
      );
      const registryDirectory = process.env.VSCODE_AGENT_BRIDGE_REGISTRY_DIR;
      assert.ok(registryDirectory);
      await writeFile(
        path.join(registryDirectory, "managed-e2e-passed.json"),
        `${JSON.stringify({ privateCommitCount: 10, promotedCommitCount: 1, treeMatches: true })}\n`,
        "utf8",
      );
    } finally {
      worktreeClient.close();
    }
  });
});

async function isPrimaryTestWindow(): Promise<boolean> {
  const configured = process.env.VSCODE_AGENT_BRIDGE_E2E_WORKSPACE;
  if (!configured) {
    return false;
  }
  const current = await waitFor(
    () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    "E2E workspace folder",
    5_000,
  ).catch(() => undefined);
  return (
    current !== undefined &&
    path.resolve(configured).toLowerCase() === path.resolve(current).toLowerCase()
  );
}

async function waitForManagedCompletionMarker(): Promise<void> {
  const registryDirectory = process.env.VSCODE_AGENT_BRIDGE_REGISTRY_DIR;
  if (!registryDirectory) {
    return;
  }
  await waitFor(
    async () => {
      try {
        await readFile(path.join(registryDirectory, "managed-e2e-passed.json"), "utf8");
        return true;
      } catch {
        return undefined;
      }
    },
    "primary managed E2E completion",
    60_000,
  );
}

async function assertAuthenticationBoundary(descriptor: InstanceDescriptor): Promise<void> {
  const unauthenticated = await BridgeRpcClient.connect(descriptor.transport.endpoint);
  await assert.rejects(
    () => unauthenticated.request(BRIDGE_METHODS.getEditorContext, {}),
    (error: unknown) =>
      error instanceof BridgeRpcError && error.bridgeCode === "AUTHENTICATION_FAILED",
  );
  unauthenticated.close();

  const wrongToken = await BridgeRpcClient.connect(descriptor.transport.endpoint);
  await assert.rejects(
    () =>
      wrongToken.request(BRIDGE_METHODS.initialize, {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        authToken: "x".repeat(43),
        client: { name: "extension-host-e2e", version: BRIDGE_RELEASE_VERSION },
      }),
    (error: unknown) =>
      error instanceof BridgeRpcError && error.bridgeCode === "AUTHENTICATION_FAILED",
  );
  wrongToken.close();
}

async function exerciseExperimentWorkflow(
  client: BridgeRpcClient,
  descriptor: InstanceDescriptor,
  workspaceUri: vscode.Uri,
  document: vscode.TextDocument,
): Promise<void> {
  const initialHead = await readGitHead(workspaceUri.fsPath);
  const started = await vscode.commands.executeCommand<ExperimentInfo>(
    "vscodeAgentBridge.e2eStartExperiment",
    "E2E recoverable experiment",
  );
  assert.ok(started);
  assert.equal(started.instanceId, descriptor.instanceId);
  assert.equal(started.lifecycle, "active");
  assert.equal(started.health, "complete");

  const active = await client.request<ExperimentInfo>(BRIDGE_METHODS.getExperiment, {});
  assert.equal(active.sessionId, started.sessionId);
  assert.ok(active.currentCheckpointId, "the experiment should create a baseline checkpoint");

  const beforeApply = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
    uri: document.uri.toString(true),
  });
  const prepared = await client.request<PreparedChangeSet>(BRIDGE_METHODS.prepareTextEdits, {
    sessionId: active.sessionId,
    title: "Insert an agent marker",
    rationale: "Exercise guarded dirty-buffer edits",
    documents: [
      {
        uri: document.uri.toString(true),
        expectedSha256: beforeApply.contentSha256,
        expectedVersion: beforeApply.documentVersion,
        edits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: `// ${AGENT_MARKER}\n`,
          },
        ],
      },
    ],
  });
  const applied = await client.request<AppliedChangeSet>(BRIDGE_METHODS.applyChangeSet, {
    sessionId: active.sessionId,
    changeSetId: prepared.changeSetId,
  });
  assert.ok(document.getText().includes(AGENT_MARKER));
  assert.equal(document.isDirty, true, "agent apply must not save the document");
  assert.ok(applied.documents.every((item) => item.isDirty));

  const tsconfigUri = vscode.Uri.joinPath(workspaceUri, "tsconfig.json");
  const tsconfigDocument = await vscode.workspace.openTextDocument(tsconfigUri);
  const tsconfigEditor = await vscode.window.showTextDocument(tsconfigDocument, { preview: false });
  const [bridgeSnapshot, tsconfigSnapshot] = await Promise.all([
    client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
      uri: document.uri.toString(true),
    }),
    client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
      uri: tsconfigUri.toString(true),
    }),
  ]);
  const stale = await client.request<PreparedChangeSet>(BRIDGE_METHODS.prepareTextEdits, {
    sessionId: active.sessionId,
    title: "Atomic stale edit",
    documents: [
      {
        uri: document.uri.toString(true),
        expectedSha256: bridgeSnapshot.contentSha256,
        expectedVersion: bridgeSnapshot.documentVersion,
        edits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: `// ${STALE_MARKER}\n`,
          },
        ],
      },
      {
        uri: tsconfigUri.toString(true),
        expectedSha256: tsconfigSnapshot.contentSha256,
        expectedVersion: tsconfigSnapshot.documentVersion,
        edits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: " ",
          },
        ],
      },
    ],
  });
  assert.equal(
    await tsconfigEditor.edit((builder) => builder.insert(new vscode.Position(0, 0), " ")),
    true,
  );
  await assert.rejects(
    () =>
      client.request(BRIDGE_METHODS.applyChangeSet, {
        sessionId: active.sessionId,
        changeSetId: stale.changeSetId,
      }),
    (error: unknown) => error instanceof BridgeRpcError && error.bridgeCode === "STALE_CHANGE_SET",
  );
  assert.ok(!document.getText().includes(STALE_MARKER), "no document may be partially edited");
  assert.equal(tsconfigDocument.getText().startsWith("  "), false);
  assert.equal(
    await tsconfigEditor.edit((builder) =>
      builder.delete(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1))),
    ),
    true,
  );

  const bridgeEditor = await vscode.window.showTextDocument(document, { preview: false });
  const beforeRename = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
    uri: document.uri.toString(true),
  });
  const symbolOffset = document.getText().indexOf("bridgeGreeting");
  assert.ok(symbolOffset >= 0);
  const renamePosition = document.positionAt(symbolOffset + 2);
  const rename = await client.request<PreparedChangeSet>(BRIDGE_METHODS.prepareRename, {
    sessionId: active.sessionId,
    title: "Rename bridge greeting",
    uri: document.uri.toString(true),
    position: { line: renamePosition.line, character: renamePosition.character },
    newName: "renamedBridgeGreeting",
    expectedSha256: beforeRename.contentSha256,
    expectedVersion: beforeRename.documentVersion,
  });
  const renamed = await client.request<AppliedChangeSet>(BRIDGE_METHODS.applyChangeSet, {
    sessionId: active.sessionId,
    changeSetId: rename.changeSetId,
  });
  assert.ok(document.getText().includes("renamedBridgeGreeting"));

  const evidence = await client.request<{ source: string; summary: string }>(
    BRIDGE_METHODS.recordExperimentEvidence,
    {
      sessionId: active.sessionId,
      checkpointId: renamed.checkpointId,
      kind: "test",
      status: "passed",
      summary: "Extension Host guarded edit workflow passed",
    },
  );
  assert.equal(evidence.source, "client-reported");

  const checkpoints = await client.request<ExperimentCheckpointsResult>(
    BRIDGE_METHODS.listExperimentCheckpoints,
    { sessionId: active.sessionId, offset: 0, limit: 100 },
  );
  assert.ok(checkpoints.checkpoints.some((checkpoint) => checkpoint.source === "baseline"));
  assert.ok(checkpoints.checkpoints.filter((checkpoint) => checkpoint.source === "agentApply").length >= 2);

  await vscode.commands.executeCommand(
    "vscodeAgentBridge.e2eMarkCheckpointAccepted",
    renamed.checkpointId,
  );
  assert.equal(
    await bridgeEditor.edit((builder) =>
      builder.insert(new vscode.Position(0, 0), "// temporary\n"),
    ),
    true,
  );
  await vscode.commands.executeCommand("vscodeAgentBridge.e2eRestoreAccepted");
  assert.ok(!document.getText().includes("// temporary"));
  assert.ok(document.getText().includes("renamedBridgeGreeting"));
  assert.equal(document.isDirty, true, "restore must leave editor buffers dirty");

  assert.equal(await tsconfigDocument.save(), true);
  assert.equal(await document.save(), true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await vscode.commands.executeCommand("vscodeAgentBridge.e2eFinalizeExperiment");
  assert.equal(await readGitHead(workspaceUri.fsPath), initialHead, "v0.3 must not create Git commits");
  await assert.rejects(
    () => client.request(BRIDGE_METHODS.getExperiment, {}),
    (error: unknown) =>
      error instanceof BridgeRpcError && error.bridgeCode === "NO_ACTIVE_EXPERIMENT",
  );
}

async function readGitHead(cwd: string): Promise<string> {
  return (await readGitOutput(cwd, ["rev-parse", "HEAD"])).trim();
}

async function readGitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}

async function execGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function findWorktreePath(repository: string, branch: string): Promise<string> {
  const output = await readGitOutput(repository, ["worktree", "list", "--porcelain"]);
  for (const record of output.split(/\r?\n\r?\n/u)) {
    const fields = record.split(/\r?\n/u);
    if (fields.includes(`branch refs/heads/${branch}`)) {
      const worktree = fields.find((field) => field.startsWith("worktree "));
      if (worktree) {
        return path.resolve(worktree.slice("worktree ".length));
      }
    }
  }
  throw new Error(`Managed worktree for ${branch} was not found.`);
}

async function waitForDescriptor(): Promise<InstanceDescriptor> {
  const instancesDirectory = resolveRegistryDirectories().instances;
  return waitFor(async () => {
    const names = await readdir(instancesDirectory).catch(() => []);
    const descriptorName = names.find((name) => name.endsWith(".json"));
    if (!descriptorName) {
      return undefined;
    }
    const parsed = InstanceDescriptorSchema.safeParse(
      JSON.parse(await readFile(path.join(instancesDirectory, descriptorName), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  }, "bridge instance descriptor");
}

async function waitForDescriptorForWorkspace(workspacePath: string): Promise<InstanceDescriptor> {
  const instancesDirectory = resolveRegistryDirectories().instances;
  return waitFor(async () => {
    const names = await readdir(instancesDirectory).catch(() => []);
    for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
      const parsed = InstanceDescriptorSchema.safeParse(
        JSON.parse(await readFile(path.join(instancesDirectory, name), "utf8")),
      );
      if (
        parsed.success &&
        parsed.data.workspaceFolders.some(
          (folder) =>
            path.resolve(vscode.Uri.parse(folder.uri, true).fsPath).toLowerCase() ===
            path.resolve(workspacePath).toLowerCase(),
        )
      ) {
        return parsed.data;
      }
    }
    return undefined;
  }, "managed worktree descriptor", 30_000);
}

async function waitFor<T>(
  callback: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value !== undefined && value !== false) {
        return value as T;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}.`, { cause: lastError });
}

class BridgeRpcError extends Error {
  constructor(
    readonly bridgeCode: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeRpcError";
  }
}

class BridgeRpcClient {
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
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
    const id = this.#nextRequestId++;
    const result = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
    this.#socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  }

  close(): void {
    this.#socket.destroy();
  }

  #acceptData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      const response = JSON.parse(line) as {
        id: number;
        result?: unknown;
        error?: { message: string; data?: { bridgeCode?: string } };
      };
      const pending = this.#pending.get(response.id);
      if (!pending) {
        continue;
      }
      this.#pending.delete(response.id);
      if (response.error) {
        pending.reject(
          new BridgeRpcError(response.error.data?.bridgeCode ?? "UNKNOWN", response.error.message),
        );
      } else {
        pending.resolve(response.result);
      }
    }
  }

  #rejectPending(error: unknown): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
