type WorldResourceCleanup = () => void;

const cleanupsByWorld = new WeakMap<object, Map<object, WorldResourceCleanup>>();

/** Internal ownership bridge that keeps the ECS World independent of optional services. */
export function registerWorldResourceCleanup(
  world: object,
  resourceKey: object,
  cleanup: WorldResourceCleanup,
): void {
  let cleanups = cleanupsByWorld.get(world);
  if (!cleanups) {
    cleanups = new Map();
    cleanupsByWorld.set(world, cleanups);
  }
  cleanups.set(resourceKey, cleanup);
}

export function unregisterWorldResourceCleanup(world: object, resourceKey: object): void {
  const cleanups = cleanupsByWorld.get(world);
  if (!cleanups) return;
  cleanups.delete(resourceKey);
  if (cleanups.size === 0) cleanupsByWorld.delete(world);
}

export function destroyWorldResources(world: object): void {
  const cleanups = cleanupsByWorld.get(world);
  if (!cleanups) return;
  // Delete before invoking callbacks so cleanup remains idempotent and a
  // callback cannot be visited twice if it unregisters itself.
  cleanupsByWorld.delete(world);
  for (const cleanup of cleanups.values()) cleanup();
}
