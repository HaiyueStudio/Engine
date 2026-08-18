import { Entity } from '../Entity';

export interface EntityHierarchyDisabledCacheEntry {
  version: number;
  disabled: boolean;
}

export type EntityHierarchyDisabledCache = Map<number, EntityHierarchyDisabledCacheEntry>;

export function isEntityDisabledInHierarchy(entity: Entity): boolean {
  let current: Entity | null = entity;
  while (current) {
    if (current.disabled) return true;
    current = current.parent as Entity | null;
  }
  return false;
}

export function isEntityDisabledInHierarchyCached(
  entity: Entity,
  cache: EntityHierarchyDisabledCache,
): boolean {
  const cached = cache.get(entity.id);
  if (cached && cached.version === entity.hierarchyVersion) return cached.disabled;

  const parent = entity.parent as Entity | null;
  const disabled = entity.disabled || (parent ? isEntityDisabledInHierarchyCached(parent, cache) : false);
  cache.set(entity.id, { version: entity.hierarchyVersion, disabled });
  return disabled;
}

export function sweepEntityHierarchyDisabledCache(
  cache: EntityHierarchyDisabledCache,
  liveEntities: ReadonlyMap<number, Entity>,
): void {
  for (const entityId of cache.keys()) {
    if (!liveEntities.has(entityId)) cache.delete(entityId);
  }
}
