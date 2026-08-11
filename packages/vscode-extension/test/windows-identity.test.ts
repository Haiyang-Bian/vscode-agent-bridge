import { describe, expect, test } from "bun:test";

import {
  currentSidCommand,
  hardenAclCommand,
  parseWhoamiSid,
} from "../src/windows-identity.js";

describe("fixed Windows identity and descriptor ACL commands", () => {
  test("uses whoami.exe without a shell and parses only SID-shaped output", () => {
    expect(currentSidCommand()).toEqual({
      executable: "whoami.exe",
      args: ["/user", "/fo", "csv", "/nh"],
    });
    expect(parseWhoamiSid('"DESKTOP\\alice","S-1-5-21-1-2-3-1001"\r\n')).toBe("S-1-5-21-1-2-3-1001");
    expect(parseWhoamiSid("not a sid")).toBeNull();
  });

  test("removes inheritance and grants only the current SID plus SYSTEM", () => {
    const command = hardenAclCommand("C:\\registry\\instance.json", "S-1-5-21-1-2-3-1001", false);
    expect(command.executable).toBe("icacls.exe");
    expect(command.args).toEqual([
      "C:\\registry\\instance.json",
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-21-1-2-3-1001:(F)",
      "*S-1-5-18:(F)",
    ]);
    expect(command.args.join(" ")).not.toMatch(/Users|Everyone|Authenticated Users/iu);
  });
});
