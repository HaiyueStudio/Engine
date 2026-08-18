const QUADRIC_COMPONENTS = 10;

interface EdgeRecord {
  readonly a: number;
  readonly b: number;
  faceCount: number;
}

export interface Geometry3DQemCollapseCandidate {
  readonly a: number;
  readonly b: number;
  readonly t: number;
  readonly error: number;
  readonly removedFaces: number;
  readonly incidentFaces: readonly number[];
}

interface TopologyPass {
  readonly quadrics: Float64Array;
  readonly edges: Map<string, EdgeRecord>;
  readonly neighbors: Map<number, Set<number>>;
  readonly incidentFaces: Map<number, number[]>;
  readonly boundaryVertices: Set<number>;
}

export function buildGeometry3DQemCollapseCandidates(
  indices: readonly number[],
  positions: readonly number[],
  vertexCount: number,
  preserveBoundary: boolean,
): Geometry3DQemCollapseCandidate[] {
  const topology = buildTopologyPass(indices, positions, vertexCount);
  const candidates: Geometry3DQemCollapseCandidate[] = [];
  for (const edge of topology.edges.values()) {
    if (edge.faceCount < 1 || edge.faceCount > 2) continue;
    if (
      preserveBoundary
      && (topology.boundaryVertices.has(edge.a) || topology.boundaryVertices.has(edge.b))
    ) continue;
    if (!satisfiesLinkCondition(indices, edge, topology)) continue;

    const choice = chooseConstrainedQuadricPosition(topology.quadrics, positions, edge.a, edge.b);
    const incidentFaces = mergeSortedUnique(
      topology.incidentFaces.get(edge.a) ?? [],
      topology.incidentFaces.get(edge.b) ?? [],
    );
    if (wouldFlipIncidentFace(indices, positions, edge.a, edge.b, choice.t, incidentFaces)) continue;
    candidates.push({
      a: edge.a,
      b: edge.b,
      t: choice.t,
      error: choice.error,
      removedFaces: edge.faceCount,
      incidentFaces,
    });
  }
  return candidates.sort((left, right) => (
    left.error - right.error
    || left.a - right.a
    || left.b - right.b
  ));
}

function buildTopologyPass(
  indices: readonly number[],
  positions: readonly number[],
  vertexCount: number,
): TopologyPass {
  const quadrics = new Float64Array(vertexCount * QUADRIC_COMPONENTS);
  const edges = new Map<string, EdgeRecord>();
  const neighbors = new Map<number, Set<number>>();
  const incidentFaces = new Map<number, number[]>();
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]!;
    const b = indices[offset + 1]!;
    const c = indices[offset + 2]!;
    const face = offset / 3;
    appendIncidentFace(incidentFaces, a, face);
    appendIncidentFace(incidentFaces, b, face);
    appendIncidentFace(incidentFaces, c, face);
    addEdge(edges, neighbors, a, b);
    addEdge(edges, neighbors, b, c);
    addEdge(edges, neighbors, c, a);
    addFaceQuadric(quadrics, positions, a, b, c);
  }
  const boundaryVertices = new Set<number>();
  for (const edge of edges.values()) {
    if (edge.faceCount !== 1) continue;
    boundaryVertices.add(edge.a);
    boundaryVertices.add(edge.b);
  }
  return { quadrics, edges, neighbors, incidentFaces, boundaryVertices };
}

function addFaceQuadric(
  quadrics: Float64Array,
  positions: readonly number[],
  a: number,
  b: number,
  c: number,
): void {
  const aOffset = a * 3;
  const bOffset = b * 3;
  const cOffset = c * 3;
  const abx = positions[bOffset]! - positions[aOffset]!;
  const aby = positions[bOffset + 1]! - positions[aOffset + 1]!;
  const abz = positions[bOffset + 2]! - positions[aOffset + 2]!;
  const acx = positions[cOffset]! - positions[aOffset]!;
  const acy = positions[cOffset + 1]! - positions[aOffset + 1]!;
  const acz = positions[cOffset + 2]! - positions[aOffset + 2]!;
  let nx = aby * acz - abz * acy;
  let ny = abz * acx - abx * acz;
  let nz = abx * acy - aby * acx;
  const length = Math.hypot(nx, ny, nz);
  if (length <= Number.EPSILON) return;
  nx /= length;
  ny /= length;
  nz /= length;
  const d = -(nx * positions[aOffset]! + ny * positions[aOffset + 1]! + nz * positions[aOffset + 2]!);
  for (const vertex of [a, b, c]) addPlaneQuadric(quadrics, vertex, nx, ny, nz, d);
}

function addPlaneQuadric(
  quadrics: Float64Array,
  vertex: number,
  a: number,
  b: number,
  c: number,
  d: number,
): void {
  const offset = vertex * QUADRIC_COMPONENTS;
  const values = [
    a * a, a * b, a * c, a * d,
    b * b, b * c, b * d,
    c * c, c * d,
    d * d,
  ];
  for (let component = 0; component < QUADRIC_COMPONENTS; component++) {
    quadrics[offset + component] = quadrics[offset + component]! + values[component]!;
  }
}

function chooseConstrainedQuadricPosition(
  quadrics: Float64Array,
  positions: readonly number[],
  a: number,
  b: number,
): { readonly t: number; readonly error: number } {
  let bestT = 0.5;
  let bestError = Number.POSITIVE_INFINITY;
  for (const t of [0.5, 0, 1]) {
    const x = positionComponent(positions, a, b, t, 0);
    const y = positionComponent(positions, a, b, t, 1);
    const z = positionComponent(positions, a, b, t, 2);
    const error = evaluateCombinedQuadric(quadrics, a, b, x, y, z);
    if (error < bestError) {
      bestError = error;
      bestT = t;
    }
  }
  return { t: bestT, error: Math.max(0, bestError) };
}

function evaluateCombinedQuadric(
  quadrics: Float64Array,
  a: number,
  b: number,
  x: number,
  y: number,
  z: number,
): number {
  const ao = a * QUADRIC_COMPONENTS;
  const bo = b * QUADRIC_COMPONENTS;
  const q = (component: number): number => quadrics[ao + component]! + quadrics[bo + component]!;
  return (
    q(0) * x * x
    + 2 * q(1) * x * y
    + 2 * q(2) * x * z
    + 2 * q(3) * x
    + q(4) * y * y
    + 2 * q(5) * y * z
    + 2 * q(6) * y
    + q(7) * z * z
    + 2 * q(8) * z
    + q(9)
  );
}

function satisfiesLinkCondition(
  indices: readonly number[],
  edge: EdgeRecord,
  topology: TopologyPass,
): boolean {
  const aNeighbors = topology.neighbors.get(edge.a);
  const bNeighbors = topology.neighbors.get(edge.b);
  if (!aNeighbors || !bNeighbors) return false;
  const common = new Set<number>();
  for (const neighbor of aNeighbors) {
    if (neighbor !== edge.b && bNeighbors.has(neighbor)) common.add(neighbor);
  }
  const opposites = new Set<number>();
  for (const face of topology.incidentFaces.get(edge.a) ?? []) {
    const offset = face * 3;
    const vertices = [indices[offset]!, indices[offset + 1]!, indices[offset + 2]!];
    if (!vertices.includes(edge.b)) continue;
    for (const vertex of vertices) if (vertex !== edge.a && vertex !== edge.b) opposites.add(vertex);
  }
  if (common.size !== opposites.size) return false;
  for (const vertex of common) if (!opposites.has(vertex)) return false;
  return opposites.size === edge.faceCount;
}

function wouldFlipIncidentFace(
  indices: readonly number[],
  positions: readonly number[],
  a: number,
  b: number,
  t: number,
  incidentFaces: readonly number[],
): boolean {
  const replacement = [
    positionComponent(positions, a, b, t, 0),
    positionComponent(positions, a, b, t, 1),
    positionComponent(positions, a, b, t, 2),
  ] as const;
  for (const face of incidentFaces) {
    const offset = face * 3;
    const faceVertices = [indices[offset]!, indices[offset + 1]!, indices[offset + 2]!];
    if (faceVertices.includes(a) && faceVertices.includes(b)) continue;
    const oldNormal = triangleNormal(positions, faceVertices);
    const newPositions = faceVertices.map(vertex => (
      vertex === a || vertex === b ? replacement : readPosition(positions, vertex)
    ));
    const newNormal = triangleNormalFromPoints(newPositions);
    const oldLengthSquared = dot3(oldNormal, oldNormal);
    const newLengthSquared = dot3(newNormal, newNormal);
    if (oldLengthSquared <= Number.EPSILON) continue;
    if (newLengthSquared <= oldLengthSquared * 1e-12) return true;
    if (dot3(oldNormal, newNormal) <= 0) return true;
  }
  return false;
}

function addEdge(
  edges: Map<string, EdgeRecord>,
  neighbors: Map<number, Set<number>>,
  first: number,
  second: number,
): void {
  const a = Math.min(first, second);
  const b = Math.max(first, second);
  const key = `${a}:${b}`;
  const edge = edges.get(key);
  if (edge) edge.faceCount++;
  else edges.set(key, { a, b, faceCount: 1 });
  appendNeighbor(neighbors, first, second);
  appendNeighbor(neighbors, second, first);
}

function appendNeighbor(neighbors: Map<number, Set<number>>, vertex: number, neighbor: number): void {
  let set = neighbors.get(vertex);
  if (!set) {
    set = new Set<number>();
    neighbors.set(vertex, set);
  }
  set.add(neighbor);
}

function appendIncidentFace(incidentFaces: Map<number, number[]>, vertex: number, face: number): void {
  const faces = incidentFaces.get(vertex);
  if (faces) faces.push(face);
  else incidentFaces.set(vertex, [face]);
}

function mergeSortedUnique(first: readonly number[], second: readonly number[]): number[] {
  return [...new Set([...first, ...second])].sort((a, b) => a - b);
}

function positionComponent(
  positions: readonly number[],
  a: number,
  b: number,
  t: number,
  component: number,
): number {
  const first = positions[a * 3 + component]!;
  return first + (positions[b * 3 + component]! - first) * t;
}

function readPosition(positions: readonly number[], vertex: number): readonly [number, number, number] {
  const offset = vertex * 3;
  return [positions[offset]!, positions[offset + 1]!, positions[offset + 2]!];
}

function triangleNormal(
  positions: readonly number[],
  vertices: readonly number[],
): readonly [number, number, number] {
  return triangleNormalFromPoints(vertices.map(vertex => readPosition(positions, vertex)));
}

function triangleNormalFromPoints(
  points: readonly (readonly [number, number, number])[],
): readonly [number, number, number] {
  const a = points[0]!;
  const b = points[1]!;
  const c = points[2]!;
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  return [
    aby * acz - abz * acy,
    abz * acx - abx * acz,
    abx * acy - aby * acx,
  ];
}

function dot3(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}
