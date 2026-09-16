import { createHmac, timingSafeEqual } from "node:crypto";

/** Domain-separated message authentication; the management secret never leaves its private file. */
export function managementProof(secret: string, direction: "request" | "response", payload: unknown): string {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(`VSCodeAgentBridge/service-v1/${direction}\n`).update(JSON.stringify(payload)).digest("hex");
}
export function validManagementProof(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "hex"), b = Buffer.from(expected, "hex");
  return a.length === 32 && a.length === b.length && timingSafeEqual(a, b);
}
