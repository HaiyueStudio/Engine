import { EngineError, EngineErrorCode } from '../core/EngineError';
import type { Geometry3D } from '../geometry/Geometry3D';
import { requiredItemAt, requiredNumberAt } from '../math/arrayAccess';
import type {
  NavMeshAgentOptions,
  NavMeshBuildOptions,
  NavMeshGridOptions,
  NavMeshObstacle,
  NavMeshObstacleId,
  NavMeshPath,
  NavMeshPoint,
} from './NavMesh';
import type { NavBackend, NavMeshCompatibilityView } from './NavBackend';

const DEFAULT_MAX_SLOPE = Math.PI / 4;
const SQRT_HALF = Math.SQRT1_2;
const EPSILON = 1e-6;

interface StoredObstacle {
  id: NavMeshObstacleId;
  x: number;
  z: number;
  radius: number;
  enabled: boolean;
}

interface TriangleSample {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  cx: number;
  cy: number;
  cz: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  walkable: boolean;
}

/**
 * Internal Y-up heightfield implementation. The public NavMesh owns no search
 * or obstacle state and delegates through NavBackend.
 */
export class HeightfieldNavBackend implements NavBackend, NavMeshCompatibilityView {
  readonly originX: number;
  readonly originZ: number;
  readonly cellSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly maxStepHeight: number;
  readonly heights: Float32Array;
  readonly walkable: Uint8Array;
  readonly clearance: Float32Array;

  private readonly _obstacles = new Map<NavMeshObstacleId, StoredObstacle>();
  private readonly _gScore: Float64Array;
  private readonly _fScore: Float64Array;
  private readonly _parent: Int32Array;
  private readonly _state: Uint8Array;
  private readonly _heap: Int32Array;
  private readonly _heapPosition: Int32Array;
  private _heapSize = 0;
  private readonly _nodePath: number[] = [];
  private readonly _smoothedPath: number[] = [];

  constructor(options: NavMeshGridOptions) {
    validateGridOptions(options);
    this.originX = options.origin[0];
    this.originZ = options.origin[1];
    this.cellSize = options.cellSize;
    this.columns = options.columns;
    this.rows = options.rows;
    this.maxStepHeight = options.maxStepHeight ?? options.cellSize * 0.75;
    const count = options.columns * options.rows;
    this.heights = new Float32Array(count);
    this.walkable = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const height = requiredNumberAt(options.heights, i, 'NavMesh heights');
      this.heights[i] = height;
      this.walkable[i] = Number.isFinite(height)
        && (options.walkable === undefined || requiredNumberAt(options.walkable, i, 'NavMesh walkable mask') !== 0)
        ? 1
        : 0;
    }
    this.clearance = computeStaticClearance(
      this.originX,
      this.originZ,
      this.cellSize,
      this.columns,
      this.rows,
      this.walkable,
    );
    this._gScore = new Float64Array(count);
    this._fScore = new Float64Array(count);
    this._parent = new Int32Array(count);
    this._state = new Uint8Array(count);
    this._heap = new Int32Array(count);
    this._heapPosition = new Int32Array(count);
  }

  static fromGeometry(
    geometry: Pick<Geometry3D, 'positions' | 'indices'>,
    options: NavMeshBuildOptions,
  ): HeightfieldNavBackend {
    validateBuildOptions(options);
    const triangles = collectTriangles(geometry, options.maxSlopeRadians ?? DEFAULT_MAX_SLOPE);
    if (triangles.length === 0) throw navigationParameterError('NavMesh geometry contains no complete finite triangles.');

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const triangle of triangles) {
      minX = Math.min(minX, triangle.minX);
      maxX = Math.max(maxX, triangle.maxX);
      minZ = Math.min(minZ, triangle.minZ);
      maxZ = Math.max(maxZ, triangle.maxZ);
    }
    const padding = options.boundsPadding ?? options.cellSize * 0.5;
    const originX = minX - padding;
    const originZ = minZ - padding;
    const columns = Math.max(1, Math.ceil((maxX - minX + padding * 2) / options.cellSize));
    const rows = Math.max(1, Math.ceil((maxZ - minZ + padding * 2) / options.cellSize));
    const heights = new Float32Array(columns * rows);
    const walkable = new Uint8Array(columns * rows);
    heights.fill(Number.NaN);

    for (let row = 0; row < rows; row++) {
      const z = originZ + (row + 0.5) * options.cellSize;
      for (let column = 0; column < columns; column++) {
        const x = originX + (column + 0.5) * options.cellSize;
        let bestHeight = -Infinity;
        let bestWalkable = false;
        for (const triangle of triangles) {
          if (x < triangle.minX - EPSILON || x > triangle.maxX + EPSILON
            || z < triangle.minZ - EPSILON || z > triangle.maxZ + EPSILON) continue;
          const sample = sampleTriangleHeightXZ(triangle, x, z);
          if (sample === null || sample <= bestHeight) continue;
          bestHeight = sample;
          bestWalkable = triangle.walkable;
        }
        if (bestHeight === -Infinity) continue;
        const index = row * columns + column;
        heights[index] = bestHeight;
        walkable[index] = bestWalkable ? 1 : 0;
      }
    }

    return new HeightfieldNavBackend({
      origin: [originX, originZ],
      cellSize: options.cellSize,
      columns,
      rows,
      heights,
      walkable,
      ...(options.maxStepHeight === undefined ? {} : { maxStepHeight: options.maxStepHeight }),
    });
  }

  get obstacleCount(): number { return this._obstacles.size; }

  setObstacle(obstacle: NavMeshObstacle): this {
    const x = pointValue(obstacle.position, 0, 'NavMesh obstacle position');
    const z = pointValue(obstacle.position, 2, 'NavMesh obstacle position');
    if (!isObstacleId(obstacle.id) || !Number.isFinite(x) || !Number.isFinite(z)
      || !Number.isFinite(obstacle.radius) || obstacle.radius < 0) {
      throw navigationParameterError('NavMesh obstacle id, position, and radius must be finite and valid.');
    }
    this._obstacles.set(obstacle.id, {
      id: obstacle.id,
      x,
      z,
      radius: obstacle.radius,
      enabled: obstacle.enabled ?? true,
    });
    return this;
  }

  removeObstacle(id: NavMeshObstacleId): boolean { return this._obstacles.delete(id); }
  clearObstacles(): void { this._obstacles.clear(); }

  isPositionWalkable(position: NavMeshPoint, options: NavMeshAgentOptions): boolean {
    validateAgentOptions(options);
    const x = pointValue(position, 0, 'NavMesh position');
    const z = pointValue(position, 2, 'NavMesh position');
    const cell = this._cellAt(x, z);
    if (cell < 0 || !this._isCellAllowed(cell, options)) return false;
    return this._distanceToCellCenterSquared(cell, x, z) <= this.cellSize * this.cellSize * 0.5 + EPSILON;
  }

  sampleSurface(position: NavMeshPoint, options: NavMeshAgentOptions, out: Float32Array): Float32Array | null {
    validateAgentOptions(options);
    if (out.length < 3) throw navigationParameterError('NavMesh output point requires at least three elements.');
    const x = pointValue(position, 0, 'NavMesh surface sample');
    const z = pointValue(position, 2, 'NavMesh surface sample');
    const cell = this._cellAt(x, z);
    if (cell < 0 || !this._isCellAllowed(cell, options)) return null;
    out[0] = x;
    out[1] = requiredNumberAt(this.heights, cell, 'NavMesh heights');
    out[2] = z;
    return out;
  }

  /** Projects a point to the closest cell available to the supplied agent. */
  projectPoint(position: NavMeshPoint, options: NavMeshAgentOptions, out: Float32Array): Float32Array | null {
    validateAgentOptions(options);
    const x = pointValue(position, 0, 'NavMesh project point');
    const z = pointValue(position, 2, 'NavMesh project point');
    const cell = this._findClosestAllowedCell(x, z, options);
    if (cell < 0) return null;
    this._writeCellPoint(cell, out);
    return out;
  }

  findPath(
    start: NavMeshPoint,
    target: NavMeshPoint,
    options: NavMeshAgentOptions,
    out: NavMeshPath,
  ): NavMeshPath {
    validateAgentOptions(options);
    out.reset();
    const startX = pointValue(start, 0, 'NavMesh path start');
    const startZ = pointValue(start, 2, 'NavMesh path start');
    const targetX = pointValue(target, 0, 'NavMesh path target');
    const targetY = pointValue(target, 1, 'NavMesh path target');
    const targetZ = pointValue(target, 2, 'NavMesh path target');
    out.requestedTarget.set([targetX, targetY, targetZ]);

    const startCell = this._findClosestAllowedCell(startX, startZ, options);
    if (startCell < 0) return out;
    const directTargetCell = this._cellAt(targetX, targetZ);
    const requestedTargetAllowed = directTargetCell >= 0 && this._isCellAllowed(directTargetCell, options);
    const goalCell = requestedTargetAllowed
      ? directTargetCell
      : this._findClosestAllowedCell(targetX, targetZ, options);
    if (goalCell < 0) return out;

    this._beginSearch(startCell, goalCell);
    let bestCell = startCell;
    let bestDistance = this._distanceToCellCenterSquared(startCell, targetX, targetZ);
    let reachedGoal = false;

    while (this._heapSize > 0) {
      const current = this._popHeap();
      this._state[current] = 2;
      out.visitedNodeCount++;
      const targetDistance = this._distanceToCellCenterSquared(current, targetX, targetZ);
      if (targetDistance < bestDistance) {
        bestDistance = targetDistance;
        bestCell = current;
      }
      if (current === goalCell) {
        bestCell = current;
        reachedGoal = true;
        break;
      }
      this._visitNeighbours(current, goalCell, options);
    }

    const resolvedCell = reachedGoal ? goalCell : bestCell;
    this._reconstructPath(startCell, resolvedCell);
    this._smoothPath(options);
    this._writePath(startX, startZ, targetX, targetZ, requestedTargetAllowed && reachedGoal, out);
    out.status = requestedTargetAllowed && reachedGoal ? 'complete' : 'partial';
    const lastOffset = (out.pointCount - 1) * 3;
    out.resolvedTarget[0] = requiredNumberAt(out.points, lastOffset, 'NavMesh result points');
    out.resolvedTarget[1] = requiredNumberAt(out.points, lastOffset + 1, 'NavMesh result points');
    out.resolvedTarget[2] = requiredNumberAt(out.points, lastOffset + 2, 'NavMesh result points');
    return out;
  }

  private _beginSearch(startCell: number, goalCell: number): void {
    this._gScore.fill(Infinity);
    this._fScore.fill(Infinity);
    this._parent.fill(-1);
    this._state.fill(0);
    this._heapPosition.fill(-1);
    this._heapSize = 0;
    this._gScore[startCell] = 0;
    this._fScore[startCell] = this._heuristic(startCell, goalCell);
    this._state[startCell] = 1;
    this._pushOrDecrease(startCell);
  }

  private _visitNeighbours(current: number, goal: number, options: NavMeshAgentOptions): void {
    const column = current % this.columns;
    const row = Math.floor(current / this.columns);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nextColumn = column + dx;
        const nextRow = row + dz;
        if (nextColumn < 0 || nextColumn >= this.columns || nextRow < 0 || nextRow >= this.rows) continue;
        const next = nextRow * this.columns + nextColumn;
        if (this._state[next] === 2 || !this._canTransition(current, next, options)) continue;
        if (dx !== 0 && dz !== 0) {
          const horizontal = row * this.columns + nextColumn;
          const vertical = nextRow * this.columns + column;
          if (!this._canTransition(current, horizontal, options)
            || !this._canTransition(current, vertical, options)) continue;
        }
        const currentScore = requiredNumberAt(this._gScore, current, 'NavMesh gScore');
        const tentative = currentScore + (dx === 0 || dz === 0 ? 1 : Math.SQRT2);
        if (tentative >= requiredNumberAt(this._gScore, next, 'NavMesh gScore')) continue;
        this._parent[next] = current;
        this._gScore[next] = tentative;
        this._fScore[next] = tentative + this._heuristic(next, goal);
        this._state[next] = 1;
        this._pushOrDecrease(next);
      }
    }
  }

  private _canTransition(from: number, to: number, options: NavMeshAgentOptions): boolean {
    if (!this._isCellAllowed(to, options)) return false;
    const maxStep = options.maxStepHeight ?? this.maxStepHeight;
    return Math.abs(
      requiredNumberAt(this.heights, from, 'NavMesh heights')
      - requiredNumberAt(this.heights, to, 'NavMesh heights'),
    ) <= maxStep + EPSILON;
  }

  private _isCellAllowed(cell: number, options: NavMeshAgentOptions): boolean {
    if (requiredNumberAt(this.walkable, cell, 'NavMesh walkable mask') === 0) return false;
    if (requiredNumberAt(this.clearance, cell, 'NavMesh clearance') + EPSILON < options.radius) return false;
    const x = this._cellX(cell);
    const z = this._cellZ(cell);
    const ignored = options.ignoreObstacleIds;
    for (const obstacle of this._obstacles.values()) {
      if (!obstacle.enabled || includesObstacleId(ignored, obstacle.id)) continue;
      const radius = options.radius + obstacle.radius;
      const dx = x - obstacle.x;
      const dz = z - obstacle.z;
      if (dx * dx + dz * dz < radius * radius - EPSILON) return false;
    }
    return true;
  }

  private _cellAt(x: number, z: number): number {
    const column = Math.floor((x - this.originX) / this.cellSize);
    const row = Math.floor((z - this.originZ) / this.cellSize);
    if (column < 0 || column >= this.columns || row < 0 || row >= this.rows) return -1;
    return row * this.columns + column;
  }

  private _findClosestAllowedCell(x: number, z: number, options: NavMeshAgentOptions): number {
    const direct = this._cellAt(x, z);
    if (direct >= 0 && this._isCellAllowed(direct, options)) return direct;
    let best = -1;
    let bestDistance = Infinity;
    const count = this.columns * this.rows;
    for (let cell = 0; cell < count; cell++) {
      if (!this._isCellAllowed(cell, options)) continue;
      const distance = this._distanceToCellCenterSquared(cell, x, z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = cell;
      }
    }
    return best;
  }

  private _reconstructPath(start: number, end: number): void {
    this._nodePath.length = 0;
    let current = end;
    this._nodePath.push(current);
    while (current !== start) {
      current = requiredNumberAt(this._parent, current, 'NavMesh parent table');
      if (current < 0) break;
      this._nodePath.push(current);
    }
    this._nodePath.reverse();
  }

  private _smoothPath(options: NavMeshAgentOptions): void {
    this._smoothedPath.length = 0;
    if (this._nodePath.length === 0) return;
    let cursor = 0;
    this._smoothedPath.push(requiredItemAt(this._nodePath, 0, 'NavMesh node path'));
    while (cursor < this._nodePath.length - 1) {
      let next = cursor + 1;
      for (let candidate = this._nodePath.length - 1; candidate > cursor + 1; candidate--) {
        const from = requiredItemAt(this._nodePath, cursor, 'NavMesh node path');
        const to = requiredItemAt(this._nodePath, candidate, 'NavMesh node path');
        if (this._canTraverseSegment(from, to, options)) {
          next = candidate;
          break;
        }
      }
      this._smoothedPath.push(requiredItemAt(this._nodePath, next, 'NavMesh node path'));
      cursor = next;
    }
  }

  private _canTraverseSegment(from: number, to: number, options: NavMeshAgentOptions): boolean {
    const x0 = this._cellX(from);
    const z0 = this._cellZ(from);
    const x1 = this._cellX(to);
    const z1 = this._cellZ(to);
    const distance = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(distance / (this.cellSize * 0.35)));
    let previous = from;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const cell = this._cellAt(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
      if (cell < 0 || !this._isCellAllowed(cell, options)) return false;
      if (cell !== previous && !this._canTransition(previous, cell, options)) return false;
      previous = cell;
    }
    return true;
  }

  private _writePath(
    startX: number,
    startZ: number,
    targetX: number,
    targetZ: number,
    exactTarget: boolean,
    out: NavMeshPath,
  ): void {
    out.pointCount = 0;
    const firstCell = requiredItemAt(this._smoothedPath, 0, 'NavMesh smoothed path');
    const directStart = this._cellAt(startX, startZ) === firstCell;
    out.writePoint(
      0,
      directStart ? startX : this._cellX(firstCell),
      requiredNumberAt(this.heights, firstCell, 'NavMesh heights'),
      directStart ? startZ : this._cellZ(firstCell),
    );
    for (let i = 1; i < this._smoothedPath.length; i++) {
      const cell = requiredItemAt(this._smoothedPath, i, 'NavMesh smoothed path');
      out.writePoint(i, this._cellX(cell), requiredNumberAt(this.heights, cell, 'NavMesh heights'), this._cellZ(cell));
    }
    if (exactTarget) {
      const cell = this._cellAt(targetX, targetZ);
      const targetHeight = requiredNumberAt(this.heights, cell, 'NavMesh heights');
      if (out.pointCount === 1 && (Math.abs(startX - targetX) > EPSILON || Math.abs(startZ - targetZ) > EPSILON)) {
        out.writePoint(1, targetX, targetHeight, targetZ);
      } else {
        out.writePoint(Math.max(0, out.pointCount - 1), targetX, targetHeight, targetZ);
      }
    }
  }

  private _pushOrDecrease(node: number): void {
    let position = requiredNumberAt(this._heapPosition, node, 'NavMesh heap positions');
    if (position < 0) {
      position = this._heapSize++;
      this._heap[position] = node;
      this._heapPosition[node] = position;
    }
    while (position > 0) {
      const parent = (position - 1) >> 1;
      const parentNode = requiredNumberAt(this._heap, parent, 'NavMesh heap');
      if (this._compareHeapNodes(parentNode, node) <= 0) break;
      this._heap[position] = parentNode;
      this._heapPosition[parentNode] = position;
      position = parent;
    }
    this._heap[position] = node;
    this._heapPosition[node] = position;
  }

  private _popHeap(): number {
    const result = requiredNumberAt(this._heap, 0, 'NavMesh heap');
    this._heapPosition[result] = -1;
    this._heapSize--;
    if (this._heapSize === 0) return result;
    const last = requiredNumberAt(this._heap, this._heapSize, 'NavMesh heap');
    let position = 0;
    while (true) {
      const left = position * 2 + 1;
      if (left >= this._heapSize) break;
      const right = left + 1;
      let child = left;
      if (right < this._heapSize) {
        const leftNode = requiredNumberAt(this._heap, left, 'NavMesh heap');
        const rightNode = requiredNumberAt(this._heap, right, 'NavMesh heap');
        if (this._compareHeapNodes(rightNode, leftNode) < 0) child = right;
      }
      const childNode = requiredNumberAt(this._heap, child, 'NavMesh heap');
      if (this._compareHeapNodes(last, childNode) <= 0) break;
      this._heap[position] = childNode;
      this._heapPosition[childNode] = position;
      position = child;
    }
    this._heap[position] = last;
    this._heapPosition[last] = position;
    return result;
  }

  private _compareHeapNodes(a: number, b: number): number {
    return requiredNumberAt(this._fScore, a, 'NavMesh fScore')
      - requiredNumberAt(this._fScore, b, 'NavMesh fScore') || a - b;
  }

  private _heuristic(a: number, b: number): number {
    const ax = a % this.columns;
    const az = Math.floor(a / this.columns);
    const bx = b % this.columns;
    const bz = Math.floor(b / this.columns);
    const dx = Math.abs(ax - bx);
    const dz = Math.abs(az - bz);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  }

  private _cellX(cell: number): number { return this.originX + (cell % this.columns + 0.5) * this.cellSize; }
  private _cellZ(cell: number): number { return this.originZ + (Math.floor(cell / this.columns) + 0.5) * this.cellSize; }
  private _distanceToCellCenterSquared(cell: number, x: number, z: number): number {
    const dx = this._cellX(cell) - x;
    const dz = this._cellZ(cell) - z;
    return dx * dx + dz * dz;
  }
  private _writeCellPoint(cell: number, out: Float32Array): void {
    if (out.length < 3) throw navigationParameterError('NavMesh output point requires at least three elements.');
    out[0] = this._cellX(cell);
    out[1] = requiredNumberAt(this.heights, cell, 'NavMesh heights');
    out[2] = this._cellZ(cell);
  }
}

function validateGridOptions(options: NavMeshGridOptions): void {
  if (!Number.isFinite(options.origin[0]) || !Number.isFinite(options.origin[1])
    || !Number.isFinite(options.cellSize) || options.cellSize <= 0
    || !Number.isInteger(options.columns) || options.columns <= 0
    || !Number.isInteger(options.rows) || options.rows <= 0
    || !Number.isFinite(options.maxStepHeight ?? options.cellSize * 0.75)
    || (options.maxStepHeight ?? 0) < 0) {
    throw navigationParameterError('NavMesh grid dimensions, origin, cell size, and step height must be finite and valid.');
  }
  const count = options.columns * options.rows;
  if (options.heights.length !== count || (options.walkable !== undefined && options.walkable.length !== count)) {
    throw navigationParameterError(`NavMesh grid arrays must contain exactly ${count} cells.`);
  }
}

function validateBuildOptions(options: NavMeshBuildOptions): void {
  const slope = options.maxSlopeRadians ?? DEFAULT_MAX_SLOPE;
  if (!Number.isFinite(options.cellSize) || options.cellSize <= 0
    || !Number.isFinite(slope) || slope < 0 || slope >= Math.PI * 0.5
    || !Number.isFinite(options.maxStepHeight ?? options.cellSize * 0.75)
    || (options.maxStepHeight ?? 0) < 0
    || !Number.isFinite(options.boundsPadding ?? 0) || (options.boundsPadding ?? 0) < 0) {
    throw navigationParameterError('NavMesh build options must use positive cell size and valid slope, step, and padding values.');
  }
}

function validateAgentOptions(options: NavMeshAgentOptions): void {
  if (!Number.isFinite(options.radius) || options.radius < 0
    || !Number.isFinite(options.maxStepHeight ?? 0) || (options.maxStepHeight ?? 0) < 0) {
    throw navigationParameterError('NavMesh agent radius and optional step height must be finite and non-negative.');
  }
}

function collectTriangles(
  geometry: Pick<Geometry3D, 'positions' | 'indices'>,
  maxSlopeRadians: number,
): TriangleSample[] {
  const result: TriangleSample[] = [];
  const positions = geometry.positions;
  const indices = geometry.indices;
  const triangleCount = indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);
  const minNormalY = Math.cos(maxSlopeRadians);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const ia = indices ? requiredNumberAt(indices, triangle * 3, 'NavMesh geometry indices') : triangle * 3;
    const ib = indices ? requiredNumberAt(indices, triangle * 3 + 1, 'NavMesh geometry indices') : triangle * 3 + 1;
    const ic = indices ? requiredNumberAt(indices, triangle * 3 + 2, 'NavMesh geometry indices') : triangle * 3 + 2;
    const ax = requiredNumberAt(positions, ia * 3, 'NavMesh geometry positions');
    const ay = requiredNumberAt(positions, ia * 3 + 1, 'NavMesh geometry positions');
    const az = requiredNumberAt(positions, ia * 3 + 2, 'NavMesh geometry positions');
    const bx = requiredNumberAt(positions, ib * 3, 'NavMesh geometry positions');
    const by = requiredNumberAt(positions, ib * 3 + 1, 'NavMesh geometry positions');
    const bz = requiredNumberAt(positions, ib * 3 + 2, 'NavMesh geometry positions');
    const cx = requiredNumberAt(positions, ic * 3, 'NavMesh geometry positions');
    const cy = requiredNumberAt(positions, ic * 3 + 1, 'NavMesh geometry positions');
    const cz = requiredNumberAt(positions, ic * 3 + 2, 'NavMesh geometry positions');
    if (![ax, ay, az, bx, by, bz, cx, cy, cz].every(Number.isFinite)) continue;
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const normalLength = Math.hypot(nx, ny, nz);
    if (normalLength < EPSILON) continue;
    result.push({
      ax, ay, az, bx, by, bz, cx, cy, cz,
      minX: Math.min(ax, bx, cx),
      maxX: Math.max(ax, bx, cx),
      minZ: Math.min(az, bz, cz),
      maxZ: Math.max(az, bz, cz),
      walkable: Math.abs(ny) / normalLength >= minNormalY,
    });
  }
  return result;
}

function sampleTriangleHeightXZ(triangle: TriangleSample, x: number, z: number): number | null {
  const v0x = triangle.bx - triangle.ax;
  const v0z = triangle.bz - triangle.az;
  const v1x = triangle.cx - triangle.ax;
  const v1z = triangle.cz - triangle.az;
  const v2x = x - triangle.ax;
  const v2z = z - triangle.az;
  const denominator = v0x * v1z - v1x * v0z;
  if (Math.abs(denominator) < EPSILON) return null;
  const u = (v2x * v1z - v1x * v2z) / denominator;
  const v = (v0x * v2z - v2x * v0z) / denominator;
  if (u < -EPSILON || v < -EPSILON || u + v > 1 + EPSILON) return null;
  return triangle.ay + u * (triangle.by - triangle.ay) + v * (triangle.cy - triangle.ay);
}

function computeStaticClearance(
  originX: number,
  originZ: number,
  cellSize: number,
  columns: number,
  rows: number,
  walkable: Uint8Array,
): Float32Array {
  const result = new Float32Array(columns * rows);
  const blocked: number[] = [];
  for (let i = 0; i < walkable.length; i++) {
    if (requiredNumberAt(walkable, i, 'NavMesh walkable mask') === 0) blocked.push(i);
  }
  const maxX = originX + columns * cellSize;
  const maxZ = originZ + rows * cellSize;
  for (let cell = 0; cell < walkable.length; cell++) {
    if (requiredNumberAt(walkable, cell, 'NavMesh walkable mask') === 0) {
      result[cell] = 0;
      continue;
    }
    const x = originX + (cell % columns + 0.5) * cellSize;
    const z = originZ + (Math.floor(cell / columns) + 0.5) * cellSize;
    let clearance = Math.min(x - originX, maxX - x, z - originZ, maxZ - z);
    for (const blockedCell of blocked) {
      const bx = originX + (blockedCell % columns + 0.5) * cellSize;
      const bz = originZ + (Math.floor(blockedCell / columns) + 0.5) * cellSize;
      const dx = Math.max(Math.abs(x - bx) - cellSize * 0.5, 0);
      const dz = Math.max(Math.abs(z - bz) - cellSize * 0.5, 0);
      clearance = Math.min(clearance, Math.hypot(dx, dz));
      if (clearance <= 0) break;
    }
    result[cell] = Math.max(0, clearance - cellSize * SQRT_HALF * 0.05);
  }
  return result;
}

function pointValue(point: NavMeshPoint, index: number, label: string): number {
  const value = requiredNumberAt(point, index, label);
  if (!Number.isFinite(value)) throw navigationParameterError(`${label} must contain finite coordinates.`);
  return value;
}

function includesObstacleId(
  values: NavMeshAgentOptions['ignoreObstacleIds'],
  id: NavMeshObstacleId,
): boolean {
  if (!values) return false;
  return Array.isArray(values)
    ? values.includes(id)
    : (values as ReadonlySet<NavMeshObstacleId>).has(id);
}

function isObstacleId(value: unknown): value is NavMeshObstacleId {
  return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length > 0);
}

function navigationParameterError(message: string): EngineError {
  return new EngineError(
    EngineErrorCode.GeometryInvalidParameter,
    message,
    {
      path: 'navigation',
      hint: 'Validate NavMesh geometry, grid dimensions, and agent/obstacle settings before building or querying.',
      docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
    },
  );
}
