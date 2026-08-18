import { Entity } from '../ecs/Entity';
import { World } from '../ecs/World';
import { Camera3D } from '../components/Camera3D';
import { Mesh3D } from '../components/Mesh3D';
import { Transform3D } from '../components/Transform3D';
import { Frustum, computeBoundingSphere, transformBoundingSphere } from '../culling/Frustum';
import type { BoundingSphere } from '../culling/Frustum';
import type { Geometry3D } from '../geometry/Geometry3D';
import { mat4 } from 'wgpu-matrix';
import { IDENTITY_MAT4 } from '../math/constants';
import {
  requiredMat4Array,
  requiredVec3Array,
  type RequiredMat4Array,
  type RequiredVec3Array,
} from '../math/arrayAccess';
import { getSpatialIndexService, type MeshSpatialEntry } from '../spatial/SpatialIndexService';

export type BoxSelectionMode = 'center' | 'intersect' | 'all';

export interface BoxSelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoxSelectionResult {
  rect: BoxSelectionRect;
  frustum: Frustum;
  entities: Entity[];
  nativeEvent: PointerEvent;
}

export interface BoxSelectionControlOptions {
  enabled?: boolean;
  button?: number;
  minDragPixels?: number;
  overlayClassName?: string;
  overlayParent?: HTMLElement;
  selectionMode?: BoxSelectionMode;
  stopImmediatePropagation?: boolean;
  filter?: (entity: Entity) => boolean;
  onSelect?: (result: BoxSelectionResult) => void;
}

interface BoundingSphereCacheEntry {
  readonly positions: Float32Array;
  readonly geometryVersion: number;
  readonly sphere: BoundingSphere;
}

type SelectionPoints = readonly [
  RequiredVec3Array,
  RequiredVec3Array,
  RequiredVec3Array,
  RequiredVec3Array,
  RequiredVec3Array,
  RequiredVec3Array,
  RequiredVec3Array,
  RequiredVec3Array,
];

const BOX_SELECTION_IDENTITY_MAT4 = requiredMat4Array(IDENTITY_MAT4, 'box-selection identity matrix');

export class BoxSelectionControl {
  enabled: boolean;
  button: number;
  minDragPixels: number;
  selectionMode: BoxSelectionMode;

  readonly selectionFrustum = new Frustum();
  readonly selectedEntities: Entity[] = [];

  private readonly _canvas: HTMLCanvasElement;
  private readonly _world: World;
  private readonly _cameraEntity: Entity;
  private readonly _filter: ((entity: Entity) => boolean) | null;
  private readonly _onSelect: ((result: BoxSelectionResult) => void) | null;
  private readonly _stopImmediatePropagation: boolean;
  private readonly _overlay: HTMLDivElement;
  private readonly _sphereCache = new WeakMap<Geometry3D, BoundingSphereCacheEntry>();
  private readonly _viewMatrix = requiredMat4Array(mat4.identity() as Float32Array, 'box-selection view matrix');
  private readonly _viewProjMatrix = requiredMat4Array(mat4.identity() as Float32Array, 'box-selection view-projection matrix');
  private readonly _invViewProjMatrix = requiredMat4Array(mat4.identity() as Float32Array, 'box-selection inverse view-projection matrix');
  private readonly _selectionPlanes = new Float32Array(24);
  private readonly _selectionPoints: SelectionPoints = createSelectionPoints();
  private readonly _selectionInside = requiredVec3Array(new Float32Array(3), 'box-selection inside point');
  private readonly _spatialCandidates: MeshSpatialEntry[] = [];

  private _dragging = false;
  private _pointerId = -1;
  private _startClientX = 0;
  private _startClientY = 0;

  constructor(
    canvas: HTMLCanvasElement,
    world: World,
    cameraEntity: Entity,
    options: BoxSelectionControlOptions = {},
  ) {
    this._canvas = canvas;
    this._world = world;
    this._cameraEntity = cameraEntity;
    this._filter = options.filter ?? null;
    this._onSelect = options.onSelect ?? null;
    this._stopImmediatePropagation = options.stopImmediatePropagation ?? true;

    this.enabled = options.enabled ?? true;
    this.button = options.button ?? 0;
    this.minDragPixels = options.minDragPixels ?? 4;
    this.selectionMode = options.selectionMode ?? 'center';

    this._overlay = document.createElement('div');
    this._overlay.className = options.overlayClassName ?? 'box-selection-control-rect';
    Object.assign(this._overlay.style, {
      position: 'fixed',
      display: 'none',
      pointerEvents: 'none',
      border: '1px solid rgba(90,170,255,0.95)',
      background: 'rgba(90,170,255,0.18)',
      zIndex: '9999',
    });
    (options.overlayParent ?? document.body).appendChild(this._overlay);

    this._bind();
  }

  dispose(): void {
    const c = this._canvas;
    c.removeEventListener('pointerdown', this._onPointerDown, true);
    c.removeEventListener('pointermove', this._onPointerMove, true);
    c.removeEventListener('pointerup', this._onPointerUp, true);
    c.removeEventListener('pointercancel', this._onPointerCancel, true);
    this._spatialCandidates.length = 0;
    this._overlay.remove();
  }

  selectRect(rect: BoxSelectionRect, nativeEvent?: PointerEvent): BoxSelectionResult | null {
    const frustum = this._buildSelectionFrustum(rect);
    if (!frustum) return null;

    this.selectedEntities.length = 0;
    const candidates = this._spatialCandidates;
    candidates.length = 0;
    const spatial = getSpatialIndexService(this._world).syncMeshIndex();
    spatial.queryFrustum(frustum, candidates);
    for (const entry of candidates) {
      const entity = entry.entity;
      if (entity.world !== this._world) continue;
      if (entity === this._cameraEntity) continue;
      if (this._filter && !this._filter(entity)) continue;
      const mesh = entry.mesh;
      const worldMatrix = requiredMat4Array(entry.worldMatrix, 'selected entity world matrix');
      const localSphere = this._getLocalSphere(mesh.geometry);
      const worldSphere = transformBoundingSphere(localSphere, worldMatrix);
      if (this._isSelected(mesh, worldMatrix, worldSphere)) {
        this.selectedEntities.push(entity);
      }
    }
    candidates.length = 0;

    const result: BoxSelectionResult = {
      rect,
      frustum,
      entities: [...this.selectedEntities],
      nativeEvent: nativeEvent ?? new PointerEvent('pointerup'),
    };
    this._onSelect?.(result);
    return result;
  }

  private _bind(): void {
    const c = this._canvas;
    c.addEventListener('pointerdown', this._onPointerDown, true);
    c.addEventListener('pointermove', this._onPointerMove, true);
    c.addEventListener('pointerup', this._onPointerUp, true);
    c.addEventListener('pointercancel', this._onPointerCancel, true);
  }

  private _getLocalSphere(geometry: Geometry3D): BoundingSphere {
    const cached = this._sphereCache.get(geometry);
    if (
      cached
      && cached.positions === geometry.positions
      && cached.geometryVersion === geometry.version
    ) {
      return cached.sphere;
    }
    const sphere = computeBoundingSphere(geometry.positions);
    this._sphereCache.set(geometry, {
      positions: geometry.positions,
      geometryVersion: geometry.version,
      sphere,
    });
    return sphere;
  }

  private _isSelected(mesh: Mesh3D, worldMatrix: RequiredMat4Array, worldSphere: BoundingSphere): boolean {
    if (this.selectionMode === 'center') {
      return this.selectionFrustum.containsPoint(worldSphere.center);
    }
    if (!this.selectionFrustum.containsSphere(worldSphere)) return false;
    return this.selectionFrustum.intersectsGeometry(
      mesh.geometry,
      worldMatrix,
      this.selectionMode === 'all' ? 'all' : 'any',
    );
  }

  private _onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || event.button !== this.button || this._dragging) return;
    this._dragging = true;
    this._pointerId = event.pointerId;
    this._startClientX = event.clientX;
    this._startClientY = event.clientY;
    this._canvas.setPointerCapture(event.pointerId);
    this._setOverlayRect(this._makeClientRect(this._startClientX, this._startClientY, event.clientX, event.clientY));
    this._stopEvent(event);
  };

  private _onPointerMove = (event: PointerEvent): void => {
    if (!this._dragging || event.pointerId !== this._pointerId) return;
    this._setOverlayRect(this._makeClientRect(this._startClientX, this._startClientY, event.clientX, event.clientY));
    this._stopEvent(event);
  };

  private _onPointerUp = (event: PointerEvent): void => {
    if (!this._dragging || event.pointerId !== this._pointerId) return;
    const rect = this._makeClientRect(this._startClientX, this._startClientY, event.clientX, event.clientY);
    this._finishDrag();

    if (Math.max(rect.width, rect.height) >= this.minDragPixels) {
      this.selectRect(this._clientRectToCanvasRect(rect), event);
    }
    this._stopEvent(event);
  };

  private _onPointerCancel = (event: PointerEvent): void => {
    if (!this._dragging || event.pointerId !== this._pointerId) return;
    this._finishDrag();
  };

  private _stopEvent(event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (this._stopImmediatePropagation) event.stopImmediatePropagation();
  }

  private _finishDrag(): void {
    this._dragging = false;
    this._pointerId = -1;
    this._overlay.style.display = 'none';
  }

  private _makeClientRect(x0: number, y0: number, x1: number, y1: number): BoxSelectionRect {
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    return { x, y, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  }

  private _clientRectToCanvasRect(rect: BoxSelectionRect): BoxSelectionRect {
    const bounds = this._canvas.getBoundingClientRect();
    const x0 = Math.max(bounds.left, Math.min(bounds.right, rect.x));
    const y0 = Math.max(bounds.top, Math.min(bounds.bottom, rect.y));
    const x1 = Math.max(bounds.left, Math.min(bounds.right, rect.x + rect.width));
    const y1 = Math.max(bounds.top, Math.min(bounds.bottom, rect.y + rect.height));
    return { x: x0 - bounds.left, y: y0 - bounds.top, width: x1 - x0, height: y1 - y0 };
  }

  private _setOverlayRect(rect: BoxSelectionRect): void {
    this._overlay.style.display = 'block';
    this._overlay.style.left = `${rect.x}px`;
    this._overlay.style.top = `${rect.y}px`;
    this._overlay.style.width = `${rect.width}px`;
    this._overlay.style.height = `${rect.height}px`;
  }

  private _buildSelectionFrustum(rect: BoxSelectionRect): Frustum | null {
    const camera = this._cameraEntity.getComponent(Camera3D);
    if (!camera || rect.width <= 0 || rect.height <= 0) return null;

    const camTransform = this._cameraEntity.getComponent(Transform3D);
    if (camTransform) this._updateWorldMatrix(this._cameraEntity);

    const canvasRect = this._canvas.getBoundingClientRect();
    if (
      !Number.isFinite(canvasRect.width)
      || !Number.isFinite(canvasRect.height)
      || canvasRect.width <= 0
      || canvasRect.height <= 0
    ) return null;
    camera.updateAspect(canvasRect.width / canvasRect.height);

    const camWorld = camTransform
      ? requiredMat4Array(camTransform.worldMatrix, 'box-selection camera world matrix')
      : BOX_SELECTION_IDENTITY_MAT4;
    const view = requiredMat4Array(
      mat4.inverse(camWorld, this._viewMatrix) as Float32Array,
      'box-selection view matrix',
    );
    const viewProj = requiredMat4Array(
      mat4.multiply(camera.projectionMatrix, view, this._viewProjMatrix) as Float32Array,
      'box-selection view-projection matrix',
    );
    const invViewProj = requiredMat4Array(
      mat4.inverse(viewProj, this._invViewProjMatrix) as Float32Array,
      'box-selection inverse view-projection matrix',
    );

    const x0 = rect.x / canvasRect.width * 2 - 1;
    const x1 = (rect.x + rect.width) / canvasRect.width * 2 - 1;
    const y0 = 1 - (rect.y + rect.height) / canvasRect.height * 2;
    const y1 = 1 - rect.y / canvasRect.height * 2;
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const bottom = Math.min(y0, y1);
    const top = Math.max(y0, y1);
    const nearZ = camera.reverseZ ? 1 : 0;
    const farZ = camera.reverseZ ? 0 : 1;

    const points = this._selectionPoints;
    const nlb = this._unproject(invViewProj, left, bottom, nearZ, points[0]);
    const nrb = this._unproject(invViewProj, right, bottom, nearZ, points[1]);
    const nrt = this._unproject(invViewProj, right, top, nearZ, points[2]);
    const nlt = this._unproject(invViewProj, left, top, nearZ, points[3]);
    const flb = this._unproject(invViewProj, left, bottom, farZ, points[4]);
    const frb = this._unproject(invViewProj, right, bottom, farZ, points[5]);
    const frt = this._unproject(invViewProj, right, top, farZ, points[6]);
    const flt = this._unproject(invViewProj, left, top, farZ, points[7]);

    const inside = this._selectionInside;
    inside[0] = (nlb[0] + nrb[0] + nrt[0] + nlt[0] + flb[0] + frb[0] + frt[0] + flt[0]) / 8;
    inside[1] = (nlb[1] + nrb[1] + nrt[1] + nlt[1] + flb[1] + frb[1] + frt[1] + flt[1]) / 8;
    inside[2] = (nlb[2] + nrb[2] + nrt[2] + nlt[2] + flb[2] + frb[2] + frt[2] + flt[2]) / 8;

    const planes = this._selectionPlanes;
    this._writePlane(planes, 0, nlb, nrb, nrt, inside);
    this._writePlane(planes, 1, frb, flb, flt, inside);
    this._writePlane(planes, 2, flb, nlb, nlt, inside);
    this._writePlane(planes, 3, nrb, frb, frt, inside);
    this._writePlane(planes, 4, nlb, flb, frb, inside);
    this._writePlane(planes, 5, nrt, frt, flt, inside);
    this.selectionFrustum.setFromPlanes(planes);
    return this.selectionFrustum;
  }

  private _unproject(
    invViewProj: RequiredMat4Array,
    x: number,
    y: number,
    z: number,
    out: RequiredVec3Array,
  ): RequiredVec3Array {
    const wx = invViewProj[0] * x + invViewProj[4] * y + invViewProj[8]  * z + invViewProj[12];
    const wy = invViewProj[1] * x + invViewProj[5] * y + invViewProj[9]  * z + invViewProj[13];
    const wz = invViewProj[2] * x + invViewProj[6] * y + invViewProj[10] * z + invViewProj[14];
    const ww = invViewProj[3] * x + invViewProj[7] * y + invViewProj[11] * z + invViewProj[15];
    const invW = Math.abs(ww) > 1e-8 ? 1 / ww : 1;
    out[0] = wx * invW;
    out[1] = wy * invW;
    out[2] = wz * invW;
    return out;
  }

  private _writePlane(
    planes: Float32Array,
    planeIndex: number,
    a: RequiredVec3Array,
    b: RequiredVec3Array,
    c: RequiredVec3Array,
    inside: RequiredVec3Array,
  ): void {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    let d = -(nx * a[0] + ny * a[1] + nz * a[2]);

    if (nx * inside[0] + ny * inside[1] + nz * inside[2] + d < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      d = -d;
    }

    const i = planeIndex * 4;
    planes[i] = nx;
    planes[i + 1] = ny;
    planes[i + 2] = nz;
    planes[i + 3] = d;
  }

  private _updateWorldMatrix(entity: Entity): void {
    const transform = entity.getComponent(Transform3D);
    if (!transform) return;
    const parent = entity.parent as Entity | null;
    if (parent) {
      const parentTransform = parent.getComponent(Transform3D);
      if (parentTransform) {
        this._updateWorldMatrix(parent);
        transform.updateWorldMatrix(parentTransform.worldMatrix, parentTransform.worldVersion);
        return;
      }
    }
    transform.updateWorldMatrix();
  }
}

function createSelectionPoints(): SelectionPoints {
  return [
    requiredVec3Array(new Float32Array(3), 'box-selection near-left-bottom point'),
    requiredVec3Array(new Float32Array(3), 'box-selection near-right-bottom point'),
    requiredVec3Array(new Float32Array(3), 'box-selection near-right-top point'),
    requiredVec3Array(new Float32Array(3), 'box-selection near-left-top point'),
    requiredVec3Array(new Float32Array(3), 'box-selection far-left-bottom point'),
    requiredVec3Array(new Float32Array(3), 'box-selection far-right-bottom point'),
    requiredVec3Array(new Float32Array(3), 'box-selection far-right-top point'),
    requiredVec3Array(new Float32Array(3), 'box-selection far-left-top point'),
  ];
}
