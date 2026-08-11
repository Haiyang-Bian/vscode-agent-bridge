import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CanonicalPathBoundary, isContained } from "../src/canonical-path-boundary.js";

describe("canonical workspace path boundary", () => {
  test("accepts existing and missing descendants but rejects lexical escapes", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "bridge-canonical-"));
    try {
      const root = path.join(temporary, "root");
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(path.join(root, "src", "index.ts"), "export {};\n");
      const boundary = new CanonicalPathBoundary([root]);
      expect((await boundary.assertPath(path.join(root, "src", "index.ts"))).exists).toBeTrue();
      expect((await boundary.assertPath(path.join(root, "missing", "next.ts"), true)).exists).toBeFalse();
      await expect(boundary.assertPath(path.join(root, "..", "escape.ts"), true)).rejects.toMatchObject({ code: "RESOURCE_OUT_OF_SCOPE" });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects a symlink or Windows junction anywhere in the ancestor chain", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "bridge-reparse-"));
    try {
      const root = path.join(temporary, "root");
      const outside = path.join(temporary, "outside");
      await mkdir(root);
      await mkdir(outside);
      await writeFile(path.join(outside, "secret.txt"), "secret");
      const linked = path.join(root, "linked");
      await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
      await expect(new CanonicalPathBoundary([root]).assertPath(path.join(linked, "secret.txt"))).rejects.toMatchObject({ code: "RESOURCE_OUT_OF_SCOPE" });
      await expect(new CanonicalPathBoundary([root]).assertPath(path.join(linked, "missing", "new.txt"), true)).rejects.toMatchObject({ code: "RESOURCE_OUT_OF_SCOPE" });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("normalizes Windows case without accepting cross-drive or UNC-prefix escapes", () => {
    expect(isContained("C:\\Workspace", "C:\\Workspace\\src\\index.ts")).toBe(process.platform === "win32");
    expect(isContained("C:\\Workspace", "c:\\workspace\\SRC\\index.ts")).toBe(process.platform === "win32");
    expect(isContained("C:\\Workspace", "D:\\Workspace\\index.ts")).toBeFalse();
    expect(isContained("C:\\Workspace", "\\\\server\\share\\Workspace\\index.ts")).toBeFalse();
    expect(isContained("\\\\server\\share\\Workspace", "\\\\server\\share\\workspace\\src\\index.ts")).toBe(process.platform === "win32");
    expect(isContained("\\\\server\\share\\Workspace", "\\\\server\\other\\Workspace\\index.ts")).toBeFalse();
  });

  test("revalidates a path after a regular ancestor becomes a reparse point", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "bridge-revalidate-"));
    try {
      const root = path.join(temporary, "root");
      const ancestor = path.join(root, "target");
      const outside = path.join(temporary, "outside");
      await mkdir(ancestor, { recursive: true });
      await mkdir(outside);
      const boundary = new CanonicalPathBoundary([root]);
      expect((await boundary.assertPath(path.join(ancestor, "new.txt"), true)).exists).toBeFalse();
      await rm(ancestor, { recursive: true });
      await symlink(outside, ancestor, process.platform === "win32" ? "junction" : "dir");
      await expect(boundary.assertPath(path.join(ancestor, "new.txt"), true)).rejects.toMatchObject({
        code: "RESOURCE_OUT_OF_SCOPE",
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
