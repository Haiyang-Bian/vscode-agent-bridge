export interface PublishedBridgeLifecycle {
  markReady(): Promise<void>;
  markDegraded(): Promise<void>;
}

export async function initializePublishedBridge(
  host: PublishedBridgeLifecycle,
  publishInitializing: () => Promise<void>,
  initializeStorage: () => Promise<void>,
  reportDegraded: (error: unknown) => void,
): Promise<void> {
  await publishInitializing();
  try {
    await initializeStorage();
    await host.markReady();
  } catch (error) {
    await host.markDegraded();
    reportDegraded(error);
  }
}
