import { AsyncLocalStorage } from "node:async_hooks";

const requestSignals = new AsyncLocalStorage<AbortSignal>();

export function withBridgeRequestSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return requestSignals.run(signal, operation);
}

export function bridgeRequestSignal(explicit?: AbortSignal): AbortSignal | undefined {
  const scoped = requestSignals.getStore();
  return explicit && scoped ? AbortSignal.any([explicit, scoped]) : explicit ?? scoped;
}
