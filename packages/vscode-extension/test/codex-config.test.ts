import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MCP_TOOL_NAMES } from "@vscode-agent-bridge/protocol";

import {
  CodexConfigConflictError,
  createManagedConfigBlock,
  enabledToolsForPolicies,
  inspectManagedConfigText,
  removeCodexConfigBlock,
  removeManagedConfigText,
  updateCodexConfigFile,
  updateManagedConfigText,
} from "../src/codex-config.js";

let temporaryRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vscode-agent-bridge-config-test-"));
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("Codex managed MCP configuration", () => {
  test("adds a valid managed block without changing existing settings", () => {
    const source = "# keep this comment\nmodel = \"gpt-test\"\n";
    const executable = path.join(temporaryRoot, "bridge.exe");
    const result = updateManagedConfigText(source, executable);

    expect(result).toStartWith(source);
    expect(result).toContain("[mcp_servers.vscode_agent_bridge]");
    expect(result).toContain("default_tools_approval_mode = \"approve\"");
    for (const toolName of MCP_TOOL_NAMES) {
      expect(result).toContain(toolName);
    }
    expect(result).not.toMatch(/^cwd\s*=/mu);
    expect(inspectManagedConfigText(result, executable)).toBe("current");
  });

  test("maps autonomy and terminal policies to approval and bounded tool lists", () => {
    const executable = path.join(temporaryRoot, "bridge.exe");
    const autonomous = createManagedConfigBlock(executable, {
      autonomyProfile: "autonomous",
      terminalReadPolicy: "allow",
    });
    expect(autonomous).toContain('default_tools_approval_mode = "approve"');
    expect(autonomous).toContain("vscode_read_terminal_output");

    const review = createManagedConfigBlock(executable, {
      autonomyProfile: "review",
      terminalReadPolicy: "metadataOnly",
    });
    expect(review).toContain('default_tools_approval_mode = "writes"');
    expect(review).toContain("vscode_list_terminals");
    expect(review).not.toContain("vscode_list_terminal_executions");
    expect(review).not.toContain("vscode_read_terminal_output");

    const readOnlyTools = enabledToolsForPolicies({
      autonomyProfile: "readOnly",
      terminalReadPolicy: "allow",
    });
    expect(readOnlyTools).toContain("vscode_read_document");
    expect(readOnlyTools).toContain("vscode_list_code_actions");
    expect(readOnlyTools).toContain("vscode_list_terminals");
    expect(readOnlyTools).not.toContain("vscode_prepare_text_edits");
    expect(readOnlyTools).not.toContain("vscode_apply_change_set");
    expect(readOnlyTools).not.toContain("vscode_save_document");
    expect(readOnlyTools).not.toContain("vscode_read_terminal_output");

    const denied = createManagedConfigBlock(executable, {
      autonomyProfile: "autonomous",
      terminalReadPolicy: "deny",
    });
    expect(denied).not.toContain("vscode_list_terminals");
  });

  test("detects a managed block whose policy no longer matches", () => {
    const executable = path.join(temporaryRoot, "bridge.exe");
    const source = createManagedConfigBlock(executable, {
      autonomyProfile: "autonomous",
      terminalReadPolicy: "allow",
    });
    expect(
      inspectManagedConfigText(source, executable, {
        autonomyProfile: "review",
        terminalReadPolicy: "allow",
      }),
    ).toBe("outdated");
    expect(
      inspectManagedConfigText(source, executable, {
        autonomyProfile: "autonomous",
        terminalReadPolicy: "metadataOnly",
      }),
    ).toBe("outdated");
  });

  test("updates only the existing managed block", () => {
    const firstExecutable = path.join(temporaryRoot, "0.1.0", "bridge.exe");
    const nextExecutable = path.join(temporaryRoot, "0.2.0", "bridge.exe");
    const first = updateManagedConfigText("model = \"gpt-test\"\n", firstExecutable);
    const next = updateManagedConfigText(first, nextExecutable);

    expect(next).toContain("model = \"gpt-test\"");
    expect(next).not.toContain(firstExecutable.replaceAll("\\", "/"));
    expect(inspectManagedConfigText(next, nextExecutable)).toBe("current");
    expect(inspectManagedConfigText(first, nextExecutable)).toBe("outdated");
  });

  test("refuses to overwrite an unmanaged table", () => {
    const source =
      "[mcp_servers.vscode_agent_bridge]\ncommand = \"C:/custom/bridge.exe\"\n";
    expect(() => updateManagedConfigText(source, path.join(temporaryRoot, "bridge.exe"))).toThrow(
      CodexConfigConflictError,
    );
    expect(inspectManagedConfigText(source, path.join(temporaryRoot, "bridge.exe"))).toBe(
      "conflict",
    );
  });

  test("refuses malformed TOML and malformed markers", () => {
    expect(() => updateManagedConfigText("invalid = [", "C:/bridge.exe")).toThrow();
    expect(
      inspectManagedConfigText("# vscode-agent-bridge:begin\n", "C:/bridge.exe"),
    ).toBe("conflict");
  });

  test("removes only the managed block", () => {
    const source = updateManagedConfigText(
      "model = \"gpt-test\"\n",
      path.join(temporaryRoot, "bridge.exe"),
    );
    const result = removeManagedConfigText(source);

    expect(result).toContain("model = \"gpt-test\"");
    expect(result).not.toContain("vscode-agent-bridge:begin");
    expect(result).not.toContain("mcp_servers.vscode_agent_bridge");
  });

  test("backs up and atomically replaces an existing config file", async () => {
    const configPath = path.join(temporaryRoot, ".codex", "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "model = \"gpt-test\"\n", "utf8");

    const result = await updateCodexConfigFile(
      configPath,
      path.join(temporaryRoot, "bridge.exe"),
    );
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(await readFile(result.backupPath!, "utf8")).toBe("model = \"gpt-test\"\n");
    expect(await readFile(configPath, "utf8")).toContain("vscode-agent-bridge:begin");
    expect((await readdir(path.dirname(configPath))).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });

  test("does not create a backup for a new config file", async () => {
    const configPath = path.join(temporaryRoot, "new", "config.toml");
    const result = await updateCodexConfigFile(
      configPath,
      path.join(temporaryRoot, "bridge.exe"),
    );
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeUndefined();
  });

  test("removes only the managed block from disk and backs up the original", async () => {
    const configPath = path.join(temporaryRoot, ".codex", "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      updateManagedConfigText(
        "model = \"gpt-test\"\nanalytics.enabled = false\n",
        path.join(temporaryRoot, "bridge.exe"),
      ),
      "utf8",
    );

    const result = await removeCodexConfigBlock(configPath);
    const remaining = await readFile(configPath, "utf8");
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(remaining).toContain("model = \"gpt-test\"");
    expect(remaining).toContain("analytics.enabled = false");
    expect(remaining).not.toContain("vscode-agent-bridge:begin");
  });
});
