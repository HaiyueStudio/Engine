import { traceRayBruteForce } from '../reference/index.js';
import type { CanonicalRay, RayInput, RayPrimitiveIdentity, RayReferenceScene, RayVec3 } from '../reference/index.js';
import { RAY_ACCELERATION_POLICY, diagnostic } from './bvh.js';
import { transformPoint, vec3 } from './math.js';
import type {
  RayAccelerationCandidateQuery,
  RayAccelerationDiagnostic,
  RayAccelerationSnapshot,
  RayBlas,
  RayBounds3,
  RayBvhNode,
  RayTlasInstance,
} from './types.js';

const EMPTY_SCENE: RayReferenceScene = Object.freeze({
  geometries: Object.freeze([]),
  instances: Object.freeze([]),
  analyticPrimitives: Object.freeze([]),
});

export function queryRayAccelerationCandidates(
  acceleration: RayAccelerationSnapshot,
  input: RayInput,
): RayAccelerationCandidateQuery {
  const canonical = traceRayBruteForce(EMPTY_SCENE, input);
  const diagnostics: RayAccelerationDiagnostic[] = [];
  if (!canonical.ray) {
    diagnostics.push(diagnostic('tlas-build', 'error', 'RAY_ACCEL_QUERY_RAY_INVALID',
      'Acceleration candidate query received an invalid ray.', {}));
    return freezeQuery([], diagnostics, 0, 0, false);
  }
  const ray = canonical.ray;
  const candidates: RayPrimitiveIdentity[] = [];
  let tlasNodeTests = 0;
  let blasNodeTests = 0;
  let aborted = false;
  if (acceleration.tlas.rootNode < 0) return freezeQuery([], diagnostics, 0, 0, false);
  const stack = [acceleration.tlas.rootNode];
  while (stack.length > 0) {
    if (stack.length > RAY_ACCELERATION_POLICY.traversalStackLimit) {
      diagnostics.push(stackOverflow('TLAS', stack.length));
      aborted = true;
      break;
    }
    const nodeIndex = stack.pop()!;
    const node = acceleration.tlas.nodes[nodeIndex];
    if (!node) {
      diagnostics.push(diagnostic('tlas-build', 'error', 'RAY_ACCEL_NODE_INVALID',
        `TLAS references missing node ${nodeIndex}.`, { nodeIndex }));
      aborted = true;
      break;
    }
    tlasNodeTests++;
    if (!intersectsBounds(ray.origin, ray.direction, ray.tMin, ray.tMax, node.bounds)) continue;
    if (node.indexCount > 0) {
      for (let offset = 0; offset < node.indexCount; offset++) {
        const instanceIndex = acceleration.tlas.instanceIndices[node.firstIndex + offset];
        const instance = instanceIndex === undefined ? undefined : acceleration.tlas.instances[instanceIndex];
        if (!instance) {
          diagnostics.push(diagnostic('tlas-build', 'error', 'RAY_ACCEL_INSTANCE_INVALID',
            'TLAS leaf references a missing instance.', { nodeIndex, offset }));
          aborted = true;
          continue;
        }
        const blas = acceleration.blases.get(instance.blasKey);
        if (!blas) {
          diagnostics.push(diagnostic('blas-build', 'error', 'RAY_ACCEL_BLAS_MISSING',
            `TLAS instance ${instance.instanceId} references missing BLAS ${instance.blasKey}.`, {
              instanceId: instance.instanceId,
              blasKey: instance.blasKey,
            }));
          aborted = true;
          continue;
        }
        const localOrigin = transformPoint(instance.inverseTransform, ray.origin);
        const localPoint = transformPoint(instance.inverseTransform, vec3(
          ray.origin[0] + ray.direction[0],
          ray.origin[1] + ray.direction[1],
          ray.origin[2] + ray.direction[2],
        ));
        const localDirection = vec3(
          localPoint[0] - localOrigin[0],
          localPoint[1] - localOrigin[1],
          localPoint[2] - localOrigin[2],
        );
        const result = queryBlas(blas, instance, localOrigin, localDirection, ray, diagnostics);
        candidates.push(...result.candidates);
        blasNodeTests += result.nodeTests;
        aborted ||= result.aborted;
      }
    } else {
      // Push right first so the deterministic left child is visited first.
      stack.push(node.rightChild, node.leftChild);
    }
  }
  candidates.sort(compareIdentity);
  const unique = candidates.filter((candidate, index) => index === 0 || compareIdentity(candidate, candidates[index - 1]!) !== 0);
  return freezeQuery(unique, diagnostics, tlasNodeTests, blasNodeTests, aborted);
}

export function validateAccelerationStructure(
  acceleration: RayAccelerationSnapshot,
): readonly RayAccelerationDiagnostic[] {
  const diagnostics: RayAccelerationDiagnostic[] = [];
  for (const blas of acceleration.blases.values()) {
    validateHierarchy('BLAS', blas.nodes, blas.rootNode, blas.primitiveIndices.length, index => (
      blas.primitives[blas.primitiveIndices[index]!]?.bounds ?? null
    ), diagnostics, { blasKey: blas.key });
  }
  validateHierarchy('TLAS', acceleration.tlas.nodes, acceleration.tlas.rootNode,
    acceleration.tlas.instanceIndices.length, index => (
      acceleration.tlas.instances[acceleration.tlas.instanceIndices[index]!]?.bounds ?? null
    ), diagnostics, { sourceFingerprint: acceleration.source.fingerprint });
  return Object.freeze(diagnostics);
}

function queryBlas(
  blas: RayBlas,
  instance: RayTlasInstance,
  origin: RayVec3,
  direction: RayVec3,
  ray: CanonicalRay,
  diagnostics: RayAccelerationDiagnostic[],
): { candidates: RayPrimitiveIdentity[]; nodeTests: number; aborted: boolean } {
  if (blas.rootNode < 0) return { candidates: [], nodeTests: 0, aborted: false };
  const candidates: RayPrimitiveIdentity[] = [];
  const stack = [blas.rootNode];
  let nodeTests = 0;
  while (stack.length > 0) {
    if (stack.length > RAY_ACCELERATION_POLICY.traversalStackLimit) {
      diagnostics.push(stackOverflow('BLAS', stack.length));
      return { candidates, nodeTests, aborted: true };
    }
    const nodeIndex = stack.pop()!;
    const node = blas.nodes[nodeIndex];
    if (!node) {
      diagnostics.push(diagnostic('blas-build', 'error', 'RAY_ACCEL_NODE_INVALID',
        `BLAS ${blas.key} references missing node ${nodeIndex}.`, { blasKey: blas.key, nodeIndex }));
      return { candidates, nodeTests, aborted: true };
    }
    nodeTests++;
    if (!intersectsBounds(origin, direction, ray.tMin, ray.tMax, node.bounds)) continue;
    if (node.indexCount > 0) {
      for (let offset = 0; offset < node.indexCount; offset++) {
        const primitiveSourceIndex = blas.primitiveIndices[node.firstIndex + offset];
        const primitive = primitiveSourceIndex === undefined ? undefined : blas.primitives[primitiveSourceIndex];
        if (!primitive) continue;
        candidates.push(Object.freeze(instance.analyticIdentity ?? {
          instanceId: instance.instanceId,
          entityId: instance.entityId,
          geometryId: instance.geometryId,
          geometryRevision: instance.geometryRevision,
          primitiveIndex: primitive.primitiveIndex,
        }));
      }
    } else {
      stack.push(node.rightChild, node.leftChild);
    }
  }
  return { candidates, nodeTests, aborted: false };
}

function intersectsBounds(
  origin: RayVec3,
  direction: RayVec3,
  tMin: number,
  tMax: number,
  value: RayBounds3,
): boolean {
  let low = tMin;
  let high = tMax;
  for (let axis = 0; axis < 3; axis++) {
    const component = direction[axis]!;
    const originComponent = origin[axis]!;
    const minimum = value.min[axis]!;
    const maximum = value.max[axis]!;
    if (Math.abs(component) <= Number.EPSILON) {
      if (originComponent < minimum || originComponent > maximum) return false;
      continue;
    }
    const inverse = 1 / component;
    let a = (minimum - originComponent) * inverse;
    let b = (maximum - originComponent) * inverse;
    if (a > b) [a, b] = [b, a];
    low = Math.max(low, a);
    high = Math.min(high, b);
    if (low > high) return false;
  }
  return true;
}

function validateHierarchy(
  label: 'BLAS' | 'TLAS',
  nodes: readonly RayBvhNode[],
  rootNode: number,
  orderedItemCount: number,
  itemBounds: (orderedIndex: number) => RayBounds3 | null,
  diagnostics: RayAccelerationDiagnostic[],
  context: Record<string, string | number | boolean | null>,
): void {
  if (rootNode < 0) {
    if (nodes.length !== 0 || orderedItemCount !== 0) diagnostics.push(structureError(label, 'empty root has live data', context));
    return;
  }
  const visited = new Set<number>();
  const stack = [rootNode];
  while (stack.length > 0) {
    const nodeIndex = stack.pop()!;
    if (visited.has(nodeIndex)) {
      diagnostics.push(structureError(label, `node ${nodeIndex} is cyclic or multiply referenced`, context));
      continue;
    }
    visited.add(nodeIndex);
    const node = nodes[nodeIndex];
    if (!node) {
      diagnostics.push(structureError(label, `node ${nodeIndex} is missing`, context));
      continue;
    }
    if (node.depth + 1 > RAY_ACCELERATION_POLICY.traversalStackLimit) {
      diagnostics.push(structureError(label, `node ${nodeIndex} exceeds stack depth`, context));
    }
    if (node.indexCount > 0) {
      if (node.leftChild !== -1 || node.rightChild !== -1
        || node.firstIndex < 0 || node.firstIndex + node.indexCount > orderedItemCount) {
        diagnostics.push(structureError(label, `leaf ${nodeIndex} has invalid range`, context));
        continue;
      }
      for (let offset = 0; offset < node.indexCount; offset++) {
        const childBounds = itemBounds(node.firstIndex + offset);
        if (!childBounds || !containsBounds(node.bounds, childBounds)) {
          diagnostics.push(structureError(label, `leaf ${nodeIndex} does not contain ordered item ${node.firstIndex + offset}`, context));
        }
      }
    } else {
      const left = nodes[node.leftChild];
      const right = nodes[node.rightChild];
      if (!left || !right || !containsBounds(node.bounds, left.bounds) || !containsBounds(node.bounds, right.bounds)) {
        diagnostics.push(structureError(label, `internal node ${nodeIndex} does not contain both children`, context));
      }
      stack.push(node.rightChild, node.leftChild);
    }
  }
  if (visited.size !== nodes.length) diagnostics.push(structureError(label, `${nodes.length - visited.size} nodes are unreachable`, context));
}

function containsBounds(parent: RayBounds3, child: RayBounds3): boolean {
  return parent.min[0] <= child.min[0] && parent.min[1] <= child.min[1] && parent.min[2] <= child.min[2]
    && parent.max[0] >= child.max[0] && parent.max[1] >= child.max[1] && parent.max[2] >= child.max[2];
}

function structureError(
  label: 'BLAS' | 'TLAS',
  detail: string,
  context: Record<string, string | number | boolean | null>,
): RayAccelerationDiagnostic {
  return diagnostic(label === 'BLAS' ? 'blas-build' : 'tlas-build', 'error', 'RAY_ACCEL_STRUCTURE_INVALID',
    `${label} ${detail}.`, context);
}

function stackOverflow(label: 'BLAS' | 'TLAS', stackSize: number): RayAccelerationDiagnostic {
  return diagnostic(label === 'BLAS' ? 'blas-build' : 'tlas-build', 'error', 'RAY_ACCEL_STACK_OVERFLOW',
    `${label} candidate traversal exceeded the bounded stack.`, {
      stackSize,
      stackLimit: RAY_ACCELERATION_POLICY.traversalStackLimit,
    });
}

function compareIdentity(a: RayPrimitiveIdentity, b: RayPrimitiveIdentity): number {
  return a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1
    : a.geometryId < b.geometryId ? -1 : a.geometryId > b.geometryId ? 1
      : a.geometryRevision - b.geometryRevision || a.primitiveIndex - b.primitiveIndex
        || (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0);
}

function freezeQuery(
  candidates: readonly RayPrimitiveIdentity[],
  diagnostics: readonly RayAccelerationDiagnostic[],
  tlasNodeTests: number,
  blasNodeTests: number,
  aborted: boolean,
): RayAccelerationCandidateQuery {
  return Object.freeze({
    candidates: Object.freeze([...candidates]),
    diagnostics: Object.freeze([...diagnostics]),
    tlasNodeTests,
    blasNodeTests,
    aborted,
  });
}
