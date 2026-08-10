import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import * as vscode from "vscode";

import {
  CHANGE_SET_TTL_MS,
  MAX_CHANGE_SET_DOCUMENTS,
  MAX_CHANGE_SET_EDITS,
  MAX_CHANGE_SET_REPLACEMENT_CHARACTERS,
  BridgeError,
  type AppliedChangeSet,
  type ApplyChangeSetParams,
  type PreparedChangeSet,
  type PreparedDocumentChange,
  type PrepareRenameParams,
  type PrepareResourceChangesParams,
  type PrepareTextEditsParams,
  type ResourceChange,
  type TextReplacement,
} from "@vscode-agent-bridge/protocol";

import { ExperimentManager } from "./experiment-manager.js";
import { AgentEditorVisibility } from "./agent-editor-visibility.js";
import { assertAgentWriteAllowed } from "./policies.js";
import {
  applyResourcePlan,
  assertResourcePlanFresh,
  prepareResourcePlan,
  type PreparedResourcePlan,
} from "./resource-change-executor.js";
import { validateConfigurationContentForUri } from "./workspace-configuration-manager.js";

interface InternalPreparedDocument {
  readonly uri: vscode.Uri;
  readonly expectedVersion: number | undefined;
  readonly beforeSha256: string;
  readonly edits: readonly TextReplacement[];
}

interface InternalChangeSet {
  readonly result: PreparedChangeSet;
  readonly documents: readonly InternalPreparedDocument[];
  readonly resourcePlan: PreparedResourcePlan | null;
  state: "prepared" | "consumed";
}

export class ChangeSetManager {
  readonly #instanceId: string;
  readonly #experiments: ExperimentManager;
  readonly #visibility: AgentEditorVisibility;
  readonly #changeSets = new Map<string, InternalChangeSet>();

  constructor(
    instanceId: string,
    experiments: ExperimentManager,
    visibility: AgentEditorVisibility,
  ) {
    this.#instanceId = instanceId;
    this.#experiments = experiments;
    this.#visibility = visibility;
  }

  async prepareTextEdits(params: PrepareTextEditsParams): Promise<PreparedChangeSet> {
    this.#assertMutationAllowed();
    await this.#assertActiveSession(params.sessionId);
    return this.#prepare(
      "text-edits",
      params.sessionId,
      params.title,
      params.rationale ?? null,
      params.documents,
    );
  }

  async prepareRename(params: PrepareRenameParams): Promise<PreparedChangeSet> {
    this.#assertMutationAllowed();
    const experiment = await this.#assertActiveSession(params.sessionId);
    const uri = parseSupportedUri(params.uri, experiment.rootUri);
    const document = await resolveExistingDocument(uri);
    assertExpectedDocument(document, params.expectedSha256, params.expectedVersion);
    const position = validatePosition(document, params.position);

    await vscode.commands.executeCommand("vscode.prepareRename", uri, position);
    const workspaceEdit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
      "vscode.executeDocumentRenameProvider",
      uri,
      position,
      params.newName,
    );
    if (!workspaceEdit) {
      throw new BridgeError("INVALID_REQUEST", "No rename provider returned edits.");
    }
    const entries = workspaceEdit.entries();
    if (entries.length === 0 || workspaceEdit.size !== entries.length) {
      throw new BridgeError(
        "EDIT_OUT_OF_SCOPE",
        "The rename provider returned resource operations or no text edits.",
      );
    }
    const documents = await Promise.all(
      entries.map(async ([targetUri, edits]) => {
        const target = parseSupportedUri(targetUri.toString(true), experiment.rootUri);
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
    return this.#prepare(
      "rename",
      params.sessionId,
      params.title,
      params.rationale ?? null,
      documents,
    );
  }

  async prepareResourceChanges(
    params: PrepareResourceChangesParams,
  ): Promise<PreparedChangeSet> {
    this.#assertMutationAllowed();
    this.#purgeExpired();
    const experiment = await this.#assertActiveSession(params.sessionId);
    await this.#experiments.assertResourceChangesAllowed(params.sessionId);
    const resourcePlan = await prepareResourcePlan(experiment.rootUri, params.operations);
    for (const prepared of resourcePlan.operations) {
      if (prepared.operation.operation === "create" && prepared.operation.kind === "file") {
        validateConfigurationContentForUri(prepared.uri, prepared.operation.content!);
      }
      if (
        prepared.operation.operation === "rename" &&
        prepared.operation.kind === "file" &&
        prepared.targetUri
      ) {
        const content = prepared.before.entries[0]?.content;
        if (content) {
          validateConfigurationContentForUri(
            prepared.targetUri,
            Buffer.from(content).toString("utf8"),
          );
        }
      }
    }
    const createdAt = new Date();
    const changeSetId = randomUUID();
    const result: PreparedChangeSet = {
      instanceId: this.#instanceId,
      sessionId: params.sessionId,
      changeSetId,
      kind: "resource-changes",
      title: params.title,
      rationale: params.rationale ?? null,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + CHANGE_SET_TTL_MS).toISOString(),
      documents: [],
      resources: [...params.operations],
      editCount: 0,
      resourceOperationCount: params.operations.length,
      replacementCharacters: params.operations.reduce(
        (total, operation) =>
          total + (operation.operation === "create" ? (operation.content?.length ?? 0) : 0),
        0,
      ),
    };
    this.#changeSets.set(changeSetId, {
      result,
      documents: [],
      resourcePlan,
      state: "prepared",
    });
    return result;
  }

  async apply(params: ApplyChangeSetParams): Promise<AppliedChangeSet> {
    return this.applyPrepared(params);
  }

  async prepareGeneratedTextEdits(
    sessionId: string,
    title: string,
    rationale: string,
    documents: readonly {
      uri: string;
      expectedSha256: string;
      expectedVersion: number;
      edits: readonly TextReplacement[];
    }[],
  ): Promise<PreparedChangeSet> {
    return this.#prepare("text-edits", sessionId, title, rationale, documents);
  }

  async applyPrepared(
    params: ApplyChangeSetParams,
    checkpointSummary?: string,
  ): Promise<AppliedChangeSet> {
    this.#assertMutationAllowed();
    const experiment = await this.#assertActiveSession(params.sessionId);
    const changeSet = this.#changeSets.get(params.changeSetId);
    if (!changeSet || changeSet.result.sessionId !== params.sessionId) {
      throw new BridgeError("CHANGE_SET_NOT_FOUND", "The prepared change set was not found.");
    }
    if (changeSet.state === "consumed") {
      throw new BridgeError(
        "CHANGE_SET_ALREADY_APPLIED",
        "The prepared change set has already been consumed.",
      );
    }
    changeSet.state = "consumed";
    if (Date.now() >= Date.parse(changeSet.result.expiresAt)) {
      throw new BridgeError("CHANGE_SET_EXPIRED", "The prepared change set has expired.");
    }

    if (changeSet.resourcePlan) {
      await assertResourcePlanFresh(changeSet.resourcePlan);
      const visibleUris = changeSet.resourcePlan.operations
        .filter(({ before }) => before.exists && before.kind === "file")
        .map(({ uri }) => uri);
      if (visibleUris.length > 0) {
        await this.#visibility.reveal(experiment.rootUri, visibleUris);
      }
      await this.#experiments.captureBeforeResourceApply(
        params.sessionId,
        changeSet.resourcePlan.affectedUris,
      );
      try {
        await applyResourcePlan(changeSet.resourcePlan);
      } catch (error) {
        if (error instanceof BridgeError && error.code === "RESOURCE_RECOVERY_REQUIRED") {
          await this.#experiments.markResourceRecoveryRequired(params.sessionId);
        }
        throw error;
      }
      const checkpointId = await this.#experiments.captureAfterAgentApply(
        params.sessionId,
        checkpointSummary ?? changeSet.result.title,
        changeSet.resourcePlan.affectedUris,
      );
      return {
        instanceId: this.#instanceId,
        sessionId: params.sessionId,
        changeSetId: params.changeSetId,
        checkpointId,
        appliedAt: new Date().toISOString(),
        documents: [],
        resources: changeSet.result.resources as ResourceChange[],
      };
    }

    const resolved = await Promise.all(
      changeSet.documents.map(async (prepared) => {
        const document = await resolveExistingDocument(prepared.uri);
        try {
          assertExpectedDocument(document, prepared.beforeSha256, prepared.expectedVersion);
          const edits = prepared.edits.map((edit) => ({
            range: validateRange(document, edit.range),
            newText: edit.newText,
          }));
          return { document, edits };
        } catch (error) {
          if (error instanceof BridgeError) {
            throw new BridgeError("STALE_CHANGE_SET", "A target document changed after preparation.");
          }
          throw error;
        }
      }),
    );

    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const target of resolved) {
      for (const edit of target.edits) {
        workspaceEdit.replace(target.document.uri, edit.range, edit.newText);
      }
    }
    await this.#visibility.reveal(
      experiment.rootUri,
      resolved.map(({ document }) => document.uri),
    );
    if (!(await this.#experiments.applyGuardedWorkspaceEdit(workspaceEdit))) {
      throw new BridgeError("INTERNAL_ERROR", "VS Code refused to apply the prepared text edits.");
    }

    const documents = resolved.map(({ document }) => ({
      uri: document.uri.toString(true),
      documentVersion: document.version,
      contentSha256: sha256(document.getText()),
      isDirty: document.isDirty,
    }));
    const checkpointId = await this.#experiments.captureAfterAgentApply(
      params.sessionId,
      checkpointSummary ?? changeSet.result.title,
      resolved.map(({ document }) => document.uri),
    );
    return {
      instanceId: this.#instanceId,
      sessionId: params.sessionId,
      changeSetId: params.changeSetId,
      checkpointId,
      appliedAt: new Date().toISOString(),
      documents,
      resources: [],
    };
  }

  async #prepare(
    kind: "text-edits" | "rename",
    sessionId: string,
    title: string,
    rationale: string | null,
    rawDocuments: readonly {
      uri: string;
      expectedSha256: string;
      expectedVersion?: number | undefined;
      edits: readonly TextReplacement[];
    }[],
  ): Promise<PreparedChangeSet> {
    this.#purgeExpired();
    const experiment = await this.#assertActiveSession(sessionId);
    if (rawDocuments.length > MAX_CHANGE_SET_DOCUMENTS) {
      throw new BridgeError("EDIT_LIMIT_EXCEEDED", "Change set contains too many documents.");
    }
    let editCount = 0;
    let replacementCharacters = 0;
    const internalDocuments: InternalPreparedDocument[] = [];
    const preparedDocuments: PreparedDocumentChange[] = [];
    for (const raw of rawDocuments) {
      const uri = parseSupportedUri(raw.uri, experiment.rootUri);
      const document = await resolveExistingDocument(uri);
      assertExpectedDocument(document, raw.expectedSha256, raw.expectedVersion);
      const edits = raw.edits.map((edit) => ({
        range: toBridgeRange(validateRange(document, edit.range)),
        newText: edit.newText,
      }));
      assertNonOverlapping(edits);
      editCount += edits.length;
      replacementCharacters += edits.reduce((total, edit) => total + edit.newText.length, 0);
      const afterText = applyTextEdits(document, edits);
      validateConfigurationContentForUri(uri, afterText, document.getText());
      preparedDocuments.push({
        uri: uri.toString(true),
        beforeSha256: raw.expectedSha256,
        beforeVersion: document.version,
        afterSha256: sha256(afterText),
        edits,
        editCount: edits.length,
        replacementCharacters: edits.reduce((total, edit) => total + edit.newText.length, 0),
      });
      internalDocuments.push({
        uri,
        expectedVersion: raw.expectedVersion,
        beforeSha256: raw.expectedSha256,
        edits,
      });
    }
    if (
      editCount === 0 ||
      editCount > MAX_CHANGE_SET_EDITS ||
      replacementCharacters > MAX_CHANGE_SET_REPLACEMENT_CHARACTERS
    ) {
      throw new BridgeError("EDIT_LIMIT_EXCEEDED", "Change set exceeds the bounded edit surface.");
    }
    const changeSetId = randomUUID();
    const createdAt = new Date();
    const result: PreparedChangeSet = {
      instanceId: this.#instanceId,
      sessionId,
      changeSetId,
      kind,
      title,
      rationale,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + CHANGE_SET_TTL_MS).toISOString(),
      documents: preparedDocuments,
      resources: [],
      editCount,
      resourceOperationCount: 0,
      replacementCharacters,
    };
    this.#changeSets.set(changeSetId, {
      result,
      documents: internalDocuments,
      resourcePlan: null,
      state: "prepared",
    });
    return result;
  }

  async #assertActiveSession(sessionId: string) {
    const experiment = await this.#experiments.getActiveExperiment();
    if (experiment.sessionId !== sessionId) {
      throw new BridgeError(
        "EXPERIMENT_NOT_FOUND",
        "The requested experiment is not active in this VS Code window.",
      );
    }
    return experiment;
  }

  #assertMutationAllowed(): void {
    assertAgentWriteAllowed();
  }

  #purgeExpired(): void {
    const now = Date.now();
    for (const [changeSetId, changeSet] of this.#changeSets) {
      if (changeSet.state === "consumed" || now >= Date.parse(changeSet.result.expiresAt)) {
        this.#changeSets.delete(changeSetId);
      }
    }
  }
}

export function parseSupportedUri(rawUri: string, rootUri: string): vscode.Uri {
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(rawUri, true);
  } catch {
    throw new BridgeError("DOCUMENT_NOT_FOUND", "The requested document URI is invalid.");
  }
  if (uri.scheme !== "file" && uri.scheme !== "untitled") {
    throw new BridgeError(
      "UNSUPPORTED_DOCUMENT_SCHEME",
      "Guarded edits support only file and already-open untitled documents.",
    );
  }
  if (uri.scheme === "file") {
    const root = vscode.Uri.parse(rootUri, true);
    const relative = path.relative(path.resolve(root.fsPath), path.resolve(uri.fsPath));
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new BridgeError("EDIT_OUT_OF_SCOPE", "Document is outside the active experiment root.");
    }
  }
  return uri;
}

export async function resolveExistingDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString(true) === uri.toString(true),
  );
  if (open) {
    return open;
  }
  if (uri.scheme === "untitled") {
    throw new BridgeError(
      "DOCUMENT_NOT_FOUND",
      "Untitled documents must already be open in the selected VS Code window.",
    );
  }
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    throw new BridgeError("DOCUMENT_NOT_FOUND", "The requested document could not be opened.");
  }
}

export function assertExpectedDocument(
  document: vscode.TextDocument,
  expectedSha256: string,
  expectedVersion?: number,
): void {
  if (
    sha256(document.getText()) !== expectedSha256 ||
    (expectedVersion !== undefined && document.version !== expectedVersion)
  ) {
    throw new BridgeError(
      "STALE_DOCUMENT_VERSION",
      "The document no longer matches the expected version and content hash.",
    );
  }
}

export function validateRange(
  document: vscode.TextDocument,
  range: TextReplacement["range"],
): vscode.Range {
  const start = validatePosition(document, range.start);
  const end = validatePosition(document, range.end);
  if (start.isAfter(end)) {
    throw new BridgeError("POSITION_OUT_OF_RANGE", "Text edit range starts after it ends.");
  }
  return new vscode.Range(start, end);
}

function validatePosition(
  document: vscode.TextDocument,
  position: { line: number; character: number },
): vscode.Position {
  if (position.line >= document.lineCount) {
    throw new BridgeError("POSITION_OUT_OF_RANGE", "Text edit line is outside the document.");
  }
  if (position.character > document.lineAt(position.line).text.length) {
    throw new BridgeError("POSITION_OUT_OF_RANGE", "Text edit character is outside the line.");
  }
  return new vscode.Position(position.line, position.character);
}

function assertNonOverlapping(edits: readonly TextReplacement[]): void {
  const sorted = [...edits].sort((left, right) => comparePositions(left.range.start, right.range.start));
  for (let index = 1; index < sorted.length; index += 1) {
    if (comparePositions(sorted[index - 1]!.range.end, sorted[index]!.range.start) > 0) {
      throw new BridgeError("INVALID_REQUEST", "Prepared text edit ranges overlap.");
    }
  }
}

function applyTextEdits(document: vscode.TextDocument, edits: readonly TextReplacement[]): string {
  let text = document.getText();
  const descending = [...edits].sort(
    (left, right) => document.offsetAt(toPosition(right.range.start)) - document.offsetAt(toPosition(left.range.start)),
  );
  for (const edit of descending) {
    const start = document.offsetAt(toPosition(edit.range.start));
    const end = document.offsetAt(toPosition(edit.range.end));
    text = `${text.slice(0, start)}${edit.newText}${text.slice(end)}`;
  }
  return text;
}

function toPosition(position: { line: number; character: number }): vscode.Position {
  return new vscode.Position(position.line, position.character);
}

export function toBridgeRange(range: vscode.Range): TextReplacement["range"] {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function comparePositions(
  left: { line: number; character: number },
  right: { line: number; character: number },
): number {
  return left.line - right.line || left.character - right.character;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
