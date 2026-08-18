import { mat4 } from 'wgpu-matrix';
import type { IEngine } from '../core/IEngine';
import type { World } from '../ecs/World';
import type { Entity } from '../ecs/Entity';
import { Camera2D } from '../components/Camera2D';
import { Camera3D } from '../components/Camera3D';
import { Frustum } from '../culling/Frustum';
import { IDENTITY_MAT4 } from '../math/constants';
import { TransformStore } from './TransformStore';
import { getWorldStructureVersion } from '../ecs/WorldStructure';
import { EngineError, EngineErrorCode } from '../core/EngineError';

/** Opaque, allocation-free capability for consuming the current World frame phase. */
export type WorldFrameToken = number & { readonly __worldFrameToken: never };

const WORLD_FRAME_TOKEN_PHASE_RANGE = 0x1_0000_0000;
const MAX_WORLD_FRAME_TOKEN_OWNER = 0x1f_ffff;
let nextWorldFrameTokenOwner = 0;

export interface Camera3DFrameOptions {
  width?: number;
  height?: number;
  reverseZ?: boolean;
  /** Sub-pixel projection offset in display pixels. Positive Y points down. */
  projectionJitter?: readonly [x: number, y: number] | Float32Array;
}

export interface Camera3DFrameData {
  entity: Entity;
  camera: Camera3D;
  projectionMatrix: Float32Array;
  viewMatrix: Float32Array;
  viewProjectionMatrix: Float32Array;
  inverseViewProjectionMatrix: Float32Array;
  worldMatrix: Float32Array;
  position: Float32Array;
  frustum: Frustum;
  frustumPlanes: Float32Array;
  width: number;
  height: number;
  reverseZ: boolean;
  projectionJitter: Float32Array;
  frameId: number;
  phaseRevision: number;
}

export interface Camera2DFrameOptions {
  width?: number;
  height?: number;
}

export interface Camera2DFrameData {
  entity: Entity;
  camera: Camera2D;
  projectionMatrix: Float32Array;
  viewMatrix: Float32Array;
  viewProjectionMatrix: Float32Array;
  worldMatrix: Float32Array;
  width: number;
  height: number;
  frameId: number;
  phaseRevision: number;
}

interface Camera3DCacheEntry {
  phaseRevision: number;
  width: number;
  height: number;
  reverseZ: boolean;
  jitterX: number;
  jitterY: number;
  projectionMatrix: Float32Array;
  viewMatrix: Float32Array;
  viewProjectionMatrix: Float32Array;
  inverseViewProjectionMatrix: Float32Array;
  worldMatrix: Float32Array;
  position: Float32Array;
  frustum: Frustum;
  frustumPlanes: Float32Array;
  data: Camera3DFrameData;
}

interface Camera2DCacheEntry {
  phaseRevision: number;
  width: number;
  height: number;
  viewMatrix: Float32Array;
  viewProjectionMatrix: Float32Array;
  worldMatrix: Float32Array;
  data: Camera2DFrameData;
}

export class FrameData {
  readonly transforms = new TransformStore();
  private readonly _tokenOwner = allocateWorldFrameTokenOwner();
  private _engine: IEngine | null = null;
  private _world: World | null = null;
  private _worldStructureVersion = -1;
  private _time = 0;
  private _delta = 0;
  private _frameId = 0;
  private _phaseRevision = 0;
  private readonly _camera3D = new Map<number, Camera3DCacheEntry>();
  private readonly _camera2D = new Map<number, Camera2DCacheEntry>();
  private readonly _camera3DPool: Camera3DCacheEntry[] = [];
  private readonly _camera2DPool: Camera2DCacheEntry[] = [];

  begin(world: World, engine: IEngine | null, time: number, delta: number): this {
    this.beginFrame(world, engine, time, delta);
    return this;
  }

  /** Starts one logical World frame and its initial update phase. */
  beginFrame(world: World, engine: IEngine | null, time: number, delta: number): WorldFrameToken {
    if (this._world !== world) this._releaseCameraCaches();
    this._world = world;
    this._engine = engine;
    this._time = time;
    this._delta = delta;
    this._frameId = nextRevision(this._frameId);
    return this._beginPhase(world);
  }

  /** Invalidates phase-local snapshots without advancing the logical frame. */
  advancePhase(): WorldFrameToken {
    if (!this._world || this._frameId === 0) {
      throw invalidFrameTokenError('FrameData.advancePhase() requires an active logical frame.');
    }
    return this._beginPhase(this._world);
  }

  /** Attaches an engine to a phase already opened by World.update(). */
  useFrameToken(world: World, engine: IEngine | null, token: WorldFrameToken): this {
    if (this._world !== world || this._frameId === 0 || token !== this._currentToken()) {
      throw invalidFrameTokenError('WorldFrameToken does not identify the active FrameData phase.');
    }
    this._engine = engine;
    return this;
  }

  private _beginPhase(world: World): WorldFrameToken {
    this._phaseRevision = nextRevision(this._phaseRevision);
    const structureVersion = getWorldStructureVersion(world);
    if (structureVersion !== this._worldStructureVersion) {
      this._reconcileCameraCaches(world);
      this._worldStructureVersion = structureVersion;
    }
    this.transforms.beginPhase(world);
    return this._currentToken();
  }

  private _currentToken(): WorldFrameToken {
    return (this._tokenOwner * WORLD_FRAME_TOKEN_PHASE_RANGE + this._phaseRevision) as WorldFrameToken;
  }

  get world(): World | null {
    return this._world;
  }

  get engine(): IEngine | null {
    return this._engine;
  }

  get time(): number {
    return this._time;
  }

  get delta(): number {
    return this._delta;
  }

  get frameId(): number {
    return this._frameId;
  }

  get phaseRevision(): number {
    return this._phaseRevision;
  }

  get camera3DCacheSize(): number { return this._camera3D.size; }
  get camera2DCacheSize(): number { return this._camera2D.size; }
  get pooledCamera3DCount(): number { return this._camera3DPool.length; }
  get pooledCamera2DCount(): number { return this._camera2DPool.length; }

  getCamera3D(entity: Entity, camera: Camera3D, options?: Camera3DFrameOptions): Camera3DFrameData;
  getCamera3D(entity: Entity, camera: Camera3D, width?: number, height?: number, reverseZ?: boolean): Camera3DFrameData;
  getCamera3D(
    entity: Entity,
    camera: Camera3D,
    optionsOrWidth?: Camera3DFrameOptions | number,
    requestedHeight?: number,
    requestedReverseZ?: boolean,
  ): Camera3DFrameData {
    const options = typeof optionsOrWidth === 'object' ? optionsOrWidth : undefined;
    const requestedWidth = typeof optionsOrWidth === 'number' ? optionsOrWidth : undefined;
    const width = Math.max(1, options?.width ?? requestedWidth ?? this._engine?.width ?? 1);
    const height = Math.max(1, options?.height ?? requestedHeight ?? this._engine?.height ?? 1);
    const reverseZ = options?.reverseZ ?? requestedReverseZ ?? camera.reverseZ;
    const jitterX = options?.projectionJitter?.[0] ?? 0;
    const jitterY = options?.projectionJitter?.[1] ?? 0;

    let entry = this._camera3D.get(entity.id);
    if (!entry) {
      entry = this._camera3DPool.pop() ?? createCamera3DCacheEntry(entity, camera);
      resetCamera3DCacheEntry(entry, entity, camera);
      this._camera3D.set(entity.id, entry);
    }

    const samePhase = entry.phaseRevision === this._phaseRevision
      && entry.width === width
      && entry.height === height
      && entry.reverseZ === reverseZ
      && entry.jitterX === jitterX
      && entry.jitterY === jitterY;
    if (samePhase) return entry.data;

    const transformWorldMatrix = this.transforms.getWorldMatrix(entity) ?? IDENTITY_MAT4;
    entry.worldMatrix.set(transformWorldMatrix);
    const view = mat4.inverse(entry.worldMatrix, entry.viewMatrix) as Float32Array;
    const projection = camera.writeProjectionMatrix(
      entry.projectionMatrix,
      width / height,
      reverseZ,
    );
    applyProjectionJitter(projection, jitterX, jitterY, width, height);
    const viewProjection = mat4.multiply(projection, view, entry.viewProjectionMatrix) as Float32Array;
    mat4.inverse(viewProjection, entry.inverseViewProjectionMatrix);
    entry.position[0] = entry.worldMatrix[12] ?? 0;
    entry.position[1] = entry.worldMatrix[13] ?? 0;
    entry.position[2] = entry.worldMatrix[14] ?? 0;
    entry.frustum.setFromViewProjection(viewProjection).copyPlanesTo(entry.frustumPlanes);
    entry.phaseRevision = this._phaseRevision;
    entry.width = width;
    entry.height = height;
    entry.reverseZ = reverseZ;
    entry.jitterX = jitterX;
    entry.jitterY = jitterY;
    const data = entry.data;
    data.entity = entity;
    data.camera = camera;
    data.worldMatrix = entry.worldMatrix;
    data.width = width;
    data.height = height;
    data.reverseZ = reverseZ;
    data.projectionJitter[0] = jitterX;
    data.projectionJitter[1] = jitterY;
    data.frameId = this._frameId;
    data.phaseRevision = this._phaseRevision;
    return entry.data;
  }

  getCamera2D(entity: Entity, camera: Camera2D, options?: Camera2DFrameOptions): Camera2DFrameData;
  getCamera2D(entity: Entity, camera: Camera2D, width?: number, height?: number): Camera2DFrameData;
  getCamera2D(
    entity: Entity,
    camera: Camera2D,
    optionsOrWidth?: Camera2DFrameOptions | number,
    requestedHeight?: number,
  ): Camera2DFrameData {
    const options = typeof optionsOrWidth === 'object' ? optionsOrWidth : undefined;
    const requestedWidth = typeof optionsOrWidth === 'number' ? optionsOrWidth : undefined;
    const width = Math.max(1, options?.width ?? requestedWidth ?? this._engine?.displayWidth ?? this._engine?.width ?? 1);
    const height = Math.max(1, options?.height ?? requestedHeight ?? this._engine?.displayHeight ?? this._engine?.height ?? 1);
    camera.resize(width, height);

    let entry = this._camera2D.get(entity.id);
    if (!entry) {
      entry = this._camera2DPool.pop() ?? createCamera2DCacheEntry(entity, camera);
      resetCamera2DCacheEntry(entry, entity, camera);
      this._camera2D.set(entity.id, entry);
    }

    const samePhase = entry.phaseRevision === this._phaseRevision
      && entry.width === width
      && entry.height === height;
    if (samePhase) return entry.data;

    const transformEntry = this.transforms.getEntry(entity);
    entry.worldMatrix.set(transformEntry.hasTransform ? transformEntry.worldMatrix : IDENTITY_MAT4);
    let viewProjection: Float32Array;
    if (transformEntry.hasTransform) {
      const view = mat4.inverse(entry.worldMatrix, entry.viewMatrix) as Float32Array;
      viewProjection = mat4.multiply(camera.projectionMatrix, view, entry.viewProjectionMatrix) as Float32Array;
    } else {
      entry.viewMatrix.set(IDENTITY_MAT4);
      entry.viewProjectionMatrix.set(camera.projectionMatrix);
      viewProjection = entry.viewProjectionMatrix;
    }

    entry.phaseRevision = this._phaseRevision;
    entry.width = width;
    entry.height = height;
    const data = entry.data;
    data.entity = entity;
    data.camera = camera;
    data.projectionMatrix = camera.projectionMatrix;
    data.viewProjectionMatrix = viewProjection;
    data.worldMatrix = entry.worldMatrix;
    data.width = width;
    data.height = height;
    data.frameId = this._frameId;
    data.phaseRevision = this._phaseRevision;
    return entry.data;
  }

  getWorldMatrix2D(entity: Entity): Float32Array {
    return this.transforms.getWorldMatrix(entity) ?? IDENTITY_MAT4;
  }

  private _releaseCameraCaches(): void {
    for (const entry of this._camera3D.values()) this._camera3DPool.push(entry);
    for (const entry of this._camera2D.values()) this._camera2DPool.push(entry);
    this._camera3D.clear();
    this._camera2D.clear();
    this._worldStructureVersion = -1;
  }

  private _reconcileCameraCaches(world: World): void {
    for (const [entityId, entry] of this._camera3D) {
      if (world.entities.get(entityId) === entry.data.entity) continue;
      this._camera3D.delete(entityId);
      this._camera3DPool.push(entry);
    }
    for (const [entityId, entry] of this._camera2D) {
      if (world.entities.get(entityId) === entry.data.entity) continue;
      this._camera2D.delete(entityId);
      this._camera2DPool.push(entry);
    }
  }
}

function createCamera3DCacheEntry(entity: Entity, camera: Camera3D): Camera3DCacheEntry {
  const projectionMatrix = mat4.identity() as Float32Array;
  const viewMatrix = mat4.identity() as Float32Array;
  const viewProjectionMatrix = mat4.identity() as Float32Array;
  const inverseViewProjectionMatrix = mat4.identity() as Float32Array;
  const worldMatrix = mat4.identity() as Float32Array;
  const position = new Float32Array(3);
  const projectionJitter = new Float32Array(2);
  const frustum = new Frustum();
  const frustumPlanes = new Float32Array(24);
  const data: Camera3DFrameData = {
    entity,
    camera,
    projectionMatrix,
    viewMatrix,
    viewProjectionMatrix,
    inverseViewProjectionMatrix,
    worldMatrix,
    position,
    frustum,
    frustumPlanes,
    width: 1,
    height: 1,
    reverseZ: false,
    projectionJitter,
    frameId: 0,
    phaseRevision: 0,
  };
  return {
    phaseRevision: 0,
    width: 1,
    height: 1,
    reverseZ: false,
    jitterX: 0,
    jitterY: 0,
    projectionMatrix,
    viewMatrix,
    viewProjectionMatrix,
    inverseViewProjectionMatrix,
    worldMatrix,
    position,
    frustum,
    frustumPlanes,
    data,
  };
}

function createCamera2DCacheEntry(entity: Entity, camera: Camera2D): Camera2DCacheEntry {
  const viewMatrix = mat4.identity() as Float32Array;
  const viewProjectionMatrix = mat4.identity() as Float32Array;
  const worldMatrix = mat4.identity() as Float32Array;
  const data: Camera2DFrameData = {
    entity,
    camera,
    projectionMatrix: camera.projectionMatrix,
    viewMatrix,
    viewProjectionMatrix,
    worldMatrix,
    width: 1,
    height: 1,
    frameId: 0,
    phaseRevision: 0,
  };
  return {
    phaseRevision: 0,
    width: 1,
    height: 1,
    viewMatrix,
    viewProjectionMatrix,
    worldMatrix,
    data,
  };
}

function resetCamera3DCacheEntry(entry: Camera3DCacheEntry, entity: Entity, camera: Camera3D): void {
  entry.phaseRevision = 0;
  entry.width = 1;
  entry.height = 1;
  entry.reverseZ = false;
  entry.jitterX = 0;
  entry.jitterY = 0;
  entry.data.entity = entity;
  entry.data.camera = camera;
  entry.data.width = 1;
  entry.data.height = 1;
  entry.data.reverseZ = false;
  entry.data.projectionJitter.fill(0);
  entry.data.frameId = 0;
  entry.data.phaseRevision = 0;
}

function resetCamera2DCacheEntry(entry: Camera2DCacheEntry, entity: Entity, camera: Camera2D): void {
  entry.phaseRevision = 0;
  entry.width = 1;
  entry.height = 1;
  entry.data.entity = entity;
  entry.data.camera = camera;
  entry.data.projectionMatrix = camera.projectionMatrix;
  entry.data.width = 1;
  entry.data.height = 1;
  entry.data.frameId = 0;
  entry.data.phaseRevision = 0;
}

function nextRevision(current: number): number {
  const next = (current + 1) >>> 0;
  return next === 0 ? 1 : next;
}

function applyProjectionJitter(
  projection: Float32Array,
  jitterX: number,
  jitterY: number,
  width: number,
  height: number,
): void {
  if (jitterX === 0 && jitterY === 0) return;
  if (!Number.isFinite(jitterX) || !Number.isFinite(jitterY)) {
    throw new RangeError('Camera3D projection jitter must contain finite pixel offsets.');
  }
  const ndcX = (2 * jitterX) / Math.max(1, width);
  const ndcY = (-2 * jitterY) / Math.max(1, height);
  for (let column = 0; column < 4; column++) {
    const offset = column * 4;
    const clipW = projection[offset + 3]!;
    projection[offset] = projection[offset]! + ndcX * clipW;
    projection[offset + 1] = projection[offset + 1]! + ndcY * clipW;
  }
}

function allocateWorldFrameTokenOwner(): number {
  nextWorldFrameTokenOwner++;
  if (nextWorldFrameTokenOwner > MAX_WORLD_FRAME_TOKEN_OWNER) {
    throw new RangeError('FrameData token owner capacity exceeded');
  }
  return nextWorldFrameTokenOwner;
}

function invalidFrameTokenError(message: string): EngineError {
  return new EngineError(EngineErrorCode.EngineInvalidState, message, {
    hint: 'Use the WorldFrameToken supplied to the current WorldRuntimeIntegration update.',
  });
}
