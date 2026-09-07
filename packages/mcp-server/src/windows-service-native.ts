import { dlopen, ptr, type Pointer } from "bun:ffi";
import { SERVICE_LIMITS } from "@vscode-agent-bridge/protocol";
import { ServiceError } from "./service-errors.js";

// This adapter is loaded only by the Windows daemon/CLI, never by the extension.
const kernel = dlopen("kernel32.dll", {
  CreateNamedPipeW: { args: ["ptr", "u32", "u32", "u32", "u32", "u32", "u32", "ptr"], returns: "i64" },
  ConnectNamedPipe: { args: ["i64", "ptr"], returns: "bool" },
  DisconnectNamedPipe: { args: ["i64"], returns: "bool" },
  ReadFile: { args: ["i64", "ptr", "u32", "ptr", "ptr"], returns: "bool" },
  WriteFile: { args: ["i64", "ptr", "u32", "ptr", "ptr"], returns: "bool" },
  CloseHandle: { args: ["i64"], returns: "bool" },
  GetLastError: { args: [], returns: "u32" },
  LocalFree: { args: ["ptr"], returns: "ptr" },
});
const security = dlopen("advapi32.dll", {
  ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "bool" },
  GetSecurityDescriptorDacl: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "bool" },
  SetNamedSecurityInfoW: { args: ["ptr", "u32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
});

export function assertSid(sid: string): void {
  if (!/^S-1-(?:\d+-)+\d+$/u.test(sid)) throw permissionError();
}

function privateDescriptor(sid: string, directory: boolean): Pointer {
  assertSid(sid);
  const flags = directory ? "OICI" : "";
  const text = Buffer.from(`D:P(A;${flags};FA;;;${sid})(A;${flags};FA;;;SY)\0`, "utf16le");
  const result = new BigUint64Array(1);
  if (!security.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(text), 1, ptr(result), null)) throw permissionError();
  return Number(result[0]) as Pointer;
}

/** Replace the DACL, rather than merely adding grants to potentially broad ACLs. */
export function hardenPrivatePath(target: string, sid: string, directory: boolean): void {
  const descriptor = privateDescriptor(sid, directory);
  try {
    const present = new Uint32Array(1), defaulted = new Uint32Array(1), dacl = new BigUint64Array(1);
    if (!security.symbols.GetSecurityDescriptorDacl(descriptor, ptr(present), ptr(dacl), ptr(defaulted)) || !present[0]) throw permissionError();
    const targetBuffer = Buffer.from(`${target}\0`, "utf16le");
    // SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION.
    if (security.symbols.SetNamedSecurityInfoW(ptr(targetBuffer), 1, 0x80000004, null, null, Number(dacl[0]) as Pointer, null) !== 0) throw permissionError();
  } finally { kernel.symbols.LocalFree(descriptor); }
}

/** A single nonblocking, local-only pipe instance, held until close/process exit. */
export class WindowsControlPipe {
  readonly #handle: number | bigint;
  readonly #readBuffer = Buffer.alloc(SERVICE_LIMITS.managementMessageBytes);
  readonly #count = new Uint32Array(1);
  readonly #handler: (message: unknown) => unknown;
  readonly #timer: ReturnType<typeof setInterval>;
  #incoming = Buffer.alloc(0);
  #connectedAt = 0;
  #responded = false;
  #closed = false;

  private constructor(handle: number | bigint, handler: (message: unknown) => unknown) {
    this.#handle = handle;
    this.#handler = handler;
    this.#timer = setInterval(() => this.#poll(), 20);
  }

  static acquire(endpoint: string, sid: string, handler: (message: unknown) => unknown): WindowsControlPipe | null {
    const descriptor = privateDescriptor(sid, false);
    try {
      const attributes = Buffer.alloc(24); // SECURITY_ATTRIBUTES on Windows x64.
      attributes.writeUInt32LE(24, 0);
      attributes.writeBigUInt64LE(BigInt(descriptor), 8);
      const name = Buffer.from(`${endpoint}\0`, "utf16le");
      const handle = kernel.symbols.CreateNamedPipeW(
        ptr(name), 0x80003, 9, 1, SERVICE_LIMITS.managementMessageBytes,
        SERVICE_LIMITS.managementMessageBytes, 0, ptr(attributes),
      );
      // Every failure requires identity verification by the caller. Bun/libuv
      // error codes are deliberately not used as evidence of an existing daemon.
      return Number(handle) === -1 ? null : new WindowsControlPipe(handle, handler);
    } finally { kernel.symbols.LocalFree(descriptor); }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    kernel.symbols.CloseHandle(this.#handle);
  }

  #disconnect(): void {
    kernel.symbols.DisconnectNamedPipe(this.#handle);
    this.#incoming = Buffer.alloc(0);
    this.#connectedAt = 0;
    this.#responded = false;
  }

  #poll(): void {
    if (this.#closed) return;
    const connected = kernel.symbols.ConnectNamedPipe(this.#handle, null);
    const connectionError = connected ? 0 : kernel.symbols.GetLastError();
    if ((connected || connectionError === 535) && !this.#connectedAt) this.#connectedAt = Date.now();
    if (this.#connectedAt && Date.now() - this.#connectedAt > 2000) { this.#disconnect(); return; }
    const read = kernel.symbols.ReadFile(this.#handle, ptr(this.#readBuffer), this.#readBuffer.length, ptr(this.#count), null);
    if (!read) {
      const error = kernel.symbols.GetLastError();
      if (error === 109 || error === 232) this.#disconnect();
      return;
    }
    const bytes = this.#count[0] ?? 0;
    if (!bytes) return;
    if (this.#responded || this.#incoming.length + bytes > SERVICE_LIMITS.managementMessageBytes) { this.#disconnect(); return; }
    this.#incoming = Buffer.concat([this.#incoming, this.#readBuffer.subarray(0, bytes)]);
    const newline = this.#incoming.indexOf(10);
    if (newline < 0) return;
    if (newline !== this.#incoming.length - 1) { this.#disconnect(); return; }
    let result: unknown;
    try { result = this.#handler(JSON.parse(this.#incoming.toString("utf8"))); }
    catch { result = { error: "SERVICE_AUTHENTICATION_FAILED" }; }
    const response = Buffer.from(`${JSON.stringify(result)}\n`);
    if (response.length > SERVICE_LIMITS.managementMessageBytes) { this.#disconnect(); return; }
    const written = kernel.symbols.WriteFile(this.#handle, ptr(response), response.length, ptr(this.#count), null);
    if (!written || this.#count[0] !== response.length) { this.#disconnect(); return; }
    // Disconnecting here would discard unread response bytes. The client closes
    // after consuming its single response; a bounded timeout handles abandonment.
    this.#responded = true;
  }
}

function permissionError(): ServiceError {
  return new ServiceError("SERVICE_PERMISSION_DENIED", "Private Windows permissions could not be established.");
}
