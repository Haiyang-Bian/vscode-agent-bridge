import { ServiceManagementRequestSchema, type ServiceIdentity, type ServiceStatus } from "@vscode-agent-bridge/protocol";
import { HttpMcpRuntime } from "./http-runtime.js";
import { managementProof, validManagementProof } from "./service-auth.js";
import { waitForReady } from "./service-control.js";
import { ServiceError } from "./service-errors.js";
import { readIdentity, resolveServicePaths, type ServicePaths } from "./service-state.js";
import { WindowsControlPipe } from "./windows-service-native.js";

export async function serve(paths?: ServicePaths, identity?: ServiceIdentity): Promise<ServiceStatus> {
  paths ??= await resolveServicePaths();
  identity ??= await readIdentity(paths);
  const runtime = new HttpMcpRuntime({ identity });
  let stopping: Promise<void> | undefined;
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const usedNonces = new Map<string, number>();
  const stop = () => {
    stopping ??= runtime.stop().finally(() => { owner?.close(); resolveExit(); });
    return stopping;
  };
  const owner = WindowsControlPipe.acquire(paths.endpoint, paths.userSid, message => {
    const parsed = ServiceManagementRequestSchema.safeParse(message);
    if (!parsed.success) return { error: "SERVICE_AUTHENTICATION_FAILED" };
    const request = parsed.data;
    const payload = { contractVersion: request.contractVersion, serviceId: request.serviceId, nonce: request.nonce, timestamp: request.timestamp,
      command: request.command, ...(request.expectedBootId ? { expectedBootId: request.expectedBootId } : {}) };
    const now = Date.now();
    for (const [nonce, time] of usedNonces) if (now - time > 30_000) usedNonces.delete(nonce);
    if (request.serviceId !== identity.serviceId || Math.abs(now - request.timestamp) > 30_000 || usedNonces.has(request.nonce) || usedNonces.size >= 256 ||
      !validManagementProof(request.proof, managementProof(identity.managementToken, "request", payload)) ||
      (request.command === "stop" && request.expectedBootId !== runtime.status.bootId)) {
      return { error: "SERVICE_AUTHENTICATION_FAILED" };
    }
    usedNonces.set(request.nonce, now);
    const status = runtime.status;
    if (parsed.data.command === "stop") setTimeout(() => { void stop(); }, 100);
    const response = { nonce: request.nonce, status };
    return { ...response, proof: managementProof(identity.managementToken, "response", response) };
  });
  if (!owner) return waitForReady(paths, identity);
  const onSignal = () => { void stop(); };
  try {
    try { runtime.start(); }
    catch { throw new ServiceError("SERVICE_PORT_IN_USE", "The configured HTTP port cannot be bound. The address was not changed."); }
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    await exited;
    await stopping;
    return runtime.status;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    owner.close();
  }
}
