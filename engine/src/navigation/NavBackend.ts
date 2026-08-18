import type {
  NavMeshAgentOptions,
  NavMeshObstacle,
  NavMeshObstacleId,
  NavMeshPath,
  NavMeshPoint,
} from './NavMesh';

/**
 * Internal navigation query seam.
 *
 * Backends own all mutable topology, search, obstacle, and scratch state.
 * Deliberately keep heightfield storage out of this protocol so a polygon
 * backend can implement it without manufacturing grid-shaped state.
 */
export interface NavBackend {
  readonly obstacleCount: number;

  setObstacle(obstacle: NavMeshObstacle): void;
  removeObstacle(id: NavMeshObstacleId): boolean;
  clearObstacles(): void;
  isPositionWalkable(position: NavMeshPoint, options: NavMeshAgentOptions): boolean;
  sampleSurface(position: NavMeshPoint, options: NavMeshAgentOptions, out: Float32Array): Float32Array | null;
  projectPoint(position: NavMeshPoint, options: NavMeshAgentOptions, out: Float32Array): Float32Array | null;
  findPath(
    start: NavMeshPoint,
    target: NavMeshPoint,
    options: NavMeshAgentOptions,
    out: NavMeshPath,
  ): NavMeshPath;
}

/**
 * Compatibility data exposed by today's public NavMesh fields.
 *
 * This is separate from NavBackend because these fields describe the current
 * heightfield representation, not the navigation query contract.
 */
export interface NavMeshCompatibilityView {
  readonly originX: number;
  readonly originZ: number;
  readonly cellSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly maxStepHeight: number;
  readonly heights: Float32Array;
  readonly walkable: Uint8Array;
  readonly clearance: Float32Array;
}
