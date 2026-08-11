import { createHash } from "node:crypto";
import path from "node:path";

import * as vscode from "vscode";

import {
  BridgeError,
  type DiagnosticEvent,
  type ExtensionDetailsResult,
  type ExtensionSummary,
  type GetExtensionConfigurationSchemaParams,
  type GetExtensionDetailsParams,
  type ListDiagnosticEventsParams,
  type ListDiagnosticEventsResult,
  type ListExtensionsParams,
  type ListExtensionsResult,
  type ListOutputSourcesParams,
  type ListOutputSourcesResult,
  type OutputSource,
  type ReadVisibleOutputParams,
  type ReadVisibleOutputResult,
} from "@vscode-agent-bridge/protocol";

import type { TaskManager } from "./task-manager.js";
import type { TerminalObserver } from "./terminal-observer.js";
import { selectAndSortOutputSources } from "./output-source-order.js";

const DIAGNOSTIC_RETENTION_MS = 15 * 60 * 1_000;
const MAX_DIAGNOSTIC_EVENTS = 2_000;

interface DiagnosticSummary {
  readonly total: number;
  readonly errors: number;
  readonly warnings: number;
  readonly information: number;
  readonly hints: number;
  readonly sources: string[];
  readonly signature: string;
}

interface OutputDocumentRecord {
  readonly sourceId: string;
  readonly uri: vscode.Uri;
  label: string;
  lastObservedAt: string;
  open: boolean;
}

interface DebugSignalSource {
  readonly activeCount: number;
  readonly outputSessionCount: number;
}

export class ExtensionAwarenessManager implements vscode.Disposable {
  readonly #instanceId: string;
  readonly #terminals: TerminalObserver;
  readonly #tasks: TaskManager;
  readonly #debug: DebugSignalSource;
  readonly #diagnosticSummaries = new Map<string, DiagnosticSummary>();
  readonly #diagnosticEvents: DiagnosticEvent[] = [];
  readonly #outputDocuments = new Map<string, OutputDocumentRecord>();
  readonly #disposables: vscode.Disposable[];
  #diagnosticCursor = 1;

  constructor(
    instanceId: string,
    terminals: TerminalObserver,
    tasks: TaskManager,
    debug: DebugSignalSource,
  ) {
    this.#instanceId = instanceId;
    this.#terminals = terminals;
    this.#tasks = tasks;
    this.#debug = debug;
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      this.#diagnosticSummaries.set(uri.toString(true), summarizeDiagnostics(diagnostics));
    }
    for (const document of vscode.workspace.textDocuments) this.#observeOutputDocument(document);
    this.#disposables = [
      vscode.languages.onDidChangeDiagnostics((event) => {
        for (const uri of event.uris) this.#captureDiagnosticChange(uri);
      }),
      vscode.workspace.onDidOpenTextDocument((document) => this.#observeOutputDocument(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.#closeOutputDocument(document)),
      vscode.workspace.onDidChangeTextDocument(({ document }) => this.#observeOutputDocument(document)),
    ];
  }

  getStats(): {
    readonly installedExtensions: number;
    readonly activeExtensions: number;
    readonly visibleOutputSources: number;
    readonly diagnosticEvents: number;
  } {
    this.#cleanupDiagnosticEvents();
    const extensions = vscode.extensions.all.map(extensionSummary).filter((value) => value !== null);
    return {
      installedExtensions: extensions.length,
      activeExtensions: extensions.filter((extension) => extension.active).length,
      visibleOutputSources: [...this.#outputDocuments.values()].filter((record) => record.open).length,
      diagnosticEvents: this.#diagnosticEvents.length,
    };
  }

  listExtensions(params: ListExtensionsParams): ListExtensionsResult {
    const query = params.query?.trim().toLowerCase();
    const all = vscode.extensions.all
      .map(extensionSummary)
      .filter((extension): extension is ExtensionSummary => extension !== null)
      .filter((extension) => params.includeBuiltIn || !extension.builtIn)
      .filter((extension) => !params.activeOnly || extension.active)
      .filter(
        (extension) =>
          !query ||
          extension.extensionId.toLowerCase().includes(query) ||
          extension.displayName.toLowerCase().includes(query) ||
          extension.publisher.toLowerCase().includes(query),
      )
      .sort((left, right) => left.extensionId.localeCompare(right.extensionId));
    const page = all.slice(params.offset, params.offset + params.limit);
    return {
      instanceId: this.#instanceId,
      extensions: page,
      returnedCount: page.length,
      totalCount: all.length,
      truncated: params.offset + page.length < all.length,
    };
  }

  getExtensionDetails(params: GetExtensionDetailsParams): ExtensionDetailsResult {
    const extension = findExtension(params.extensionId);
    const summary = extensionSummary(extension);
    if (!summary) throw new BridgeError("EXTENSION_NOT_FOUND", "The installed extension manifest is invalid.");
    const manifest = record(extension.packageJSON);
    const contributes = record(manifest.contributes);
    return {
      instanceId: this.#instanceId,
      extension: summary,
      activationEvents: stringArray(manifest.activationEvents, 500, 500),
      languages: recordArray(contributes.languages, 500).flatMap((language) => {
        const id = boundedString(language.id, 200);
        return id
          ? [{ id, aliases: stringArray(language.aliases, 50, 500), extensions: stringArray(language.extensions, 100, 200) }]
          : [];
      }),
      debuggers: namedTypes(contributes.debuggers, 200),
      taskDefinitions: namedTypes(contributes.taskDefinitions, 200),
      commands: recordArray(contributes.commands, 1_000).flatMap((command) => {
        const id = boundedString(command.command, 500);
        const title = typeof command.title === "string" ? boundedString(command.title, 1_000) : null;
        return id && title ? [{ command: id, title }] : [];
      }),
      configurationKeys: configurationProperties(contributes.configuration).map(({ key }) => key).slice(0, 2_000),
      themes: recordArray(contributes.themes, 500).map((theme) => ({
        id: boundedString(theme.id, 300),
        label: boundedString(theme.label, 500),
        uiTheme: boundedString(theme.uiTheme, 200),
      })),
      activatedByRequest: false,
    };
  }

  getExtensionConfigurationSchema(params: GetExtensionConfigurationSchemaParams) {
    const extension = findExtension(params.extensionId);
    const manifest = record(extension.packageJSON);
    const contributes = record(manifest.contributes);
    const all = configurationProperties(contributes.configuration);
    const page = all.slice(params.offset, params.offset + params.limit);
    return {
      instanceId: this.#instanceId,
      extensionId: extension.id,
      properties: page,
      returnedCount: page.length,
      totalCount: all.length,
      truncated: params.offset + page.length < all.length,
    };
  }

  getProfileContext() {
    return {
      instanceId: this.#instanceId,
      profileName: null,
      profileId: null,
      stableApiCoverage: "unavailable" as const,
      canManageCurrentProfileConfiguration: true,
      supportedConfigurationTargets: ["global", "workspace", "workspaceFolder"] as const,
      privateProfileDataAccessed: false as const,
    };
  }

  listOutputSources(params: ListOutputSourcesParams): ListOutputSourcesResult {
    this.#cleanupDiagnosticEvents();
    const now = new Date().toISOString();
    const sources: OutputSource[] = [];
    for (const record of this.#outputDocuments.values()) {
      sources.push({
        sourceId: record.sourceId,
        extensionId: null,
        label: record.label,
        sourceType: "outputDocument",
        status: record.open ? "active" : "inactive",
        coverage: "visible",
        canReadNow: record.open,
        lastObservedAt: record.lastObservedAt,
        errorCount: 0,
        warningCount: 0,
      });
    }
    const terminalStats = this.#terminals.getStats();
    if (terminalStats.terminalCount > 0 || terminalStats.executionCount > 0) {
      sources.push({
        sourceId: "capture:terminals",
        extensionId: null,
        label: "Captured terminal executions",
        sourceType: "terminalCapture",
        status: terminalStats.terminalCount > 0 ? "active" : "inactive",
        coverage: "captured",
        canReadNow: terminalStats.executionsWithOutput > 0,
        lastObservedAt: now,
        errorCount: 0,
        warningCount: 0,
      });
    }
    if (this.#tasks.activeCount > 0) {
      sources.push({
        sourceId: "capture:tasks",
        extensionId: null,
        label: "VS Code Task executions",
        sourceType: "taskCapture",
        status: "emitting",
        coverage: "captured",
        canReadNow: false,
        lastObservedAt: now,
        errorCount: 0,
        warningCount: 0,
      });
    }
    if (this.#debug.outputSessionCount > 0) {
      sources.push({
        sourceId: "capture:debug",
        extensionId: null,
        label: "VS Code Debug Console",
        sourceType: "debugCapture",
        status: this.#debug.activeCount > 0 ? "emitting" : "inactive",
        coverage: "captured",
        canReadNow: true,
        lastObservedAt: now,
        errorCount: 0,
        warningCount: 0,
      });
    }
    sources.push(...diagnosticSources(params.rootUri));
    for (const summary of vscode.extensions.all.map(extensionSummary)) {
      if (!summary) continue;
      const counts = summary.contributions;
      if (counts.languages + counts.debuggers + counts.taskDefinitions === 0 && !counts.testing) continue;
      sources.push({
        sourceId: `capability:${summary.extensionId}`,
        extensionId: summary.extensionId,
        label: `${summary.displayName} IDE capabilities`,
        sourceType: "extensionCapability",
        status: summary.active ? "active" : "available",
        coverage: "metadataOnly",
        canReadNow: false,
        lastObservedAt: null,
        errorCount: 0,
        warningCount: 0,
      });
    }
    const filtered = selectAndSortOutputSources(sources, params.sourceTypes);
    const page = filtered.slice(params.offset, params.offset + params.limit);
    return {
      instanceId: this.#instanceId,
      sources: page,
      returnedCount: page.length,
      totalCount: filtered.length,
      truncated: params.offset + page.length < filtered.length,
    };
  }

  readVisibleOutput(params: ReadVisibleOutputParams): ReadVisibleOutputResult {
    const record = this.#outputDocuments.get(params.sourceId);
    if (!record) throw new BridgeError("OUTPUT_SOURCE_NOT_FOUND", "The requested output source was not observed.");
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString(true) === record.uri.toString(true) && isOutputDocument(candidate),
    );
    if (!document || !record.open) {
      throw new BridgeError("OUTPUT_NOT_VISIBLE", "Select or open this Output channel in VS Code before reading it.");
    }
    const text = document.getText();
    if (params.cursor > text.length) {
      throw new BridgeError("OUTPUT_CURSOR_EXPIRED", "The visible Output document changed before this cursor.");
    }
    const page = text.slice(params.cursor, params.cursor + params.maxChars);
    return {
      instanceId: this.#instanceId,
      sourceId: params.sourceId,
      text: page,
      cursor: params.cursor,
      nextCursor: params.cursor + page.length,
      returnedCharacters: page.length,
      totalCharacters: text.length,
      truncated: params.cursor + page.length < text.length,
      droppedPrefix: false,
      coverage: "visible",
    };
  }

  listDiagnosticEvents(params: ListDiagnosticEventsParams): ListDiagnosticEventsResult {
    this.#cleanupDiagnosticEvents();
    const oldestCursor = this.#diagnosticEvents[0]?.cursor ?? this.#diagnosticCursor;
    const cursorExpired = params.afterCursor > 0 && params.afterCursor < oldestCursor - 1;
    const selected = this.#diagnosticEvents
      .filter((event) => event.cursor > params.afterCursor)
      .filter((event) => !params.rootUri || uriWithinRoot(event.uri, params.rootUri))
      .filter((event) => !params.source || event.sources.includes(params.source))
      .filter((event) => !params.severity || event[severityField(params.severity)] > 0);
    const page = selected.slice(0, params.limit);
    return {
      instanceId: this.#instanceId,
      events: page,
      oldestCursor,
      nextCursor: page.at(-1)?.cursor ?? params.afterCursor,
      cursorExpired,
      truncated: page.length < selected.length,
      coverage: "sinceActivation",
    };
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
  }

  #observeOutputDocument(document: vscode.TextDocument): void {
    if (!isOutputDocument(document)) return;
    const sourceId = outputSourceId(document.uri);
    const existing = this.#outputDocuments.get(sourceId);
    const observedAt = new Date().toISOString();
    if (existing) {
      existing.open = true;
      existing.lastObservedAt = observedAt;
      existing.label = outputLabel(document.uri, document.fileName);
    } else {
      this.#outputDocuments.set(sourceId, {
        sourceId,
        uri: document.uri,
        label: outputLabel(document.uri, document.fileName),
        lastObservedAt: observedAt,
        open: true,
      });
    }
  }

  #closeOutputDocument(document: vscode.TextDocument): void {
    if (!isOutputDocument(document)) return;
    const record = this.#outputDocuments.get(outputSourceId(document.uri));
    if (record) {
      record.open = false;
      record.lastObservedAt = new Date().toISOString();
    }
  }

  #captureDiagnosticChange(uri: vscode.Uri): void {
    const key = uri.toString(true);
    const previous = this.#diagnosticSummaries.get(key) ?? emptyDiagnostics();
    const current = summarizeDiagnostics(vscode.languages.getDiagnostics(uri));
    this.#diagnosticSummaries.set(key, current);
    if (previous.signature === current.signature) return;
    this.#diagnosticEvents.push({
      cursor: this.#diagnosticCursor++,
      occurredAt: new Date().toISOString(),
      uri: key,
      change: previous.total === 0 ? "added" : current.total === 0 ? "removed" : "changed",
      previousCount: previous.total,
      currentCount: current.total,
      errors: current.errors,
      warnings: current.warnings,
      information: current.information,
      hints: current.hints,
      sources: current.sources,
    });
    this.#cleanupDiagnosticEvents();
  }

  #cleanupDiagnosticEvents(): void {
    const cutoff = Date.now() - DIAGNOSTIC_RETENTION_MS;
    while (
      this.#diagnosticEvents.length > MAX_DIAGNOSTIC_EVENTS ||
      (this.#diagnosticEvents[0] && Date.parse(this.#diagnosticEvents[0].occurredAt) < cutoff)
    ) {
      this.#diagnosticEvents.shift();
    }
  }
}

function findExtension(extensionId: string): vscode.Extension<unknown> {
  const extension = vscode.extensions.getExtension(extensionId);
  if (!extension) throw new BridgeError("EXTENSION_NOT_FOUND", "The requested VS Code extension is not installed.");
  return extension;
}

function extensionSummary(extension: vscode.Extension<unknown>): ExtensionSummary | null {
  if (!validExtensionId(extension.id)) return null;
  const manifest = record(extension.packageJSON);
  const contributes = record(manifest.contributes);
  const publisher = boundedString(manifest.publisher, 200) ?? extension.id.split(".")[0]!;
  const displayName = boundedString(manifest.displayName, 500) ?? boundedString(manifest.name, 500) ?? extension.id;
  const dependencies = stringArray(manifest.extensionDependencies, 200, 300).filter(validExtensionId);
  const extensionPack = stringArray(manifest.extensionPack, 200, 300).filter(validExtensionId);
  const configurationKeys = configurationProperties(contributes.configuration).length;
  return {
    extensionId: extension.id,
    version: boundedString(manifest.version, 200) ?? "unknown",
    publisher,
    displayName,
    builtIn: manifest.isBuiltin === true,
    active: extension.isActive,
    extensionKind: [extensionKind(extension.extensionKind)],
    dependencies,
    extensionPack,
    contributions: {
      languages: recordArray(contributes.languages, 10_000).length,
      debuggers: recordArray(contributes.debuggers, 10_000).length,
      taskDefinitions: recordArray(contributes.taskDefinitions, 10_000).length,
      commands: recordArray(contributes.commands, 10_000).length,
      configurationKeys,
      themes: recordArray(contributes.themes, 10_000).length,
      testing: contributes.testing !== undefined,
      formatterDeclarationCoverage: "notDeclaredByManifest",
    },
  };
}

function extensionKind(kind: vscode.ExtensionKind): "ui" | "workspace" | "web" | "unknown" {
  if (kind === vscode.ExtensionKind.UI) return "ui";
  if (kind === vscode.ExtensionKind.Workspace) return "workspace";
  return "unknown";
}

function configurationProperties(value: unknown): Array<{
  key: string;
  type: string[];
  scope: string | null;
  description: string | null;
  enumValues: Array<string | number | boolean | null>;
}> {
  const sections = Array.isArray(value) ? value : value ? [value] : [];
  const result = [];
  for (const sectionValue of sections) {
    const properties = record(record(sectionValue).properties);
    for (const [key, rawSchema] of Object.entries(properties)) {
      const schema = record(rawSchema);
      const types = Array.isArray(schema.type)
        ? schema.type.filter((item): item is string => typeof item === "string").slice(0, 10)
        : typeof schema.type === "string"
          ? [schema.type]
          : [];
      const enumValues = Array.isArray(schema.enum)
        ? schema.enum.filter(
            (item): item is string | number | boolean | null =>
              item === null || ["string", "number", "boolean"].includes(typeof item),
          ).slice(0, 200)
        : [];
      result.push({
        key: key.slice(0, 500),
        type: types.map((item) => item.slice(0, 100)),
        scope: boundedString(schema.scope, 100),
        description: boundedString(schema.markdownDescription, 4_000) ?? boundedString(schema.description, 4_000),
        enumValues,
      });
    }
  }
  return result.sort((left, right) => left.key.localeCompare(right.key));
}

function namedTypes(value: unknown, limit: number): Array<{ type: string; label: string | null }> {
  return recordArray(value, limit).flatMap((candidate) => {
    const type = boundedString(candidate.type, 300);
    return type ? [{ type, label: boundedString(candidate.label, 500) }] : [];
  });
}

function diagnosticSources(rootUri?: string): OutputSource[] {
  const aggregated = new Map<string, { errors: number; warnings: number }>();
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (rootUri && !uriWithinRoot(uri.toString(true), rootUri)) continue;
    for (const diagnostic of diagnostics) {
      const source = diagnostic.source?.slice(0, 500) || "Unknown diagnostic source";
      const counts = aggregated.get(source) ?? { errors: 0, warnings: 0 };
      if (diagnostic.severity === vscode.DiagnosticSeverity.Error) counts.errors += 1;
      if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) counts.warnings += 1;
      aggregated.set(source, counts);
    }
  }
  return [...aggregated.entries()].map(([source, counts]) => ({
    sourceId: `diagnostics:${createHash("sha256").update(source).digest("hex").slice(0, 24)}`,
    extensionId: null,
    label: source,
    sourceType: "diagnostics",
    status: "emitting",
    coverage: "metadataOnly",
    canReadNow: false,
    lastObservedAt: null,
    errorCount: counts.errors,
    warningCount: counts.warnings,
  }));
}

function summarizeDiagnostics(diagnostics: readonly vscode.Diagnostic[]): DiagnosticSummary {
  let errors = 0;
  let warnings = 0;
  let information = 0;
  let hints = 0;
  const sources = new Set<string>();
  const transientSignature: string[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === vscode.DiagnosticSeverity.Error) errors += 1;
    else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) warnings += 1;
    else if (diagnostic.severity === vscode.DiagnosticSeverity.Information) information += 1;
    else hints += 1;
    if (diagnostic.source) sources.add(diagnostic.source.slice(0, 500));
    transientSignature.push(
      `${diagnostic.severity}:${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}`,
    );
  }
  return {
    total: diagnostics.length,
    errors,
    warnings,
    information,
    hints,
    sources: [...sources].sort(),
    signature: createHash("sha256").update(transientSignature.sort().join("\n")).digest("hex"),
  };
}

function emptyDiagnostics(): DiagnosticSummary {
  return { total: 0, errors: 0, warnings: 0, information: 0, hints: 0, sources: [], signature: "" };
}

function severityField(severity: ListDiagnosticEventsParams["severity"]): "errors" | "warnings" | "information" | "hints" {
  if (severity === "error") return "errors";
  if (severity === "warning") return "warnings";
  if (severity === "information") return "information";
  return "hints";
}

function uriWithinRoot(uriValue: string, rootValue: string): boolean {
  try {
    const uri = vscode.Uri.parse(uriValue);
    const root = vscode.Uri.parse(rootValue);
    if (uri.scheme !== root.scheme) return false;
    if (uri.scheme !== "file") return uriValue.startsWith(rootValue);
    const relative = path.relative(root.fsPath, uri.fsPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function isOutputDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "output" || document.uri.scheme === "log";
}

function outputSourceId(uri: vscode.Uri): string {
  return `visible:${createHash("sha256").update(uri.toString(true)).digest("hex").slice(0, 32)}`;
}

function outputLabel(uri: vscode.Uri, fileName: string): string {
  const candidate = decodeURIComponent(
    (uri.path.split("/").filter(Boolean).at(-1) ?? uri.authority) || fileName,
  );
  return candidate.slice(0, 1_000) || "Visible Output";
}

function validExtensionId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/iu.test(value);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordArray(value: unknown, limit: number): Record<string, unknown>[] {
  return Array.isArray(value) ? value.slice(0, limit).map(record).filter((item) => Object.keys(item).length > 0) : [];
}

function stringArray(value: unknown, limit: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, limit).map((item) => item.slice(0, maxLength))
    : [];
}

function boundedString(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : null;
}
