import { expect, test } from "bun:test";
import { prepareHiddenWindowsExecutable, verifyHiddenWindowsExecutable } from "./windows-executable.ts";

function image(length = 1024): Buffer {
  const bytes = Buffer.alloc(length, 0);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(0x8664, 132);
  bytes.writeUInt16LE(240, 148);
  bytes.writeUInt16LE(0x20b, 152);
  bytes.writeUInt16LE(3, 220);
  bytes.writeUInt32LE(16, 260);
  bytes.fill(0xa5, 512);
  return bytes;
}

test("changes only the GUI subsystem and checksum, preserving the bundled payload", () => {
  for (const length of [1024, 1025]) {
    const bytes = image(length);
    const original = Buffer.from(bytes);
    expect(() => verifyHiddenWindowsExecutable(bytes)).toThrow("GUI subsystem");
    prepareHiddenWindowsExecutable(bytes);
    verifyHiddenWindowsExecutable(bytes);
    expect(bytes.readUInt16LE(220)).toBe(2);
    const prepared = Buffer.from(bytes);
    prepareHiddenWindowsExecutable(bytes);
    expect(bytes).toEqual(prepared);
    original.copy(bytes, 216, 216, 222);
    expect(bytes).toEqual(original);
  }
});

test("detects payload corruption after checksum publication", () => {
  const bytes = image();
  prepareHiddenWindowsExecutable(bytes);
  bytes[800] = 0;
  expect(() => verifyHiddenWindowsExecutable(bytes)).toThrow("checksum mismatch");
});

test("rejects malformed, non-x64 and signed PE images before modification", () => {
  const invalid = [Buffer.alloc(0), Buffer.alloc(64), image().subarray(0, 200)];
  const corruptions = [
    (bytes: Buffer) => bytes.writeUInt32LE(0xffffffff, 60),
    (bytes: Buffer) => bytes.writeUInt32LE(0, 128),
    (bytes: Buffer) => bytes.writeUInt16LE(0x14c, 132),
    (bytes: Buffer) => bytes.writeUInt16LE(0x10b, 152),
    (bytes: Buffer) => bytes.writeUInt32LE(4096, 296),
    (bytes: Buffer) => bytes.writeUInt16LE(1, 220),
  ];
  for (const corrupt of corruptions) {
    const bytes = image();
    corrupt(bytes);
    invalid.push(bytes);
  }
  for (const bytes of invalid) {
    const original = Buffer.from(bytes);
    expect(() => prepareHiddenWindowsExecutable(bytes)).toThrow();
    expect(bytes).toEqual(original);
  }
});
