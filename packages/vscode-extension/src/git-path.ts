import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

export async function canonicalizeExistingPath(value: string): Promise<string> {
  return path.resolve(await realpath(path.resolve(value)));
}

export function pathForComparison(value: string): string {
  const resolved = path.resolve(value);
  try {
    return path.resolve(realpathSync.native(resolved));
  } catch {
    return resolved;
  }
}

export function samePath(left: string, right: string): boolean {
  const normalizedLeft = pathForComparison(left);
  const normalizedRight = pathForComparison(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(pathForComparison(root), pathForComparison(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
