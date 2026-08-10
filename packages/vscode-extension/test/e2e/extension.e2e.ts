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
  type ApplyCodeActionResult,
  type DocumentSnapshot,
  type ExperimentCheckpointsResult,
  type ExperimentInfo,
  type ExperimentsResult,
  type FormatDocumentResult,
  type InstanceDescriptor,
  type ListCodeActionsResult,
  type ListTerminalExecutionsResult,
  type ListTerminalsResult,
  type PreparedChangeSet,
  type ReadTerminalOutputResult,
  type SaveDocumentResult,
  type WorkspaceSetupResult,
} from "@vscode-agent-bridge/protocol";

import { isPathWithin, samePath } from "../../src/git-path.js";

const UNSAVED_MARKER = "UNSAVED_VSCODE_AGENT_BRIDGE_E2E";
const AGENT_MARKER = "AGENT_CHANGE_SET_E2E";
const STALE_MARKER = "STALE_CHANGE_SET_MUST_NOT_APPLY";
const TERMINAL_MARKER = "TERMINAL_OUTPUT_VSCODE_AGENT_BRIDGE_E2E";
const execFileAsync = promisify(execFile);

suite("VS Code Agent Bridge Extension Host", function () {
  this.timeout(150_000);

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
    const activation = extension.activate();
    const initializingDescriptor = await waitForDescriptor("initializing");
    const initializingClient = await BridgeRpcClient.connect(
      initializingDescriptor.transport.endpoint,
    );
    try {
      const initialized = await initializingClient.request<{ lifecycle: string }>(
        BRIDGE_METHODS.initialize,
        {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          authToken: initializingDescriptor.authToken,
          client: { name: "extension-host-e2e", version: BRIDGE_RELEASE_VERSION },
        },
      );
      assert.equal(initialized.lifecycle, "initializing");
      await assert.rejects(
        () => initializingClient.request(BRIDGE_METHODS.getEditorContext, {}),
        isBridgeError("BRIDGE_INITIALIZING"),
      );
    } finally {
      initializingClient.close();
    }
    await activation;

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

    const descriptor = await waitForDescriptor("ready");
    await assertAuthenticationBoundary(descriptor);
    const client = await BridgeRpcClient.connect(descriptor.transport.endpoint);
    try {
      await client.request(BRIDGE_METHODS.initialize, {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        authToken: descriptor.authToken,
        client: { name: "extension-host-e2e", version: BRIDGE_RELEASE_VERSION },
      });

      const setupBefore = await client.request<WorkspaceSetupResult>(
        BRIDGE_METHODS.getWorkspaceSetup,
        { rootUri: workspaceFolder.uri.toString(true) },
      );
      assert.equal(setupBefore.onboarding, "unconfigured");
      assert.equal(setupBefore.vscodeDirectory, "missing");
      assert.ok(setupBefore.files.every((file) => file.state === "missing"));

      const cancelledClient = await BridgeRpcClient.connect(descriptor.transport.endpoint);
      try {
        await cancelledClient.request(BRIDGE_METHODS.initialize, {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          authToken: descriptor.authToken,
          client: { name: "extension-host-e2e", version: BRIDGE_RELEASE_VERSION },
        });
        const cancelledStart = cancelledClient.request(BRIDGE_METHODS.startExperiment, {
          rootUri: workspaceFolder.uri.toString(true),
          title: "Cancelled onboarding must not persist",
          reason: "Exercise socket-close cancellation while user confirmation is pending",
        });
        setTimeout(() => cancelledClient.close(), 250);
        await assert.rejects(cancelledStart);
      } finally {
        cancelledClient.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const setupAfterCancellation = await client.request<WorkspaceSetupResult>(
        BRIDGE_METHODS.getWorkspaceSetup,
        { rootUri: workspaceFolder.uri.toString(true) },
      );
      assert.equal(setupAfterCancellation.onboarding, "unconfigured");
      assert.equal(setupAfterCancellation.vscodeDirectory, "missing");

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
      await exerciseTerminalObservation(client);
      await exerciseAutonomyPolicies(client, workspaceFolder.uri, document);

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
    } finally {
      await vscode.commands
        .executeCommand("vscodeAgentBridge.e2eAbandonExperiment")
        .then(undefined, () => undefined);
      for (const dirtyDocument of vscode.workspace.textDocuments.filter(
        (candidate) =>
          candidate.isDirty &&
          candidate.uri.scheme === "file" &&
          isPathWithin(workspaceFolder.uri.fsPath, candidate.uri.fsPath),
      )) {
        await dirtyDocument.save();
      }
      await execGit(workspaceFolder.uri.fsPath, ["restore", "--staged", "--worktree", "--", "."]);
      await execGit(workspaceFolder.uri.fsPath, ["clean", "-fd", "--", ".vscode"]);
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
  return current !== undefined && samePath(configured, current);
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
  const started = await client.request<ExperimentInfo>(BRIDGE_METHODS.startExperiment, {
    rootUri: workspaceUri.toString(true),
    title: "E2E recoverable experiment",
    reason: "Exercise Agent-owned workspace experiment startup",
  });
  assert.ok(started);
  assert.equal(started.instanceId, descriptor.instanceId);
  assert.equal(started.lifecycle, "active");
  assert.equal(started.health, "complete");

  const setupAfter = await client.request<WorkspaceSetupResult>(BRIDGE_METHODS.getWorkspaceSetup, {
    rootUri: workspaceUri.toString(true),
  });
  assert.equal(setupAfter.onboarding, "enabled");
  assert.equal(setupAfter.editVisibility, "focusFirst");
  assert.equal(setupAfter.vscodeDirectory, "present");
  assert.equal(setupAfter.files.find((file) => file.kind === "settings")?.state, "present");
  assert.equal(setupAfter.files.find((file) => file.kind === "launch")?.state, "missing");
  assert.equal(setupAfter.files.find((file) => file.kind === "tasks")?.state, "missing");
  await vscode.workspace
    .getConfiguration("editor", workspaceUri)
    .update("formatOnSave", true, vscode.ConfigurationTarget.WorkspaceFolder);

  const active = await client.request<ExperimentInfo>(BRIDGE_METHODS.getExperiment, {});
  assert.equal(active.sessionId, started.sessionId);
  assert.ok(active.currentCheckpointId, "the experiment should create a baseline checkpoint");

  const listed = await client.request<ExperimentsResult>(BRIDGE_METHODS.listExperiments, {
    rootUri: workspaceUri.toString(true),
    offset: 0,
    limit: 20,
  });
  assert.equal(listed.activeSessionId, active.sessionId);
  assert.ok(listed.experiments.some((experiment) => experiment.sessionId === active.sessionId));
  const renamedExperiment = await client.request<ExperimentInfo>(BRIDGE_METHODS.renameExperiment, {
    sessionId: active.sessionId,
    expectedTitle: started.title,
    title: "E2E task-named experiment",
    reason: "Reflect the concrete task in the experiment timeline",
  });
  assert.equal(renamedExperiment.title, "E2E task-named experiment");
  await assert.rejects(
    () =>
      client.request(BRIDGE_METHODS.renameExperiment, {
        sessionId: active.sessionId,
        expectedTitle: started.title,
        title: "Stale title overwrite",
        reason: "Verify optimistic title concurrency",
      }),
    isBridgeError("EXPERIMENT_STATE_CHANGED"),
  );
  const explicit = await client.request<{ checkpoint: { checkpointId: string; source: string } }>(
    BRIDGE_METHODS.createExperimentCheckpoint,
    {
      sessionId: active.sessionId,
      title: "Initial Agent checkpoint",
      reason: "Verify reflexive checkpoint creation",
    },
  );
  assert.equal(explicit.checkpoint.source, "explicit");

  const checkpointsBeforeIgnoredOutput = await client.request<ExperimentCheckpointsResult>(
    BRIDGE_METHODS.listExperimentCheckpoints,
    { sessionId: active.sessionId, offset: 0, limit: 200 },
  );
  const ignoredOutputDirectory = vscode.Uri.joinPath(workspaceUri, "ignored-output");
  const ignoredOutput = vscode.Uri.joinPath(ignoredOutputDirectory, "build-marker.tmp");
  await vscode.workspace.fs.createDirectory(ignoredOutputDirectory);
  await vscode.workspace.fs.writeFile(ignoredOutput, Buffer.from("ignored build output\n"));
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const checkpointsAfterIgnoredOutput = await client.request<ExperimentCheckpointsResult>(
    BRIDGE_METHODS.listExperimentCheckpoints,
    { sessionId: active.sessionId, offset: 0, limit: 200 },
  );
  assert.equal(
    checkpointsAfterIgnoredOutput.totalCount,
    checkpointsBeforeIgnoredOutput.totalCount,
    "Git-ignored build output must not expand the experiment timeline",
  );
  await vscode.workspace.fs.delete(ignoredOutputDirectory, { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, 700));

  const formatUri = vscode.Uri.joinPath(workspaceUri, "format.bridgeformat");
  const [beforeApply, beforeVisibleFormat] = await Promise.all([
    client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
      uri: document.uri.toString(true),
    }),
    client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
      uri: formatUri.toString(true),
    }),
  ]);
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
      {
        uri: formatUri.toString(true),
        expectedSha256: beforeVisibleFormat.contentSha256,
        expectedVersion: beforeVisibleFormat.documentVersion,
        edits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "// VISIBLE_MULTI_FILE_E2E\n",
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
  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(true), document.uri.toString(true));
  assert.ok(
    vscode.window.tabGroups.all.some((group) =>
      group.tabs.some(
        (tab) =>
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString(true) === formatUri.toString(true),
      ),
    ),
    "focusFirst should open every target while returning focus to the first document",
  );

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

  await vscode.window.showTextDocument(document, { preview: false });
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

  const formatDocument = await vscode.workspace.openTextDocument(formatUri);
  await vscode.window.showTextDocument(formatDocument, { preview: false });
  const beforeFormat = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
    uri: formatUri.toString(true),
  });
  const formatted = await client.request<FormatDocumentResult>(BRIDGE_METHODS.formatDocument, {
    sessionId: active.sessionId,
    uri: formatUri.toString(true),
    expectedVersion: beforeFormat.documentVersion,
    expectedSha256: beforeFormat.contentSha256,
    reason: "Exercise the fixed VS Code formatting provider",
  });
  assert.equal(formatted.applied, true);
  assert.equal(formatted.isDirty, true);
  assert.equal(formatDocument.getText(), "export const formattedValue = 42;\n");

  const beforeNoOpFormat = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
    uri: formatUri.toString(true),
  });
  const noOpFormat = await client.request<FormatDocumentResult>(BRIDGE_METHODS.formatDocument, {
    sessionId: active.sessionId,
    uri: formatUri.toString(true),
    expectedVersion: beforeNoOpFormat.documentVersion,
    expectedSha256: beforeNoOpFormat.contentSha256,
    reason: "Treat an undefined formatter result as an explicit no-op",
  });
  assert.equal(noOpFormat.applied, false);
  assert.equal(noOpFormat.editCount, 0);
  assert.equal(noOpFormat.checkpointId, null);
  assert.equal(noOpFormat.documentVersion, beforeNoOpFormat.documentVersion);
  assert.equal(noOpFormat.contentSha256, beforeNoOpFormat.contentSha256);

  const formatEditor = await vscode.window.showTextDocument(formatDocument, { preview: false });
  assert.equal(
    await formatEditor.edit((builder) =>
      builder.replace(
        new vscode.Range(new vscode.Position(0, 0), formatDocument.positionAt(formatDocument.getText().length)),
        "export       const saveFormattingTarget=7;\n",
      ),
    ),
    true,
  );
  const beforeFormatSave = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
    uri: formatUri.toString(true),
  });
  const formatSaved = await client.request<SaveDocumentResult>(BRIDGE_METHODS.saveDocument, {
    sessionId: active.sessionId,
    uri: formatUri.toString(true),
    expectedVersion: beforeFormatSave.documentVersion,
    expectedSha256: beforeFormatSave.contentSha256,
    reason: "Verify final text after format-on-save",
  });
  assert.equal(formatSaved.isDirty, false);
  assert.equal(formatSaved.saveEffectsChangedContent, true);
  assert.equal(await readFile(formatUri.fsPath, "utf8"), "export const formattedValue = 42;\n");

  const actionUri = vscode.Uri.joinPath(workspaceUri, "action.bridgeaction");
  const actionDocument = await vscode.workspace.openTextDocument(actionUri);
  await vscode.window.showTextDocument(actionDocument, { preview: false });
  await vscode.workspace
    .getConfiguration("vscodeAgentBridge")
    .update("enableAcceptanceFixtures", true, vscode.ConfigurationTarget.Global);
  const beforeActions = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
    uri: actionUri.toString(true),
  });
  const actions = await client.request<ListCodeActionsResult>(BRIDGE_METHODS.listCodeActions, {
    sessionId: active.sessionId,
    uri: actionUri.toString(true),
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: "BROKEN_E2E".length },
    },
    expectedVersion: beforeActions.documentVersion,
    expectedSha256: beforeActions.contentSha256,
    kinds: ["quickfix"],
    limit: 20,
  });
  const applicableAction = actions.actions.find(
    (action) =>
      action.applicable && action.title === "Apply VS Code Agent Bridge acceptance text edit",
  );
  assert.ok(applicableAction, "the opt-in acceptance Code Action should be applicable");
  assert.ok(
    actions.actions.filter((action) => !action.applicable).length >= 2,
    "command-only and resource Code Actions must be visible but inapplicable",
  );
  const actionApplied = await client.request<ApplyCodeActionResult>(BRIDGE_METHODS.applyCodeAction, {
    sessionId: active.sessionId,
    actionId: applicableAction.actionId,
    reason: "Apply a provider-generated pure text Quick Fix",
  });
  assert.ok(actionDocument.getText().includes("FIXED_E2E"));
  assert.equal(actionDocument.isDirty, true);
  await assert.rejects(
    () =>
      client.request(BRIDGE_METHODS.applyCodeAction, {
        sessionId: active.sessionId,
        actionId: applicableAction.actionId,
        reason: "A one-use Code Action must not apply twice",
      }),
    (error: unknown) =>
      error instanceof BridgeRpcError && error.bridgeCode === "CODE_ACTION_ALREADY_APPLIED",
  );
  const beforeActionSave = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
    uri: actionUri.toString(true),
  });
  const actionSaved = await client.request<SaveDocumentResult>(BRIDGE_METHODS.saveDocument, {
    sessionId: active.sessionId,
    uri: actionUri.toString(true),
    expectedVersion: beforeActionSave.documentVersion,
    expectedSha256: beforeActionSave.contentSha256,
    reason: "Persist the safe Code Action result",
  });
  assert.equal(actionSaved.isDirty, false);

  const evidence = await client.request<{ source: string; summary: string }>(
    BRIDGE_METHODS.recordExperimentEvidence,
    {
      sessionId: active.sessionId,
      checkpointId: actionApplied.checkpointId,
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
  assert.ok(checkpoints.checkpoints.filter((checkpoint) => checkpoint.source === "agentApply").length >= 4);

  const activities = await vscode.commands.executeCommand<
    Array<{
      toolName: string;
      status: string;
      targets: string[];
      checkpointId: string | null;
    }>
  >("vscodeAgentBridge.e2eGetAgentActivity");
  assert.ok(activities);
  assert.ok(
    [
      "vscode_start_experiment",
      "vscode_rename_experiment",
      "vscode_create_experiment_checkpoint",
      "vscode_apply_change_set",
      "vscode_format_document",
      "vscode_apply_code_action",
    ].every((toolName) => activities.some((entry) => entry.toolName === toolName)),
  );
  assert.ok(activities.some((entry) => entry.status === "no-op"));
  assert.equal(JSON.stringify(activities).includes(workspaceUri.fsPath), false);
  assert.ok(activities.flatMap((entry) => entry.targets).every((target) => !path.isAbsolute(target)));

  await vscode.commands.executeCommand(
    "vscodeAgentBridge.e2eMarkCheckpointAccepted",
    actionSaved.checkpointId,
  );
  const bridgeEditor = await vscode.window.showTextDocument(document, { preview: false });
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

  for (const dirtyDocument of vscode.workspace.textDocuments.filter(
    (candidate) => candidate.isDirty && candidate.uri.scheme === "file",
  )) {
    const snapshot = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
      uri: dirtyDocument.uri.toString(true),
    });
    const saved = await client.request<SaveDocumentResult>(BRIDGE_METHODS.saveDocument, {
      sessionId: active.sessionId,
      uri: dirtyDocument.uri.toString(true),
      expectedVersion: snapshot.documentVersion,
      expectedSha256: snapshot.contentSha256,
      reason: "Save the explicitly accepted E2E candidate",
    });
    assert.equal(saved.isDirty, false);
  }
  const finalCheckpointId = await vscode.commands.executeCommand<string>(
    "vscodeAgentBridge.e2eCreateCheckpoint",
    "Final saved E2E candidate",
  );
  assert.ok(finalCheckpointId);
  await vscode.commands.executeCommand(
    "vscodeAgentBridge.e2eMarkCheckpointAccepted",
    finalCheckpointId,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  await vscode.commands.executeCommand("vscodeAgentBridge.e2eFinalizeExperiment");
  assert.equal(await readGitHead(workspaceUri.fsPath), initialHead, "v0.3 must not create Git commits");
  await assert.rejects(
    () => client.request(BRIDGE_METHODS.getExperiment, {}),
    (error: unknown) =>
      error instanceof BridgeRpcError && error.bridgeCode === "NO_ACTIVE_EXPERIMENT",
  );
}

async function exerciseTerminalObservation(client: BridgeRpcClient): Promise<void> {
  await setAgentPolicies("autonomous", "allow");
  const terminalName = `bridge-e2e-${Date.now()}`;
  const terminal = vscode.window.createTerminal({ name: terminalName, shellPath: "powershell.exe" });
  terminal.show(false);
  try {
    const shellIntegration = await waitFor(
      () => terminal.shellIntegration,
      "PowerShell terminal Shell Integration",
      30_000,
    );
    const listed = await waitFor(async () => {
      const result = await client.request<ListTerminalsResult>(BRIDGE_METHODS.listTerminals, {});
      return result.terminals.find((candidate) => candidate.name === terminalName) ? result : undefined;
    }, "bridged terminal registration");
    const terminalInfo = listed.terminals.find((candidate) => candidate.name === terminalName)!;
    assert.equal(terminalInfo.shellIntegration, "available");

    shellIntegration.executeCommand(
      `Write-Output '${TERMINAL_MARKER}_START'; Start-Sleep -Milliseconds 1800; Write-Output '${TERMINAL_MARKER}_DONE'`,
    );
    const running = await waitFor(async () => {
      const result = await client.request<ListTerminalExecutionsResult>(
        BRIDGE_METHODS.listTerminalExecutions,
        { terminalId: terminalInfo.terminalId, limit: 20 },
      );
      return result.executions.find((execution) => execution.status === "running");
    }, "running terminal execution");
    assert.ok(running.commandLine?.includes(TERMINAL_MARKER));
    assert.equal(running.coverage.output, "capturing");

    const completed = await waitFor(async () => {
      const result = await client.request<ListTerminalExecutionsResult>(
        BRIDGE_METHODS.listTerminalExecutions,
        { terminalId: terminalInfo.terminalId, limit: 20 },
      );
      return result.executions.find(
        (execution) => execution.executionId === running.executionId && execution.status === "exited",
      );
    }, "completed terminal execution");
    assert.equal(completed.exitCode, 0);

    let cursor = 0;
    let output = "";
    for (;;) {
      const page = await client.request<ReadTerminalOutputResult>(BRIDGE_METHODS.readTerminalOutput, {
        executionId: completed.executionId,
        cursor,
        maxChars: 19,
      });
      output += page.text;
      if (page.nextCursor === null) {
        assert.equal(page.complete, true);
        break;
      }
      cursor = page.nextCursor;
    }
    assert.ok(output.includes(`${TERMINAL_MARKER}_START`));
    assert.ok(output.includes(`${TERMINAL_MARKER}_DONE`));

    terminal.dispose();
    await waitFor(async () => {
      const result = await client.request<ListTerminalsResult>(BRIDGE_METHODS.listTerminals, {});
      return result.terminals.some(
        (candidate) => candidate.terminalId === terminalInfo.terminalId && candidate.lifecycle === "closed",
      );
    }, "closed terminal retention");

    await setAgentPolicies("autonomous", "metadataOnly");
    const metadata = await client.request<ListTerminalsResult>(BRIDGE_METHODS.listTerminals, {});
    const redacted = metadata.terminals.find((candidate) => candidate.terminalId === terminalInfo.terminalId);
    assert.ok(redacted);
    assert.equal(redacted.cwd, null);
    assert.equal(redacted.coverage.output, "redacted");
    await assert.rejects(
      () => client.request(BRIDGE_METHODS.listTerminalExecutions, { limit: 20 }),
      isBridgeError("POLICY_DENIED"),
    );

    await setAgentPolicies("autonomous", "deny");
    await assert.rejects(
      () => client.request(BRIDGE_METHODS.listTerminals, {}),
      isBridgeError("POLICY_DENIED"),
    );
  } finally {
    terminal.dispose();
    await setAgentPolicies("autonomous", "allow");
  }
}

async function exerciseAutonomyPolicies(
  client: BridgeRpcClient,
  workspaceUri: vscode.Uri,
  document: vscode.TextDocument,
): Promise<void> {
  await setAgentPolicies("autonomous", "allow");
  const autonomous = await vscode.commands.executeCommand<ExperimentInfo>(
    "vscodeAgentBridge.e2eStartExperiment",
    "E2E autonomous finalize",
  );
  assert.ok(autonomous);
  await vscode.commands.executeCommand("vscodeAgentBridge.e2eFinalizeExperiment");
  await assert.rejects(
    () => client.request(BRIDGE_METHODS.getExperiment, {}),
    isBridgeError("NO_ACTIVE_EXPERIMENT"),
  );

  await setAgentPolicies("review", "allow");
  const review = await vscode.commands.executeCommand<ExperimentInfo>(
    "vscodeAgentBridge.e2eStartExperiment",
    "E2E review finalize",
  );
  assert.ok(review);
  await assert.rejects(
    async () => await vscode.commands.executeCommand("vscodeAgentBridge.e2eFinalizeExperiment"),
    isObjectErrorCode("INVALID_REQUEST"),
  );
  await vscode.commands.executeCommand("vscodeAgentBridge.e2eAbandonExperiment");

  await setAgentPolicies("autonomous", "allow");
  const readOnly = await vscode.commands.executeCommand<ExperimentInfo>(
    "vscodeAgentBridge.e2eStartExperiment",
    "E2E read-only enforcement",
  );
  assert.ok(readOnly);
  await setAgentPolicies("readOnly", "metadataOnly");
  const snapshot = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
    uri: document.uri.toString(true),
  });
  await assert.rejects(
    () =>
      client.request(BRIDGE_METHODS.saveDocument, {
        sessionId: readOnly.sessionId,
        uri: document.uri.toString(true),
        expectedVersion: snapshot.documentVersion,
        expectedSha256: snapshot.contentSha256,
        reason: "The extension must reject this read-only write",
      }),
    isBridgeError("POLICY_DENIED"),
  );
  const actionUri = vscode.Uri.joinPath(workspaceUri, "action.bridgeaction");
  const actionSnapshot = await client.request<DocumentSnapshot>(BRIDGE_METHODS.readDocument, {
    uri: actionUri.toString(true),
  });
  const actions = await client.request<ListCodeActionsResult>(BRIDGE_METHODS.listCodeActions, {
    sessionId: readOnly.sessionId,
    uri: actionUri.toString(true),
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    expectedVersion: actionSnapshot.documentVersion,
    expectedSha256: actionSnapshot.contentSha256,
    limit: 20,
  });
  assert.ok(actions.returnedCount > 0, "Code Action discovery remains read-only");
  await vscode.commands.executeCommand("vscodeAgentBridge.e2eAbandonExperiment");
  await setAgentPolicies("autonomous", "allow");
}

async function setAgentPolicies(
  autonomyProfile: "autonomous" | "review" | "readOnly",
  terminalReadPolicy: "allow" | "metadataOnly" | "deny",
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("vscodeAgentBridge");
  await configuration.update("autonomyProfile", autonomyProfile, vscode.ConfigurationTarget.Global);
  await configuration.update(
    "terminalReadPolicy",
    terminalReadPolicy,
    vscode.ConfigurationTarget.Global,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
}

function isBridgeError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof BridgeRpcError && error.bridgeCode === code;
}

function isObjectErrorCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === "object" && error !== null && "code" in error && error.code === code;
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

async function waitForDescriptor(
  lifecycle?: InstanceDescriptor["lifecycle"],
): Promise<InstanceDescriptor> {
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
    return parsed.success && (!lifecycle || parsed.data.lifecycle === lifecycle)
      ? parsed.data
      : undefined;
  }, lifecycle ? `bridge ${lifecycle} instance descriptor` : "bridge instance descriptor");
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
        parsed.data.lifecycle === "ready" &&
        parsed.data.workspaceFolders.some((folder) =>
          samePath(vscode.Uri.parse(folder.uri, true).fsPath, workspacePath),
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
