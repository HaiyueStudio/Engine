import type { Entity } from "./Entity";
import type { System } from "./System";
import type { World } from "./World";

export const EntitiesCache = new WeakMap<World, Set<Entity>>();
export const SystemOrderCache = new WeakMap<World, System[]>();

export function getEntitiesCache(world: World): Set<Entity> {
  let cache = EntitiesCache.get(world);
  if (!cache) {
    cache = new Set();
    EntitiesCache.set(world, cache);
  }
  return cache;
}

export function getSystemOrderCache(world: World): System[] {
  let cache = SystemOrderCache.get(world);
  if (!cache) {
    cache = [];
    SystemOrderCache.set(world, cache);
  }
  return cache;
}
