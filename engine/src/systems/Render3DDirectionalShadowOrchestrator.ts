import type { RenderCommandContext } from '../core/RenderCommandContext';
import { Frustum } from '../culling/Frustum';
import type { FrameData } from '../frame/FrameData';
import {
  SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS,
  type SceneRenderEnvironment,
} from '../frame/SceneRenderEnvironment';
import type { DirectionalLight } from '../lighting/DirectionalLight';
import type { Material } from '../material/Material';
import {
  DIRECTIONAL_SHADOW_FOCUS_ORIGIN,
  writeDirectionalShadowViewProjection,
} from '../renderer/DirectionalShadowMath';
import type { DirectionalShadowState, ShadowMapRenderer } from '../renderer/ShadowMapRenderer';
import { mat4 } from 'wgpu-matrix';
import type { WorldFrameState } from './Render3DFrameState';
import {
  Render3DSceneCollector,
  type Render3DShadowCollectionOptions,
} from './Render3DSceneCollector';
import type { Render3DRenderItem } from './Render3DContracts';
import { Render3DDirectionalShadowCache } from './Render3DDirectionalShadowCache';

export interface Render3DDirectionalShadowOrchestratorOptions {
  readonly collector: Render3DSceneCollector;
  readonly collection: Omit<Render3DShadowCollectionOptions, 'frameData' | 'shadowItems' | 'containsSphere'>;
  readonly getRenderer: () => ShadowMapRenderer;
  readonly resolveShadowCullMode: (material: Material) => GPUCullMode | null;
}

/**
 * Owns camera-independent directional-shadow collection, cache validation,
 * rendering, diagnostics, and device-loss reset.
 */
export class Render3DDirectionalShadowOrchestrator {
  private readonly _slots: DirectionalShadowSlot[];
  private readonly _shadows: (DirectionalShadowState | null)[] = Array.from(
    { length: SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS },
    () => null,
  );
  private _revision = 0;

  passCount = 0;
  casterCount = 0;
  cacheHit = false;

  constructor(private readonly _options: Render3DDirectionalShadowOrchestratorOptions) {
    this._slots = Array.from({ length: SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS }, () => {
      const slot: DirectionalShadowSlot = {
        items: [],
        candidateFrustum: new Frustum(),
        view: mat4.identity() as Float32Array,
        projection: mat4.identity() as Float32Array,
        viewProjection: mat4.identity() as Float32Array,
        cache: new Render3DDirectionalShadowCache(),
        collection: null as unknown as Render3DShadowCollectionOptions,
        light: null,
        casterRevisionA: 0,
        casterRevisionB: 0,
        casterCount: 0,
        receiverCount: 0,
      };
      slot.collection = {
        ..._options.collection,
        frameData: null as unknown as FrameData,
        shadowItems: slot.items,
        containsSphere: sphere => slot.candidateFrustum.containsSphere(sphere),
      };
      return slot;
    });
  }

  get shadow(): DirectionalShadowState | null { return this._shadows[0] ?? null; }
  get shadows(): readonly (DirectionalShadowState | null)[] { return this._shadows; }
  get revision(): number { return this._revision; }

  collect(
    frameData: FrameData,
    worldFrameState: WorldFrameState,
    sceneEnvironment: SceneRenderEnvironment,
  ): boolean {
    this.passCount = 0;
    this.casterCount = 0;
    this.cacheHit = false;
    let hasRenderableShadow = false;
    let shadowStateChanged = false;

    for (let index = 0; index < this._slots.length; index++) {
      const slot = this._slots[index]!;
      slot.light = sceneEnvironment.shadowLights[index] ?? null;
      slot.items.length = 0;
      slot.casterRevisionA = 0;
      slot.casterRevisionB = 0;
      slot.casterCount = 0;
      slot.receiverCount = 0;
      if (!slot.light) {
        shadowStateChanged = this._clearSlot(index) || shadowStateChanged;
        continue;
      }

      writeDirectionalShadowViewProjection(
        slot.light,
        slot.viewProjection,
        slot.view,
        slot.projection,
      );
      slot.candidateFrustum.setFromViewProjection(slot.viewProjection);
      slot.collection.frameData = frameData;
      const stats = this._options.collector.collectShadowCasters(worldFrameState, slot.collection);
      slot.casterCount = stats.casterCount;
      slot.receiverCount = stats.receiverCount;
      slot.casterRevisionA = stats.revisionA;
      slot.casterRevisionB = stats.revisionB;
      this.casterCount += stats.casterCount;
      if (slot.items.length < 1 || slot.receiverCount < 1) {
        shadowStateChanged = this._clearSlot(index) || shadowStateChanged;
        continue;
      }
      hasRenderableShadow = true;
    }
    if (shadowStateChanged) this._revision = nextRevision(this._revision);
    return hasRenderableShadow;
  }

  render(context: RenderCommandContext): void {
    this.passCount = 0;
    this.cacheHit = false;
    let targetSize = 0;
    let renderableCount = 0;
    for (const slot of this._slots) {
      if (!this._isRenderable(slot)) continue;
      targetSize = Math.max(targetSize, slot.light!.shadow.mapSize);
      renderableCount++;
    }
    if (renderableCount === 0) return;

    const renderer = this._options.getRenderer();
    const targetChanged = typeof renderer.prepareTarget === 'function'
      ? renderer.prepareTarget(targetSize)
      : false;
    if (targetChanged) {
      for (const slot of this._slots) slot.cache.invalidate();
    }
    let cacheHits = 0;
    let changed = targetChanged;
    renderer.beginLayerBatch?.();
    try {
      for (let index = 0; index < this._slots.length; index++) {
        const slot = this._slots[index]!;
        if (!this._isRenderable(slot)) continue;
        const light = slot.light!;
        if (slot.cache.matches(
          light,
          !targetChanged && this._shadows[index] !== null,
          slot.casterRevisionA,
          slot.casterRevisionB,
          slot.casterCount,
        )) {
          cacheHits++;
          continue;
        }
        this._shadows[index] = typeof renderer.renderLayer === 'function'
          ? renderer.renderLayer(
            context.encoder,
            slot.items,
            light,
            index,
            context,
            DIRECTIONAL_SHADOW_FOCUS_ORIGIN,
            this._options.resolveShadowCullMode,
          )
          : renderer.render(
            context.encoder,
            slot.items,
            light,
            context,
            DIRECTIONAL_SHADOW_FOCUS_ORIGIN,
            this._options.resolveShadowCullMode,
          );
        slot.cache.store(light, slot.casterRevisionA, slot.casterRevisionB, slot.casterCount);
        this.passCount++;
        changed = true;
      }
    } finally {
      renderer.endLayerBatch?.();
    }
    this.cacheHit = cacheHits === renderableCount;
    if (changed) this._revision = nextRevision(this._revision);
  }

  clear(): void {
    this.passCount = 0;
    this.cacheHit = false;
    let changed = false;
    for (let index = 0; index < this._slots.length; index++) {
      changed = this._clearSlot(index) || changed;
    }
    if (changed) this._revision = nextRevision(this._revision);
  }

  reset(): void {
    for (let index = 0; index < this._slots.length; index++) {
      const slot = this._slots[index]!;
      slot.items.length = 0;
      slot.light = null;
      slot.casterRevisionA = 0;
      slot.casterRevisionB = 0;
      slot.casterCount = 0;
      slot.receiverCount = 0;
      slot.cache.reset();
      this._shadows[index] = null;
    }
    this._revision = 0;
    this.passCount = 0;
    this.casterCount = 0;
    this.cacheHit = false;
  }

  private _isRenderable(slot: DirectionalShadowSlot): boolean {
    return slot.light !== null && slot.items.length > 0 && slot.receiverCount > 0;
  }

  private _clearSlot(index: number): boolean {
    const slot = this._slots[index]!;
    slot.cache.invalidate();
    if (this._shadows[index] === null) return false;
    this._shadows[index] = null;
    return true;
  }
}

interface DirectionalShadowSlot {
  readonly items: Render3DRenderItem[];
  readonly candidateFrustum: Frustum;
  readonly view: Float32Array;
  readonly projection: Float32Array;
  readonly viewProjection: Float32Array;
  readonly cache: Render3DDirectionalShadowCache;
  collection: Render3DShadowCollectionOptions;
  light: DirectionalLight | null;
  casterRevisionA: number;
  casterRevisionB: number;
  casterCount: number;
  receiverCount: number;
}

function nextRevision(revision: number): number {
  return revision >= Number.MAX_SAFE_INTEGER ? 1 : revision + 1;
}
