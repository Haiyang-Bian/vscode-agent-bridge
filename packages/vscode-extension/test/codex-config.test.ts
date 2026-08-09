import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CodexConfigConflictError,
  inspectManagedConfigText,
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
    expect(result).toContain("default_tools_approval_mode = \"writes\"");
    expect(result).toContain("vscode_get_hover");
    expect(inspectManagedConfigText(result, executable)).toBe("current");
  });

  test("updates only the existing managed block", () => {
    const firstExecutable = path.join(temporaryRoot, "0.1.0", "bridge.exe");
    const nextExecutable = path.join(temporaryRoot, "0.2.0", "bridge.exe");
    const first = updateManagedConfigText("model = \"gpt-test\"\n", firstExecutable);
    const next = updateManagedConfigText(first, nextExecutable);

    expect(next).toContain("model = \"gpt-test\"");
    expect(next).not.toContain(firstExecutable.replaceAll("\\", "/"));
    expect(inspectManagedConfigText(next, nextExecutable)).toBe("current");
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
});
