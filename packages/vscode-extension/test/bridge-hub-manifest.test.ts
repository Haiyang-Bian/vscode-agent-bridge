import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";

describe("VS Code Agent Bridge Hub manifest", () => {
  test("keeps the stable container ID while presenting the product name and five native views", async () => {
    const manifest = JSON.parse(
      await readFile(path.resolve(process.cwd(), "packages", "vscode-extension", "package.json"), "utf8"),
    ) as any;
    const container = manifest.contributes.viewsContainers.activitybar.find(
      (candidate: any) => candidate.id === "vscodeAgentBridgeExperiments",
    );
    expect(container.title).toBe("VS Code Agent Bridge");
    expect(manifest.contributes.views.vscodeAgentBridgeExperiments.map((view: any) => view.name)).toEqual([
      "Overview",
      "Experiments",
      "Agent Activity",
      "Capabilities",
      "Usage Insights",
    ]);
    const commands = new Set(manifest.contributes.commands.map((command: any) => command.command));
    expect(commands.has("vscodeAgentBridge.clearUsageInsights")).toBe(true);
    expect(commands.has("vscodeAgentBridge.exportUsageInsights")).toBe(true);
  });
});
