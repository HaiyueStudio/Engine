import type { Render3DSubmitter, Render3DSubmitterOptions } from './Render3DSubmitter';
import type { PbrRenderer } from '../renderer/PbrRenderer';
import type { IEngine } from '../core/IEngine';
import { SCENE_COLOR_FORMAT } from '../postprocess/SceneColor';
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
import type { DeferredLightingBackendPort, DeferredLightingRecordInput } from '../renderer/DeferredLightingBackendPort';
import type { Render3DPostScenePasses } from './Render3DPostScenePasses';

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

  /** Adapts the existing sky/output owners to an optional lighting provider. */
  renderDeferred(backend: DeferredLightingBackendPort, input: Omit<DeferredLightingRecordInput,
    'engine' | 'drawSky' | 'applyViewport' | 'sceneDescriptor' | 'sceneLoadDescriptor' | 'drawOpaque' | 'drawOpaqueForward' | 'drawTransparent' | 'prepareTransparent'> & {
      postScene: Render3DPostScenePasses;
      submitter: Render3DSubmitter;
      submitterOptions: Render3DSubmitterOptions;
      pbrRenderer: PbrRenderer;
      viewProj: Float32Array;
      viewMatrix: Float32Array;
      disabledCache: EntityHierarchyDisabledCache;
    }): boolean {
    const { postScene, disabledCache, submitter, submitterOptions, pbrRenderer, viewProj, viewMatrix, ...record } = input;
    return backend.record({ ...record, engine: this._engine,
      drawOpaque: pass => submitter.drawOpaqueItems(input.opaqueItems, pass, viewProj, viewMatrix, submitterOptions),
      drawOpaqueForward: (pass, indices) => {
        for (const index of indices) submitter.drawItemRun(input.opaqueItems, pass, viewProj, viewMatrix, index, 1, submitterOptions);
      },
      prepareTransparent: () => pbrRenderer.setTransmissionFramebuffer(input.needsSceneColorCapture
        ? postScene.captureSceneColor(input.context.encoder) : null),
      drawTransparent: pass => {
        submitter.drawDepthPrepassItems(input.transparentItems, pass, viewProj, viewMatrix, submitterOptions);
        submitter.drawTransparentItems(input.transparentItems, pass, viewProj, viewMatrix, input.opaqueItems.length, submitterOptions);
      },
      sceneDescriptor: postScene.buildScenePassDescriptor('clear', input.view.reverseZ, input.context.view, input.needsSceneColorCapture),
      sceneLoadDescriptor: () => postScene.buildScenePassDescriptor('load', input.view.reverseZ, input.context.view, input.needsSceneColorCapture),
      applyViewport: pass => postScene.applySceneViewport(pass, input.view),
      drawSky: pass => this.renderSky(pass, input.world, disabledCache, input.sceneFrame, input.view.reverseZ, input.view.sampleCount),
    });
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan, reverseZ: boolean, msaaSamples: 1 | 4): void {
    if (!this._skyRenderer) {
      this._skyRenderer = new SkyRenderer();
      this._skyRenderer.colorFormat = SCENE_COLOR_FORMAT;
      this._skyRenderer.prepare(this._engine);
    }
    this._skyRenderer.reverseZ = reverseZ;
    this._skyRenderer.msaaSamples = msaaSamples;
    this._skyRenderer.contributePipelineWarmup(plan);

    if (!this._helperRenderer) {
      this._helperRenderer = new MeshHelperRenderer();
      this._helperRenderer.colorFormat = SCENE_COLOR_FORMAT;
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
      this._skyRenderer.colorFormat = SCENE_COLOR_FORMAT;
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
      this._helperRenderer.colorFormat = SCENE_COLOR_FORMAT;
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
