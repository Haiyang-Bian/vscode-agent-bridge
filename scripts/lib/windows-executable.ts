/** Build-only PE handling; never modify an installed or signed executable. */
function headerOffsets(bytes: Buffer): { optional: number; checksum: number; subsystem: number } {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("Expected a Windows executable with an MZ header.");
  }
  const pe = bytes.readUInt32LE(60);
  if (pe < 64 || pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) {
    throw new Error("Invalid PE header bounds or signature.");
  }
  const optional = pe + 24;
  const size = bytes.readUInt16LE(pe + 20);
  if (bytes.readUInt16LE(pe + 4) !== 0x8664 || size < 152 || optional + size > bytes.length ||
      bytes.readUInt16LE(optional) !== 0x20b || bytes.readUInt32LE(optional + 108) < 5) {
    throw new Error("Expected a complete x64 PE32+ optional header.");
  }
  // IMAGE_DIRECTORY_ENTRY_SECURITY is a file offset and size, not an RVA.
  if (bytes.readUInt32LE(optional + 144) !== 0 || bytes.readUInt32LE(optional + 148) !== 0) {
    throw new Error("Refusing to modify or accept a pre-signed build output.");
  }
  return { optional, checksum: optional + 64, subsystem: optional + 68 };
}

function calculateChecksum(bytes: Buffer, checksumOffset: number): number {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 2) {
    if (offset === checksumOffset || offset === checksumOffset + 2) continue;
    sum += bytes[offset]! + ((bytes[offset + 1] ?? 0) << 8);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return (((sum & 0xffff) + (sum >>> 16)) + bytes.length) >>> 0;
}

export function prepareHiddenWindowsExecutable(bytes: Buffer): void {
  const offsets = headerOffsets(bytes);
  const subsystem = bytes.readUInt16LE(offsets.subsystem);
  if (subsystem !== 2 && subsystem !== 3) {
    throw new Error("Expected a Windows GUI or console build output.");
  }
  // Bun 1.3.11 ignores compile.windows.hideConsole. Upstream fix: oven-sh/bun#36292.
  // Keep the pinned toolchain and apply that narrow PE correction before hashing.
  bytes.writeUInt16LE(2, offsets.subsystem); // IMAGE_SUBSYSTEM_WINDOWS_GUI
  bytes.writeUInt32LE(calculateChecksum(bytes, offsets.checksum), offsets.checksum);
}

export function verifyHiddenWindowsExecutable(bytes: Buffer): void {
  const offsets = headerOffsets(bytes);
  if (bytes.readUInt16LE(offsets.subsystem) !== 2) {
    throw new Error("MCP executable must use the Windows GUI subsystem (no console).");
  }
  if (bytes.readUInt32LE(offsets.checksum) !== calculateChecksum(bytes, offsets.checksum)) {
    throw new Error("MCP executable PE checksum mismatch.");
  }
}

/** Independent artifact check using Windows ImageHlp, not the build algorithm. */
export async function verifyNativeWindowsChecksum(executablePath: string): Promise<void> {
  if (process.platform !== "win32") return;
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const library = dlopen("imagehlp.dll", {
    MapFileAndCheckSumW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
  });
  try {
    const fileName = Buffer.from(`${executablePath}\0`, "utf16le");
    const header = new Uint32Array(1);
    const computed = new Uint32Array(1);
    const result = library.symbols.MapFileAndCheckSumW(ptr(fileName), ptr(header), ptr(computed));
    if (result !== 0 || header[0] !== computed[0]) {
      throw new Error("Windows ImageHlp rejected the MCP executable checksum.");
    }
  } finally {
    library.close();
  }
}
