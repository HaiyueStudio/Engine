import type { World } from './World';

const structureVersions = new WeakMap<World, number>();

/** Internal monotonic entity/component revision used to invalidate frame caches. */
export function bumpWorldStructureVersion(world: World): void {
  const next = ((structureVersions.get(world) ?? 0) + 1) >>> 0;
  structureVersions.set(world, next === 0 ? 1 : next);
}

export function getWorldStructureVersion(world: World): number {
  return structureVersions.get(world) ?? 0;
}
