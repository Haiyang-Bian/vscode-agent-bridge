import * as vscode from "vscode";

export class LegacyExperimentData {
  readonly uri: vscode.Uri;

  constructor(globalStorageUri: vscode.Uri) {
    this.uri = vscode.Uri.joinPath(globalStorageUri, "experiments", "v1");
  }

  async exists(): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(this.uri);
      return (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
      return false;
    }
  }

  async openLocation(): Promise<void> {
    const target = (await this.exists()) ? this.uri : vscode.Uri.joinPath(this.uri, "..", "..");
    await vscode.env.openExternal(target);
  }

  async deleteInteractively(): Promise<boolean> {
    if (!(await this.exists())) return false;
    const first = await vscode.window.showWarningMessage(
      "Delete legacy VS Code Agent Bridge experiment metadata and snapshots? Git branches and worktrees are outside this location and will not be changed.",
      { modal: true },
      "Continue",
    );
    if (first !== "Continue") return false;
    const second = await vscode.window.showWarningMessage(
      "Permanently delete the legacy Bridge experiment data directory?",
      { modal: true },
      "Delete Legacy Data",
    );
    if (second !== "Delete Legacy Data") return false;
    await vscode.workspace.fs.delete(this.uri, { recursive: true, useTrash: false });
    return true;
  }
}
