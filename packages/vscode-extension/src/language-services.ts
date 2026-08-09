import { createHash } from "node:crypto";

import * as vscode from "vscode";

import {
  BridgeError,
  type DiagnosticItem,
  type DiagnosticsParams,
  type DiagnosticsResult,
  type DocumentSnapshot,
  type DocumentSymbolItem,
  type DocumentSymbolsParams,
  type DocumentSymbolsResult,
  type HoverParams,
  type HoverResult,
  type LocationItem,
  type LocationsResult,
  type PositionedDocumentParams,
  type Range as BridgeRange,
  type ReadDocumentParams,
} from "@vscode-agent-bridge/protocol";

export async function readDocument(
  instanceId: string,
  params: ReadDocumentParams,
): Promise<DocumentSnapshot> {
  assertLocalExtensionHost();
  const document = await resolveDocument(params.uri);
  const range = params.range ? validateRange(document, params.range) : fullDocumentRange(document);
  const completeText = document.getText(range);
  const text = completeText.slice(0, params.maxChars);

  return {
    instanceId,
    uri: document.uri.toString(true),
    languageId: document.languageId,
    documentVersion: document.version,
    isDirty: document.isDirty,
    isUntitled: document.isUntitled,
    range: toRange(range),
    text,
    returnedCharacters: text.length,
    totalCharacters: completeText.length,
    truncated: text.length < completeText.length,
    contentSha256: createHash("sha256").update(document.getText()).digest("hex"),
    capturedAt: new Date().toISOString(),
  };
}

export async function getDiagnostics(
  instanceId: string,
  params: DiagnosticsParams,
): Promise<DiagnosticsResult> {
  assertLocalExtensionHost();

  let diagnosticGroups: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
  if (params.scope === "active") {
    const document = await resolveDocument();
    diagnosticGroups = [[document.uri, vscode.languages.getDiagnostics(document.uri)]];
  } else if (params.scope === "document") {
    const document = await resolveDocument(params.uri);
    diagnosticGroups = [[document.uri, vscode.languages.getDiagnostics(document.uri)]];
  } else {
    const selectedWorkspace = resolveWorkspaceFolder(params.workspaceFolderUri);
    diagnosticGroups = vscode.languages
      .getDiagnostics()
      .filter(([uri]) => {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        return folder !== undefined && (!selectedWorkspace || folder.uri.toString(true) === selectedWorkspace);
      });
  }

  const severityFilter = params.severities ? new Set(params.severities) : undefined;
  const sourceFilter = params.source?.toLocaleLowerCase();
  const diagnostics = diagnosticGroups
    .flatMap(([uri, values]) => values.map((diagnostic) => toDiagnosticItem(uri, diagnostic)))
    .filter(
      (diagnostic) =>
        (!severityFilter || severityFilter.has(diagnostic.severity)) &&
        (!sourceFilter || diagnostic.source?.toLocaleLowerCase() === sourceFilter),
    )
    .sort(compareDiagnostics);
  const visibleDiagnostics = diagnostics.slice(0, params.limit);

  return {
    instanceId,
    scope: params.scope,
    diagnostics: visibleDiagnostics,
    returnedCount: visibleDiagnostics.length,
    totalCount: diagnostics.length,
    truncated: visibleDiagnostics.length < diagnostics.length,
  };
}

export async function getDocumentSymbols(
  instanceId: string,
  params: DocumentSymbolsParams,
): Promise<DocumentSymbolsResult> {
  assertLocalExtensionHost();
  const document = await resolveDocument(params.uri);
  const rawSymbols =
    (await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
      "vscode.executeDocumentSymbolProvider",
      document.uri,
    )) ?? [];
  const symbols = normalizeSymbols(rawSymbols);
  const visibleSymbols = symbols.slice(0, params.limit);

  return {
    instanceId,
    uri: document.uri.toString(true),
    symbols: visibleSymbols,
    returnedCount: visibleSymbols.length,
    totalCount: symbols.length,
    truncated: visibleSymbols.length < symbols.length,
  };
}

export async function getDefinitions(
  instanceId: string,
  params: PositionedDocumentParams,
): Promise<LocationsResult> {
  return getLocations(
    instanceId,
    params,
    "vscode.executeDefinitionProvider",
    undefined,
  );
}

export async function getReferences(
  instanceId: string,
  params: PositionedDocumentParams,
): Promise<LocationsResult> {
  return getLocations(
    instanceId,
    params,
    "vscode.executeReferenceProvider",
    { includeDeclaration: true },
  );
}

export async function getHover(instanceId: string, params: HoverParams): Promise<HoverResult> {
  assertLocalExtensionHost();
  const document = await resolveDocument(params.uri);
  const position = validatePosition(document, params.position);
  const hovers =
    (await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      position,
    )) ?? [];
  const rawContents = hovers.flatMap((hover) =>
    hover.contents.map((content) => sanitizeHoverMarkdown(hoverContentValue(content))),
  );
  const totalCharacters = rawContents.reduce((total, value) => total + value.length, 0);
  let remaining = params.maxChars;
  const contents: string[] = [];
  for (const content of rawContents) {
    if (remaining === 0) {
      break;
    }
    const visible = content.slice(0, remaining);
    contents.push(visible);
    remaining -= visible.length;
  }
  const returnedCharacters = contents.reduce((total, value) => total + value.length, 0);

  return {
    instanceId,
    uri: document.uri.toString(true),
    position: toPosition(position),
    range: hovers.find((hover) => hover.range)?.range
      ? toRange(hovers.find((hover) => hover.range)!.range!)
      : null,
    contents,
    returnedCharacters,
    totalCharacters,
    truncated: returnedCharacters < totalCharacters,
  };
}

async function getLocations(
  instanceId: string,
  params: PositionedDocumentParams,
  command: "vscode.executeDefinitionProvider" | "vscode.executeReferenceProvider",
  commandContext: { includeDeclaration: boolean } | undefined,
): Promise<LocationsResult> {
  assertLocalExtensionHost();
  const document = await resolveDocument(params.uri);
  const position = validatePosition(document, params.position);
  const rawLocations =
    (await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      command,
      document.uri,
      position,
      ...(commandContext ? [commandContext] : []),
    )) ?? [];
  const locations = deduplicateLocations(rawLocations.map(toLocationItem));
  const visibleLocations = locations.slice(0, params.limit);

  return {
    instanceId,
    uri: document.uri.toString(true),
    position: toPosition(position),
    locations: visibleLocations,
    returnedCount: visibleLocations.length,
    totalCount: locations.length,
    truncated: visibleLocations.length < locations.length,
  };
}

async function resolveDocument(uri?: string): Promise<vscode.TextDocument> {
  if (!uri) {
    const activeDocument = vscode.window.activeTextEditor?.document;
    if (!activeDocument) {
      throw new BridgeError("NO_ACTIVE_EDITOR", "The selected VS Code window has no active text editor.");
    }
    return activeDocument;
  }

  let parsedUri: vscode.Uri;
  try {
    parsedUri = vscode.Uri.parse(uri, true);
  } catch {
    throw new BridgeError("DOCUMENT_NOT_FOUND", "The requested document URI is invalid.");
  }
  if (!parsedUri.scheme) {
    throw new BridgeError("DOCUMENT_NOT_FOUND", "The requested document URI must include a scheme.");
  }

  const openDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString(true) === parsedUri.toString(true),
  );
  if (openDocument) {
    return openDocument;
  }

  try {
    return await vscode.workspace.openTextDocument(parsedUri);
  } catch {
    throw new BridgeError("DOCUMENT_NOT_FOUND", "The requested document could not be opened.");
  }
}

function resolveWorkspaceFolder(workspaceFolderUri?: string): string | undefined {
  if (!workspaceFolderUri) {
    return undefined;
  }
  const folder = vscode.workspace.workspaceFolders?.find(
    (candidate) => candidate.uri.toString(true) === workspaceFolderUri,
  );
  if (!folder) {
    throw new BridgeError(
      "INVALID_REQUEST",
      "workspaceFolderUri is not one of the current VS Code workspace folders.",
    );
  }
  return folder.uri.toString(true);
}

function validateRange(document: vscode.TextDocument, range: BridgeRange): vscode.Range {
  const start = validatePosition(document, range.start);
  const end = validatePosition(document, range.end);
  if (start.isAfter(end)) {
    throw new BridgeError("POSITION_OUT_OF_RANGE", "The requested range starts after it ends.");
  }
  return new vscode.Range(start, end);
}

function validatePosition(
  document: vscode.TextDocument,
  position: { line: number; character: number },
): vscode.Position {
  if (position.line >= document.lineCount) {
    throw new BridgeError("POSITION_OUT_OF_RANGE", "The requested line is outside the document.");
  }
  if (position.character > document.lineAt(position.line).text.length) {
    throw new BridgeError("POSITION_OUT_OF_RANGE", "The requested character is outside the line.");
  }
  return new vscode.Position(position.line, position.character);
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
}

function toDiagnosticItem(uri: vscode.Uri, diagnostic: vscode.Diagnostic): DiagnosticItem {
  const code = diagnostic.code;
  const codeValue =
    code === undefined
      ? null
      : typeof code === "object"
        ? String(code.value)
        : String(code);
  const codeDescription = (diagnostic as vscode.Diagnostic & {
    codeDescription?: { href: vscode.Uri };
  }).codeDescription;

  return {
    uri: uri.toString(true),
    range: toRange(diagnostic.range),
    message: diagnostic.message,
    severity: diagnosticSeverityName(diagnostic.severity),
    source: diagnostic.source ?? null,
    code: codeValue,
    codeDescriptionUri:
      codeDescription?.href.toString(true) ??
      (typeof code === "object" ? code.target.toString(true) : null),
    tags: (diagnostic.tags ?? []).map((tag) =>
      tag === vscode.DiagnosticTag.Deprecated ? "deprecated" : "unnecessary",
    ),
    relatedInformation: (diagnostic.relatedInformation ?? []).map((information) => ({
      uri: information.location.uri.toString(true),
      range: toRange(information.location.range),
      message: information.message,
    })),
  };
}

function diagnosticSeverityName(
  severity: vscode.DiagnosticSeverity,
): "error" | "warning" | "information" | "hint" {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    default:
      return "hint";
  }
}

function compareDiagnostics(left: DiagnosticItem, right: DiagnosticItem): number {
  return (
    left.uri.localeCompare(right.uri) ||
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    left.severity.localeCompare(right.severity) ||
    left.message.localeCompare(right.message)
  );
}

function normalizeSymbols(
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
): DocumentSymbolItem[] {
  const normalized: DocumentSymbolItem[] = [];
  for (const symbol of symbols) {
    if ("selectionRange" in symbol) {
      appendDocumentSymbol(normalized, symbol, 0, null);
    } else {
      normalized.push({
        name: symbol.name,
        detail: null,
        kind: symbolKindName(symbol.kind),
        containerName: symbol.containerName || null,
        depth: 0,
        range: toRange(symbol.location.range),
        selectionRange: toRange(symbol.location.range),
      });
    }
  }
  return normalized;
}

function appendDocumentSymbol(
  target: DocumentSymbolItem[],
  symbol: vscode.DocumentSymbol,
  depth: number,
  containerName: string | null,
): void {
  target.push({
    name: symbol.name,
    detail: symbol.detail || null,
    kind: symbolKindName(symbol.kind),
    containerName,
    depth,
    range: toRange(symbol.range),
    selectionRange: toRange(symbol.selectionRange),
  });
  for (const child of symbol.children) {
    appendDocumentSymbol(target, child, depth + 1, symbol.name);
  }
}

function symbolKindName(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind] ?? `Unknown(${kind})`;
}

function toLocationItem(location: vscode.Location | vscode.LocationLink): LocationItem {
  if ("targetUri" in location) {
    return {
      uri: location.targetUri.toString(true),
      range: toRange(location.targetSelectionRange ?? location.targetRange),
    };
  }
  return {
    uri: location.uri.toString(true),
    range: toRange(location.range),
  };
}

function deduplicateLocations(locations: readonly LocationItem[]): LocationItem[] {
  const keyed = new Map<string, LocationItem>();
  for (const location of locations) {
    keyed.set(
      `${location.uri}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`,
      location,
    );
  }
  return [...keyed.values()].sort(
    (left, right) =>
      left.uri.localeCompare(right.uri) ||
      left.range.start.line - right.range.start.line ||
      left.range.start.character - right.range.start.character ||
      left.range.end.line - right.range.end.line ||
      left.range.end.character - right.range.end.character,
  );
}

function sanitizeHoverMarkdown(value: string): string {
  return value.replace(/command:[^)\s]+/giu, "command:[redacted]");
}

function hoverContentValue(
  content: vscode.MarkdownString | string | { language: string; value: string },
): string {
  if (typeof content === "string") {
    return content;
  }
  return content.value;
}

function assertLocalExtensionHost(): void {
  if (vscode.env.remoteName) {
    throw new BridgeError(
      "UNSUPPORTED_REMOTE",
      `VS Code remote context ${vscode.env.remoteName} is not supported by this release.`,
    );
  }
}

function toRange(range: vscode.Range): BridgeRange {
  return {
    start: toPosition(range.start),
    end: toPosition(range.end),
  };
}

function toPosition(position: vscode.Position): { line: number; character: number } {
  return { line: position.line, character: position.character };
}
