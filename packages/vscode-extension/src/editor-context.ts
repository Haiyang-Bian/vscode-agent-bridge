import * as vscode from "vscode";

import type {
  EditorContext,
  EditorInfo,
  WorkspaceFolder,
} from "@vscode-agent-bridge/protocol";

export function getEditorContext(instanceId: string): EditorContext {
  return {
    instanceId,
    workspaceTrusted: vscode.workspace.isTrusted,
    remoteName: vscode.env.remoteName ?? null,
    workspaceFolders: getWorkspaceFolders(),
    activeEditor: vscode.window.activeTextEditor
      ? toEditorInfo(vscode.window.activeTextEditor)
      : null,
    visibleEditors: vscode.window.visibleTextEditors.map(toEditorInfo),
  };
}

export function getWorkspaceFolders(): WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    uri: folder.uri.toString(true),
    index: folder.index,
  }));
}

function toEditorInfo(editor: vscode.TextEditor): EditorInfo {
  const document = editor.document;

  return {
    uri: document.uri.toString(true),
    languageId: document.languageId,
    documentVersion: document.version,
    isDirty: document.isDirty,
    isUntitled: document.isUntitled,
    eol: document.eol === vscode.EndOfLine.CRLF ? "CRLF" : "LF",
    viewColumn: editor.viewColumn ?? null,
    selection: {
      anchor: toPosition(editor.selection.anchor),
      active: toPosition(editor.selection.active),
    },
    visibleRanges: editor.visibleRanges.map((range) => ({
      start: toPosition(range.start),
      end: toPosition(range.end),
    })),
  };
}

function toPosition(position: vscode.Position): { line: number; character: number } {
  return {
    line: position.line,
    character: position.character,
  };
}
