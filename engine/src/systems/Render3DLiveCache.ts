import type { World } from '../ecs/World';
import type { EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import type { LiveIdSet } from '../renderer/utils';
import type { Render3DBoundsCache } from './Render3DBoundsCache';

const LIVE_BASIC = 1 << 0;
const LIVE_DEPTH = 1 << 1;
const LIVE_NORMAL = 1 << 2;
const LIVE_HELPER = 1 << 3;
const LIVE_OUTLINE = 1 << 4;
const LIVE_VOLUME = 1 << 5;
const LIVE_PBR = 1 << 6;
const LIVE_MOTION = 1 << 7;
const LIVE_BLINN_PHONG = 1 << 8;
const MARKER_SWEEP_INTERVAL = 120;

interface LiveFrameMarker {
  frame: number;
  mask: number;
}

/**
 * Owns frame-local renderer liveness and the bounded marker lifecycle.
 * Render3DSystem orchestrates rendering; this object only answers which cached
 * entity/geometry/material ids survived the current frame.
 */
export class Render3DLiveCache {
  private readonly entityMarkers = new Map<number, LiveFrameMarker>();
  private readonly geometryMarkers = new Map<number, LiveFrameMarker>();
  private readonly materialMarkers = new Map<number, LiveFrameMarker>();
  private sweepCountdown = MARKER_SWEEP_INTERVAL;

  frame = 0;

  readonly basicEntities = this.ids(this.entityMarkers, LIVE_BASIC);
  readonly basicGeometries = this.ids(this.geometryMarkers, LIVE_BASIC);
  readonly basicMaterials = this.ids(this.materialMarkers, LIVE_BASIC);
  readonly blinnPhongEntities = this.ids(this.entityMarkers, LIVE_BLINN_PHONG);
  readonly blinnPhongGeometries = this.ids(this.geometryMarkers, LIVE_BLINN_PHONG);
  readonly blinnPhongMaterials = this.ids(this.materialMarkers, LIVE_BLINN_PHONG);
  readonly depthEntities = this.ids(this.entityMarkers, LIVE_DEPTH);
  readonly depthGeometries = this.ids(this.geometryMarkers, LIVE_DEPTH);
  readonly depthMaterials = this.ids(this.materialMarkers, LIVE_DEPTH);
  readonly normalEntities = this.ids(this.entityMarkers, LIVE_NORMAL);
  readonly normalGeometries = this.ids(this.geometryMarkers, LIVE_NORMAL);
  readonly normalMaterials = this.ids(this.materialMarkers, LIVE_NORMAL);
  readonly helperEntities = this.ids(this.entityMarkers, LIVE_HELPER);
  readonly helperGeometries = this.ids(this.geometryMarkers, LIVE_HELPER);
  readonly outlineEntities = this.ids(this.entityMarkers, LIVE_OUTLINE);
  readonly outlineGeometries = this.ids(this.geometryMarkers, LIVE_OUTLINE);
  readonly motionGeometries = this.ids(this.geometryMarkers, LIVE_MOTION);
  readonly volumeEntities = this.ids(this.entityMarkers, LIVE_VOLUME);
  readonly volumeGeometries = this.ids(this.geometryMarkers, LIVE_VOLUME);
  readonly volumeMaterials = this.ids(this.materialMarkers, LIVE_VOLUME);
  readonly pbrEntities = this.ids(this.entityMarkers, LIVE_PBR);
  readonly pbrGeometries = this.ids(this.geometryMarkers, LIVE_PBR);
  readonly pbrMaterials = this.ids(this.materialMarkers, LIVE_PBR);

  /** Returns true when the safe-integer frame counter wrapped and dependent caches must reset. */
  beginFrame(): boolean {
    if (this.frame === Number.MAX_SAFE_INTEGER) {
      this.frame = 1;
      this.clear();
      return true;
    }
    this.frame += 1;
    return false;
  }

  sweep(
    world: World,
    boundsCache: Render3DBoundsCache,
    disabledHierarchyCache: EntityHierarchyDisabledCache,
  ): void {
    this.sweepCountdown -= 1;
    if (this.sweepCountdown > 0) return;
    this.sweepCountdown = MARKER_SWEEP_INTERVAL;
    this.sweepMap(this.entityMarkers);
    this.sweepMap(this.geometryMarkers);
    this.sweepMap(this.materialMarkers);
    boundsCache.sweep(this.frame);
    for (const entityId of disabledHierarchyCache.keys()) {
      if (!world.entities.has(entityId)) disabledHierarchyCache.delete(entityId);
    }
  }

  clear(): void {
    this.entityMarkers.clear();
    this.geometryMarkers.clear();
    this.materialMarkers.clear();
  }

  private ids(markers: Map<number, LiveFrameMarker>, mask: number): LiveIdSet & { add(id: number): void } {
    return {
      add: id => {
        const marker = markers.get(id);
        if (!marker) {
          markers.set(id, { frame: this.frame, mask });
        } else if (marker.frame !== this.frame) {
          marker.frame = this.frame;
          marker.mask = mask;
        } else {
          marker.mask |= mask;
        }
      },
      has: id => {
        const marker = markers.get(id);
        return !!marker && marker.frame === this.frame && (marker.mask & mask) !== 0;
      },
    };
  }

  private sweepMap(markers: Map<number, LiveFrameMarker>): void {
    for (const [id, marker] of markers) {
      if (marker.frame !== this.frame) markers.delete(id);
    }
  }
}
