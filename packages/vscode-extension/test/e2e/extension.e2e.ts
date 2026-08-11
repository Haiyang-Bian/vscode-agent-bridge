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
  type AppliedChangeSet,
  type ApplyCodeActionResult,
  type DocumentSnapshot,
  type ExperimentCheckpointsResult,
  type ExperimentInfo,
  type ExtensionConfigurationResult,
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

import {
  E2E_SCENARIOS,
  type E2EScenario,
} from "../../../../scripts/lib/test-impact.js";

import { isPathWithin, samePath } from "../../src/git-path.js";

const UNSAVED_MARKER = "UNSAVED_VSCODE_AGENT_BRIDGE_E2E";
const AGENT_MARKER = "AGENT_CHANGE_SET_E2E";
const STALE_MARKER = "STALE_CHANGE_SET_MUST_NOT_APPLY";
const TERMINAL_MARKER = "TERMINAL_OUTPUT_VSCODE_AGENT_BRIDGE_E2E";
const TASK_MARKER = "TASK_OUTPUT_VSCODE_AGENT_BRIDGE_E2E";
const VISIBLE_OUTPUT_MARKER = "VISIBLE_OUTPUT_VSCODE_AGENT_BRIDGE_E2E";
const DEBUG_OUTPUT_MARKER = "DEBUG_OUTPUT_VSCODE_AGENT_BRIDGE_E2E";
const execFileAsync = promisify(execFile);
const requestedScenarios = resolveRequestedScenarios();
const actualScenarios = new Set<E2EScenario>();

suite("VS Code Agent Bridge Extension Host", function () {
  this.timeout(150_000);

  test("runs selected IDE workflow scenarios", async () => {
    if (!(await isPrimaryTestWindow())) {
      return;
    }
    const primaryRequested = requestedScenarios.filter((scenario) => scenario !== "managed-worktree");
    if (primaryRequested.length === 0) {
      await writePrimaryCompletionMarker("workspace-restored");
      return;
    }
    const extension = vscode.extensions.all.find(
      (candidate) => candidate.id.toLowerCase() === "alicelin.vscode-agent-bridge",
    );
    assert.ok(extension, "the extension under development should be installed");
    const bridgeConfiguration = vscode.workspace.getConfiguration("vscodeAgentBridge");
    const previousGlobalConfiguration = captureGlobalConfiguration(bridgeConfiguration, [
      "enabled",
      "executionMode",
      "enableAcceptanceFixtures",
    ]);
    await bridgeConfiguration.update("enabled", true, vscode.ConfigurationTarget.Global);
    await bridgeConfiguration.update("executionMode", "explicit", vscode.ConfigurationTarget.Global);
    if (process.env.VSCODE_AGENT_BRIDGE_EXPECT_PACKAGED === "1") {
      const extensionsDirectory = process.env.VSCODE_AGENT_BRIDGE_E2E_EXTENSIONS_DIR;
      assert.ok(extensionsDirectory);
      assert.equal(isPathWithin(extensionsDirectory, extension.extensionPath), true);
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

    const descriptor = await waitForDescriptor("ready");
    await assertAuthenticationBoundary(descriptor);
    const client = await BridgeRpcClient.connect(descriptor.transport.endpoint);
    try {
      await client.request(BRIDGE_METHODS.initialize, {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        authToken: descriptor.authToken,
        client: { name: "extension-host-e2e", version: BRIDGE_RELEASE_VERSION },
      });

      if (isScenarioRequested("lifecycle")) {
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
        actualScenarios.add("lifecycle");
      }

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
      actualScenarios.add("core-language");

      if (isScenarioRequested("extension-ecosystem")) {
        await exerciseExtensionAwareness(client, workspaceFolder.uri);
        actualScenarios.add("extension-ecosystem");
      }

      const experimentOptions = {
        experimentResource: isScenarioRequested("experiment-resource"),
        taskTerminal: isScenarioRequested("task-terminal"),
        debug: isScenarioRequested("debug"),
        extensionEcosystem: isScenarioRequested("extension-ecosystem"),
      };
      if (Object.values(experimentOptions).some(Boolean)) {
        console.log("[e2e] selected experiment workflow starting");
        await exerciseExperimentWorkflow(client, descriptor, workspaceFolder.uri, document, experimentOptions);
        console.log("[e2e] selected experiment workflow completed");
        if (experimentOptions.experimentResource) actualScenarios.add("experiment-resource");
        if (experimentOptions.debug) actualScenarios.add("debug");
      }
      if (experimentOptions.taskTerminal) {
        await exerciseTerminalObservation(client);
        actualScenarios.add("task-terminal");
        console.log("[e2e] selected terminal workflow completed");
      }

      const plainDocument = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(workspaceFolder.uri, ".gitignore"),
      );
      await vscode.window.showTextDocument(plainDocument, { preview: false });
      console.log("[v0.7-e2e] no-provider document opened");
      const noDefinitions = await client.request<{ locations: unknown[] }>(
        BRIDGE_METHODS.getDefinitions,
        {
          uri: plainDocument.uri.toString(true),
          position: { line: 0, character: 0 },
          limit: 20,
        },
      );
      assert.deepEqual(noDefinitions.locations, []);
      console.log("[v0.7-e2e] no-provider request completed");

      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      console.log("[v0.7-e2e] editors closed");
      await assert.rejects(
        () => client.request(BRIDGE_METHODS.readDocument, {}),
        (error: unknown) => error instanceof BridgeRpcError && error.bridgeCode === "NO_ACTIVE_EDITOR",
      );
      console.log("[v0.7-e2e] no-active-editor rejection completed");
      if (isScenarioRequested("master-switch")) {
        console.log("[e2e] master switch workflow starting");
        await exerciseMasterSwitch(client);
        actualScenarios.add("master-switch");
        console.log("[e2e] master switch workflow completed");
      }
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
      await execGit(workspaceFolder.uri.fsPath, [
        "clean",
        "-fd",
        "--",
        ".vscode",
        "task-output.txt",
        "resource-created-e2e.txt",
        "resource-accepted-e2e.txt",
      ]);
      client.close();
      await restoreGlobalConfiguration(bridgeConfiguration, previousGlobalConfiguration);
    }
    await writePrimaryCompletionMarker("workspace-restored");
  });

  test("isolates ten private commits and promotes one target commit", async () => {
    if (!isScenarioRequested("managed-worktree")) {
      return;
    }
    if (!(await isPrimaryTestWindow())) {
      await waitForManagedCompletionMarker();
      return;
    }
    const extension = vscode.extensions.getExtension("AliceLin.vscode-agent-bridge");
    assert.ok(extension);
    const bridgeConfiguration = vscode.workspace.getConfiguration("vscodeAgentBridge");
    const previousGlobalConfiguration = captureGlobalConfiguration(bridgeConfiguration, ["enabled"]);
    try {
      await bridgeConfiguration.update("enabled", true, vscode.ConfigurationTarget.Global);
      await extension.activate();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    for (const dirtyDocument of vscode.workspace.textDocuments.filter(
      (candidate) =>
        candidate.isDirty &&
        candidate.uri.scheme === "file" &&
        isPathWithin(workspaceFolder.uri.fsPath, candidate.uri.fsPath),
    )) {
      await dirtyDocument.save();
    }
    await execGit(workspaceFolder.uri.fsPath, ["restore", "--staged", "--worktree", "--", "."]);
    await execGit(workspaceFolder.uri.fsPath, [
      "clean",
      "-fd",
      "--",
      ".vscode",
      "task-output.txt",
      "resource-created-e2e.txt",
      "resource-accepted-e2e.txt",
    ]);
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
    let managedCompleted = false;
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
      managedCompleted = true;
    } finally {
      worktreeClient.close();
    }
    if (managedCompleted) {
      const registryDirectory = process.env.VSCODE_AGENT_BRIDGE_REGISTRY_DIR;
      assert.ok(registryDirectory);
      await writeFile(
        path.join(registryDirectory, "managed-e2e-passed.json"),
        `${JSON.stringify({
          privateCommitCount: 10,
          promotedCommitCount: 1,
          treeMatches: true,
          scenario: "managed-worktree",
          cleanupStatus: "client-closed",
        })}\n`,
        "utf8",
      );
    }
    } finally {
      await restoreGlobalConfiguration(bridgeConfiguration, previousGlobalConfiguration);
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
  options: {
    experimentResource: boolean;
    taskTerminal: boolean;
    debug: boolean;
    extensionEcosystem: boolean;
  },
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
  if (options.extensionEcosystem) {
    await exerciseExtensionProfileConfiguration(client, active.sessionId, workspaceUri);
  }
  const acceptedResourceUri = await exerciseWorkspaceWorkflows(
    client,
    active.sessionId,
    workspaceUri,
    options,
  );
  console.log("[e2e] selected workspace workflows completed");

  if (!options.experimentResource) {
    return;
  }
  assert.ok(acceptedResourceUri);

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
  const acceptedResourceText = await readFile(acceptedResourceUri.fsPath, "utf8");
  const preparedDelete = await client.request<PreparedChangeSet>(
    BRIDGE_METHODS.prepareResourceChanges,
    {
      sessionId: active.sessionId,
      title: "Delete accepted resource temporarily",
      rationale: "Verify v2 resource recovery writes the accepted structure back to disk",
      operations: [
        {
          operation: "delete",
          uri: acceptedResourceUri.toString(true),
          kind: "file",
          expectedSha256: createHash("sha256").update(acceptedResourceText).digest("hex"),
          recursive: false,
        },
      ],
    },
  );
  await client.request(BRIDGE_METHODS.applyChangeSet, {
    sessionId: active.sessionId,
    changeSetId: preparedDelete.changeSetId,
  });
  await assert.rejects(() => readFile(acceptedResourceUri.fsPath, "utf8"));
  const bridgeEditor = await vscode.window.showTextDocument(document, { preview: false });
  assert.equal(
    await bridgeEditor.edit((builder) =>
      builder.insert(new vscode.Position(0, 0), "// temporary\n"),
    ),
    true,
  );
  console.log("[v0.7-e2e] accepted resource restore starting");
  await vscode.commands.executeCommand("vscodeAgentBridge.e2eRestoreAccepted");
  console.log("[v0.7-e2e] accepted resource restore completed");
  assert.ok(!document.getText().includes("// temporary"));
  assert.ok(document.getText().includes("renamedBridgeGreeting"));
  assert.equal(document.isDirty, false, "v2 resource restore must save restored documents to disk");
  assert.equal(await readFile(acceptedResourceUri.fsPath, "utf8"), acceptedResourceText);

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
  console.log("[v0.7-e2e] experiment finalize starting");
  await vscode.commands.executeCommand("vscodeAgentBridge.e2eFinalizeExperiment");
  console.log("[v0.7-e2e] experiment finalize completed");
  assert.equal(await readGitHead(workspaceUri.fsPath), initialHead, "v0.3 must not create Git commits");
  await assert.rejects(
    () => client.request(BRIDGE_METHODS.getExperiment, {}),
    (error: unknown) =>
      error instanceof BridgeRpcError && error.bridgeCode === "NO_ACTIVE_EXPERIMENT",
  );
}

async function exerciseExtensionProfileConfiguration(
  client: BridgeRpcClient,
  sessionId: string,
  workspaceUri: vscode.Uri,
): Promise<void> {
  const extensionId = "AliceLin.vscode-agent-bridge";
  const key = "vscodeAgentBridge.enableAcceptanceFixtures";
  const rootUri = workspaceUri.toString(true);
  const before = await client.request<ExtensionConfigurationResult>(
    BRIDGE_METHODS.getExtensionConfiguration,
    { extensionId, key, target: "global", rootUri },
  );
  assert.equal(before.sensitive, false);
  const changed = await client.request<{
    changed: boolean;
    globalChangeId: string | null;
    recoverability: string;
  }>(BRIDGE_METHODS.updateExtensionConfiguration, {
    sessionId,
    rootUri,
    extensionId,
    key,
    target: "global",
    expectedValueSha256: before.targetValueSha256,
    newValue: true,
    reason: "Exercise a declared current-Profile setting update",
  });
  assert.equal(changed.changed, true);
  assert.ok(changed.globalChangeId);
  assert.equal(changed.recoverability, "globalJournal");
  await assert.rejects(
    () => client.request(BRIDGE_METHODS.updateExtensionConfiguration, {
      sessionId,
      rootUri,
      extensionId,
      key,
      target: "global",
      expectedValueSha256: before.targetValueSha256,
      newValue: false,
      reason: "Reject a stale Profile setting update",
    }),
    isBridgeError("EXTENSION_CONFIGURATION_STALE"),
  );
  assert.equal(
    await vscode.commands.executeCommand<boolean>("vscodeAgentBridge.e2eUndoLastProfileChange"),
    true,
  );
  const restored = await client.request<ExtensionConfigurationResult>(
    BRIDGE_METHODS.getExtensionConfiguration,
    { extensionId, key, target: "global", rootUri },
  );
  assert.equal(restored.targetValueSha256, before.targetValueSha256);
}

async function exerciseTerminalObservation(client: BridgeRpcClient): Promise<void> {
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

  } finally {
    terminal.dispose();
  }
}

async function exerciseWorkspaceWorkflows(
  client: BridgeRpcClient,
  sessionId: string,
  workspaceUri: vscode.Uri,
  options: {
    experimentResource: boolean;
    taskTerminal: boolean;
    debug: boolean;
  },
): Promise<vscode.Uri | null> {
  const rootUri = workspaceUri.toString(true);
  if (options.experimentResource) {
    const settings = await client.request<{
      exists: boolean;
      contentSha256: string | null;
    }>(BRIDGE_METHODS.getWorkspaceConfiguration, { rootUri, target: "settings" });
    assert.equal(settings.exists, true);
    const settingsUpdate = await client.request<{ saved: boolean; deferredEffects: boolean }>(
      BRIDGE_METHODS.updateWorkspaceConfiguration,
      {
        sessionId,
        rootUri,
        target: "settings",
        expectedExists: true,
        expectedSha256: settings.contentSha256,
        operations: [{ operation: "add", path: "/vscodeAgentBridge.e2eMarker", value: true }],
        reason: "Verify comment-preserving JSONC workspace settings updates",
      },
    );
    assert.equal(settingsUpdate.saved, true);
    assert.equal(settingsUpdate.deferredEffects, false);
  }

  if (options.taskTerminal) {
    const missingTasks = await client.request<{ exists: boolean; contentSha256: string | null }>(
      BRIDGE_METHODS.getWorkspaceConfiguration,
      { rootUri, target: "tasks" },
    );
    assert.equal(missingTasks.exists, false);
    await assert.rejects(() => client.request(BRIDGE_METHODS.updateWorkspaceConfiguration, {
      sessionId,
      rootUri,
      target: "tasks",
      expectedExists: false,
      expectedSha256: null,
      operations: [{ operation: "add", path: "/tasks", value: [] }],
      reason: "Generic configuration must not author executable Task definitions",
    }));

    const taskLabel = "Bridge explicit E2E test";
    const prepared = await client.request<{
      preparedTaskId: string;
      task: { taskId: string; fingerprint: string; label: string; origin: string };
      execution: { command: string; args: string[]; cwd: string; envKeys: string[] };
    }>(BRIDGE_METHODS.prepareTask, {
      sessionId,
      rootUri,
      label: taskLabel,
      execution: {
        kind: "process",
        process: "powershell.exe",
        args: [
          "-NoProfile",
          "-Command",
          `Write-Output '${TASK_MARKER}'; Set-Content -LiteralPath task-output.txt -Value '${TASK_MARKER}'`,
        ],
        options: { cwd: ".", env: { BRIDGE_E2E_ENV: "ENV_VALUE_MUST_NOT_BE_RECORDED" } },
      },
      group: "test",
      isBackground: false,
      problemMatchers: [],
      detail: "Visible temporary E2E Task",
      reason: "Prepare an IDE-visible Process Task",
    });
    assert.equal(prepared.task.origin, "agentPrepared");
    assert.equal(prepared.execution.command, "powershell.exe");
    assert.deepEqual(prepared.execution.envKeys, ["BRIDGE_E2E_ENV"]);
    const task = prepared.task;
    const started = await client.request<{ execution: { executionId: string } }>(BRIDGE_METHODS.runTask, {
    sessionId,
    rootUri,
    taskId: task.taskId,
    expectedFingerprint: task.fingerprint,
    reason: "Run the explicitly listed test Task",
  });
    const finished = await waitFor(async () => {
      const result = await client.request<{
        executions: Array<{ executionId: string; status: string; exitCode: number | null; checkpointId: string | null }>;
      }>(BRIDGE_METHODS.listTaskExecutions, { rootUri, activeOnly: false, offset: 0, limit: 50 });
      return result.executions.find(
        (execution) => execution.executionId === started.execution.executionId && execution.status === "exited" && execution.checkpointId,
      );
    }, "completed VS Code Agent Task with checkpoint", 30_000);
    assert.equal(finished.exitCode, 0);
    assert.equal((await readFile(vscode.Uri.joinPath(workspaceUri, "task-output.txt").fsPath, "utf8")).trim(), TASK_MARKER);

    await client.request(BRIDGE_METHODS.persistTask, {
      sessionId,
      rootUri,
      preparedTaskId: prepared.preparedTaskId,
      expectedExists: false,
      expectedSha256: null,
      reason: "Persist the prepared Task with an exact tasks.json precondition",
    });
    await waitFor(async () => {
      const result = await client.request<{
        tasks: Array<{ taskId: string; fingerprint: string; label: string; origin: string }>;
      }>(BRIDGE_METHODS.listTasks, { rootUri, group: "test", offset: 0, limit: 50 });
      return result.tasks.some((candidate) => candidate.label === taskLabel && candidate.origin === "agentPersisted")
        ? result
        : undefined;
    }, "persisted VS Code Agent Task");
  }

  if (options.debug) {
    await exerciseDebugWorkflow(client, sessionId, workspaceUri);
  }

  if (!options.experimentResource) {
    return null;
  }
  const createdUri = vscode.Uri.joinPath(workspaceUri, "resource-created-e2e.txt");
  const acceptedUri = vscode.Uri.joinPath(workspaceUri, "resource-accepted-e2e.txt");
  const resourceText = "recoverable resource E2E\n";
  const preparedCreate = await client.request<PreparedChangeSet>(BRIDGE_METHODS.prepareResourceChanges, {
    sessionId,
    title: "Create recoverable text resource",
    operations: [{ operation: "create", uri: createdUri.toString(true), kind: "file", content: resourceText }],
  });
  await client.request(BRIDGE_METHODS.applyChangeSet, { sessionId, changeSetId: preparedCreate.changeSetId });
  const preparedRename = await client.request<PreparedChangeSet>(BRIDGE_METHODS.prepareResourceChanges, {
    sessionId,
    title: "Rename recoverable text resource",
    operations: [{
      operation: "rename",
      uri: createdUri.toString(true),
      targetUri: acceptedUri.toString(true),
      kind: "file",
      expectedSha256: createHash("sha256").update(resourceText).digest("hex"),
    }],
  });
  await client.request(BRIDGE_METHODS.applyChangeSet, { sessionId, changeSetId: preparedRename.changeSetId });
  assert.equal(await readFile(acceptedUri.fsPath, "utf8"), resourceText);
  return acceptedUri;
}

async function exerciseDebugWorkflow(
  client: BridgeRpcClient,
  sessionId: string,
  workspaceUri: vscode.Uri,
): Promise<void> {
  const rootUri = workspaceUri.toString(true);
  const launch = await client.request<{ exists: boolean; contentSha256: string | null }>(
    BRIDGE_METHODS.getWorkspaceConfiguration,
    { rootUri, target: "launch" },
  );
  assert.equal(launch.exists, false);
  const configurationName = "Bridge inline E2E debug";
  const prepared = await client.request<{
    preparedConfigurationId: string;
    configuration: { configurationId: string; name: string; fingerprint: string; origin: string };
    execution: { type: string; request: string; envKeys: string[] };
  }>(BRIDGE_METHODS.prepareDebugConfiguration, {
    sessionId,
    rootUri,
    configuration: {
      name: configurationName,
      type: "vscode-agent-bridge-e2e",
      request: "launch",
      env: { BRIDGE_DEBUG_E2E: "DEBUG_ENV_VALUE_MUST_NOT_BE_RECORDED" },
    },
    reason: "Prepare an inline E2E adapter configuration",
  });
  assert.equal(prepared.configuration.origin, "agentPrepared");
  assert.deepEqual(prepared.execution.envKeys, ["BRIDGE_DEBUG_E2E"]);
  const selected = prepared.configuration;

  const listedBreakpoints = await client.request<{ revision: string }>(
    BRIDGE_METHODS.listBreakpoints,
    { rootUri },
  );
  const updatedBreakpoints = await client.request<{ breakpoints: unknown[] }>(
    BRIDGE_METHODS.updateBreakpoints,
    {
      sessionId,
      rootUri,
      expectedRevision: listedBreakpoints.revision,
      breakpoints: [
        {
          kind: "source",
          uri: vscode.Uri.joinPath(workspaceUri, "bridge.ts").toString(true),
          line: 0,
          character: 0,
          enabled: true,
          condition: null,
          hitCondition: null,
          logMessage: null,
        },
        {
          kind: "function",
          functionName: "bridgeGreeting",
          enabled: true,
          condition: null,
          hitCondition: null,
          logMessage: null,
        },
      ],
      reason: "Exercise bounded source and function breakpoint replacement",
    },
  );
  assert.equal(updatedBreakpoints.breakpoints.length, 2);

  await client.request(BRIDGE_METHODS.startDebugSession, {
    sessionId,
    rootUri,
    configurationId: selected.configurationId,
    expectedFingerprint: selected.fingerprint,
    reason: "Start the selected prepared E2E Debug configuration",
  });
  const debugSession = await waitFor(async () => {
    const result = await client.request<{
      sessions: Array<{ debugSessionId: string; status: string; name: string }>;
    }>(BRIDGE_METHODS.listDebugSessions, { rootUri, includeTerminated: false });
    return result.sessions.find(
      (candidate) => candidate.name === configurationName && candidate.status === "stopped",
    );
  }, "stopped inline E2E debug session");

  const debugOutput = await waitFor(async () => {
    const listed = await client.request<{
      sessions: Array<{ debugSessionId: string; coverage: string; eventCount: number }>;
    }>(BRIDGE_METHODS.listDebugOutput, {
      rootUri,
      includeTerminated: true,
      offset: 0,
      limit: 50,
    });
    const captured = listed.sessions.find(
      (candidate) => candidate.debugSessionId === debugSession.debugSessionId && candidate.eventCount > 0,
    );
    if (!captured) return undefined;
    return client.request<{
      events: Array<{ text: string; category: string; sourcePath: string | null }>;
      coverage: string;
    }>(BRIDGE_METHODS.readDebugOutput, {
      debugSessionId: debugSession.debugSessionId,
      cursor: 0,
      maxChars: 65_536,
    });
  }, "captured Debug Console output");
  assert.equal(debugOutput.coverage, "sinceActivation");
  assert.match(debugOutput.events.map((event) => event.text).join(""), new RegExp(DEBUG_OUTPUT_MARKER));
  assert.ok(debugOutput.events.some((event) => event.sourcePath === "bridge.ts"));
  assert.ok(!JSON.stringify(debugOutput).includes("TELEMETRY_MUST_NOT_BE_CAPTURED"));
  assert.ok(!JSON.stringify(debugOutput).includes("\u001b"));

  const threads = await client.request<{ threads: Array<{ id: number }> }>(
    BRIDGE_METHODS.getDebugState,
    { debugSessionId: debugSession.debugSessionId, query: "threads", offset: 0, limit: 20 },
  );
  assert.equal(threads.threads[0]?.id, 1);
  const stack = await client.request<{ stackFrames: Array<{ id: number; sourceUri: string | null }> }>(
    BRIDGE_METHODS.getDebugState,
    { debugSessionId: debugSession.debugSessionId, query: "stackTrace", threadId: 1, offset: 0, limit: 20 },
  );
  assert.ok(stack.stackFrames[0]?.sourceUri?.endsWith("bridge.ts"));
  const frameId = stack.stackFrames[0]!.id;
  const scopes = await client.request<{ scopes: Array<{ variablesReference: number }> }>(
    BRIDGE_METHODS.getDebugState,
    { debugSessionId: debugSession.debugSessionId, query: "scopes", frameId, offset: 0, limit: 20 },
  );
  const variablesReference = scopes.scopes[0]!.variablesReference;
  const variables = await client.request<{ variables: Array<{ name: string; value: string }> }>(
    BRIDGE_METHODS.getDebugState,
    { debugSessionId: debugSession.debugSessionId, query: "variables", variablesReference, offset: 0, limit: 20 },
  );
  assert.deepEqual(variables.variables[0], { name: "counter", value: "1", type: "number", evaluateName: "counter", variablesReference: 0, namedVariables: null, indexedVariables: null });
  const evaluated = await client.request<{ result: string }>(BRIDGE_METHODS.evaluateDebugExpression, {
    sessionId,
    debugSessionId: debugSession.debugSessionId,
    frameId,
    context: "watch",
    expression: "counter",
    reason: "Evaluate a bounded expression without persisting it",
  });
  assert.equal(evaluated.result, "1");
  const set = await client.request<{ value: string }>(BRIDGE_METHODS.setDebugVariable, {
    sessionId,
    debugSessionId: debugSession.debugSessionId,
    variablesReference,
    name: "counter",
    value: "7",
    reason: "Exercise fixed setVariable routing",
  });
  assert.equal(set.value, "7");

  await client.request(BRIDGE_METHODS.controlDebugSession, {
    sessionId,
    debugSessionId: debugSession.debugSessionId,
    action: "continue",
    threadId: 1,
    reason: "Continue through the fixed DAP whitelist",
  });
  await assert.rejects(
    () => client.request(BRIDGE_METHODS.getDebugState, {
      debugSessionId: debugSession.debugSessionId,
      query: "scopes",
      frameId,
      offset: 0,
      limit: 20,
    }),
    isBridgeError("DEBUG_STATE_STALE"),
  );
  await waitFor(async () => {
    const result = await client.request<{ sessions: Array<{ debugSessionId: string; status: string }> }>(
      BRIDGE_METHODS.listDebugSessions,
      { rootUri, includeTerminated: false },
    );
    return result.sessions.some(
      (candidate) => candidate.debugSessionId === debugSession.debugSessionId && candidate.status === "stopped",
    ) ? true : undefined;
  }, "debug session stopped after continue");
  await client.request(BRIDGE_METHODS.controlDebugSession, {
    sessionId,
    debugSessionId: debugSession.debugSessionId,
    action: "terminate",
    reason: "Terminate the bounded E2E debug session",
  });
  await waitFor(async () => {
    const result = await client.request<{ sessions: Array<{ debugSessionId: string; status: string }> }>(
      BRIDGE_METHODS.listDebugSessions,
      { rootUri, includeTerminated: true },
    );
    return result.sessions.some(
      (candidate) => candidate.debugSessionId === debugSession.debugSessionId && candidate.status === "terminated",
    ) ? true : undefined;
  }, "terminated inline E2E debug session");

  await client.request(BRIDGE_METHODS.persistDebugConfiguration, {
    sessionId,
    rootUri,
    preparedConfigurationId: prepared.preparedConfigurationId,
    expectedExists: false,
    expectedSha256: null,
    reason: "Persist the prepared E2E Debug configuration with an exact launch.json precondition",
  });
  await waitFor(async () => {
    const result = await client.request<{
      configurations: Array<{ name: string; origin: string }>;
      parseErrors: string[];
    }>(BRIDGE_METHODS.listDebugConfigurations, { rootUri });
    assert.deepEqual(result.parseErrors, []);
    return result.configurations.some((candidate) => candidate.name === configurationName && candidate.origin === "agentPersisted")
      ? result
      : undefined;
  }, "persisted E2E Debug configuration");
}

async function exerciseExtensionAwareness(
  client: BridgeRpcClient,
  workspaceUri: vscode.Uri,
): Promise<void> {
  const extensions = await client.request<{
    extensions: Array<{ extensionId: string; active: boolean }>;
    totalCount: number;
  }>(BRIDGE_METHODS.listExtensions, { offset: 0, limit: 1_000 });
  assert.ok(extensions.totalCount > 0);
  assert.ok(
    extensions.extensions.some(
      (extension) =>
        extension.extensionId.toLowerCase() === "alicelin.vscode-agent-bridge" && extension.active,
    ),
  );
  const inactive = extensions.extensions.find((extension) => !extension.active);
  if (inactive) {
    assert.equal(vscode.extensions.getExtension(inactive.extensionId)?.isActive, false);
    await client.request(BRIDGE_METHODS.getExtensionDetails, {
      extensionId: inactive.extensionId,
    });
    assert.equal(vscode.extensions.getExtension(inactive.extensionId)?.isActive, false);
  }
  const details = await client.request<{
    extension: { extensionId: string; active: boolean };
    commands: Array<{ command: string }>;
    activatedByRequest: boolean;
  }>(BRIDGE_METHODS.getExtensionDetails, { extensionId: "AliceLin.vscode-agent-bridge" });
  assert.equal(details.extension.active, true);
  assert.equal(details.activatedByRequest, false);
  assert.ok(details.commands.some((command) => command.command === "vscodeAgentBridge.runDoctor"));

  const configuration = await client.request<{
    properties: Array<{ key: string }>;
  }>(BRIDGE_METHODS.getExtensionConfigurationSchema, {
    extensionId: "AliceLin.vscode-agent-bridge",
    offset: 0,
    limit: 1_000,
  });
  assert.ok(configuration.properties.some((property) => property.key === "vscodeAgentBridge.enabled"));

  const profile = await client.request<{
    profileName: string | null;
    stableApiCoverage: string;
    privateProfileDataAccessed: boolean;
  }>(BRIDGE_METHODS.getProfileContext, {});
  assert.equal(profile.profileName, null);
  assert.equal(profile.stableApiCoverage, "unavailable");
  assert.equal(profile.privateProfileDataAccessed, false);

  const pythonExtensionBefore = vscode.extensions.getExtension("ms-python.python");
  const pythonWasActive = pythonExtensionBefore?.isActive ?? false;
  const integrations = await client.request<{
    integrations: Array<{
      integrationId: string;
      extensionId: string;
      installed: boolean;
      availability: string;
      activationPolicy: string;
    }>;
    returnedCount: number;
    totalCount: number;
  }>(BRIDGE_METHODS.listExtensionIntegrations, { offset: 0, limit: 20 });
  assert.equal(integrations.returnedCount, 1);
  assert.equal(integrations.totalCount, 1);
  assert.deepEqual(
    integrations.integrations.map((integration) => integration.integrationId),
    ["python.environment"],
  );
  assert.equal(integrations.integrations[0]?.extensionId, "ms-python.python");
  assert.equal(integrations.integrations[0]?.activationPolicy, "onStateRequest");
  assert.equal(vscode.extensions.getExtension("ms-python.python")?.isActive ?? false, pythonWasActive);
  if (!pythonExtensionBefore) {
    const state = await client.request<{
      status: string;
      reason: string | null;
      activatedByRequest: boolean;
      environment: unknown;
    }>(BRIDGE_METHODS.getExtensionIntegrationState, {
      integrationId: "python.environment",
      rootUri: workspaceUri.toString(true),
    });
    assert.equal(state.status, "unavailable");
    assert.equal(state.reason, "notInstalled");
    assert.equal(state.activatedByRequest, false);
    assert.equal(state.environment, null);
  } else if (integrations.integrations[0]?.availability === "versionUnsupported") {
    await assert.rejects(
      () => client.request(BRIDGE_METHODS.getExtensionIntegrationState, {
        integrationId: "python.environment",
        rootUri: workspaceUri.toString(true),
      }),
      isBridgeError("EXTENSION_VERSION_UNSUPPORTED"),
    );
  }

  const diagnosticEvents = await waitFor(async () => {
    const result = await client.request<{
      events: Array<{ uri: string; currentCount: number }>;
      coverage: string;
    }>(BRIDGE_METHODS.listDiagnosticEvents, {
      rootUri: workspaceUri.toString(true),
      afterCursor: 0,
      limit: 200,
    });
    return result.events.some((event) => event.currentCount > 0) ? result : undefined;
  }, "diagnostic event capture");
  assert.equal(diagnosticEvents.coverage, "sinceActivation");

  const output = vscode.window.createOutputChannel("VS Code Agent Bridge visible E2E output");
  let visibleSourceId: string | undefined;
  try {
    output.appendLine(VISIBLE_OUTPUT_MARKER);
    output.show(true);
    const visible = await waitFor(async () => {
      const result = await client.request<{
        sources: Array<{ sourceId: string; label: string; canReadNow: boolean; coverage: string }>;
      }>(BRIDGE_METHODS.listOutputSources, {
        rootUri: workspaceUri.toString(true),
        offset: 0,
        limit: 1_000,
      });
      for (const source of result.sources.filter(
        (candidate) => candidate.canReadNow && candidate.coverage === "visible",
      )) {
        const page = await client.request<{ text: string; coverage: string }>(
          BRIDGE_METHODS.readVisibleOutput,
          { sourceId: source.sourceId, cursor: 0, maxChars: 65_536 },
        );
        if (page.text.includes(VISIBLE_OUTPUT_MARKER)) {
          visibleSourceId = source.sourceId;
          return page;
        }
      }
      return undefined;
    }, "visible Output document discovery");
    assert.match(visible.text, new RegExp(VISIBLE_OUTPUT_MARKER));
    assert.equal(visible.coverage, "visible");
  } finally {
    output.dispose();
  }
  if (visibleSourceId) {
    await waitFor(async () => {
      try {
        await client.request(BRIDGE_METHODS.readVisibleOutput, {
          sourceId: visibleSourceId,
          cursor: 0,
          maxChars: 65_536,
        });
        return undefined;
      } catch (error) {
        return isBridgeError("OUTPUT_NOT_VISIBLE")(error) ? true : undefined;
      }
    }, "closed Output document refusal");
  }
}

async function exerciseMasterSwitch(client: BridgeRpcClient): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("vscodeAgentBridge");
  const before = (await listDescriptors()).length;
  assert.ok(before >= 1);
  await configuration.update("enabled", false, vscode.ConfigurationTarget.Global);
  console.log("[v0.7-e2e] master switch disabled setting written");
  await waitFor(async () => (await listDescriptors()).length === 0 ? true : undefined, "bridge descriptor removal");
  console.log("[v0.7-e2e] master switch descriptor removed");
  await assert.rejects(() => client.request(BRIDGE_METHODS.getEditorContext, {}));
  console.log("[v0.7-e2e] master switch old connection rejected");
  await configuration.update("enabled", true, vscode.ConfigurationTarget.Global);
  console.log("[v0.7-e2e] master switch enabled setting written");
  const descriptor = await waitForDescriptor("ready");
  console.log("[v0.7-e2e] master switch descriptor restored");
  const reconnected = await BridgeRpcClient.connect(descriptor.transport.endpoint);
  try {
    await reconnected.request(BRIDGE_METHODS.initialize, {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      authToken: descriptor.authToken,
      client: { name: "master-switch-e2e", version: BRIDGE_RELEASE_VERSION },
    });
    await reconnected.request(BRIDGE_METHODS.getEditorContext, {});
  } finally {
    reconnected.close();
  }
}

async function writePrimaryCompletionMarker(cleanupStatus: "workspace-restored"): Promise<void> {
  const registryDirectory = process.env.VSCODE_AGENT_BRIDGE_REGISTRY_DIR;
  assert.ok(registryDirectory, "the E2E registry directory must be configured");
  await writeFile(
    path.join(registryDirectory, "primary-e2e-passed.json"),
    `${JSON.stringify({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      toolCount: MCP_TOOL_NAMES.length,
      requestedScenarios,
      actualScenarios: [...actualScenarios],
      cleanupStatus,
    })}\n`,
    "utf8",
  );
}

function resolveRequestedScenarios(): E2EScenario[] {
  const configured = process.env.VSCODE_AGENT_BRIDGE_E2E_SCENARIOS ?? "full";
  const values = configured.split(",").filter(Boolean);
  if (values.includes("full")) {
    assert.equal(values.length, 1, "full cannot be combined with individual E2E scenarios");
    return [...E2E_SCENARIOS];
  }
  for (const value of values) {
    assert.ok(E2E_SCENARIOS.includes(value as E2EScenario), `unknown E2E scenario: ${value}`);
  }
  return [...new Set(values as E2EScenario[])];
}

function isScenarioRequested(scenario: E2EScenario): boolean {
  return requestedScenarios.includes(scenario);
}

function captureGlobalConfiguration(
  configuration: vscode.WorkspaceConfiguration,
  keys: readonly string[],
): Map<string, unknown> {
  return new Map(keys.map((key) => [key, configuration.inspect(key)?.globalValue]));
}

async function restoreGlobalConfiguration(
  configuration: vscode.WorkspaceConfiguration,
  snapshot: ReadonlyMap<string, unknown>,
): Promise<void> {
  for (const [key, value] of snapshot) {
    await configuration.update(key, value, vscode.ConfigurationTarget.Global);
  }
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

async function listDescriptors(): Promise<InstanceDescriptor[]> {
  const instancesDirectory = resolveRegistryDirectories().instances;
  const descriptors: InstanceDescriptor[] = [];
  for (const name of (await readdir(instancesDirectory).catch(() => [])).filter((candidate) => candidate.endsWith(".json"))) {
    try {
      const parsed = InstanceDescriptorSchema.safeParse(
        JSON.parse(await readFile(path.join(instancesDirectory, name), "utf8")),
      );
      if (parsed.success) descriptors.push(parsed.data);
    } catch {
      // Concurrent descriptor replacement is retried by the caller.
    }
  }
  return descriptors;
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
    if (this.#socket.destroyed) {
      return Promise.reject(new Error("Bridge socket is already closed."));
    }
    const id = this.#nextRequestId++;
    const result = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
    this.#socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      (error) => {
        if (!error) {
          return;
        }
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        pending?.reject(error);
      },
    );
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
