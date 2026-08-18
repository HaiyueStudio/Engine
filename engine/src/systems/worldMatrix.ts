import { Entity } from '../ecs/Entity';
import { Transform3D } from '../components/Transform3D';
import type { FrameData } from '../frame/FrameData';

export type WorldMatrixFrameCache = Map<Entity, Transform3D | null>;

export function updateEntityWorldMatrix(entity: Entity, cache?: WorldMatrixFrameCache, frameData?: FrameData): Transform3D | null {
  const transform = entity.getComponent(Transform3D);
  const activeFrameData = frameData ?? entity.usedBy[0]?.frameData;
  // FrameData owns its own stable entity/transform slots. Avoid refilling the
  // legacy per-call Map every frame when that device-independent cache exists.
  if (activeFrameData?.frameId) {
    if (transform) activeFrameData.transforms.getEntry(entity);
    return transform;
  }
  if (cache?.has(entity)) return cache.get(entity) ?? null;
  if (!transform) {
    cache?.set(entity, null);
    return null;
  }

  const parent = entity.parent as Entity | null;
  const parentTransform = parent ? updateEntityWorldMatrix(parent, cache, frameData) : null;
  transform.updateWorldMatrix(parentTransform?.worldMatrix, parentTransform?.worldVersion ?? 0);
  cache?.set(entity, transform);
  return transform;
}
