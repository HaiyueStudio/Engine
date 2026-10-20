import type { FrameData } from './FrameData';
import type { World } from '../ecs/World';
import { getSceneLightCandidates, getSceneRenderEnvironment } from './SceneRenderEnvironment';
import { DeferredLightTable, type DeferredLightSource } from './DeferredLightTable';

interface WorldLights {
  readonly table: DeferredLightTable;
  frameData: FrameData;
  frameId: number;
  phaseRevision: number;
  source: DeferredLightSource;
}
const worlds = new WeakMap<World, WorldLights>();

/** Loaded only by the experimental backend. Default Forward does no complete-table packing. */
export function getDeferredWorldLights(frameData: FrameData, world: World): DeferredLightSource {
  let owner = worlds.get(world);
  if (owner && owner.frameData === frameData && owner.frameId === frameData.frameId
    && owner.phaseRevision === frameData.phaseRevision) return owner.source;
  const table = owner?.table ?? new DeferredLightTable();
  const scene = getSceneRenderEnvironment(frameData, world);
  const source = table.update(getSceneLightCandidates(frameData, world), scene.shadowLights);
  if (!owner) {
    owner = { table, frameData, frameId: frameData.frameId, phaseRevision: frameData.phaseRevision, source };
    worlds.set(world, owner);
  } else {
    owner.frameData = frameData;
    owner.frameId = frameData.frameId;
    owner.phaseRevision = frameData.phaseRevision;
    owner.source = source;
  }
  return source;
}
