import { spawn } from "node:child_process";

import { BridgeError } from "@vscode-agent-bridge/protocol";

export interface FixedProcessCommand {
  readonly executable: "whoami.exe" | "icacls.exe";
  readonly args: readonly string[];
}

export type FixedProcessRunner = (command: FixedProcessCommand) => Promise<string>;

const SYSTEM_SID = "S-1-5-18";

export function currentSidCommand(): FixedProcessCommand {
  return { executable: "whoami.exe", args: ["/user", "/fo", "csv", "/nh"] };
}

export function hardenAclCommand(
  targetPath: string,
  currentSid: string,
  directory: boolean,
): FixedProcessCommand {
  assertSid(currentSid);
  const permission = directory ? "(OI)(CI)F" : "(F)";
  return {
    executable: "icacls.exe",
    args: [
      targetPath,
      "/inheritance:r",
      "/grant:r",
      `*${currentSid}:${permission}`,
      `*${SYSTEM_SID}:${permission}`,
    ],
  };
}

export class WindowsIdentityAcl {
  readonly #runner: FixedProcessRunner;
  #sid: Promise<string> | null = null;

  constructor(runner: FixedProcessRunner = runFixedProcess) {
    this.#runner = runner;
  }

  async harden(targetPath: string, directory: boolean): Promise<void> {
    if (process.platform !== "win32") return;
    const sid = await (this.#sid ??= this.#loadSid());
    await this.#runner(hardenAclCommand(targetPath, sid, directory));
  }

  async #loadSid(): Promise<string> {
    const output = await this.#runner(currentSidCommand());
    const sid = parseWhoamiSid(output);
    if (!sid) throw new BridgeError("REGISTRY_PERMISSION_DENIED", "Windows did not return a valid current-user SID.");
    return sid;
  }
}

export function parseWhoamiSid(output: string): string | null {
  const match = output.match(/S-1-(?:\d+-)+\d+/u);
  if (!match) return null;
  try {
    assertSid(match[0]);
    return match[0];
  } catch {
    return null;
  }
}

export async function runFixedProcess(command: FixedProcessCommand): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (value: Buffer) => stdout.push(value));
    child.stderr.on("data", (value: Buffer) => stderr.push(value));
    child.once("error", () => reject(new BridgeError("REGISTRY_PERMISSION_DENIED", `${command.executable} could not start.`)));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new BridgeError(
          "REGISTRY_PERMISSION_DENIED",
          `${command.executable} rejected the fixed identity or ACL request: ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`,
        ));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

function assertSid(value: string): void {
  if (!/^S-1-(?:\d+-)+\d+$/u.test(value)) {
    throw new BridgeError("REGISTRY_PERMISSION_DENIED", "The Windows user SID is malformed.");
  }
}
