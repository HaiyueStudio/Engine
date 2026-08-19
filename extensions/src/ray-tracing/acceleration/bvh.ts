import type { RaySceneAnalyticSphere, RaySceneTriangleGeometry, RayVec3 } from '../reference/index.js';
import {
  bounds,
  boundsCentroid,
  boundsFromPoints,
  compareText,
  emptyBounds,
  fingerprintText,
  isEmptyBounds,
  numberToken,
  unionBounds,
  vec3,
} from './math.js';
import type {
  RayAccelerationDiagnostic,
  RayAccelerationPhase,
  RayAccelerationPrimitive,
  RayBlas,
  RayBlasBuildResult,
  RayBounds3,
  RayBvhNode,
} from './types.js';

export const RAY_ACCELERATION_POLICY = Object.freeze({
  schemaVersion: 1,
  hierarchy: 'deterministic-balanced-binary' as const,
  split: 'largest-centroid-extent-median, primitive/instance identity tie-break' as const,
  blasLeafCapacity: 4,
  tlasLeafCapacity: 2,
  boundsEncoding: 'float32 outward rounded at serialization; float64 CPU build' as const,
  boundsQuantization: 'none-v1' as const,
  traversalStackLimit: 64,
  overflowBehavior: 'abort ray and emit RAY_ACCEL_STACK_OVERFLOW' as const,
  rationale: Object.freeze([
    'Binary nodes keep the first compute traversal ABI small and deterministic.',
    'Median splits bound depth independently of timing-sensitive SAH heuristics.',
    'Unquantized outward-rounded float32 bounds preserve conservative containment for large coordinates and refit.',
    'A 64-entry stack covers the balanced v1 builder while keeping per-ray storage bounded.',
  ]),
});

interface BuildItem {
  readonly sourceIndex: number;
  readonly stableId: string;
  readonly bounds: RayBounds3;
  readonly centroid: RayVec3;
}

export interface BuiltHierarchy {
  readonly rootNode: number;
  readonly bounds: RayBounds3 | null;
  readonly nodes: readonly RayBvhNode[];
  readonly order: readonly number[];
  readonly maxDepth: number;
  readonly leafCount: number;
}

export function buildBlas(geometry: RaySceneTriangleGeometry): RayBlasBuildResult {
  const diagnostics: RayAccelerationDiagnostic[] = [];
  const sourceFingerprint = fingerprintTriangleGeometry(geometry);
  if (!validateGeometry(geometry, diagnostics)) return freezeBuildResult(null, diagnostics);
  const primitives: RayAccelerationPrimitive[] = [];
  for (let primitiveIndex = 0; primitiveIndex < geometry.primitiveCount; primitiveIndex++) {
    const primitive = readTrianglePrimitive(geometry, primitiveIndex, diagnostics);
    if (!primitive) {
      diagnostics.push(diagnostic('blas-build', 'error', 'RAY_BLAS_PRIMITIVE_INVALID',
        `Geometry ${geometry.geometryId} primitive ${primitiveIndex} cannot be read.`, {
          geometryId: geometry.geometryId,
          primitiveIndex,
        }));
      return freezeBuildResult(null, diagnostics);
    }
    primitives.push(primitive);
  }
  const hierarchy = buildHierarchy(
    primitives.map((primitive, sourceIndex) => ({
      sourceIndex,
      stableId: String(primitive.primitiveIndex).padStart(12, '0'),
      bounds: primitive.bounds,
      centroid: boundsCentroid(primitive.bounds),
    })),
    RAY_ACCELERATION_POLICY.blasLeafCapacity,
  );
  diagnoseDepth(hierarchy.maxDepth, 'blas-build', diagnostics, { geometryId: geometry.geometryId });
  const key = blasKey(geometry.geometryId, geometry.revision);
  const fingerprint = fingerprintHierarchy(key, hierarchy, primitives);
  const frozenPrimitives = Object.freeze(primitives);
  const frozenDiagnostics = Object.freeze(diagnostics);
  const blas: RayBlas = Object.freeze({
    schemaVersion: 1,
    key,
    geometryId: geometry.geometryId,
    geometryRevision: geometry.revision,
    sourceKind: 'triangle-mesh',
    sourceFingerprint,
    fingerprint,
    rootNode: hierarchy.rootNode,
    bounds: hierarchy.bounds,
    nodes: hierarchy.nodes,
    primitives: frozenPrimitives,
    primitiveIndices: hierarchy.order,
    statistics: Object.freeze({
      nodeCount: hierarchy.nodes.length,
      leafCount: hierarchy.leafCount,
      primitiveCount: primitives.length,
      maxDepth: hierarchy.maxDepth,
      estimatedBytes: hierarchy.nodes.length * 32 + primitives.length * 64 + hierarchy.order.length * 4,
    }),
    diagnostics: frozenDiagnostics,
  });
  return freezeBuildResult(blas, diagnostics);
}

export function buildAnalyticSphereBlas(sphere: RaySceneAnalyticSphere): RayBlasBuildResult {
  const diagnostics: RayAccelerationDiagnostic[] = [];
  if (!Number.isInteger(sphere.identity.geometryRevision) || sphere.identity.geometryRevision < 0
    || !Number.isInteger(sphere.identity.primitiveIndex) || sphere.identity.primitiveIndex < 0
    || sphere.identity.primitiveIndex > 0xffff_ffff
    || !Number.isFinite(sphere.radius) || sphere.radius <= 0
    || sphere.center.some(value => !Number.isFinite(value))) {
    diagnostics.push(diagnostic('blas-build', 'error', 'RAY_BLAS_SPHERE_INVALID',
      `Analytic sphere ${sphere.identity.geometryId} has an invalid center or radius.`, {
        geometryId: sphere.identity.geometryId,
        primitiveIndex: sphere.identity.primitiveIndex,
      }));
    return freezeBuildResult(null, diagnostics);
  }
  const radius = sphere.radius;
  const primitiveBounds = bounds(
    vec3(sphere.center[0] - radius, sphere.center[1] - radius, sphere.center[2] - radius),
    vec3(sphere.center[0] + radius, sphere.center[1] + radius, sphere.center[2] + radius),
  );
  if ([...primitiveBounds.min, ...primitiveBounds.max].some(value => !Number.isFinite(value))) {
    diagnostics.push(diagnostic('blas-build', 'error', 'RAY_BLAS_BOUNDS_OVERFLOW',
      `Analytic sphere ${sphere.identity.geometryId} overflows finite local bounds.`, {
        geometryId: sphere.identity.geometryId,
        primitiveIndex: sphere.identity.primitiveIndex,
      }));
    return freezeBuildResult(null, diagnostics);
  }
  const primitive: RayAccelerationPrimitive = Object.freeze({
    kind: 'sphere',
    primitiveIndex: sphere.identity.primitiveIndex,
    bounds: primitiveBounds,
    data: Object.freeze([sphere.center[0], sphere.center[1], sphere.center[2], radius]),
  });
  const hierarchy = buildHierarchy([{
    sourceIndex: 0,
    stableId: String(sphere.identity.primitiveIndex).padStart(12, '0'),
    bounds: primitiveBounds,
    centroid: sphere.center,
  }], 1);
  const key = analyticBlasKey(sphere.identity.geometryId, sphere.identity.geometryRevision, sphere.identity.primitiveIndex);
  const sourceFingerprint = fingerprintText([
    key, ...sphere.center.map(numberToken), numberToken(radius),
  ].join('|'));
  const blas: RayBlas = Object.freeze({
    schemaVersion: 1,
    key,
    geometryId: sphere.identity.geometryId,
    geometryRevision: sphere.identity.geometryRevision,
    sourceKind: 'analytic-sphere',
    sourceFingerprint,
    fingerprint: fingerprintHierarchy(key, hierarchy, [primitive]),
    rootNode: hierarchy.rootNode,
    bounds: hierarchy.bounds,
    nodes: hierarchy.nodes,
    primitives: Object.freeze([primitive]),
    primitiveIndices: hierarchy.order,
    statistics: Object.freeze({
      nodeCount: hierarchy.nodes.length,
      leafCount: hierarchy.leafCount,
      primitiveCount: 1,
      maxDepth: hierarchy.maxDepth,
      estimatedBytes: hierarchy.nodes.length * 32 + 64 + 4,
    }),
    diagnostics: Object.freeze(diagnostics),
  });
  return freezeBuildResult(blas, diagnostics);
}

export function buildHierarchy(items: readonly BuildItem[], leafCapacity: number): BuiltHierarchy {
  if (items.length === 0) {
    return Object.freeze({
      rootNode: -1,
      bounds: null,
      nodes: Object.freeze([]),
      order: Object.freeze([]),
      maxDepth: 0,
      leafCount: 0,
    });
  }
  const mutableItems = [...items];
  const nodes: RayBvhNode[] = [];
  const order: number[] = [];
  let maxDepth = 0;
  let leafCount = 0;

  const build = (start: number, end: number, depth: number): number => {
    const nodeIndex = nodes.length;
    nodes.push(emptyNode(depth));
    maxDepth = Math.max(maxDepth, depth);
    let nodeBounds = emptyBounds();
    let centroidBounds = emptyBounds();
    for (let index = start; index < end; index++) {
      const item = mutableItems[index]!;
      nodeBounds = unionBounds(nodeBounds, item.bounds);
      centroidBounds = unionBounds(centroidBounds, bounds(item.centroid, item.centroid));
    }
    const count = end - start;
    if (count <= leafCapacity) {
      const firstIndex = order.length;
      for (let index = start; index < end; index++) order.push(mutableItems[index]!.sourceIndex);
      nodes[nodeIndex] = Object.freeze({
        bounds: nodeBounds,
        leftChild: -1,
        rightChild: -1,
        firstIndex,
        indexCount: count,
        depth,
      });
      leafCount++;
      return nodeIndex;
    }
    const axis = largestExtentAxis(centroidBounds);
    const sorted = mutableItems.slice(start, end).sort((a, b) => (
      a.centroid[axis] - b.centroid[axis]
      || compareText(a.stableId, b.stableId)
      || a.sourceIndex - b.sourceIndex
    ));
    mutableItems.splice(start, count, ...sorted);
    const middle = start + Math.floor(count / 2);
    const leftChild = build(start, middle, depth + 1);
    const rightChild = build(middle, end, depth + 1);
    nodes[nodeIndex] = Object.freeze({
      bounds: nodeBounds,
      leftChild,
      rightChild,
      firstIndex: 0,
      indexCount: 0,
      depth,
    });
    return nodeIndex;
  };

  const rootNode = build(0, mutableItems.length, 0);
  return Object.freeze({
    rootNode,
    bounds: nodes[rootNode]!.bounds,
    nodes: Object.freeze(nodes),
    order: Object.freeze(order),
    maxDepth,
    leafCount,
  });
}

export function blasKey(geometryId: string, revision: number): string {
  return `${geometryId}@${revision}`;
}

export function analyticBlasKey(geometryId: string, revision: number, primitiveIndex: number): string {
  return `${geometryId}@${revision}:sphere:${primitiveIndex}`;
}

export function fingerprintTriangleGeometry(geometry: RaySceneTriangleGeometry): string {
  const tokens = [geometry.geometryId, String(geometry.revision), String(geometry.primitiveCount), 'positions'];
  tokens.push(...geometry.positions.map(numberToken), 'normals');
  if (geometry.normals) tokens.push(...geometry.normals.map(numberToken));
  tokens.push('indices');
  if (geometry.indices) tokens.push(...geometry.indices.map(numberToken));
  return fingerprintText(tokens.join('|'));
}

function validateGeometry(geometry: RaySceneTriangleGeometry, diagnostics: RayAccelerationDiagnostic[]): boolean {
  let valid = true;
  if (!Number.isInteger(geometry.revision) || geometry.revision < 0 || geometry.kind !== 'triangle-mesh') {
    diagnostics.push(diagnostic('blas-build', 'error', 'RAY_BLAS_IDENTITY_INVALID',
      `Geometry ${geometry.geometryId} has an invalid revision or kind.`, { geometryId: geometry.geometryId }));
    valid = false;
  }
  if (geometry.positions.length % 3 !== 0 || geometry.positions.some(value => !Number.isFinite(value))) {
    diagnostics.push(diagnostic('blas-build', 'error', 'RAY_BLAS_POSITIONS_INVALID',
      `Geometry ${geometry.geometryId} positions must contain finite xyz triplets.`, { geometryId: geometry.geometryId }));
    valid = false;
  }
  const available = geometry.indices ? geometry.indices.length / 3 : geometry.positions.length / 9;
  if (!Number.isInteger(available) || available !== geometry.primitiveCount || geometry.primitiveCount < 0) {
    diagnostics.push(diagnostic('blas-build', 'error', 'RAY_BLAS_PRIMITIVE_COUNT_INVALID',
      `Geometry ${geometry.geometryId} primitive count does not match its data.`, {
        geometryId: geometry.geometryId,
        primitiveCount: geometry.primitiveCount,
        availablePrimitiveCount: available,
      }));
    valid = false;
  }
  if (geometry.indices) {
    const vertexCount = geometry.positions.length / 3;
    if (geometry.indices.some(index => !Number.isInteger(index) || index < 0 || index >= vertexCount)) {
      diagnostics.push(diagnostic('blas-build', 'error', 'RAY_BLAS_INDEX_INVALID',
        `Geometry ${geometry.geometryId} contains an out-of-range index.`, { geometryId: geometry.geometryId }));
      valid = false;
    }
  }
  return valid;
}

function readTrianglePrimitive(
  geometry: RaySceneTriangleGeometry,
  primitiveIndex: number,
  diagnostics: RayAccelerationDiagnostic[],
): RayAccelerationPrimitive | null {
  const base = primitiveIndex * 3;
  const i0 = geometry.indices?.[base] ?? base;
  const i1 = geometry.indices?.[base + 1] ?? base + 1;
  const i2 = geometry.indices?.[base + 2] ?? base + 2;
  const p0 = readPosition(geometry.positions, i0);
  const p1 = readPosition(geometry.positions, i1);
  const p2 = readPosition(geometry.positions, i2);
  if (!p0 || !p1 || !p2) return null;
  const primitiveBounds = boundsFromPoints([p0, p1, p2]);
  const ab = vec3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const ac = vec3(p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]);
  const cx = ab[1] * ac[2] - ab[2] * ac[1];
  const cy = ab[2] * ac[0] - ab[0] * ac[2];
  const cz = ab[0] * ac[1] - ab[1] * ac[0];
  const areaSquared = cx * cx + cy * cy + cz * cz;
  const scale = Math.max(
    (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2) * (ac[0] ** 2 + ac[1] ** 2 + ac[2] ** 2),
    1,
  );
  if (areaSquared <= 1e-24 * scale) {
    diagnostics.push(diagnostic('blas-build', 'warning', 'RAY_BLAS_TRIANGLE_DEGENERATE',
      `Geometry ${geometry.geometryId} primitive ${primitiveIndex} is degenerate and remains explicitly represented.`, {
        geometryId: geometry.geometryId,
        primitiveIndex,
      }));
  }
  return Object.freeze({
    kind: 'triangle',
    primitiveIndex,
    bounds: primitiveBounds,
    data: Object.freeze([...p0, ...p1, ...p2]),
  });
}

function readPosition(values: readonly number[], vertexIndex: number): RayVec3 | null {
  const offset = vertexIndex * 3;
  const x = values[offset]; const y = values[offset + 1]; const z = values[offset + 2];
  return x !== undefined && y !== undefined && z !== undefined && [x, y, z].every(Number.isFinite)
    ? vec3(x, y, z)
    : null;
}

function largestExtentAxis(value: RayBounds3): 0 | 1 | 2 {
  if (isEmptyBounds(value)) return 0;
  const x = value.max[0] - value.min[0];
  const y = value.max[1] - value.min[1];
  const z = value.max[2] - value.min[2];
  return y > x && y >= z ? 1 : z > x && z > y ? 2 : 0;
}

function emptyNode(depth: number): RayBvhNode {
  return Object.freeze({ bounds: emptyBounds(), leftChild: -1, rightChild: -1, firstIndex: 0, indexCount: 0, depth });
}

function fingerprintHierarchy(
  key: string,
  hierarchy: BuiltHierarchy,
  primitives: readonly RayAccelerationPrimitive[],
): string {
  const tokens = ['ray-blas-v1', key, String(hierarchy.rootNode), String(hierarchy.maxDepth)];
  for (const node of hierarchy.nodes) {
    tokens.push(...node.bounds.min.map(numberToken), ...node.bounds.max.map(numberToken));
    tokens.push(String(node.leftChild), String(node.rightChild), String(node.firstIndex), String(node.indexCount));
  }
  tokens.push(...hierarchy.order.map(String));
  for (const primitive of primitives) {
    tokens.push(primitive.kind, String(primitive.primitiveIndex), ...primitive.data.map(numberToken));
  }
  return fingerprintText(tokens.join('|'));
}

export function diagnoseDepth(
  maxDepth: number,
  phase: RayAccelerationPhase,
  diagnostics: RayAccelerationDiagnostic[],
  context: Record<string, string | number | boolean | null>,
): void {
  if (maxDepth + 1 > RAY_ACCELERATION_POLICY.traversalStackLimit) {
    diagnostics.push(diagnostic(phase, 'error', 'RAY_ACCEL_STACK_LIMIT_EXCEEDED',
      `Hierarchy depth ${maxDepth} exceeds the ${RAY_ACCELERATION_POLICY.traversalStackLimit}-entry traversal stack.`, {
        ...context,
        maxDepth,
        stackLimit: RAY_ACCELERATION_POLICY.traversalStackLimit,
      }));
  }
}

export function diagnostic(
  phase: RayAccelerationPhase,
  severity: RayAccelerationDiagnostic['severity'],
  code: string,
  message: string,
  context: Record<string, string | number | boolean | null>,
): RayAccelerationDiagnostic {
  return Object.freeze({ phase, severity, code, message, context: Object.freeze({ ...context }) });
}

function freezeBuildResult(blas: RayBlas | null, diagnostics: RayAccelerationDiagnostic[]): RayBlasBuildResult {
  return Object.freeze({ blas, diagnostics: Object.freeze([...diagnostics]) });
}
