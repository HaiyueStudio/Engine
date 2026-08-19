import { Mesh3D, Transform3D } from '@haiyue/engine/components';
import type { Entity, World } from '@haiyue/engine/ecs';
import type { Scene } from '@haiyue/engine/scene';
import { mat4n } from 'wgpu-matrix';
import type {
  RayDiagnostic,
  RayMatrix4,
  RayReferenceScene,
  RaySceneInstance,
  RaySceneTriangleGeometry,
} from '../reference/index.js';

const IDENTITY_MATRIX = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

export interface RaySceneSourceRevision {
  readonly worldId: number;
  readonly structureVersion: number;
  readonly componentChangeRevision: number;
}

export interface RaySceneMaterialFacts {
  readonly materialId: string;
  readonly revision: number;
  readonly type: string;
}

export interface RaySceneInstanceProvenance {
  readonly instanceId: string;
  readonly entityId: string;
  readonly meshComponentId: number;
  readonly hierarchyVersion: number;
  readonly transformLocalVersion: number;
  readonly material: RaySceneMaterialFacts;
}

export interface RaySceneSnapshot extends RayReferenceScene {
  readonly schemaVersion: 1;
  readonly sourceRevision: RaySceneSourceRevision;
  readonly revision: string;
  readonly fingerprint: string;
  readonly provenance: readonly RaySceneInstanceProvenance[];
  readonly diagnostics: readonly RayDiagnostic[];
}

export interface RaySceneExtractionResult {
  readonly snapshot: RaySceneSnapshot;
  readonly diagnostics: readonly RayDiagnostic[];
  readonly valid: boolean;
}

/**
 * Copies public Engine facts into a resource-free immutable snapshot.
 * The extractor never calls Transform3D.updateWorldMatrix and never writes to source objects.
 */
export function extractRayTracingScene(source: Scene | World): RaySceneExtractionResult {
  const world = resolveWorld(source);
  const diagnostics: RayDiagnostic[] = [];
  const sourceRevision = freezeSourceRevision(world);
  if (world.destroyed) {
    diagnostics.push(diagnostic('error', 'RAY_SCENE_SOURCE_DESTROYED',
      `World ${world.id} is destroyed and cannot be extracted.`, { worldId: world.id }));
  }

  const geometries = new Map<string, RaySceneTriangleGeometry>();
  const instances: RaySceneInstance[] = [];
  const provenance: RaySceneInstanceProvenance[] = [];
  const worldMatrices = new Map<number, RayMatrix4>();
  const resolving = new Set<number>();
  const entities = [...world.entities.values()].sort((a, b) => a.id - b.id);

  for (const entity of entities) {
    if (world.destroyed || entity.destroyed || isHierarchyDisabled(entity)) continue;
    const mesh = entity.getComponent(Mesh3D);
    if (!mesh || mesh.disabled || mesh.destroyed) continue;
    const geometry = mesh.geometry;
    const geometryId = `geometry:${geometry.id}`;
    const geometryKey = `${geometryId}@${geometry.version}`;
    if (!geometries.has(geometryKey)) {
      const copied = copyGeometry(geometryId, geometry, diagnostics);
      if (copied) geometries.set(geometryKey, copied);
    }
    if (!geometries.has(geometryKey)) continue;

    const transform = entity.getComponent(Transform3D);
    const worldMatrix = computeWorldMatrix(entity, world, worldMatrices, resolving, diagnostics);
    if (!worldMatrix || !isFiniteMatrix(worldMatrix)) {
      diagnostics.push(diagnostic('error', 'RAY_SCENE_TRANSFORM_INVALID',
        `Entity ${entity.id} has a non-finite world transform.`, { entityId: entity.id }));
      continue;
    }
    if (Math.abs(linearDeterminant(worldMatrix)) <= Number.EPSILON) {
      diagnostics.push(diagnostic('error', 'RAY_SCENE_TRANSFORM_SINGULAR',
        `Entity ${entity.id} has a singular world transform.`, { entityId: entity.id }));
      continue;
    }
    const material = mesh.material;
    const instanceId = `instance:${entity.id}:mesh:${mesh.id}`;
    const entityId = `entity:${entity.id}`;
    const materialFacts = Object.freeze({
      materialId: `material:${material.id}`,
      revision: material.revision,
      type: material.type,
    });
    instances.push(Object.freeze({
      instanceId,
      entityId,
      geometryId,
      geometryRevision: geometry.version,
      transform: worldMatrix,
    }));
    provenance.push(Object.freeze({
      instanceId,
      entityId,
      meshComponentId: mesh.id,
      hierarchyVersion: entity.hierarchyVersion,
      transformLocalVersion: transform?.localVersion ?? 0,
      material: materialFacts,
    }));
  }

  instances.sort(compareInstance);
  provenance.sort((a, b) => compareText(a.instanceId, b.instanceId));
  const geometryList = [...geometries.values()].sort(compareGeometry);
  const fingerprint = fingerprintScene(sourceRevision, geometryList, instances, provenance);
  const frozenDiagnostics = Object.freeze([...diagnostics]);
  const snapshot: RaySceneSnapshot = Object.freeze({
    schemaVersion: 1,
    sourceRevision,
    revision: `world:${world.id}:${sourceRevision.structureVersion}:${sourceRevision.componentChangeRevision}:${fingerprint}`,
    fingerprint,
    geometries: Object.freeze(geometryList),
    instances: Object.freeze(instances),
    analyticPrimitives: Object.freeze([]),
    provenance: Object.freeze(provenance),
    diagnostics: frozenDiagnostics,
  });
  return Object.freeze({
    snapshot,
    diagnostics: frozenDiagnostics,
    valid: !diagnostics.some(entry => entry.severity === 'error'),
  });
}

/** Cheap source revision check; fingerprint comparison remains authoritative after unversioned raw-array mutation. */
export function hasRaySceneSourceRevisionChanged(snapshot: RaySceneSnapshot, source: Scene | World): boolean {
  const current = freezeSourceRevision(resolveWorld(source));
  return current.worldId !== snapshot.sourceRevision.worldId
    || current.structureVersion !== snapshot.sourceRevision.structureVersion
    || current.componentChangeRevision !== snapshot.sourceRevision.componentChangeRevision;
}

function resolveWorld(source: Scene | World): World {
  return 'world' in source ? source.world : source;
}

function freezeSourceRevision(world: World): RaySceneSourceRevision {
  return Object.freeze({
    worldId: world.id,
    structureVersion: world.structureVersion,
    componentChangeRevision: world.componentChangeRevision,
  });
}

function copyGeometry(
  geometryId: string,
  geometry: Mesh3D['geometry'],
  diagnostics: RayDiagnostic[],
): RaySceneTriangleGeometry | null {
  if (geometry.topology !== null && geometry.topology !== 'triangle-list') {
    diagnostics.push(diagnostic('error', 'RAY_SCENE_TOPOLOGY_UNSUPPORTED',
      `Geometry ${geometryId} uses unsupported topology ${geometry.topology}.`, {
        geometryId,
        topology: geometry.topology,
      }));
    return null;
  }
  if (geometry.skinning || (geometry.hasMorphTargets && geometry.morphUseGpu)) {
    diagnostics.push(diagnostic('error', 'RAY_SCENE_DEFORMATION_UNSUPPORTED',
      `Geometry ${geometryId} requires GPU deformation that the CPU reference cannot observe.`, { geometryId }));
    return null;
  }
  if (geometry.instanceCount !== 1 || geometry.instanceAttributes.size > 0) {
    diagnostics.push(diagnostic('error', 'RAY_SCENE_INSTANCING_UNSUPPORTED',
      `Geometry ${geometryId} contains geometry-owned instances; G02 requires one canonical entity instance.`, {
        geometryId,
        instanceCount: geometry.instanceCount,
      }));
    return null;
  }
  const positions = [...geometry.positions];
  if (positions.length % 3 !== 0 || positions.some(value => !Number.isFinite(value))) {
    diagnostics.push(diagnostic('error', 'RAY_SCENE_POSITIONS_INVALID',
      `Geometry ${geometryId} positions must be finite xyz triplets.`, { geometryId, positionCount: positions.length }));
    return null;
  }
  const normals = geometry.normals ? [...geometry.normals] : null;
  if (normals && (normals.length !== positions.length || normals.some(value => !Number.isFinite(value)))) {
    diagnostics.push(diagnostic('error', 'RAY_SCENE_NORMALS_INVALID',
      `Geometry ${geometryId} normals must be finite and match positions.`, { geometryId, normalCount: normals.length }));
    return null;
  }
  const indices = geometry.indices ? [...geometry.indices] : null;
  const vertexCount = positions.length / 3;
  if (indices && (indices.length % 3 !== 0 || indices.some(index => !Number.isInteger(index) || index < 0 || index >= vertexCount))) {
    diagnostics.push(diagnostic('error', 'RAY_SCENE_INDICES_INVALID',
      `Geometry ${geometryId} indices must contain valid triangle triplets.`, { geometryId, indexCount: indices.length }));
    return null;
  }
  if (!indices && positions.length % 9 !== 0) {
    diagnostics.push(diagnostic('error', 'RAY_SCENE_NON_INDEXED_TRIANGLES_INVALID',
      `Geometry ${geometryId} non-indexed positions must contain complete triangle triplets.`, {
        geometryId,
        vertexCount,
      }));
    return null;
  }
  const primitiveCount = indices ? indices.length / 3 : positions.length / 9;
  if (primitiveCount === 0) {
    diagnostics.push(diagnostic('info', 'RAY_SCENE_GEOMETRY_EMPTY',
      `Geometry ${geometryId} is empty.`, { geometryId }));
  }
  diagnoseDegenerateTriangles(geometryId, positions, indices, primitiveCount, diagnostics);
  return Object.freeze({
    kind: 'triangle-mesh',
    geometryId,
    revision: geometry.version,
    positions: Object.freeze(positions),
    normals: normals ? Object.freeze(normals) : null,
    indices: indices ? Object.freeze(indices) : null,
    primitiveCount,
  });
}

function diagnoseDegenerateTriangles(
  geometryId: string,
  positions: readonly number[],
  indices: readonly number[] | null,
  primitiveCount: number,
  diagnostics: RayDiagnostic[],
): void {
  for (let primitiveIndex = 0; primitiveIndex < primitiveCount; primitiveIndex++) {
    const base = primitiveIndex * 3;
    const i0 = indices?.[base] ?? base;
    const i1 = indices?.[base + 1] ?? base + 1;
    const i2 = indices?.[base + 2] ?? base + 2;
    const a = readPosition(positions, i0);
    const b = readPosition(positions, i1);
    const c = readPosition(positions, i2);
    const abx = b[0] - a[0]; const aby = b[1] - a[1]; const abz = b[2] - a[2];
    const acx = c[0] - a[0]; const acy = c[1] - a[1]; const acz = c[2] - a[2];
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    const areaSquared = cx * cx + cy * cy + cz * cz;
    const edgeScale = Math.max(
      (abx * abx + aby * aby + abz * abz) * (acx * acx + acy * acy + acz * acz),
      1,
    );
    if (areaSquared <= 1e-24 * edgeScale) {
      diagnostics.push(diagnostic('warning', 'RAY_SCENE_TRIANGLE_DEGENERATE',
        `Geometry ${geometryId} primitive ${primitiveIndex} is degenerate.`, { geometryId, primitiveIndex }));
    }
  }
}

function readPosition(positions: readonly number[], vertexIndex: number): readonly [number, number, number] {
  const offset = vertexIndex * 3;
  return [positions[offset]!, positions[offset + 1]!, positions[offset + 2]!];
}

function computeWorldMatrix(
  entity: Entity,
  world: World,
  cache: Map<number, RayMatrix4>,
  resolving: Set<number>,
  diagnostics: RayDiagnostic[],
): RayMatrix4 | null {
  const cached = cache.get(entity.id);
  if (cached) return cached;
  if (resolving.has(entity.id)) {
    diagnostics.push(diagnostic('error', 'RAY_SCENE_HIERARCHY_CYCLE',
      `Entity ${entity.id} participates in a hierarchy cycle.`, { entityId: entity.id }));
    return null;
  }
  resolving.add(entity.id);
  const local = entity.getComponent(Transform3D)?.localMatrix ?? IDENTITY_MATRIX;
  let result: RayMatrix4;
  if (entity.parent && world.entities.get(entity.parent.id) === entity.parent) {
    const parent = computeWorldMatrix(entity.parent, world, cache, resolving, diagnostics);
    if (!parent) {
      resolving.delete(entity.id);
      return null;
    }
    result = freezeMatrix(multiplyMatrix(parent, local));
  } else {
    result = freezeMatrix(local);
  }
  resolving.delete(entity.id);
  cache.set(entity.id, result);
  return result;
}

function isHierarchyDisabled(entity: Entity): boolean {
  let current: Entity | null = entity;
  const visited = new Set<number>();
  while (current) {
    if (visited.has(current.id)) return true;
    visited.add(current.id);
    if (current.disabled || current.destroyed) return true;
    current = current.parent;
  }
  return false;
}

function multiplyMatrix(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  return mat4n.multiply(a, b);
}

function freezeMatrix(values: ArrayLike<number>): RayMatrix4 {
  return Object.freeze(Array.from(values));
}

function isFiniteMatrix(values: readonly number[]): boolean {
  return values.length === 16 && values.every(Number.isFinite);
}

function linearDeterminant(matrix: readonly number[]): number {
  const a00 = matrix[0]!; const a01 = matrix[4]!; const a02 = matrix[8]!;
  const a10 = matrix[1]!; const a11 = matrix[5]!; const a12 = matrix[9]!;
  const a20 = matrix[2]!; const a21 = matrix[6]!; const a22 = matrix[10]!;
  return a00 * (a11 * a22 - a12 * a21)
    - a01 * (a10 * a22 - a12 * a20)
    + a02 * (a10 * a21 - a11 * a20);
}

function fingerprintScene(
  revision: RaySceneSourceRevision,
  geometries: readonly RaySceneTriangleGeometry[],
  instances: readonly RaySceneInstance[],
  provenance: readonly RaySceneInstanceProvenance[],
): string {
  const values: string[] = [
    'ray-scene-v1',
    String(revision.worldId),
    String(revision.structureVersion),
    String(revision.componentChangeRevision),
  ];
  for (const geometry of geometries) {
    values.push(geometry.geometryId, String(geometry.revision), geometry.kind, String(geometry.primitiveCount));
    pushNumbers(values, geometry.positions);
    values.push('|normals|');
    if (geometry.normals) pushNumbers(values, geometry.normals);
    values.push('|indices|');
    if (geometry.indices) pushNumbers(values, geometry.indices);
  }
  for (const instance of instances) {
    values.push(instance.instanceId, instance.entityId, instance.geometryId, String(instance.geometryRevision));
    pushNumbers(values, instance.transform);
  }
  for (const item of provenance) {
    values.push(
      item.instanceId,
      item.entityId,
      String(item.meshComponentId),
      String(item.hierarchyVersion),
      String(item.transformLocalVersion),
      item.material.materialId,
      String(item.material.revision),
      item.material.type,
    );
  }
  return `fnv1a64:${fnv1a64(values.join('\u001f'))}`;
}

function pushNumbers(target: string[], values: readonly number[]): void {
  for (const value of values) target.push(Object.is(value, -0) ? '-0' : String(value));
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function compareGeometry(a: RaySceneTriangleGeometry, b: RaySceneTriangleGeometry): number {
  return compareText(a.geometryId, b.geometryId) || a.revision - b.revision;
}

function compareInstance(a: RaySceneInstance, b: RaySceneInstance): number {
  return compareText(a.instanceId, b.instanceId);
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function diagnostic(
  severity: RayDiagnostic['severity'],
  code: string,
  message: string,
  context: Record<string, string | number | boolean | null>,
): RayDiagnostic {
  return Object.freeze({
    phase: 'scene-extraction',
    severity,
    code,
    message,
    context: Object.freeze({ ...context }),
  });
}
