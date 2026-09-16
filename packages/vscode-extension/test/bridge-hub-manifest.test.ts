import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";

describe("VS Code Agent Bridge manifest", () => {
  test("exposes only Status and Agent Activity without experiment settings", async () => {
    const manifest = JSON.parse(
      await readFile(path.resolve(process.cwd(), "packages", "vscode-extension", "package.json"), "utf8"),
    ) as any;
    const container = manifest.contributes.viewsContainers.activitybar.find(
      (candidate: any) => candidate.id === "vscodeAgentBridge",
    );
    expect(container.title).toBe("VS Code Agent Bridge");
    expect(manifest.contributes.views.vscodeAgentBridge.map((view: any) => view.name)).toEqual([
      "Status",
      "Agent Activity",
    ]);
    const commands = new Set(manifest.contributes.commands.map((command: any) => command.command));
    expect(commands.has("vscodeAgentBridge.clearUsageInsights")).toBe(true);
    expect(commands.has("vscodeAgentBridge.exportUsageInsights")).toBe(true);
    expect(commands.has("vscodeAgentBridge.openLegacyExperimentData")).toBe(true);
    expect(commands.has("vscodeAgentBridge.deleteLegacyExperimentData")).toBe(true);
    expect([...commands].some((command) => String(command).toLowerCase().includes("experiment"))).toBe(true);
    expect(manifest.contributes.configuration.properties).not.toHaveProperty("vscodeAgentBridge.experiments.enabled");
    expect(manifest.contributes.configuration.properties).not.toHaveProperty("vscodeAgentBridge.agentEditVisibility");
    expect(manifest.contributes.configuration.properties).not.toHaveProperty("vscodeAgentBridge.executionMode");
  });
});
