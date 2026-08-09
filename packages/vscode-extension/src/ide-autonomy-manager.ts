import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import {
  BridgeError,
  CODE_ACTION_TTL_MS,
  type ApplyCodeActionParams,
  type ApplyCodeActionResult,
  type FormatDocumentParams,
  type FormatDocumentResult,
  type ListCodeActionsParams,
  type ListCodeActionsResult,
  type SaveDocumentParams,
  type SaveDocumentResult,
} from "@vscode-agent-bridge/protocol";

import {
  ChangeSetManager,
  assertExpectedDocument,
  parseSupportedUri,
  resolveExistingDocument,
  sha256,
  toBridgeRange,
  validateRange,
} from "./change-set-manager.js";
import { ExperimentManager } from "./experiment-manager.js";
import { toDiagnosticItem } from "./language-services.js";
import { assertAgentWriteAllowed } from "./policies.js";

interface CodeActionGuard {
  readonly uri: vscode.Uri;
  readonly expectedVersion: number;
  readonly expectedSha256: string;
}

interface CodeActionHandle {
  readonly actionId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly changeSetId: string | null;
  readonly unsupportedReason: string | null;
  readonly expiresAt: number;
  readonly guard: CodeActionGuard;
  state: "available" | "applied";
}

export class IdeAutonomyManager {
  readonly #instanceId: string;
  readonly #experiments: ExperimentManager;
  readonly #changeSets: ChangeSetManager;
  readonly #actions = new Map<string, CodeActionHandle>();

  constructor(
    instanceId: string,
    experiments: ExperimentManager,
    changeSets: ChangeSetManager,
  ) {
    this.#instanceId = instanceId;
    this.#experiments = experiments;
    this.#changeSets = changeSets;
  }

  async saveDocument(params: SaveDocumentParams): Promise<SaveDocumentResult> {
    assertAgentWriteAllowed();
    const experiment = await this.#assertSession(params.sessionId);
    const uri = parseSupportedUri(params.uri, experiment.rootUri);
    if (uri.scheme !== "file") {
      throw new BridgeError(
        "UNSUPPORTED_DOCUMENT_SCHEME",
        "Only existing file documents can be saved by the Agent.",
      );
    }
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString(true) === uri.toString(true),
    );
    if (!document || document.isUntitled) {
      throw new BridgeError(
        "DOCUMENT_NOT_FOUND",
        "The document must already be open in the selected VS Code window.",
      );
    }
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      throw new BridgeError("DOCUMENT_NOT_FOUND", "The file document no longer exists.");
    }
    assertExpectedDocument(document, params.expectedSha256, params.expectedVersion);
    const beforeSha256 = sha256(document.getText());
    const saved = await this.#experiments.saveGuardedDocument(
      params.sessionId,
      document,
      params.reason,
    );
    if (!saved.saved || !saved.checkpointId) {
      throw new BridgeError("SAVE_FAILED", "VS Code could not save the guarded document.");
    }
    const contentSha256 = sha256(document.getText());
    return {
      instanceId: this.#instanceId,
      sessionId: params.sessionId,
      uri: document.uri.toString(true),
      saved: true,
      documentVersion: document.version,
      contentSha256,
      isDirty: document.isDirty,
      checkpointId: saved.checkpointId,
      savedAt: new Date().toISOString(),
      saveEffectsChangedContent: beforeSha256 !== contentSha256,
    };
  }

  async formatDocument(params: FormatDocumentParams): Promise<FormatDocumentResult> {
    assertAgentWriteAllowed();
    const experiment = await this.#assertSession(params.sessionId);
    const uri = parseSupportedUri(params.uri, experiment.rootUri);
    const document = await resolveExistingDocument(uri);
    assertExpectedDocument(document, params.expectedSha256, params.expectedVersion);
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString(true) === uri.toString(true),
    );
    const tabSize = typeof editor?.options.tabSize === "number" ? editor.options.tabSize : 4;
    const insertSpaces =
      typeof editor?.options.insertSpaces === "boolean" ? editor.options.insertSpaces : true;
    const edits =
      (await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>(
        "vscode.executeFormatDocumentProvider",
        uri,
        { tabSize, insertSpaces },
      )) ?? [];
    // The fixed VS Code command can return undefined when a formatter has no changes,
    // so the safe observable meaning is a successful no-op rather than provider absence.
    assertExpectedDocument(document, params.expectedSha256, params.expectedVersion);
    if (edits.length === 0) {
      return {
        instanceId: this.#instanceId,
        sessionId: params.sessionId,
        uri: document.uri.toString(true),
        applied: false,
        documentVersion: document.version,
        contentSha256: sha256(document.getText()),
        isDirty: document.isDirty,
        editCount: 0,
        checkpointId: null,
      };
    }
    const prepared = await this.#changeSets.prepareGeneratedTextEdits(
      params.sessionId,
      "Format document",
      params.reason,
      [
        {
          uri: document.uri.toString(true),
          expectedSha256: params.expectedSha256,
          expectedVersion: params.expectedVersion,
          edits: edits.map((edit) => ({ range: toBridgeRange(edit.range), newText: edit.newText })),
        },
      ],
    );
    const applied = await this.#changeSets.applyPrepared(
      { sessionId: params.sessionId, changeSetId: prepared.changeSetId },
      params.reason,
    );
    const result = applied.documents[0]!;
    return {
      instanceId: this.#instanceId,
      sessionId: params.sessionId,
      uri: result.uri,
      applied: true,
      documentVersion: result.documentVersion,
      contentSha256: result.contentSha256,
      isDirty: result.isDirty,
      editCount: prepared.editCount,
      checkpointId: applied.checkpointId,
    };
  }

  async listCodeActions(params: ListCodeActionsParams): Promise<ListCodeActionsResult> {
    this.#purgeOldActions();
    const experiment = await this.#assertSession(params.sessionId);
    const uri = parseSupportedUri(params.uri, experiment.rootUri);
    const document = await resolveExistingDocument(uri);
    assertExpectedDocument(document, params.expectedSha256, params.expectedVersion);
    const range = validateRange(document, params.range);
    const requestedKinds = params.kinds?.length ? params.kinds : [undefined];
    const groups = await Promise.all(
      requestedKinds.map((kind) =>
        vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command> | undefined>(
          "vscode.executeCodeActionProvider",
          uri,
          range,
          kind,
          params.limit,
        ),
      ),
    );
    assertExpectedDocument(document, params.expectedSha256, params.expectedVersion);
    const rawActions = deduplicateCodeActions(groups.flatMap((group) => group ?? []));
    const visible = rawActions.slice(0, params.limit);
    const summaries = await Promise.all(
      visible.map((candidate) =>
        this.#prepareCodeAction(candidate, params, experiment.rootUri, {
          uri,
          expectedVersion: params.expectedVersion,
          expectedSha256: params.expectedSha256,
        }),
      ),
    );
    return {
      instanceId: this.#instanceId,
      sessionId: params.sessionId,
      uri: document.uri.toString(true),
      actions: summaries,
      returnedCount: summaries.length,
      totalCount: rawActions.length,
      truncated: summaries.length < rawActions.length,
      ttlMs: CODE_ACTION_TTL_MS,
    };
  }

  async applyCodeAction(params: ApplyCodeActionParams): Promise<ApplyCodeActionResult> {
    assertAgentWriteAllowed();
    await this.#assertSession(params.sessionId);
    const handle = this.#actions.get(params.actionId);
    if (!handle || handle.sessionId !== params.sessionId) {
      throw new BridgeError("CODE_ACTION_NOT_FOUND", "The requested Code Action was not found.");
    }
    if (handle.state === "applied") {
      throw new BridgeError(
        "CODE_ACTION_ALREADY_APPLIED",
        "The requested Code Action has already been consumed.",
      );
    }
    handle.state = "applied";
    if (Date.now() >= handle.expiresAt) {
      throw new BridgeError("CODE_ACTION_EXPIRED", "The requested Code Action has expired.");
    }
    if (!handle.changeSetId || handle.unsupportedReason) {
      throw new BridgeError(
        "CODE_ACTION_UNSUPPORTED",
        handle.unsupportedReason ?? "The Code Action does not contain a supported text edit.",
      );
    }
    const guardDocument = await resolveExistingDocument(handle.guard.uri);
    try {
      assertExpectedDocument(
        guardDocument,
        handle.guard.expectedSha256,
        handle.guard.expectedVersion,
      );
    } catch {
      throw new BridgeError("STALE_CHANGE_SET", "The Code Action document changed after listing.");
    }
    let applied;
    try {
      applied = await this.#changeSets.applyPrepared(
        { sessionId: params.sessionId, changeSetId: handle.changeSetId },
        `${handle.title}: ${params.reason}`.slice(0, 2_000),
      );
    } catch (error) {
      if (error instanceof BridgeError && error.code === "CHANGE_SET_EXPIRED") {
        throw new BridgeError("CODE_ACTION_EXPIRED", "The requested Code Action has expired.");
      }
      if (error instanceof BridgeError && error.code === "CHANGE_SET_ALREADY_APPLIED") {
        throw new BridgeError(
          "CODE_ACTION_ALREADY_APPLIED",
          "The requested Code Action has already been consumed.",
        );
      }
      throw error;
    }
    return {
      instanceId: this.#instanceId,
      sessionId: params.sessionId,
      actionId: params.actionId,
      checkpointId: applied.checkpointId,
      appliedAt: applied.appliedAt,
      documents: applied.documents,
    };
  }

  async #prepareCodeAction(
    candidate: vscode.CodeAction | vscode.Command,
    params: ListCodeActionsParams,
    rootUri: string,
    guard: CodeActionGuard,
  ): Promise<ListCodeActionsResult["actions"][number]> {
    const actionId = randomUUID();
    const expiresAt = Date.now() + CODE_ACTION_TTL_MS;
    const action = isCodeAction(candidate) ? candidate : undefined;
    let unsupportedReason = action?.disabled?.reason ?? null;
    let changeSetId: string | null = null;
    if (!action) {
      unsupportedReason = "Command-only actions are not supported.";
    } else if (action.command) {
      unsupportedReason = "Actions containing commands are not supported.";
    } else if (!action.edit) {
      unsupportedReason = "The action does not contain a text WorkspaceEdit.";
    } else if (!unsupportedReason) {
      const entries = action.edit.entries();
      if (entries.length === 0 || action.edit.size !== entries.length) {
        unsupportedReason = "Resource operations and empty edits are not supported.";
      } else {
        try {
          const documents = await Promise.all(
            entries.map(async ([targetUri, edits]) => {
              const target = parseSupportedUri(targetUri.toString(true), rootUri);
              const targetDocument = await resolveExistingDocument(target);
              return {
                uri: target.toString(true),
                expectedSha256: sha256(targetDocument.getText()),
                expectedVersion: targetDocument.version,
                edits: edits.map((edit) => ({
                  range: toBridgeRange(edit.range),
                  newText: edit.newText,
                })),
              };
            }),
          );
          const prepared = await this.#changeSets.prepareGeneratedTextEdits(
            params.sessionId,
            action.title.slice(0, 1_000),
            "Prepared from a VS Code Code Action provider.",
            documents,
          );
          changeSetId = prepared.changeSetId;
        } catch (error) {
          unsupportedReason =
            error instanceof BridgeError
              ? `Provider edit rejected by bridge policy (${error.code}).`
              : "Provider edit could not be prepared safely.";
        }
      }
    }
    const title = candidate.title.slice(0, 1_000);
    this.#actions.set(actionId, {
      actionId,
      sessionId: params.sessionId,
      title,
      changeSetId,
      unsupportedReason,
      expiresAt,
      guard,
      state: "available",
    });
    return {
      actionId,
      title,
      kind: action?.kind?.value ?? null,
      diagnostics: (action?.diagnostics ?? [])
        .slice(0, 50)
        .map((diagnostic) => boundDiagnostic(toDiagnosticItem(guard.uri, diagnostic))),
      applicable: Boolean(changeSetId && !unsupportedReason),
      unsupportedReason,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async #assertSession(sessionId: string) {
    const experiment = await this.#experiments.getActiveExperiment();
    if (experiment.sessionId !== sessionId) {
      throw new BridgeError(
        "EXPERIMENT_NOT_FOUND",
        "The requested experiment is not active in this VS Code window.",
      );
    }
    return experiment;
  }

  #purgeOldActions(): void {
    const threshold = Date.now() - CODE_ACTION_TTL_MS;
    for (const [actionId, action] of this.#actions) {
      if (action.state === "applied" || action.expiresAt < threshold) {
        this.#actions.delete(actionId);
      }
    }
  }
}

function isCodeAction(candidate: vscode.CodeAction | vscode.Command): candidate is vscode.CodeAction {
  return typeof candidate.command !== "string";
}

function deduplicateCodeActions(
  actions: readonly (vscode.CodeAction | vscode.Command)[],
): Array<vscode.CodeAction | vscode.Command> {
  const keyed = new Map<string, vscode.CodeAction | vscode.Command>();
  for (const action of actions) {
    const codeAction = isCodeAction(action) ? action : undefined;
    const key = [
      action.title,
      codeAction?.kind?.value ?? "command",
      codeAction?.edit?.size ?? 0,
      codeAction?.diagnostics?.length ?? 0,
      typeof action.command === "string" ? action.command : action.command?.command ?? "",
    ].join("\u0000");
    keyed.set(key, action);
  }
  return [...keyed.values()];
}

function boundDiagnostic(
  diagnostic: ReturnType<typeof toDiagnosticItem>,
): ReturnType<typeof toDiagnosticItem> {
  return {
    ...diagnostic,
    message: diagnostic.message.slice(0, 2_000),
    relatedInformation: diagnostic.relatedInformation.slice(0, 20).map((information) => ({
      ...information,
      message: information.message.slice(0, 2_000),
    })),
  };
}
