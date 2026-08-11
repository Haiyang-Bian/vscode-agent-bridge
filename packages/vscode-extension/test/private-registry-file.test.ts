import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { publishPrivateJson, type PrivatePathHardener } from "../src/private-registry-file.js";

describe("private registry file publication", () => {
  test("hardens before and after atomic publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-private-registry-"));
    const target = path.join(root, "instance.json");
    const hardened: string[] = [];
    const hardener: PrivatePathHardener = {
      harden: async (targetPath) => { hardened.push(targetPath); },
    };
    try {
      await publishPrivateJson(target, { authToken: "secret" }, hardener);
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ authToken: "secret" });
      expect(hardened).toHaveLength(2);
      expect(hardened[0]).toEndWith(".tmp");
      expect(hardened[1]).toBe(target);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes the published token when the post-rename ACL check fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-private-registry-"));
    const target = path.join(root, "instance.json");
    let calls = 0;
    const hardener: PrivatePathHardener = {
      harden: async () => {
        calls += 1;
        if (calls === 2) throw new Error("ACL rejected");
      },
    };
    try {
      await expect(publishPrivateJson(target, { authToken: "secret" }, hardener)).rejects.toThrow("ACL rejected");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
