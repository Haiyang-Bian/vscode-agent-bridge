import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";

export interface PrivatePathHardener {
  harden(targetPath: string, directory: boolean): Promise<void>;
}

export async function publishPrivateJson(
  targetPath: string,
  value: unknown,
  hardener: PrivatePathHardener,
): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hardener.harden(temporaryPath, false);
    await rename(temporaryPath, targetPath);
    try {
      await hardener.harden(targetPath, false);
    } catch (error) {
      await rm(targetPath, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
