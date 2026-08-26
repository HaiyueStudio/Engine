import { System } from '../ecs/System';
import { Entity } from '../ecs/Entity';
import { World } from '../ecs/World';
import type { IEngine } from '../core/IEngine';
import { Mesh3D } from '../components/Mesh3D';
import { Camera3D } from '../components/Camera3D';
import { Interactive, InteractiveEvent } from '../components/Interactive';
import { Ray, type RayHit, type RayIntersectMeshOptions } from '../math/Ray';
import {
  requiredMat4Array,
  requiredVec3Array,
} from '../math/arrayAccess';
import { isEntityDisabledInHierarchyCached } from '../ecs/utils/hierarchy';
import type { EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import {
  getSpatialIndexService,
  type MeshSpatialEntry,
  type SpatialIndexService,
} from '../spatial/SpatialIndexService';

interface PendingEvent {
  type: 'pointerdown' | 'pointerup' | 'pointermove' | 'click';
  native: PointerEvent | MouseEvent | null;
  ndcX: number;
  ndcY: number;
}

export interface InteractionRaycastResult {
  entity: Entity | null;
  distance: number;
  /** Caller-owned world-space hit point, updated in place. */
  point: Float32Array;
  /** Caller-owned world-space hit normal, updated in place. */
  normal: Float32Array;
}

export function createInteractionRaycastResult(): InteractionRaycastResult {
  return {
    entity: null,
    distance: Number.POSITIVE_INFINITY,
    point: new Float32Array(3),
    normal: new Float32Array(3),
  };
}

export interface InteractionSystemOptions {
  /** Use Ray's cached per-geometry BVH acceleration. Defaults to true. */
  useBVH?: boolean;
  /** Use a world-space Mesh3D AABB spatial index before exact mesh ray tests. Defaults to true. */
  spatialIndex?: boolean;
  /** Number of entities per spatial tree leaf. Defaults to 8. */
  spatialLeafSize?: number;
  /** Keep raycasting hover every frame at the last pointer position. Defaults to false. */
  continuousHover?: boolean;
  /** Bind native canvas pointer listeners. Disable when a deterministic host injects input. Defaults to true. */
  bindCanvas?: boolean;
}

/**
 * InteractionSystem
 *
 * Raycasting rules
 * ─────────────────
 * • Entity with Mesh3D, NO Interactive component  → acts as an opaque occluder.
 *   The ray stops at this entity; nothing behind it receives events.
 *
 * • Entity with Mesh3D + Interactive (penetrable=false, default)
 *   → fires pointer events AND stops the ray.
 *
 * • Entity with Mesh3D + Interactive (penetrable=true)
 *   → completely ignored by the ray (no occlusion, no events).
 *
 * Usage
 * ──────
 *   const interactionSystem = new InteractionSystem(engine, cameraEntity);
 *   world.addSystem(interactionSystem);
 *
 *   entity.addComponent(new Interactive({
 *     onClick: (e) => console.log('clicked', e.entity.name),
 *   }));
 */
export class InteractionSystem extends System {
  private engine: IEngine;
  private cameraEntity: Entity;
  private canvas: HTMLCanvasElement | null;

  private readonly _lastNDC = new Float32Array(2);
  private readonly _pointerNdcScratch = new Float32Array(2);
  private _lastNative: PointerEvent | MouseEvent | null = null;
  private _hoveredEntity: Entity | null = null;
  private _pending: PendingEvent[] = [];
  private _pendingPool: PendingEvent[] = [];
  private _ray = new Ray();
  private readonly _rayIntersectOptions: RayIntersectMeshOptions = { useBVH: true };
  private readonly _zeroVec3 = requiredVec3Array(new Float32Array(3), 'zero vector');
  private readonly _cameraPosition = requiredVec3Array(new Float32Array(3), 'camera position');
  private readonly _meshHit: RayHit = {
    distance: Number.POSITIVE_INFINITY,
    point: new Float32Array(3),
    normal: new Float32Array(3),
  };
  private readonly _hitResult = createInteractionRaycastResult();
  private _event: InteractiveEvent | null = null;
  private readonly _disabledHierarchyCache: EntityHierarchyDisabledCache = new Map();
  private readonly _spatialCandidates: MeshSpatialEntry[] = [];
  private _spatialService: SpatialIndexService | null = null;
  private _hoverDirty = false;
  private readonly _onPointerMove = (event: PointerEvent) => this._queuePointerEvent('pointermove', event);
  private readonly _onPointerDown = (event: PointerEvent) => this._queuePointerEvent('pointerdown', event);
  private readonly _onPointerUp = (event: PointerEvent) => this._queuePointerEvent('pointerup', event);
  private readonly _onClick = (event: MouseEvent) => this._queuePointerEvent('click', event);
  useBVH: boolean;
  spatialIndex: boolean;
  spatialLeafSize: number;
  continuousHover: boolean;
  readonly bindsCanvasInput: boolean;

  constructor(engine: IEngine, cameraEntity: Entity, options: InteractionSystemOptions = {}) {
    super({ all: [Mesh3D] });
    this.engine = engine;
    this.cameraEntity = cameraEntity;
    this.canvas = engine.canvas ?? null;
    this.useBVH = options.useBVH ?? true;
    this.spatialIndex = options.spatialIndex ?? true;
    this.spatialLeafSize = Math.max(1, options.spatialLeafSize ?? 8);
    this.continuousHover = options.continuousHover ?? false;
    this.bindsCanvasInput = options.bindCanvas ?? true;
    this.name = 'InteractionSystem';
    if (this.bindsCanvasInput) this._bindCanvas();
  }

  // ── Canvas event binding ─────────────────────────────────────────────────

  private _toNDC(e: MouseEvent, out: Float32Array): Float32Array {
    const r = this.canvas?.getBoundingClientRect();
    if (!r) {
      out[0] = 0;
      out[1] = 0;
      return out;
    }
    out[0] = ((e.clientX - r.left) / r.width) * 2 - 1;
    out[1] = 1 - ((e.clientY - r.top) / r.height) * 2;
    return out;
  }

  private _bindCanvas() {
    const c = this.canvas;
    if (!c) return;
    c.addEventListener('pointermove', this._onPointerMove);
    c.addEventListener('pointerdown', this._onPointerDown);
    c.addEventListener('pointerup', this._onPointerUp);
    c.addEventListener('click', this._onClick);
  }

  private _unbindCanvas(): void {
    const c = this.canvas;
    if (!c) return;
    c.removeEventListener('pointermove', this._onPointerMove);
    c.removeEventListener('pointerdown', this._onPointerDown);
    c.removeEventListener('pointerup', this._onPointerUp);
    c.removeEventListener('click', this._onClick);
  }

  private _queuePointerEvent(type: PendingEvent['type'], event: PointerEvent | MouseEvent): void {
    const ndc = this._toNDC(event, this._pointerNdcScratch);
    const x = ndc[0] ?? 0;
    const y = ndc[1] ?? 0;
    this._lastNDC[0] = x;
    this._lastNDC[1] = y;
    this._lastNative = event;
    this._hoverDirty = true;
    const pending = this._pendingPool.pop() ?? { type, native: null, ndcX: 0, ndcY: 0 };
    pending.type = type;
    pending.native = event;
    pending.ndcX = x;
    pending.ndcY = y;
    this._pending.push(pending);
  }

  // ── Per-frame update ─────────────────────────────────────────────────────

  override update(world: World, _time: number, _delta: number): this {
    if (this.disabled) return this;
    const camera = this.cameraEntity.getComponent(Camera3D);
    if (!camera) return this;
    const pending = this._pending;
    const shouldUpdateHover = Boolean(this._lastNative && (this._hoverDirty || this.continuousHover));
    if (pending.length === 0 && !shouldUpdateHover) return this;

    // Ensure camera world matrix is current
    const cameraFrame = world.frameData.getCamera3D(this.cameraEntity, camera);
    const wm = requiredMat4Array(cameraFrame.worldMatrix, 'camera world matrix');
    const camPos = this._cameraPosition;
    camPos[0] = wm[12];
    camPos[1] = wm[13];
    camPos[2] = wm[14];
    const invViewProj = requiredMat4Array(cameraFrame.inverseViewProjectionMatrix, 'inverse view-projection matrix');
    if (this.spatialIndex) this._rebuildSpatialIndex(world);

    // ── Process queued pointer events ──────────────────────────────────────
    for (const ev of pending) {
      const native = ev.native;
      if (!native) continue;
      this._ray.setFromCamera(ev.ndcX, ev.ndcY, camPos, invViewProj);
      const hit = this._castRay(world, this._hitResult);
      if (!hit?.entity) continue;
      const interactive = hit.entity.getComponent(Interactive);
      if (!interactive) continue; // occluder: block but no event

      const ie = this._makeEvent(ev.type, hit.entity, hit.distance, hit.point, hit.normal, native);
      if (ev.type === 'pointermove' && interactive.onPointerMove) interactive.onPointerMove(ie);
      if (ev.type === 'pointerdown' && interactive.onPointerDown) interactive.onPointerDown(ie);
      if (ev.type === 'pointerup'   && interactive.onPointerUp)   interactive.onPointerUp(ie);
      if (ev.type === 'click'       && interactive.onClick)       interactive.onClick(ie);
    }
    for (const ev of pending) {
      ev.native = null;
      this._pendingPool.push(ev);
    }
    pending.length = 0;

    // ── Hover detection at last known NDC, only when pointer state changes ─
    if (shouldUpdateHover && this._lastNative) {
      this._ray.setFromCamera(this._lastNDC[0] ?? 0, this._lastNDC[1] ?? 0, camPos, invViewProj);
      const hoverHit = this._castRay(world, this._hitResult);
      const hasHoverHit = hoverHit !== null && hoverHit.entity !== null;
      // Only entities WITH Interactive count as hover targets
      const hoverInteractive = hasHoverHit ? hoverHit.entity?.getComponent(Interactive) ?? null : null;
      const newHovered = hasHoverHit && hoverInteractive ? hoverHit.entity : null;

      if (newHovered !== this._hoveredEntity) {
        const native = this._lastNative;

        // pointerleave on previous
        if (this._hoveredEntity) {
          const old = this._hoveredEntity.getComponent(Interactive);
          if (old?.onPointerLeave) {
            old.onPointerLeave(this._makeEvent(
              'pointerleave', this._hoveredEntity, 0,
              this._zeroVec3, this._zeroVec3, native,
            ));
          }
        }

        // pointerenter on new
        if (newHovered && hoverHit && hoverInteractive?.onPointerEnter) {
          hoverInteractive.onPointerEnter(this._makeEvent(
            'pointerenter', newHovered,
            hoverHit.distance, hoverHit.point, hoverHit.normal, native,
          ));
        }

        this._hoveredEntity = newHovered;
      }
      this._hoverDirty = false;
    }

    return this;
  }

  /**
   * Casts from camera NDC into a caller-owned result. Returns false and clears
   * entity/distance when no non-penetrable Mesh3D is hit.
   */
  raycast(
    world: World,
    ndcX: number,
    ndcY: number,
    outResult: InteractionRaycastResult,
  ): boolean {
    const camera = this.cameraEntity.getComponent(Camera3D);
    if (!camera) {
      resetRaycastResult(outResult);
      return false;
    }
    const cameraFrame = world.frameData.getCamera3D(this.cameraEntity, camera);
    const wm = requiredMat4Array(cameraFrame.worldMatrix, 'camera world matrix');
    const camPos = this._cameraPosition;
    camPos[0] = wm[12];
    camPos[1] = wm[13];
    camPos[2] = wm[14];
    this._ray.setFromCamera(
      ndcX,
      ndcY,
      camPos,
      requiredMat4Array(cameraFrame.inverseViewProjectionMatrix, 'inverse view-projection matrix'),
    );
    if (this.spatialIndex) this._rebuildSpatialIndex(world);
    return this._castRay(world, outResult) !== null;
  }

  // ── Ray cast ─────────────────────────────────────────────────────────────

  /**
   * Returns the closest hit among all non-penetrable Mesh3D entities.
   * The returned entity may or may not have an Interactive component.
   */
  private _castRay(
    world: World,
    outResult: InteractionRaycastResult = this._hitResult,
  ): InteractionRaycastResult | null {
    resetRaycastResult(outResult);
    this._rayIntersectOptions.useBVH = this.useBVH;
    const hit = this.spatialIndex
      ? this._castRaySpatial(world, outResult)
      : this._castRayLinear(world, outResult);
    return hit ? outResult : null;
  }

  private _castRayLinear(world: World, outResult: InteractionRaycastResult): boolean {
    const entities = this.entitySet.get(world);
    if (!entities) return false;

    for (const entity of entities) {
      if (isEntityDisabledInHierarchyCached(entity, this._disabledHierarchyCache)) continue;
      // penetrable=true → completely invisible to ray
      const interactive = entity.getComponent(Interactive);
      if (interactive?.penetrable) continue;

      const mesh = entity.getComponent(Mesh3D);
      if (!mesh) continue;

      const worldMatrix = requiredMat4Array(world.frameData.transforms.getWorldMatrix(entity), 'entity world matrix');

      const hit = this._ray.intersectMesh(mesh.geometry, worldMatrix, this._rayIntersectOptions, this._meshHit);
      if (hit && hit.distance < outResult.distance) {
        writeRaycastResult(outResult, entity, hit);
      }
    }

    return outResult.entity !== null;
  }

  private _castRaySpatial(world: World, outResult: InteractionRaycastResult): boolean {
    if (!this._spatialService || this._spatialService.destroyed || this._spatialService.world !== world) this._rebuildSpatialIndex(world);
    const service = this._spatialService;
    if (!service) return false;

    const candidates = this._spatialCandidates;
    candidates.length = 0;
    service.meshIndex.queryRay(this._ray.origin, this._ray.direction, Number.POSITIVE_INFINITY, candidates);

    for (const entry of candidates) {
      if (entry.entity.world !== world || isEntityDisabledInHierarchyCached(entry.entity, this._disabledHierarchyCache)) continue;
      const interactive = entry.entity.getComponent(Interactive);
      if (interactive?.penetrable) continue;
      const hit = this._ray.intersectMesh(
        entry.mesh.geometry,
        entry.worldMatrix,
        this._rayIntersectOptions,
        this._meshHit,
      );
      if (hit && hit.distance < outResult.distance) {
        writeRaycastResult(outResult, entry.entity, hit);
      }
    }
    candidates.length = 0;

    return outResult.entity !== null;
  }

  private _rebuildSpatialIndex(world: World): void {
    this._spatialService = getSpatialIndexService(world);
    this._spatialService.syncMeshIndex(this.spatialLeafSize);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _makeEvent(
    type: InteractiveEvent['type'],
    entity: Entity,
    distance: number,
    point: Float32Array,
    normal: Float32Array,
    nativeEvent: PointerEvent | MouseEvent,
  ): InteractiveEvent {
    let event = this._event;
    if (!event) {
      event = {
        type,
        entity,
        distance,
        point: new Float32Array(3),
        normal: new Float32Array(3),
        nativeEvent,
      };
      this._event = event;
    }
    event.type = type;
    event.entity = entity;
    event.distance = distance;
    event.point.set(point);
    event.normal.set(normal);
    event.nativeEvent = nativeEvent;
    return event;
  }

  override destroy(): this {
    this._unbindCanvas();
    for (const pending of this._pending) pending.native = null;
    this._pending.length = 0;
    this._pendingPool.length = 0;
    this._lastNative = null;
    this._hoveredEntity = null;
    this._event = null;
    this._hoverDirty = false;
    this._disabledHierarchyCache.clear();
    this._spatialCandidates.length = 0;
    this._spatialService = null;
    this.canvas = null;
    return super.destroy();
  }

}

function resetRaycastResult(result: InteractionRaycastResult): void {
  result.entity = null;
  result.distance = Number.POSITIVE_INFINITY;
}

function writeRaycastResult(result: InteractionRaycastResult, entity: Entity, hit: RayHit): void {
  result.entity = entity;
  result.distance = hit.distance;
  result.point.set(hit.point);
  result.normal.set(hit.normal);
}
