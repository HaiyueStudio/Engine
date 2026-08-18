import type { IEngine } from '../core/IEngine';
import type { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';
import type { EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import { isEntityDisabledInHierarchyCached } from '../ecs/utils/hierarchy';
import { Sky, getSkyEntityCandidates } from '../components/Sky';
import { SkyRenderer } from '../renderer/SkyRenderer';
import { MeshHelperRenderer } from '../renderer/MeshHelperRenderer';
import type { LiveIdSet } from '../renderer/utils';
import type { Render3DHelperItem } from './Render3DContracts';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';

interface MutableLiveIdSet extends LiveIdSet {
  add(id: number): void;
}

export interface Render3DScenePassRendererLiveSets {
  helperEntities: MutableLiveIdSet;
  helperGeometries: MutableLiveIdSet;
}

export class Render3DScenePassRenderer {
  private _cachedSkyEntity: Entity | null = null;
  private _cachedSky: Sky | null = null;
  private _skyRenderer: SkyRenderer | null = null;
  private _helperRenderer: MeshHelperRenderer | null = null;

  constructor(private readonly _engine: IEngine) {}

  contributePipelineWarmup(plan: PipelineWarmupPlan, reverseZ: boolean, msaaSamples: 1 | 4): void {
    if (!this._skyRenderer) {
      this._skyRenderer = new SkyRenderer();
      this._skyRenderer.prepare(this._engine);
    }
    this._skyRenderer.reverseZ = reverseZ;
    this._skyRenderer.msaaSamples = msaaSamples;
    this._skyRenderer.contributePipelineWarmup(plan);

    if (!this._helperRenderer) {
      this._helperRenderer = new MeshHelperRenderer();
      this._helperRenderer.prepare(this._engine);
    }
    this._helperRenderer.reverseZ = reverseZ;
    this._helperRenderer.msaaSamples = msaaSamples;
    this._helperRenderer.contributePipelineWarmup(plan);
  }

  renderSky(
    passEncoder: GPURenderPassEncoder,
    world: World,
    disabledHierarchyCache: EntityHierarchyDisabledCache,
    sceneFrameUniforms: SceneFrameUniformSnapshot,
    reverseZ: boolean,
    msaaSamples: 1 | 4,
  ): void {
    const sky = this._findSky(world, disabledHierarchyCache);
    if (!sky) return;
    if (!this._skyRenderer) {
      this._skyRenderer = new SkyRenderer();
      this._skyRenderer.prepare(this._engine);
    }
    this._skyRenderer.reverseZ = reverseZ;
    this._skyRenderer.msaaSamples = msaaSamples;
    this._skyRenderer.beginView(sceneFrameUniforms);
    this._skyRenderer.render(passEncoder, sky);
  }

  renderHelpers(
    passEncoder: GPURenderPassEncoder,
    helperItems: readonly Render3DHelperItem[],
    sceneFrameUniforms: SceneFrameUniformSnapshot,
    reverseZ: boolean,
    msaaSamples: 1 | 4,
    live: Render3DScenePassRendererLiveSets,
  ): void {
    if (helperItems.length < 1) return;
    if (!this._helperRenderer) {
      this._helperRenderer = new MeshHelperRenderer();
      this._helperRenderer.prepare(this._engine);
    }
    this._helperRenderer.reverseZ = reverseZ;
    this._helperRenderer.msaaSamples = msaaSamples;
    this._helperRenderer.beginView(sceneFrameUniforms);
    for (const { entityId, geometry, helper, worldMatrix } of helperItems) {
      if (!geometry || !helper || !worldMatrix) continue;
      live.helperEntities.add(entityId);
      live.helperGeometries.add(geometry.id);
      this._helperRenderer.render(passEncoder, entityId, geometry, helper, worldMatrix);
    }
  }

  releaseRendererCaches(live: Render3DScenePassRendererLiveSets): void {
    this._helperRenderer?.releaseEntitiesNotIn(live.helperEntities);
    this._helperRenderer?.releaseGeometriesNotIn(live.helperGeometries);
  }

  destroy(): void {
    this._skyRenderer?.destroy();
    this._helperRenderer?.destroy();
    this._skyRenderer = null;
    this._helperRenderer = null;
    this._cachedSkyEntity = null;
    this._cachedSky = null;
  }

  private _findSky(world: World, disabledHierarchyCache: EntityHierarchyDisabledCache): Sky | null {
    if (
      this._cachedSkyEntity &&
      world.entities.has(this._cachedSkyEntity.id) &&
      !isEntityDisabledInHierarchyCached(this._cachedSkyEntity, disabledHierarchyCache) &&
      this._cachedSky &&
      !this._cachedSky.disabled &&
      this._cachedSkyEntity.getComponent(Sky) === this._cachedSky
    ) {
      return this._cachedSky;
    }
    this._cachedSkyEntity = null;
    this._cachedSky = null;
    const candidates = getSkyEntityCandidates(world);
    if (!candidates) return null;
    for (const entity of candidates) {
      if (!world.entities.has(entity.id)) continue;
      if (isEntityDisabledInHierarchyCached(entity, disabledHierarchyCache)) continue;
      const sky = entity.getComponent(Sky);
      if (sky && !sky.disabled) {
        this._cachedSkyEntity = entity;
        this._cachedSky = sky;
        return sky;
      }
    }
    return null;
  }
}
