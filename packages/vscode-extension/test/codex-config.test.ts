import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MCP_TOOL_NAMES } from "@vscode-agent-bridge/protocol";

import {
  CodexConfigConflictError,
  createManagedConfigBlock,
  inspectManagedConfigText,
  removeManagedConfigText,
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
    const executable = { url: "http://127.0.0.1:54321/mcp", token: "a".repeat(64) };
    const result = updateManagedConfigText(source, executable);

    expect(result).toStartWith(source);
    expect(result).toContain("[mcp_servers.vscode_agent_bridge]");
    expect(result).not.toContain("default_tools_approval_mode");
    for (const toolName of MCP_TOOL_NAMES) {
      expect(result).toContain(toolName);
    }
    expect(result).not.toMatch(/^cwd\s*=/mu);
    expect(inspectManagedConfigText(result, executable)).toBe("current");
  });

  test("delegates approval to Codex while enabling all annotated tools", () => {
    const executable = { url: "http://127.0.0.1:54321/mcp", token: "a".repeat(64) };
    const block = createManagedConfigBlock(executable);
    expect(block).not.toContain("default_tools_approval_mode");
    for (const toolName of MCP_TOOL_NAMES) {
      expect(block).toContain(toolName);
    }
  });

  test("detects a pre-v0.7 managed block with extension-owned approval", () => {
    const executable = { url: "http://127.0.0.1:54321/mcp", token: "a".repeat(64) };
    const source = createManagedConfigBlock(executable).replace(
      "tool_timeout_sec = 120",
      'tool_timeout_sec = 120\ndefault_tools_approval_mode = "writes"',
    );
    expect(inspectManagedConfigText(source, executable)).toBe("outdated");
  });

  test("updates only the existing managed block", () => {
    const firstExecutable = { url: "http://127.0.0.1:54321/mcp", token: "a".repeat(64) };
    const nextExecutable = { url: "http://127.0.0.1:54322/mcp", token: "b".repeat(64) };
    const first = updateManagedConfigText("model = \"gpt-test\"\n", firstExecutable);
    const next = updateManagedConfigText(first, nextExecutable);

    expect(next).toContain("model = \"gpt-test\"");
    expect(next).not.toContain(firstExecutable.url);
    expect(inspectManagedConfigText(next, nextExecutable)).toBe("current");
    expect(inspectManagedConfigText(first, nextExecutable)).toBe("outdated");
  });

  test("refuses to overwrite an unmanaged table", () => {
    const source =
      "[mcp_servers.vscode_agent_bridge]\ncommand = \"C:/custom/bridge.exe\"\n";
    expect(() => updateManagedConfigText(source, { url: "http://127.0.0.1:54321/mcp", token: "a".repeat(64) })).toThrow(
      CodexConfigConflictError,
    );
    expect(inspectManagedConfigText(source, { url: "http://127.0.0.1:54321/mcp", token: "a".repeat(64) })).toBe(
      "conflict",
    );
  });

  test("refuses malformed TOML and malformed markers", () => {
    expect(() => updateManagedConfigText("invalid = [", { url: "http://127.0.0.1:54321/mcp", token: "a".repeat(64) })).toThrow();
    expect(
      inspectManagedConfigText("# vscode-agent-bridge:begin\n", { url: "http://127.0.0.1:54321/mcp", token: "a".repeat(64) }),
    ).toBe("conflict");
  });

  test("refuses markers that enclose unrelated settings during update, inspection and removal", () => {
    const connection = { url: "http://127.0.0.1:54321/mcp", token: "a".repeat(64) };
    for (const foreign of ['[plugins."keep"]\nenabled = true\n', '[mcp_servers.other]\ncommand = "other.exe"\n']) {
      const source = createManagedConfigBlock(connection).replace("# vscode-agent-bridge:end", foreign + "# vscode-agent-bridge:end");
      expect(() => updateManagedConfigText(source, connection)).toThrow(CodexConfigConflictError);
      expect(() => removeManagedConfigText(source)).toThrow(CodexConfigConflictError);
      expect(inspectManagedConfigText(source, connection)).toBe("conflict");
    }
  });

  test("removes only the managed block", () => {
    const source = updateManagedConfigText(
      "model = \"gpt-test\"\n",
      { url: "http://127.0.0.1:54321/mcp", token: "a".repeat(64) },
    );
    const result = removeManagedConfigText(source);

    expect(result).toContain("model = \"gpt-test\"");
    expect(result).not.toContain("vscode-agent-bridge:begin");
    expect(result).not.toContain("mcp_servers.vscode_agent_bridge");
  });

});
