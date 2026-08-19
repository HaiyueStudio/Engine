import type { RaySceneAnalyticSphere, RaySceneInstance } from '../reference/index.js';
import type { RaySceneSnapshot } from '../scene/index.js';
import { analyticBlasKey, blasKey, buildHierarchy, diagnoseDepth, diagnostic, RAY_ACCELERATION_POLICY } from './bvh.js';
import {
  bounds,
  boundsCentroid,
  compareText,
  emptyBounds,
  fingerprintText,
  inverseMatrix4,
  numberToken,
  transformBounds,
  unionBounds,
} from './math.js';
import type {
  RayAccelerationDiagnostic,
  RayBlas,
  RayBvhNode,
  RayTlas,
  RayTlasInstance,
} from './types.js';

export function buildTlas(snapshot: RaySceneSnapshot, blases: ReadonlyMap<string, RayBlas>): RayTlas {
  const diagnostics: RayAccelerationDiagnostic[] = [];
  const materials = new Map(snapshot.provenance.map(item => [item.instanceId, item.material]));
  const instances: RayTlasInstance[] = [];
  for (const source of snapshot.instances) {
    const key = blasKey(source.geometryId, source.geometryRevision);
    const blas = blases.get(key);
    if (!blas) {
      diagnostics.push(diagnostic('tlas-build', 'error', 'RAY_TLAS_BLAS_MISSING',
        `Instance ${source.instanceId} references missing BLAS ${key}.`, { instanceId: source.instanceId, blasKey: key }));
      continue;
    }
    if (!blas.bounds) {
      diagnostics.push(diagnostic('tlas-build', 'info', 'RAY_TLAS_EMPTY_BLAS',
        `Instance ${source.instanceId} references an empty BLAS and has no TLAS leaf.`, {
          instanceId: source.instanceId,
          blasKey: key,
        }));
      continue;
    }
    const material = materials.get(source.instanceId);
    if (!material) {
      diagnostics.push(diagnostic('tlas-build', 'error', 'RAY_TLAS_MATERIAL_PROVENANCE_MISSING',
        `Instance ${source.instanceId} has no material provenance.`, { instanceId: source.instanceId }));
      continue;
    }
    const instance = createTriangleInstance(source, blas, material, diagnostics);
    if (instance) instances.push(instance);
  }
  for (const sphere of snapshot.analyticPrimitives) {
    const key = analyticBlasKey(
      sphere.identity.geometryId,
      sphere.identity.geometryRevision,
      sphere.identity.primitiveIndex,
    );
    const blas = blases.get(key);
    if (!blas?.bounds) {
      diagnostics.push(diagnostic('tlas-build', 'error', 'RAY_TLAS_BLAS_MISSING',
        `Analytic instance ${sphere.identity.instanceId} references missing BLAS ${key}.`, {
          instanceId: sphere.identity.instanceId,
          blasKey: key,
        }));
      continue;
    }
    const instance = createAnalyticInstance(sphere, blas, diagnostics);
    if (instance) instances.push(instance);
  }
  instances.sort(compareInstance);
  for (let index = 1; index < instances.length; index++) {
    if (instances[index - 1]!.instanceId === instances[index]!.instanceId) {
      diagnostics.push(diagnostic('tlas-build', 'error', 'RAY_TLAS_INSTANCE_IDENTITY_DUPLICATE',
        `TLAS contains duplicate instance identity ${instances[index]!.instanceId}.`, {
          instanceId: instances[index]!.instanceId,
        }));
    }
  }
  const hierarchy = buildHierarchy(instances.map((instance, sourceIndex) => ({
    sourceIndex,
    stableId: `${instance.instanceId}|${instance.blasKey}`,
    bounds: instance.bounds,
    centroid: boundsCentroid(instance.bounds),
  })), RAY_ACCELERATION_POLICY.tlasLeafCapacity);
  diagnoseDepth(hierarchy.maxDepth, 'tlas-build', diagnostics, { sourceFingerprint: snapshot.fingerprint });
  return freezeTlas(snapshot, instances, hierarchy.nodes, hierarchy.order, hierarchy.rootNode, hierarchy.bounds,
    hierarchy.maxDepth, hierarchy.leafCount, diagnostics);
}

export function refitTlas(
  previous: RayTlas,
  snapshot: RaySceneSnapshot,
  blases: ReadonlyMap<string, RayBlas>,
): RayTlas | null {
  const rebuiltFacts = buildTlas(snapshot, blases);
  if (rebuiltFacts.membershipFingerprint !== previous.membershipFingerprint) return null;
  const updatedByIdentity = new Map(rebuiltFacts.instances.map(instance => [instanceKey(instance), instance]));
  const instances: RayTlasInstance[] = [];
  for (const previousInstance of previous.instances) {
    const updated = updatedByIdentity.get(instanceKey(previousInstance));
    if (!updated) return null;
    instances.push(updated);
  }
  const nodes = new Array<RayBvhNode>(previous.nodes.length);
  for (let nodeIndex = previous.nodes.length - 1; nodeIndex >= 0; nodeIndex--) {
    const previousNode = previous.nodes[nodeIndex]!;
    let nodeBounds = emptyBounds();
    if (previousNode.indexCount > 0) {
      for (let offset = 0; offset < previousNode.indexCount; offset++) {
        const instanceIndex = previous.instanceIndices[previousNode.firstIndex + offset];
        if (instanceIndex === undefined || !instances[instanceIndex]) return null;
        nodeBounds = unionBounds(nodeBounds, instances[instanceIndex]!.bounds);
      }
    } else {
      const left = nodes[previousNode.leftChild];
      const right = nodes[previousNode.rightChild];
      if (!left || !right) return null;
      nodeBounds = unionBounds(left.bounds, right.bounds);
    }
    nodes[nodeIndex] = Object.freeze({ ...previousNode, bounds: nodeBounds });
  }
  const diagnostics = rebuiltFacts.diagnostics.map(entry => entry.phase === 'tlas-build'
    ? Object.freeze({ ...entry, phase: 'refit' as const })
    : entry);
  return freezeTlas(
    snapshot,
    instances,
    Object.freeze(nodes),
    previous.instanceIndices,
    previous.rootNode,
    previous.rootNode >= 0 ? nodes[previous.rootNode]!.bounds : null,
    previous.statistics.maxDepth,
    previous.statistics.leafCount,
    diagnostics,
  );
}

function createTriangleInstance(
  source: RaySceneInstance,
  blas: RayBlas,
  material: RayTlasInstance['material'],
  diagnostics: RayAccelerationDiagnostic[],
): RayTlasInstance | null {
  const inverse = inverseMatrix4(source.transform);
  if (!inverse || !blas.bounds) {
    diagnostics.push(diagnostic('tlas-build', 'error', 'RAY_TLAS_TRANSFORM_INVALID',
      `Instance ${source.instanceId} has a singular or invalid transform.`, { instanceId: source.instanceId }));
    return null;
  }
  return Object.freeze({
    instanceId: source.instanceId,
    entityId: source.entityId,
    geometryId: source.geometryId,
    geometryRevision: source.geometryRevision,
    blasKey: blas.key,
    transform: Object.freeze([...source.transform]),
    inverseTransform: inverse,
    bounds: transformBounds(blas.bounds, source.transform),
    material,
    analyticIdentity: null,
  });
}

function createAnalyticInstance(
  sphere: RaySceneAnalyticSphere,
  blas: RayBlas,
  diagnostics: RayAccelerationDiagnostic[],
): RayTlasInstance | null {
  const inverse = inverseMatrix4(sphere.transform);
  if (!inverse || !blas.bounds) {
    diagnostics.push(diagnostic('tlas-build', 'error', 'RAY_TLAS_TRANSFORM_INVALID',
      `Analytic instance ${sphere.identity.instanceId} has a singular or invalid transform.`, {
        instanceId: sphere.identity.instanceId,
      }));
    return null;
  }
  return Object.freeze({
    instanceId: sphere.identity.instanceId,
    entityId: sphere.identity.entityId,
    geometryId: sphere.identity.geometryId,
    geometryRevision: sphere.identity.geometryRevision,
    blasKey: blas.key,
    transform: Object.freeze([...sphere.transform]),
    inverseTransform: inverse,
    bounds: transformBounds(blas.bounds, sphere.transform),
    material: null,
    analyticIdentity: sphere.identity,
  });
}

function freezeTlas(
  snapshot: RaySceneSnapshot,
  instances: readonly RayTlasInstance[],
  nodes: readonly RayBvhNode[],
  instanceIndices: readonly number[],
  rootNode: number,
  rootBounds: RayTlas['bounds'],
  maxDepth: number,
  leafCount: number,
  diagnostics: readonly RayAccelerationDiagnostic[],
): RayTlas {
  const membershipFingerprint = fingerprintText(instances.map(instance => (
    `${instance.instanceId}|${instance.entityId}|${instance.geometryId}|${instance.geometryRevision}|${instance.blasKey}`
  )).join('\n'));
  const transformFingerprint = fingerprintText(instances.flatMap(instance => [
    instance.instanceId,
    ...instance.transform.map(numberToken),
  ]).join('|'));
  const materialFingerprint = fingerprintText(instances.map(instance => instance.material
    ? `${instance.instanceId}|${instance.material.materialId}|${instance.material.revision}|${instance.material.type}`
    : `${instance.instanceId}|none`).join('\n'));
  const fingerprint = fingerprintText([
    'ray-tlas-v1',
    snapshot.fingerprint,
    membershipFingerprint,
    transformFingerprint,
    materialFingerprint,
    ...nodes.flatMap(node => [
      ...node.bounds.min.map(numberToken), ...node.bounds.max.map(numberToken),
      node.leftChild, node.rightChild, node.firstIndex, node.indexCount,
    ]).map(String),
    ...instanceIndices.map(String),
  ].join('|'));
  return Object.freeze({
    schemaVersion: 1,
    sourceFingerprint: snapshot.fingerprint,
    membershipFingerprint,
    transformFingerprint,
    materialFingerprint,
    fingerprint,
    rootNode,
    bounds: rootBounds,
    nodes: Object.freeze([...nodes]),
    instances: Object.freeze([...instances]),
    instanceIndices: Object.freeze([...instanceIndices]),
    statistics: Object.freeze({
      nodeCount: nodes.length,
      leafCount,
      instanceCount: instances.length,
      maxDepth,
      estimatedBytes: nodes.length * 32 + instances.length * 144 + instanceIndices.length * 4,
    }),
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function compareInstance(a: RayTlasInstance, b: RayTlasInstance): number {
  return compareText(a.instanceId, b.instanceId)
    || compareText(a.geometryId, b.geometryId)
    || a.geometryRevision - b.geometryRevision
    || compareText(a.blasKey, b.blasKey);
}

function instanceKey(instance: RayTlasInstance): string {
  return `${instance.instanceId}|${instance.entityId}|${instance.blasKey}`;
}
