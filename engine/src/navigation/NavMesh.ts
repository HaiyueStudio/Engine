import type { Geometry3D } from '../geometry/Geometry3D';
import { HeightfieldNavBackend } from './HeightfieldNavBackend';
import type { NavBackend, NavMeshCompatibilityView } from './NavBackend';

const INTERNAL_BACKEND = Symbol('NavMesh.internalBackend');

interface InternalBackendOptions {
  readonly [INTERNAL_BACKEND]: {
    readonly backend: NavBackend;
    readonly compatibilityView: NavMeshCompatibilityView;
  };
}

export type NavMeshPoint = readonly [number, number, number] | Float32Array;
export type NavMeshObstacleId = number | string;
export type NavMeshPathStatus = 'complete' | 'partial' | 'invalid-start';

export interface NavMeshGridOptions {
  /** X/Z coordinate of the south-west grid corner. */
  origin: readonly [number, number];
  cellSize: number;
  columns: number;
  rows: number;
  /** One Y height per cell, in row-major order. Non-finite heights are unwalkable. */
  heights: ArrayLike<number>;
  /** Optional explicit walkability mask. Zero means blocked. */
  walkable?: ArrayLike<number>;
  /** Maximum height discontinuity allowed between adjacent cells. */
  maxStepHeight?: number;
}

export interface NavMeshBuildOptions {
  cellSize: number;
  maxSlopeRadians?: number;
  maxStepHeight?: number;
  boundsPadding?: number;
}

export interface NavMeshAgentOptions {
  radius: number;
  maxStepHeight?: number;
  /** Obstacles owned by the querying agent should normally be ignored. */
  ignoreObstacleIds?: ReadonlySet<NavMeshObstacleId> | readonly NavMeshObstacleId[];
}

export interface NavMeshObstacle {
  id: NavMeshObstacleId;
  position: NavMeshPoint;
  radius: number;
  enabled?: boolean;
}

/** Reusable typed-array result for allocation-free steady-state path queries. */
export class NavMeshPath {
  points = new Float32Array(24);
  pointCount = 0;
  status: NavMeshPathStatus = 'invalid-start';
  visitedNodeCount = 0;
  readonly requestedTarget = new Float32Array(3);
  readonly resolvedTarget = new Float32Array(3);

  get reachedTarget(): boolean { return this.status === 'complete'; }

  reset(): this {
    this.pointCount = 0;
    this.status = 'invalid-start';
    this.visitedNodeCount = 0;
    this.requestedTarget.fill(0);
    this.resolvedTarget.fill(0);
    return this;
  }

  writePoint(index: number, x: number, y: number, z: number): void {
    this.ensurePointCapacity(index + 1);
    const offset = index * 3;
    this.points[offset] = x;
    this.points[offset + 1] = y;
    this.points[offset + 2] = z;
    if (index >= this.pointCount) this.pointCount = index + 1;
  }

  private ensurePointCapacity(pointCount: number): void {
    const required = pointCount * 3;
    if (required <= this.points.length) return;
    let capacity = this.points.length;
    while (capacity < required) capacity *= 2;
    const next = new Float32Array(capacity);
    next.set(this.points.subarray(0, this.pointCount * 3));
    this.points = next;
  }
}

/**
 * Terrain-oriented, Y-up navigation mesh.
 *
 * Geometry is rasterized once. Agent radius and dynamic circular obstacles are
 * applied at query time, so differently sized agents share the same mesh.
 */
export class NavMesh {
  readonly originX: number;
  readonly originZ: number;
  readonly cellSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly maxStepHeight: number;
  readonly heights: Float32Array;
  readonly walkable: Uint8Array;
  readonly clearance: Float32Array;

  private readonly _backend: NavBackend;

  constructor(options: NavMeshGridOptions);
  constructor(options: NavMeshGridOptions | InternalBackendOptions) {
    const binding = isInternalBackendOptions(options)
      ? options[INTERNAL_BACKEND]
      : createHeightfieldBinding(new HeightfieldNavBackend(options));
    const { backend, compatibilityView } = binding;
    this._backend = backend;
    this.originX = compatibilityView.originX;
    this.originZ = compatibilityView.originZ;
    this.cellSize = compatibilityView.cellSize;
    this.columns = compatibilityView.columns;
    this.rows = compatibilityView.rows;
    this.maxStepHeight = compatibilityView.maxStepHeight;
    this.heights = compatibilityView.heights;
    this.walkable = compatibilityView.walkable;
    this.clearance = compatibilityView.clearance;
  }

  static fromGeometry(geometry: Pick<Geometry3D, 'positions' | 'indices'>, options: NavMeshBuildOptions): NavMesh {
    const backend = HeightfieldNavBackend.fromGeometry(geometry, options);
    return createNavMeshFacade(backend, backend);
  }

  get obstacleCount(): number { return this._backend.obstacleCount; }

  setObstacle(obstacle: NavMeshObstacle): this {
    this._backend.setObstacle(obstacle);
    return this;
  }

  removeObstacle(id: NavMeshObstacleId): boolean { return this._backend.removeObstacle(id); }
  clearObstacles(): void { this._backend.clearObstacles(); }

  isPositionWalkable(position: NavMeshPoint, options: NavMeshAgentOptions): boolean {
    return this._backend.isPositionWalkable(position, options);
  }

  /**
   * Samples the navigation surface directly below/above the supplied X/Z.
   *
   * Unlike projectPoint(), this never searches another cell. A null result is
   * therefore an explicit local "no support" signal for holes, boundaries,
   * agent-clearance failures, and dynamic obstacles. X/Z are preserved in the
   * output so locomotion code can combine the sampled Y with continuous motion.
   */
  sampleSurface(
    position: NavMeshPoint,
    options: NavMeshAgentOptions,
    out = new Float32Array(3),
  ): Float32Array | null {
    return this._backend.sampleSurface(position, options, out);
  }

  /** Projects a point to the closest cell available to the supplied agent. */
  projectPoint(position: NavMeshPoint, options: NavMeshAgentOptions, out = new Float32Array(3)): Float32Array | null {
    return this._backend.projectPoint(position, options, out);
  }

  findPath(
    start: NavMeshPoint,
    target: NavMeshPoint,
    options: NavMeshAgentOptions,
    out = new NavMeshPath(),
  ): NavMeshPath {
    return this._backend.findPath(start, target, options, out);
  }
}

function createNavMeshFacade(
  backend: NavBackend,
  compatibilityView: NavMeshCompatibilityView,
): NavMesh {
  return new NavMesh({
    [INTERNAL_BACKEND]: { backend, compatibilityView },
  } as unknown as NavMeshGridOptions);
}

function createHeightfieldBinding(backend: HeightfieldNavBackend): InternalBackendOptions[typeof INTERNAL_BACKEND] {
  return { backend, compatibilityView: backend };
}

function isInternalBackendOptions(
  options: NavMeshGridOptions | InternalBackendOptions,
): options is InternalBackendOptions {
  return INTERNAL_BACKEND in options;
}
