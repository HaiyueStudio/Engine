/** GPU-independent ray/hit semantics used as the M04 correctness oracle. */

export type RayVec3 = readonly [number, number, number];
export type RayBarycentric = readonly [number, number, number];
export type RayMatrix4 = readonly number[];

export const RAY_REFERENCE_SEMANTICS = Object.freeze({
  schemaVersion: 1,
  directionLengthEpsilon: 1e-12,
  parallelRelativeEpsilon: 1e-12,
  degenerateRelativeEpsilon: 1e-24,
  rangeEpsilon: 1e-12,
  tieRelativeEpsilon: 1e-9,
  faceRule: 'front when dot(ray.direction, windingNormal) < 0',
  barycentricOrder: '[vertex0, vertex1, vertex2]',
  normalRule: 'inverse-transpose, aligned to the world-space winding normal',
  tieBreak: 'instanceId, geometryId, geometryRevision, primitiveIndex, entityId',
} as const);

export type RayDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface RayDiagnostic {
  readonly phase: 'reference' | 'scene-extraction';
  readonly severity: RayDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RayInput {
  readonly origin: RayVec3;
  readonly direction: RayVec3;
  readonly tMin?: number;
  readonly tMax?: number;
}

export interface CanonicalRay {
  readonly origin: RayVec3;
  readonly direction: RayVec3;
  readonly tMin: number;
  readonly tMax: number;
}

export interface RayPrimitiveIdentity {
  readonly instanceId: string;
  readonly entityId: string;
  readonly geometryId: string;
  readonly geometryRevision: number;
  readonly primitiveIndex: number;
}

export interface RaySceneTriangleGeometry {
  readonly kind: 'triangle-mesh';
  readonly geometryId: string;
  readonly revision: number;
  readonly positions: readonly number[];
  readonly normals: readonly number[] | null;
  readonly indices: readonly number[] | null;
  readonly primitiveCount: number;
}

export interface RaySceneInstance {
  readonly instanceId: string;
  readonly entityId: string;
  readonly geometryId: string;
  readonly geometryRevision: number;
  readonly transform: RayMatrix4;
}

export interface RaySceneAnalyticSphere {
  readonly kind: 'sphere';
  readonly identity: RayPrimitiveIdentity;
  readonly center: RayVec3;
  readonly radius: number;
  readonly transform: RayMatrix4;
}

export interface RayReferenceScene {
  readonly geometries: readonly RaySceneTriangleGeometry[];
  readonly instances: readonly RaySceneInstance[];
  readonly analyticPrimitives: readonly RaySceneAnalyticSphere[];
}

export interface RayHit {
  readonly primitiveKind: 'triangle' | 'sphere';
  readonly identity: RayPrimitiveIdentity;
  readonly t: number;
  readonly position: RayVec3;
  readonly barycentric: RayBarycentric | null;
  readonly frontFace: boolean;
  /** World-space normal from primitive winding/implicit surface, never face-flipped. */
  readonly geometricNormal: RayVec3;
  /** Inverse-transpose normal aligned to geometricNormal, never face-flipped. */
  readonly shadingNormal: RayVec3;
  /** shadingNormal oriented against the incoming ray. */
  readonly facingNormal: RayVec3;
}

export interface RayTraceResult {
  readonly ray: CanonicalRay | null;
  readonly hit: RayHit | null;
  readonly diagnostics: readonly RayDiagnostic[];
  readonly testedPrimitiveCount: number;
}

export interface RayHitExpectation {
  readonly primitiveKind?: RayHit['primitiveKind'];
  readonly identity?: Partial<RayPrimitiveIdentity>;
  readonly t?: number;
  readonly position?: RayVec3;
  readonly barycentric?: RayBarycentric | null;
  readonly frontFace?: boolean;
  readonly geometricNormal?: RayVec3;
  readonly shadingNormal?: RayVec3;
  readonly facingNormal?: RayVec3;
}

export interface RayReferenceCorpusCase {
  readonly id: string;
  readonly scene: RayReferenceScene;
  readonly ray: RayInput;
  readonly expected: RayHitExpectation | null;
  readonly tolerance: number;
}

const IDENTITY_MATRIX = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

export function traceRayBruteForce(scene: RayReferenceScene, input: RayInput): RayTraceResult {
  const diagnostics: RayDiagnostic[] = [];
  const ray = canonicalizeRay(input, diagnostics);
  if (!ray) return freezeTraceResult(null, null, diagnostics, 0);

  const geometryById = new Map<string, RaySceneTriangleGeometry>();
  for (const geometry of scene.geometries) {
    const key = geometryKey(geometry.geometryId, geometry.revision);
    if (geometryById.has(key)) {
      diagnostics.push(diagnostic('error', 'RAY_GEOMETRY_IDENTITY_DUPLICATE',
        `Duplicate geometry identity ${key}.`, { geometryId: geometry.geometryId, geometryRevision: geometry.revision }));
      continue;
    }
    geometryById.set(key, geometry);
  }

  let best: RayHit | null = null;
  let testedPrimitiveCount = 0;
  for (const instance of scene.instances) {
    const geometry = geometryById.get(geometryKey(instance.geometryId, instance.geometryRevision));
    if (!geometry) {
      diagnostics.push(diagnostic('error', 'RAY_INSTANCE_GEOMETRY_MISSING',
        `Instance ${instance.instanceId} references missing geometry ${instance.geometryId}@${instance.geometryRevision}.`, {
          instanceId: instance.instanceId,
          geometryId: instance.geometryId,
          geometryRevision: instance.geometryRevision,
        }));
      continue;
    }
    if (!isFiniteMatrix(instance.transform)) {
      diagnostics.push(diagnostic('error', 'RAY_TRANSFORM_INVALID',
        `Instance ${instance.instanceId} has a non-finite or non-4x4 transform.`, { instanceId: instance.instanceId }));
      continue;
    }
    const normalMatrix = inverseTranspose3(instance.transform);
    if (!normalMatrix) {
      diagnostics.push(diagnostic('error', 'RAY_TRANSFORM_SINGULAR',
        `Instance ${instance.instanceId} has a singular transform.`, { instanceId: instance.instanceId }));
      continue;
    }
    const availablePrimitiveCount = geometry.indices
      ? Math.floor(geometry.indices.length / 3)
      : Math.floor(geometry.positions.length / 9);
    if (availablePrimitiveCount !== geometry.primitiveCount) {
      diagnostics.push(diagnostic('error', 'RAY_PRIMITIVE_COUNT_MISMATCH',
        `Geometry ${geometry.geometryId} declares ${geometry.primitiveCount} primitives but contains ${availablePrimitiveCount}.`, {
          geometryId: geometry.geometryId,
          declaredPrimitiveCount: geometry.primitiveCount,
          availablePrimitiveCount,
        }));
    }
    const primitiveCount = Math.min(geometry.primitiveCount, availablePrimitiveCount);
    for (let primitiveIndex = 0; primitiveIndex < primitiveCount; primitiveIndex++) {
      testedPrimitiveCount++;
      const triangle = readWorldTriangle(geometry, instance.transform, primitiveIndex, diagnostics);
      if (!triangle) continue;
      const identity = Object.freeze({
        instanceId: instance.instanceId,
        entityId: instance.entityId,
        geometryId: instance.geometryId,
        geometryRevision: instance.geometryRevision,
        primitiveIndex,
      });
      const hit = intersectTriangle(ray, triangle, identity, normalMatrix, diagnostics);
      if (hit && isPreferredHit(hit, best)) best = hit;
    }
  }

  for (const sphere of scene.analyticPrimitives) {
    testedPrimitiveCount++;
    const hit = intersectSphere(ray, sphere, diagnostics);
    if (hit && isPreferredHit(hit, best)) best = hit;
  }

  return freezeTraceResult(ray, best, diagnostics, testedPrimitiveCount);
}

export function compareRayHit(
  expected: RayHitExpectation | null,
  actual: RayHit | null,
  tolerance = 1e-9,
): readonly string[] {
  const mismatches: string[] = [];
  if (expected === null || actual === null) {
    if (expected !== actual) mismatches.push(expected === null ? 'expected miss, received hit' : 'expected hit, received miss');
    return Object.freeze(mismatches);
  }
  if (expected.primitiveKind !== undefined && expected.primitiveKind !== actual.primitiveKind) {
    mismatches.push(`primitiveKind: expected ${expected.primitiveKind}, received ${actual.primitiveKind}`);
  }
  if (expected.identity) {
    for (const key of ['instanceId', 'entityId', 'geometryId', 'geometryRevision', 'primitiveIndex'] as const) {
      const value = expected.identity[key];
      if (value !== undefined && value !== actual.identity[key]) {
        mismatches.push(`identity.${key}: expected ${String(value)}, received ${String(actual.identity[key])}`);
      }
    }
  }
  compareOptionalNumber('t', expected.t, actual.t, tolerance, mismatches);
  compareOptionalVec3('position', expected.position, actual.position, tolerance, mismatches);
  if (expected.barycentric !== undefined) {
    if (expected.barycentric === null || actual.barycentric === null) {
      if (expected.barycentric !== actual.barycentric) mismatches.push('barycentric: expected and actual nullability differ');
    } else {
      compareOptionalVec3('barycentric', expected.barycentric, actual.barycentric, tolerance, mismatches);
    }
  }
  if (expected.frontFace !== undefined && expected.frontFace !== actual.frontFace) {
    mismatches.push(`frontFace: expected ${expected.frontFace}, received ${actual.frontFace}`);
  }
  compareOptionalVec3('geometricNormal', expected.geometricNormal, actual.geometricNormal, tolerance, mismatches);
  compareOptionalVec3('shadingNormal', expected.shadingNormal, actual.shadingNormal, tolerance, mismatches);
  compareOptionalVec3('facingNormal', expected.facingNormal, actual.facingNormal, tolerance, mismatches);
  return Object.freeze(mismatches);
}

export function formatRayHitMismatch(caseId: string, mismatches: readonly string[]): string {
  return mismatches.length === 0
    ? `${caseId}: hit matches`
    : `${caseId}:\n${mismatches.map(item => `  - ${item}`).join('\n')}`;
}

export function replayRayReferenceCorpus(): Readonly<{
  passed: boolean;
  cases: readonly Readonly<{ id: string; passed: boolean; message: string; result: RayTraceResult }>[];
}> {
  const cases = RAY_REFERENCE_CORPUS.map(entry => {
    const result = traceRayBruteForce(entry.scene, entry.ray);
    const mismatches = compareRayHit(entry.expected, result.hit, entry.tolerance);
    return Object.freeze({
      id: entry.id,
      passed: mismatches.length === 0,
      message: formatRayHitMismatch(entry.id, mismatches),
      result,
    });
  });
  return Object.freeze({ passed: cases.every(entry => entry.passed), cases: Object.freeze(cases) });
}

interface WorldTriangle {
  readonly p0: RayVec3;
  readonly p1: RayVec3;
  readonly p2: RayVec3;
  readonly n0: RayVec3 | null;
  readonly n1: RayVec3 | null;
  readonly n2: RayVec3 | null;
}

function canonicalizeRay(input: RayInput, diagnostics: RayDiagnostic[]): CanonicalRay | null {
  if (!isFiniteVec3(input.origin)) {
    diagnostics.push(diagnostic('error', 'RAY_ORIGIN_INVALID', 'Ray origin must contain three finite numbers.', {}));
    return null;
  }
  if (!isFiniteVec3(input.direction)) {
    diagnostics.push(diagnostic('error', 'RAY_DIRECTION_INVALID', 'Ray direction must contain three finite numbers.', {}));
    return null;
  }
  const directionLength = length(input.direction);
  if (directionLength <= RAY_REFERENCE_SEMANTICS.directionLengthEpsilon) {
    diagnostics.push(diagnostic('error', 'RAY_DIRECTION_ZERO', 'Ray direction length is zero or too small.', { directionLength }));
    return null;
  }
  const tMin = input.tMin ?? 0;
  const tMax = input.tMax ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(tMin) || Number.isNaN(tMax) || tMax === Number.NEGATIVE_INFINITY || tMin > tMax) {
    diagnostics.push(diagnostic('error', 'RAY_RANGE_INVALID', 'Ray range must satisfy finite tMin <= tMax.', { tMin, tMax }));
    return null;
  }
  return Object.freeze({
    origin: freezeVec3(input.origin[0], input.origin[1], input.origin[2]),
    direction: freezeVec3(
      input.direction[0] / directionLength,
      input.direction[1] / directionLength,
      input.direction[2] / directionLength,
    ),
    tMin,
    tMax,
  });
}

function readWorldTriangle(
  geometry: RaySceneTriangleGeometry,
  transform: RayMatrix4,
  primitiveIndex: number,
  diagnostics: RayDiagnostic[],
): WorldTriangle | null {
  const base = primitiveIndex * 3;
  const i0 = geometry.indices?.[base] ?? base;
  const i1 = geometry.indices?.[base + 1] ?? base + 1;
  const i2 = geometry.indices?.[base + 2] ?? base + 2;
  if (![i0, i1, i2].every(index => Number.isInteger(index) && index >= 0 && index * 3 + 2 < geometry.positions.length)) {
    diagnostics.push(diagnostic('error', 'RAY_TRIANGLE_INDEX_INVALID',
      `Geometry ${geometry.geometryId} primitive ${primitiveIndex} contains an invalid vertex index.`, {
        geometryId: geometry.geometryId,
        primitiveIndex,
      }));
    return null;
  }
  const local0 = readVec3(geometry.positions, i0 * 3);
  const local1 = readVec3(geometry.positions, i1 * 3);
  const local2 = readVec3(geometry.positions, i2 * 3);
  if (!local0 || !local1 || !local2) {
    diagnostics.push(diagnostic('error', 'RAY_TRIANGLE_POSITION_INVALID',
      `Geometry ${geometry.geometryId} primitive ${primitiveIndex} contains a non-finite position.`, {
        geometryId: geometry.geometryId,
        primitiveIndex,
      }));
    return null;
  }
  const normals = geometry.normals;
  const n0 = normals ? readVec3(normals, i0 * 3) : null;
  const n1 = normals ? readVec3(normals, i1 * 3) : null;
  const n2 = normals ? readVec3(normals, i2 * 3) : null;
  if (normals && (!n0 || !n1 || !n2)) {
    diagnostics.push(diagnostic('error', 'RAY_TRIANGLE_NORMAL_INVALID',
      `Geometry ${geometry.geometryId} primitive ${primitiveIndex} contains an invalid normal; winding normal will be used.`, {
        geometryId: geometry.geometryId,
        primitiveIndex,
      }));
  }
  return {
    p0: transformPoint(transform, local0),
    p1: transformPoint(transform, local1),
    p2: transformPoint(transform, local2),
    n0: n0 && n1 && n2 ? n0 : null,
    n1: n0 && n1 && n2 ? n1 : null,
    n2: n0 && n1 && n2 ? n2 : null,
  };
}

function intersectTriangle(
  ray: CanonicalRay,
  triangle: WorldTriangle,
  identity: RayPrimitiveIdentity,
  normalMatrix: readonly number[],
  diagnostics: RayDiagnostic[],
): RayHit | null {
  const edge1 = subtract(triangle.p1, triangle.p0);
  const edge2 = subtract(triangle.p2, triangle.p0);
  const winding = cross(edge1, edge2);
  const scale = Math.max(lengthSquared(edge1) * lengthSquared(edge2), 1);
  const areaSquared = lengthSquared(winding);
  if (areaSquared <= RAY_REFERENCE_SEMANTICS.degenerateRelativeEpsilon * scale) {
    diagnostics.push(diagnostic('warning', 'RAY_TRIANGLE_DEGENERATE',
      `Primitive ${identityLabel(identity)} is degenerate.`, identityContext(identity)));
    return null;
  }
  const pvec = cross(ray.direction, edge2);
  const determinant = dot(edge1, pvec);
  const parallelScale = Math.max(length(edge1) * length(edge2), 1);
  if (Math.abs(determinant) <= RAY_REFERENCE_SEMANTICS.parallelRelativeEpsilon * parallelScale) return null;
  const inverseDeterminant = 1 / determinant;
  const tvec = subtract(ray.origin, triangle.p0);
  const u = dot(tvec, pvec) * inverseDeterminant;
  if (u < -RAY_REFERENCE_SEMANTICS.rangeEpsilon || u > 1 + RAY_REFERENCE_SEMANTICS.rangeEpsilon) return null;
  const qvec = cross(tvec, edge1);
  const v = dot(ray.direction, qvec) * inverseDeterminant;
  if (v < -RAY_REFERENCE_SEMANTICS.rangeEpsilon || u + v > 1 + RAY_REFERENCE_SEMANTICS.rangeEpsilon) return null;
  const t = dot(edge2, qvec) * inverseDeterminant;
  if (!withinRayRange(t, ray)) return null;

  const geometricNormal = normalize(winding);
  const frontFace = dot(ray.direction, geometricNormal) < 0;
  let shadingNormal = geometricNormal;
  if (triangle.n0 && triangle.n1 && triangle.n2) {
    const w = 1 - u - v;
    const localNormal = freezeVec3(
      triangle.n0[0] * w + triangle.n1[0] * u + triangle.n2[0] * v,
      triangle.n0[1] * w + triangle.n1[1] * u + triangle.n2[1] * v,
      triangle.n0[2] * w + triangle.n1[2] * u + triangle.n2[2] * v,
    );
    const transformed = transformNormal(normalMatrix, localNormal);
    if (lengthSquared(transformed) > RAY_REFERENCE_SEMANTICS.directionLengthEpsilon ** 2) {
      shadingNormal = normalize(transformed);
      if (dot(shadingNormal, geometricNormal) < 0) shadingNormal = negate(shadingNormal);
    }
  }
  return freezeHit({
    primitiveKind: 'triangle',
    identity,
    t,
    position: pointOnRay(ray, t),
    barycentric: freezeVec3(1 - u - v, u, v),
    frontFace,
    geometricNormal,
    shadingNormal,
    facingNormal: frontFace ? shadingNormal : negate(shadingNormal),
  });
}

function intersectSphere(
  ray: CanonicalRay,
  sphere: RaySceneAnalyticSphere,
  diagnostics: RayDiagnostic[],
): RayHit | null {
  if (!(Number.isFinite(sphere.radius) && sphere.radius > 0) || !isFiniteVec3(sphere.center) || !isFiniteMatrix(sphere.transform)) {
    diagnostics.push(diagnostic('error', 'RAY_SPHERE_INVALID',
      `Sphere ${identityLabel(sphere.identity)} has invalid center, radius, or transform.`, identityContext(sphere.identity)));
    return null;
  }
  const inverse = inverseMatrix4(sphere.transform);
  const normalMatrix = inverseTranspose3(sphere.transform);
  if (!inverse || !normalMatrix) {
    diagnostics.push(diagnostic('error', 'RAY_TRANSFORM_SINGULAR',
      `Sphere ${identityLabel(sphere.identity)} has a singular transform.`, identityContext(sphere.identity)));
    return null;
  }
  const localOrigin = transformPoint(inverse, ray.origin);
  const localDirection = transformVector(inverse, ray.direction);
  const oc = subtract(localOrigin, sphere.center);
  const a = dot(localDirection, localDirection);
  const halfB = dot(oc, localDirection);
  const c = dot(oc, oc) - sphere.radius * sphere.radius;
  const discriminant = halfB * halfB - a * c;
  if (discriminant < 0 || a <= RAY_REFERENCE_SEMANTICS.directionLengthEpsilon) return null;
  const root = Math.sqrt(Math.max(0, discriminant));
  let t = (-halfB - root) / a;
  if (!withinRayRange(t, ray)) {
    t = (-halfB + root) / a;
    if (!withinRayRange(t, ray)) return null;
  }
  const localPosition = freezeVec3(
    localOrigin[0] + localDirection[0] * t,
    localOrigin[1] + localDirection[1] * t,
    localOrigin[2] + localDirection[2] * t,
  );
  const localNormal = normalize(subtract(localPosition, sphere.center));
  const geometricNormal = normalize(transformNormal(normalMatrix, localNormal));
  const frontFace = dot(ray.direction, geometricNormal) < 0;
  return freezeHit({
    primitiveKind: 'sphere',
    identity: sphere.identity,
    t,
    position: pointOnRay(ray, t),
    barycentric: null,
    frontFace,
    geometricNormal,
    shadingNormal: geometricNormal,
    facingNormal: frontFace ? geometricNormal : negate(geometricNormal),
  });
}

function withinRayRange(t: number, ray: CanonicalRay): boolean {
  const epsilon = RAY_REFERENCE_SEMANTICS.rangeEpsilon * Math.max(1, Math.abs(t));
  return Number.isFinite(t) && t >= ray.tMin - epsilon && t <= ray.tMax + epsilon;
}

function isPreferredHit(candidate: RayHit, current: RayHit | null): boolean {
  if (!current) return true;
  const epsilon = RAY_REFERENCE_SEMANTICS.tieRelativeEpsilon * Math.max(1, Math.abs(candidate.t), Math.abs(current.t));
  if (candidate.t < current.t - epsilon) return true;
  if (candidate.t > current.t + epsilon) return false;
  return compareIdentity(candidate.identity, current.identity) < 0;
}

function compareIdentity(a: RayPrimitiveIdentity, b: RayPrimitiveIdentity): number {
  for (const value of [
    compareText(a.instanceId, b.instanceId),
    compareText(a.geometryId, b.geometryId),
    a.geometryRevision - b.geometryRevision,
    a.primitiveIndex - b.primitiveIndex,
    compareText(a.entityId, b.entityId),
  ]) {
    if (value !== 0) return value;
  }
  return 0;
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function geometryKey(id: string, revision: number): string { return `${id}@${revision}`; }

function diagnostic(
  severity: RayDiagnosticSeverity,
  code: string,
  message: string,
  context: Record<string, string | number | boolean | null>,
): RayDiagnostic {
  return Object.freeze({ phase: 'reference', severity, code, message, context: Object.freeze({ ...context }) });
}

function identityContext(identity: RayPrimitiveIdentity): Record<string, string | number> {
  return {
    instanceId: identity.instanceId,
    entityId: identity.entityId,
    geometryId: identity.geometryId,
    geometryRevision: identity.geometryRevision,
    primitiveIndex: identity.primitiveIndex,
  };
}

function identityLabel(identity: RayPrimitiveIdentity): string {
  return `${identity.instanceId}/${identity.geometryId}@${identity.geometryRevision}#${identity.primitiveIndex}`;
}

function freezeTraceResult(
  ray: CanonicalRay | null,
  hit: RayHit | null,
  diagnostics: RayDiagnostic[],
  testedPrimitiveCount: number,
): RayTraceResult {
  return Object.freeze({ ray, hit, diagnostics: Object.freeze([...diagnostics]), testedPrimitiveCount });
}

function freezeHit(hit: RayHit): RayHit {
  return Object.freeze(hit);
}

function isFiniteVec3(value: readonly number[]): value is RayVec3 {
  return value.length === 3 && value.every(Number.isFinite);
}

function isFiniteMatrix(value: readonly number[]): boolean {
  return value.length === 16 && value.every(Number.isFinite);
}

function readVec3(values: readonly number[], offset: number): RayVec3 | null {
  const x = values[offset];
  const y = values[offset + 1];
  const z = values[offset + 2];
  return x !== undefined && y !== undefined && z !== undefined && [x, y, z].every(Number.isFinite)
    ? freezeVec3(x, y, z)
    : null;
}

function freezeVec3(x: number, y: number, z: number): RayVec3 {
  return Object.freeze([canonicalZero(x), canonicalZero(y), canonicalZero(z)]);
}

function canonicalZero(value: number): number { return Object.is(value, -0) ? 0 : value; }

function subtract(a: RayVec3, b: RayVec3): RayVec3 {
  return freezeVec3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function cross(a: RayVec3, b: RayVec3): RayVec3 {
  return freezeVec3(
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  );
}

function dot(a: RayVec3, b: RayVec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function lengthSquared(value: RayVec3): number { return dot(value, value); }
function length(value: RayVec3): number { return Math.sqrt(lengthSquared(value)); }

function normalize(value: RayVec3): RayVec3 {
  const magnitude = length(value);
  return freezeVec3(value[0] / magnitude, value[1] / magnitude, value[2] / magnitude);
}

function negate(value: RayVec3): RayVec3 { return freezeVec3(-value[0], -value[1], -value[2]); }

function transformPoint(matrix: readonly number[], value: RayVec3): RayVec3 {
  const x = value[0]; const y = value[1]; const z = value[2];
  const w = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
  const divisor = w === 0 ? 1 : w;
  return freezeVec3(
    (matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!) / divisor,
    (matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!) / divisor,
    (matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!) / divisor,
  );
}

function transformVector(matrix: readonly number[], value: RayVec3): RayVec3 {
  return freezeVec3(
    matrix[0]! * value[0] + matrix[4]! * value[1] + matrix[8]! * value[2],
    matrix[1]! * value[0] + matrix[5]! * value[1] + matrix[9]! * value[2],
    matrix[2]! * value[0] + matrix[6]! * value[1] + matrix[10]! * value[2],
  );
}

function transformNormal(matrix3: readonly number[], value: RayVec3): RayVec3 {
  return freezeVec3(
    matrix3[0]! * value[0] + matrix3[1]! * value[1] + matrix3[2]! * value[2],
    matrix3[3]! * value[0] + matrix3[4]! * value[1] + matrix3[5]! * value[2],
    matrix3[6]! * value[0] + matrix3[7]! * value[1] + matrix3[8]! * value[2],
  );
}

function pointOnRay(ray: CanonicalRay, t: number): RayVec3 {
  return freezeVec3(
    ray.origin[0] + ray.direction[0] * t,
    ray.origin[1] + ray.direction[1] * t,
    ray.origin[2] + ray.direction[2] * t,
  );
}

function inverseTranspose3(matrix: readonly number[]): readonly number[] | null {
  const a00 = matrix[0]!; const a01 = matrix[4]!; const a02 = matrix[8]!;
  const a10 = matrix[1]!; const a11 = matrix[5]!; const a12 = matrix[9]!;
  const a20 = matrix[2]!; const a21 = matrix[6]!; const a22 = matrix[10]!;
  const c00 = a11 * a22 - a12 * a21;
  const c01 = a12 * a20 - a10 * a22;
  const c02 = a10 * a21 - a11 * a20;
  const determinant = a00 * c00 + a01 * c01 + a02 * c02;
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= Number.EPSILON) return null;
  const inverseDeterminant = 1 / determinant;
  return Object.freeze([
    c00 * inverseDeterminant,
    c01 * inverseDeterminant,
    c02 * inverseDeterminant,
    (a02 * a21 - a01 * a22) * inverseDeterminant,
    (a00 * a22 - a02 * a20) * inverseDeterminant,
    (a01 * a20 - a00 * a21) * inverseDeterminant,
    (a01 * a12 - a02 * a11) * inverseDeterminant,
    (a02 * a10 - a00 * a12) * inverseDeterminant,
    (a00 * a11 - a01 * a10) * inverseDeterminant,
  ]);
}

function inverseMatrix4(matrix: readonly number[]): readonly number[] | null {
  const augmented = Array.from({ length: 4 }, (_, row) => Array.from({ length: 8 }, (_, column) => (
    column < 4 ? matrix[column * 4 + row]! : Number(column - 4 === row)
  )));
  for (let column = 0; column < 4; column++) {
    let pivotRow = column;
    for (let row = column + 1; row < 4; row++) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivotRow]![column]!)) pivotRow = row;
    }
    if (Math.abs(augmented[pivotRow]![column]!) <= Number.EPSILON) return null;
    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow]!, augmented[column]!];
    const pivot = augmented[column]![column]!;
    for (let item = 0; item < 8; item++) augmented[column]![item] = augmented[column]![item]! / pivot;
    for (let row = 0; row < 4; row++) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      for (let item = 0; item < 8; item++) {
        augmented[row]![item] = augmented[row]![item]! - factor * augmented[column]![item]!;
      }
    }
  }
  const inverse = new Array<number>(16);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) inverse[column * 4 + row] = augmented[row]![column + 4]!;
  }
  return Object.freeze(inverse);
}

function compareOptionalNumber(
  label: string,
  expected: number | undefined,
  actual: number,
  tolerance: number,
  mismatches: string[],
): void {
  if (expected !== undefined && Math.abs(expected - actual) > tolerance) {
    mismatches.push(`${label}: expected ${expected}, received ${actual}, tolerance ${tolerance}`);
  }
}

function compareOptionalVec3(
  label: string,
  expected: RayVec3 | undefined,
  actual: RayVec3,
  tolerance: number,
  mismatches: string[],
): void {
  if (!expected) return;
  for (let index = 0; index < 3; index++) {
    if (Math.abs(expected[index]! - actual[index]!) > tolerance) {
      mismatches.push(`${label}[${index}]: expected ${expected[index]}, received ${actual[index]}, tolerance ${tolerance}`);
    }
  }
}

function freezeScene(scene: RayReferenceScene): RayReferenceScene {
  return Object.freeze({
    geometries: Object.freeze(scene.geometries.map(geometry => Object.freeze(geometry))),
    instances: Object.freeze(scene.instances.map(instance => Object.freeze(instance))),
    analyticPrimitives: Object.freeze(scene.analyticPrimitives.map(primitive => Object.freeze(primitive))),
  });
}

const FRONT_TRIANGLE_GEOMETRY = Object.freeze({
  kind: 'triangle-mesh' as const,
  geometryId: 'corpus:triangle',
  revision: 1,
  positions: Object.freeze([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: Object.freeze([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: null,
  primitiveCount: 1,
});

export const RAY_REFERENCE_CORPUS: readonly RayReferenceCorpusCase[] = Object.freeze([
  Object.freeze({
    id: 'triangle-front-face-non-indexed',
    scene: freezeScene({
      geometries: [FRONT_TRIANGLE_GEOMETRY],
      instances: [{
        instanceId: 'instance:front', entityId: 'entity:front', geometryId: 'corpus:triangle',
        geometryRevision: 1, transform: IDENTITY_MATRIX,
      }],
      analyticPrimitives: [],
    }),
    ray: Object.freeze({ origin: freezeVec3(0.25, 0.25, 1), direction: freezeVec3(0, 0, -1), tMin: 0, tMax: 10 }),
    expected: Object.freeze({
      primitiveKind: 'triangle' as const,
      identity: Object.freeze({ instanceId: 'instance:front', primitiveIndex: 0 }),
      t: 1,
      position: freezeVec3(0.25, 0.25, 0),
      barycentric: freezeVec3(0.5, 0.25, 0.25),
      frontFace: true,
      geometricNormal: freezeVec3(0, 0, 1),
      facingNormal: freezeVec3(0, 0, 1),
    }),
    tolerance: 1e-12,
  }),
  Object.freeze({
    id: 'sphere-inside-exit',
    scene: freezeScene({
      geometries: [], instances: [], analyticPrimitives: [{
        kind: 'sphere',
        identity: Object.freeze({
          instanceId: 'instance:sphere', entityId: 'entity:sphere', geometryId: 'analytic:sphere',
          geometryRevision: 2, primitiveIndex: 0,
        }),
        center: freezeVec3(0, 0, 0), radius: 1, transform: IDENTITY_MATRIX,
      }],
    }),
    ray: Object.freeze({ origin: freezeVec3(0, 0, 0), direction: freezeVec3(1, 0, 0), tMin: 0, tMax: 10 }),
    expected: Object.freeze({
      primitiveKind: 'sphere' as const,
      t: 1,
      position: freezeVec3(1, 0, 0),
      barycentric: null,
      frontFace: false,
      geometricNormal: freezeVec3(1, 0, 0),
      facingNormal: freezeVec3(-1, 0, 0),
    }),
    tolerance: 1e-12,
  }),
  Object.freeze({
    id: 'deterministic-overlap-tie-break',
    scene: freezeScene({
      geometries: [FRONT_TRIANGLE_GEOMETRY],
      instances: [
        { instanceId: 'instance:z', entityId: 'entity:z', geometryId: 'corpus:triangle', geometryRevision: 1, transform: IDENTITY_MATRIX },
        { instanceId: 'instance:a', entityId: 'entity:a', geometryId: 'corpus:triangle', geometryRevision: 1, transform: IDENTITY_MATRIX },
      ],
      analyticPrimitives: [],
    }),
    ray: Object.freeze({ origin: freezeVec3(0.25, 0.25, 1), direction: freezeVec3(0, 0, -1) }),
    expected: Object.freeze({ identity: Object.freeze({ instanceId: 'instance:a' }), t: 1 }),
    tolerance: 1e-12,
  }),
]);
