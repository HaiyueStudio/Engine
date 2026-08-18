import { Geometry3D } from './Geometry3D';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { requiredNumberAt } from '../math/arrayAccess';

const EPSILON = 1e-5;
const VERTEX_KEY_SCALE = 1e5;

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

export type CSGOperation = 'union' | 'subtract' | 'intersect';

class CSGPolygonStore {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly polygonVertices: number[] = [];
  readonly polygonStarts: number[] = [];
  readonly polygonCounts: number[] = [];
  readonly polygonPlanes: number[] = [];
  readonly planeNormals: number[] = [];
  readonly planeWs: number[] = [];

  private readonly _typesScratch: number[] = [];
  private readonly _frontScratch: number[] = [];
  private readonly _backScratch: number[] = [];
  private readonly _planeCandidates: number[] = [];

  addVertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    const vertex = this.positions.length / 3;
    this.positions.push(px, py, pz);
    this.normals.push(nx, ny, nz);
    this.uvs.push(u, v);
    return vertex;
  }

  copyVertex(vertex: number): number {
    const positionOffset = vertex * 3;
    const uvOffset = vertex * 2;
    return this.addVertex(
      requiredNumberAt(this.positions, positionOffset, 'CSG vertex positions'),
      requiredNumberAt(this.positions, positionOffset + 1, 'CSG vertex positions'),
      requiredNumberAt(this.positions, positionOffset + 2, 'CSG vertex positions'),
      requiredNumberAt(this.normals, positionOffset, 'CSG vertex normals'),
      requiredNumberAt(this.normals, positionOffset + 1, 'CSG vertex normals'),
      requiredNumberAt(this.normals, positionOffset + 2, 'CSG vertex normals'),
      requiredNumberAt(this.uvs, uvOffset, 'CSG vertex uvs'),
      requiredNumberAt(this.uvs, uvOffset + 1, 'CSG vertex uvs'),
    );
  }

  interpolateVertex(a: number, b: number, t: number): number {
    const a3 = a * 3;
    const b3 = b * 3;
    const a2 = a * 2;
    const b2 = b * 2;
    const anx = requiredNumberAt(this.normals, a3, 'CSG interpolation normals');
    const any = requiredNumberAt(this.normals, a3 + 1, 'CSG interpolation normals');
    const anz = requiredNumberAt(this.normals, a3 + 2, 'CSG interpolation normals');
    const nx = anx + (requiredNumberAt(this.normals, b3, 'CSG interpolation normals') - anx) * t;
    const ny = any + (requiredNumberAt(this.normals, b3 + 1, 'CSG interpolation normals') - any) * t;
    const nz = anz + (requiredNumberAt(this.normals, b3 + 2, 'CSG interpolation normals') - anz) * t;
    const nLengthSq = nx * nx + ny * ny + nz * nz;
    const nInv = nLengthSq > EPSILON * EPSILON ? 1 / Math.sqrt(nLengthSq) : 0;

    return this.addVertex(
      interpolateArrayValue(this.positions, a3, b3, t, 'CSG interpolation positions'),
      interpolateArrayValue(this.positions, a3 + 1, b3 + 1, t, 'CSG interpolation positions'),
      interpolateArrayValue(this.positions, a3 + 2, b3 + 2, t, 'CSG interpolation positions'),
      nInv > 0 ? nx * nInv : 0,
      nInv > 0 ? ny * nInv : 1,
      nInv > 0 ? nz * nInv : 0,
      interpolateArrayValue(this.uvs, a2, b2, t, 'CSG interpolation uvs'),
      interpolateArrayValue(this.uvs, a2 + 1, b2 + 1, t, 'CSG interpolation uvs'),
    );
  }

  addPolygon(vertexIds: readonly number[]): number {
    if (vertexIds.length < 3) return -1;
    const planeIndex = this.findPlane(vertexIds);
    if (planeIndex < 0) return -1;
    const polygonIndex = this.polygonStarts.length;
    this.polygonStarts.push(this.polygonVertices.length);
    this.polygonCounts.push(vertexIds.length);
    this.polygonPlanes.push(planeIndex);
    for (const vertex of vertexIds) {
      this.polygonVertices.push(vertex);
    }
    return polygonIndex;
  }

  addPolygonCopy(vertexIds: readonly number[]): number {
    this._planeCandidates.length = vertexIds.length;
    for (let i = 0; i < vertexIds.length; i++) {
      this._planeCandidates[i] = this.copyVertex(requiredNumberAt(vertexIds, i, 'CSG polygon vertices'));
    }
    return this.addPolygon(this._planeCandidates);
  }

  addPlane(nx: number, ny: number, nz: number, w: number): number {
    const planeIndex = this.planeWs.length;
    this.planeNormals.push(nx, ny, nz);
    this.planeWs.push(w);
    return planeIndex;
  }

  clonePlane(planeIndex: number): number {
    const offset = planeIndex * 3;
    return this.addPlane(
      requiredNumberAt(this.planeNormals, offset, 'CSG plane normals'),
      requiredNumberAt(this.planeNormals, offset + 1, 'CSG plane normals'),
      requiredNumberAt(this.planeNormals, offset + 2, 'CSG plane normals'),
      requiredNumberAt(this.planeWs, planeIndex, 'CSG plane distances'),
    );
  }

  flipPlane(planeIndex: number): void {
    const offset = planeIndex * 3;
    this.planeNormals[offset] = -requiredNumberAt(this.planeNormals, offset, 'CSG plane normals');
    this.planeNormals[offset + 1] = -requiredNumberAt(this.planeNormals, offset + 1, 'CSG plane normals');
    this.planeNormals[offset + 2] = -requiredNumberAt(this.planeNormals, offset + 2, 'CSG plane normals');
    this.planeWs[planeIndex] = -requiredNumberAt(this.planeWs, planeIndex, 'CSG plane distances');
  }

  flipPolygon(polygonIndex: number): void {
    const start = requiredNumberAt(this.polygonStarts, polygonIndex, 'CSG polygon starts');
    const count = requiredNumberAt(this.polygonCounts, polygonIndex, 'CSG polygon counts');
    for (let i = 0, j = count - 1; i < j; i++, j--) {
      const left = start + i;
      const right = start + j;
      const temp = requiredNumberAt(this.polygonVertices, left, 'CSG polygon vertices');
      this.polygonVertices[left] = requiredNumberAt(this.polygonVertices, right, 'CSG polygon vertices');
      this.polygonVertices[right] = temp;
    }
    for (let i = 0; i < count; i++) {
      const vertex = requiredNumberAt(this.polygonVertices, start + i, 'CSG polygon vertices') * 3;
      this.normals[vertex] = -requiredNumberAt(this.normals, vertex, 'CSG vertex normals');
      this.normals[vertex + 1] = -requiredNumberAt(this.normals, vertex + 1, 'CSG vertex normals');
      this.normals[vertex + 2] = -requiredNumberAt(this.normals, vertex + 2, 'CSG vertex normals');
    }
    this.flipPlane(requiredNumberAt(this.polygonPlanes, polygonIndex, 'CSG polygon planes'));
  }

  classifyPolygon(planeIndex: number, polygonIndex: number): number {
    const planeOffset = planeIndex * 3;
    const nx = requiredNumberAt(this.planeNormals, planeOffset, 'CSG plane normals');
    const ny = requiredNumberAt(this.planeNormals, planeOffset + 1, 'CSG plane normals');
    const nz = requiredNumberAt(this.planeNormals, planeOffset + 2, 'CSG plane normals');
    const w = requiredNumberAt(this.planeWs, planeIndex, 'CSG plane distances');
    const start = requiredNumberAt(this.polygonStarts, polygonIndex, 'CSG polygon starts');
    const count = requiredNumberAt(this.polygonCounts, polygonIndex, 'CSG polygon counts');
    let polygonType = COPLANAR;

    for (let i = 0; i < count; i++) {
      const vertexOffset = requiredNumberAt(this.polygonVertices, start + i, 'CSG polygon vertices') * 3;
      const t = nx * requiredNumberAt(this.positions, vertexOffset, 'CSG vertex positions')
        + ny * requiredNumberAt(this.positions, vertexOffset + 1, 'CSG vertex positions')
        + nz * requiredNumberAt(this.positions, vertexOffset + 2, 'CSG vertex positions') - w;
      polygonType |= t < -EPSILON ? BACK : t > EPSILON ? FRONT : COPLANAR;
    }
    return polygonType;
  }

  splitPolygon(planeIndex: number, polygonIndex: number, coplanarFront: number[], coplanarBack: number[], front: number[], back: number[]): void {
    const planeOffset = planeIndex * 3;
    const nx = requiredNumberAt(this.planeNormals, planeOffset, 'CSG plane normals');
    const ny = requiredNumberAt(this.planeNormals, planeOffset + 1, 'CSG plane normals');
    const nz = requiredNumberAt(this.planeNormals, planeOffset + 2, 'CSG plane normals');
    const w = requiredNumberAt(this.planeWs, planeIndex, 'CSG plane distances');
    const start = requiredNumberAt(this.polygonStarts, polygonIndex, 'CSG polygon starts');
    const count = requiredNumberAt(this.polygonCounts, polygonIndex, 'CSG polygon counts');
    const types = this._typesScratch;
    types.length = count;
    let polygonType = COPLANAR;

    for (let i = 0; i < count; i++) {
      const vertexOffset = requiredNumberAt(this.polygonVertices, start + i, 'CSG polygon vertices') * 3;
      const t = nx * requiredNumberAt(this.positions, vertexOffset, 'CSG vertex positions')
        + ny * requiredNumberAt(this.positions, vertexOffset + 1, 'CSG vertex positions')
        + nz * requiredNumberAt(this.positions, vertexOffset + 2, 'CSG vertex positions') - w;
      const type = t < -EPSILON ? BACK : t > EPSILON ? FRONT : COPLANAR;
      polygonType |= type;
      types[i] = type;
    }

    switch (polygonType) {
      case COPLANAR: {
        const polygonPlaneOffset = requiredNumberAt(this.polygonPlanes, polygonIndex, 'CSG polygon planes') * 3;
        const dot =
          nx * requiredNumberAt(this.planeNormals, polygonPlaneOffset, 'CSG plane normals') +
          ny * requiredNumberAt(this.planeNormals, polygonPlaneOffset + 1, 'CSG plane normals') +
          nz * requiredNumberAt(this.planeNormals, polygonPlaneOffset + 2, 'CSG plane normals');
        (dot > 0 ? coplanarFront : coplanarBack).push(polygonIndex);
        return;
      }
      case FRONT:
        front.push(polygonIndex);
        return;
      case BACK:
        back.push(polygonIndex);
        return;
    }

    const frontVertices = this._frontScratch;
    const backVertices = this._backScratch;
    frontVertices.length = 0;
    backVertices.length = 0;

    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const ti = requiredNumberAt(types, i, 'CSG polygon classifications');
      const tj = requiredNumberAt(types, j, 'CSG polygon classifications');
      const vi = requiredNumberAt(this.polygonVertices, start + i, 'CSG polygon vertices');
      const vj = requiredNumberAt(this.polygonVertices, start + j, 'CSG polygon vertices');

      if (ti !== BACK) frontVertices.push(this.copyVertex(vi));
      if (ti !== FRONT) backVertices.push(this.copyVertex(vi));
      if ((ti | tj) === SPANNING) {
        const viOffset = vi * 3;
        const vjOffset = vj * 3;
        const vix = requiredNumberAt(this.positions, viOffset, 'CSG vertex positions');
        const viy = requiredNumberAt(this.positions, viOffset + 1, 'CSG vertex positions');
        const viz = requiredNumberAt(this.positions, viOffset + 2, 'CSG vertex positions');
        const dx = requiredNumberAt(this.positions, vjOffset, 'CSG vertex positions') - vix;
        const dy = requiredNumberAt(this.positions, vjOffset + 1, 'CSG vertex positions') - viy;
        const dz = requiredNumberAt(this.positions, vjOffset + 2, 'CSG vertex positions') - viz;
        const denom = nx * dx + ny * dy + nz * dz;
        if (Math.abs(denom) > EPSILON) {
          const t = (w - nx * vix - ny * viy - nz * viz) / denom;
          const frontVertex = this.interpolateVertex(vi, vj, t);
          const backVertex = this.copyVertex(frontVertex);
          frontVertices.push(frontVertex);
          backVertices.push(backVertex);
        }
      }
    }

    const frontPolygon = this.addPolygon(frontVertices);
    if (frontPolygon >= 0) front.push(frontPolygon);
    const backPolygon = this.addPolygon(backVertices);
    if (backPolygon >= 0) back.push(backPolygon);
  }

  private findPlane(vertexIds: readonly number[]): number {
    const count = vertexIds.length;
    if (count < 3) return -1;

    const candidates = this._planeCandidates;
    candidates.length = 0;
    candidates.push(0, 1, 2, 0, Math.floor((count - 1) / 2), count - 1, count - 3, count - 2, count - 1);
    for (let i = 0; i < candidates.length; i += 3) {
      const plane = this.planeFromVertexTriplet(
        vertexIds,
        requiredNumberAt(candidates, i, 'CSG plane candidates'),
        requiredNumberAt(candidates, i + 1, 'CSG plane candidates'),
        requiredNumberAt(candidates, i + 2, 'CSG plane candidates'),
      );
      if (plane >= 0) return plane;
    }

    const origin = requiredNumberAt(vertexIds, 0, 'CSG polygon vertices');
    const originOffset = origin * 3;
    let bestIndex = -1;
    let bestDistSq = 0;
    for (let i = 1; i < count; i++) {
      const vertexOffset = requiredNumberAt(vertexIds, i, 'CSG polygon vertices') * 3;
      const dx = requiredNumberAt(this.positions, vertexOffset, 'CSG vertex positions')
        - requiredNumberAt(this.positions, originOffset, 'CSG vertex positions');
      const dy = requiredNumberAt(this.positions, vertexOffset + 1, 'CSG vertex positions')
        - requiredNumberAt(this.positions, originOffset + 1, 'CSG vertex positions');
      const dz = requiredNumberAt(this.positions, vertexOffset + 2, 'CSG vertex positions')
        - requiredNumberAt(this.positions, originOffset + 2, 'CSG vertex positions');
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > bestDistSq) {
        bestDistSq = distSq;
        bestIndex = i;
      }
    }
    if (bestIndex < 0 || bestDistSq <= EPSILON * EPSILON) return -1;

    const axisOffset = requiredNumberAt(vertexIds, bestIndex, 'CSG polygon vertices') * 3;
    const ax = requiredNumberAt(this.positions, axisOffset, 'CSG vertex positions')
      - requiredNumberAt(this.positions, originOffset, 'CSG vertex positions');
    const ay = requiredNumberAt(this.positions, axisOffset + 1, 'CSG vertex positions')
      - requiredNumberAt(this.positions, originOffset + 1, 'CSG vertex positions');
    const az = requiredNumberAt(this.positions, axisOffset + 2, 'CSG vertex positions')
      - requiredNumberAt(this.positions, originOffset + 2, 'CSG vertex positions');
    let bestThirdIndex = -1;
    let bestAreaSq = 0;
    for (let i = 1; i < count; i++) {
      if (i === bestIndex) continue;
      const vertexOffset = requiredNumberAt(vertexIds, i, 'CSG polygon vertices') * 3;
      const bx = requiredNumberAt(this.positions, vertexOffset, 'CSG vertex positions')
        - requiredNumberAt(this.positions, originOffset, 'CSG vertex positions');
      const by = requiredNumberAt(this.positions, vertexOffset + 1, 'CSG vertex positions')
        - requiredNumberAt(this.positions, originOffset + 1, 'CSG vertex positions');
      const bz = requiredNumberAt(this.positions, vertexOffset + 2, 'CSG vertex positions')
        - requiredNumberAt(this.positions, originOffset + 2, 'CSG vertex positions');
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      const areaSq = cx * cx + cy * cy + cz * cz;
      if (areaSq > bestAreaSq) {
        bestAreaSq = areaSq;
        bestThirdIndex = i;
      }
    }
    if (bestThirdIndex < 0 || bestAreaSq <= EPSILON * EPSILON) return -1;
    return this.planeFromVertexTriplet(vertexIds, 0, bestIndex, bestThirdIndex);
  }

  private planeFromVertexTriplet(vertexIds: readonly number[], ai: number, bi: number, ci: number): number {
    if (ai < 0 || bi < 0 || ci < 0 || ai >= vertexIds.length || bi >= vertexIds.length || ci >= vertexIds.length || ai === bi || bi === ci || ai === ci) {
      return -1;
    }

    const a = requiredNumberAt(vertexIds, ai, 'CSG polygon vertices') * 3;
    const b = requiredNumberAt(vertexIds, bi, 'CSG polygon vertices') * 3;
    const c = requiredNumberAt(vertexIds, ci, 'CSG polygon vertices') * 3;
    const ax = requiredNumberAt(this.positions, a, 'CSG vertex positions');
    const ay = requiredNumberAt(this.positions, a + 1, 'CSG vertex positions');
    const az = requiredNumberAt(this.positions, a + 2, 'CSG vertex positions');
    const abx = requiredNumberAt(this.positions, b, 'CSG vertex positions') - ax;
    const aby = requiredNumberAt(this.positions, b + 1, 'CSG vertex positions') - ay;
    const abz = requiredNumberAt(this.positions, b + 2, 'CSG vertex positions') - az;
    const acx = requiredNumberAt(this.positions, c, 'CSG vertex positions') - ax;
    const acy = requiredNumberAt(this.positions, c + 1, 'CSG vertex positions') - ay;
    const acz = requiredNumberAt(this.positions, c + 2, 'CSG vertex positions') - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const lengthSq = nx * nx + ny * ny + nz * nz;
    if (lengthSq <= EPSILON * EPSILON) return -1;
    const invLength = 1 / Math.sqrt(lengthSq);
    const nnx = nx * invLength;
    const nny = ny * invLength;
    const nnz = nz * invLength;
    const w = nnx * ax + nny * ay + nnz * az;
    return this.addPlane(nnx, nny, nnz, w);
  }
}

class BSPNode {
  planeIndex = -1;
  front: BSPNode | null = null;
  back: BSPNode | null = null;
  readonly polygons: number[] = [];

  constructor(private readonly store: CSGPolygonStore, polygons: readonly number[] = []) {
    if (polygons.length > 0) this.build(polygons);
  }

  invert(): void {
    for (const polygon of this.polygons) {
      this.store.flipPolygon(polygon);
    }
    if (this.planeIndex >= 0) this.store.flipPlane(this.planeIndex);
    this.front?.invert();
    this.back?.invert();
    const temp = this.front;
    this.front = this.back;
    this.back = temp;
  }

  clipPolygons(polygons: readonly number[]): number[] {
    if (this.planeIndex < 0) return polygons.slice();

    let front: number[] = [];
    let back: number[] = [];
    for (const polygon of polygons) {
      this.store.splitPolygon(this.planeIndex, polygon, front, back, front, back);
    }
    if (this.front) front = this.front.clipPolygons(front);
    if (this.back) back = this.back.clipPolygons(back);
    else back.length = 0;
    pushAll(front, back);
    return front;
  }

  clipTo(node: BSPNode): void {
    const clipped = node.clipPolygons(this.polygons);
    this.polygons.length = 0;
    pushAll(this.polygons, clipped);
    this.front?.clipTo(node);
    this.back?.clipTo(node);
  }

  collectPolygons(out: number[]): void {
    pushAll(out, this.polygons);
    this.front?.collectPolygons(out);
    this.back?.collectPolygons(out);
  }

  build(polygons: readonly number[]): void {
    if (polygons.length === 0) return;
    if (this.planeIndex < 0) {
      this.planeIndex = chooseSplitPlane(this.store, polygons);
      if (this.planeIndex < 0) return;
    }

    const front: number[] = [];
    const back: number[] = [];
    for (const polygon of polygons) {
      this.store.splitPolygon(this.planeIndex, polygon, this.polygons, this.polygons, front, back);
    }
    if (front.length > 0) {
      if (!this.front) this.front = new BSPNode(this.store);
      this.front.build(front);
    }
    if (back.length > 0) {
      if (!this.back) this.back = new BSPNode(this.store);
      this.back.build(back);
    }
  }
}

export function createCSGGeometry(a: Geometry3D, b: Geometry3D, operation: CSGOperation): Geometry3D {
  switch (operation) {
    case 'union':
      return csgUnion(a, b);
    case 'subtract':
      return csgSubtract(a, b);
    case 'intersect':
      return csgIntersect(a, b);
    default:
      throw csgGeometryError(`Unsupported CSG operation: ${String(operation)}.`);
  }
}

export function csgUnion(a: Geometry3D, b: Geometry3D): Geometry3D {
  const { store, aPolygons, bPolygons } = geometryPairToStore(a, b);
  const aNode = new BSPNode(store, aPolygons);
  const bNode = new BSPNode(store, bPolygons);
  aNode.clipTo(bNode);
  bNode.clipTo(aNode);
  bNode.invert();
  bNode.clipTo(aNode);
  bNode.invert();
  const collectedB = collectNodePolygons(bNode);
  aNode.build(collectedB);
  return polygonsToGeometry(store, collectNodePolygons(aNode, collectedB));
}

export function csgSubtract(a: Geometry3D, b: Geometry3D): Geometry3D {
  const { store, aPolygons, bPolygons } = geometryPairToStore(a, b);
  const aNode = new BSPNode(store, aPolygons);
  const bNode = new BSPNode(store, bPolygons);
  aNode.invert();
  aNode.clipTo(bNode);
  bNode.clipTo(aNode);
  bNode.invert();
  bNode.clipTo(aNode);
  bNode.invert();
  const collectedB = collectNodePolygons(bNode);
  aNode.build(collectedB);
  aNode.invert();
  return polygonsToGeometry(store, collectNodePolygons(aNode, collectedB));
}

export function csgIntersect(a: Geometry3D, b: Geometry3D): Geometry3D {
  const { store, aPolygons, bPolygons } = geometryPairToStore(a, b);
  const aNode = new BSPNode(store, aPolygons);
  const bNode = new BSPNode(store, bPolygons);
  aNode.invert();
  bNode.clipTo(aNode);
  bNode.invert();
  aNode.clipTo(bNode);
  bNode.clipTo(aNode);
  const collectedB = collectNodePolygons(bNode);
  aNode.build(collectedB);
  aNode.invert();
  return polygonsToGeometry(store, collectNodePolygons(aNode, collectedB));
}

function geometryPairToStore(a: Geometry3D, b: Geometry3D): { store: CSGPolygonStore; aPolygons: number[]; bPolygons: number[] } {
  const store = new CSGPolygonStore();
  return {
    store,
    aPolygons: appendGeometryPolygons(store, a),
    bPolygons: appendGeometryPolygons(store, b),
  };
}

function appendGeometryPolygons(store: CSGPolygonStore, geometry: Geometry3D): number[] {
  validateCSGInputGeometry(geometry);
  const polygons: number[] = [];
  const { positions, normals, indices } = geometry;
  const uvs = geometry.getTextureCoordinates(0);
  const triangleCount = indices ? indices.length / 3 : positions.length / 9;
  const triangleVertices: [number, number, number] = [0, 0, 0];

  for (let tri = 0; tri < triangleCount; tri++) {
    for (let corner = 0; corner < 3; corner++) {
      const index = indices
        ? requiredNumberAt(indices, tri * 3 + corner, 'CSG input indices')
        : tri * 3 + corner;
      const positionOffset = index * 3;
      const uvOffset = index * 2;
      triangleVertices[corner] = store.addVertex(
        requiredNumberAt(positions, positionOffset, 'CSG input positions'),
        requiredNumberAt(positions, positionOffset + 1, 'CSG input positions'),
        requiredNumberAt(positions, positionOffset + 2, 'CSG input positions'),
        normals ? requiredNumberAt(normals, positionOffset, 'CSG input normals') : 0,
        normals ? requiredNumberAt(normals, positionOffset + 1, 'CSG input normals') : 1,
        normals ? requiredNumberAt(normals, positionOffset + 2, 'CSG input normals') : 0,
        uvs ? requiredNumberAt(uvs, uvOffset, 'CSG input uvs') : 0,
        uvs ? requiredNumberAt(uvs, uvOffset + 1, 'CSG input uvs') : 0,
      );
    }
    const polygon = store.addPolygon(triangleVertices);
    if (polygon >= 0) polygons.push(polygon);
  }
  return polygons;
}

function collectNodePolygons(node: BSPNode, out: number[] = []): number[] {
  out.length = 0;
  node.collectPolygons(out);
  return out;
}

function chooseSplitPlane(store: CSGPolygonStore, polygons: readonly number[]): number {
  let bestPlane = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  const sampleCount = Math.min(32, polygons.length);
  const step = Math.max(1, Math.floor(polygons.length / sampleCount));

  for (let i = 0; i < polygons.length; i += step) {
    const polygon = requiredNumberAt(polygons, i, 'CSG split candidates');
    const plane = requiredNumberAt(store.polygonPlanes, polygon, 'CSG polygon planes');
    let front = 0;
    let back = 0;
    let split = 0;
    for (const polygon of polygons) {
      const type = store.classifyPolygon(plane, polygon);
      if (type === FRONT) front++;
      else if (type === BACK) back++;
      else if (type === SPANNING) split++;
    }
    const score = split * 8 + Math.abs(front - back);
    if (score < bestScore) {
      bestScore = score;
      bestPlane = plane;
    }
  }

  return bestPlane >= 0 ? store.clonePlane(bestPlane) : -1;
}

function polygonsToGeometry(store: CSGPolygonStore, polygons: readonly number[]): Geometry3D {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const vertexMap = new Map<number, number[]>();

  for (const polygon of polygons) {
    const start = requiredNumberAt(store.polygonStarts, polygon, 'CSG polygon starts');
    const count = requiredNumberAt(store.polygonCounts, polygon, 'CSG polygon counts');
    if (count < 3) continue;
    const first = requiredNumberAt(store.polygonVertices, start, 'CSG polygon vertices');
    for (let i = 2; i < count; i++) {
      indices.push(
        pushIndexedVertex(store, first, positions, normals, uvs, vertexMap),
        pushIndexedVertex(store, requiredNumberAt(store.polygonVertices, start + i - 1, 'CSG polygon vertices'), positions, normals, uvs, vertexMap),
        pushIndexedVertex(store, requiredNumberAt(store.polygonVertices, start + i, 'CSG polygon vertices'), positions, normals, uvs, vertexMap),
      );
    }
  }

  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    textureCoordinates: [{ set: 0, data: new Float32Array(uvs) }],
    indices: makeIndexArray(indices, positions.length / 3),
  });
}

function pushIndexedVertex(
  store: CSGPolygonStore,
  vertex: number,
  positions: number[],
  normals: number[],
  uvs: number[],
  vertexMap: Map<number, number[]>,
): number {
  const positionOffset = vertex * 3;
  const uvOffset = vertex * 2;
  const nx = requiredNumberAt(store.normals, positionOffset, 'CSG output normals');
  const ny = requiredNumberAt(store.normals, positionOffset + 1, 'CSG output normals');
  const nz = requiredNumberAt(store.normals, positionOffset + 2, 'CSG output normals');
  const normalLengthSq = nx * nx + ny * ny + nz * nz;
  const normalInv = normalLengthSq > EPSILON * EPSILON ? 1 / Math.sqrt(normalLengthSq) : 0;
  const nnx = normalInv > 0 ? nx * normalInv : 0;
  const nny = normalInv > 0 ? ny * normalInv : 1;
  const nnz = normalInv > 0 ? nz * normalInv : 0;
  const px = requiredNumberAt(store.positions, positionOffset, 'CSG output positions');
  const py = requiredNumberAt(store.positions, positionOffset + 1, 'CSG output positions');
  const pz = requiredNumberAt(store.positions, positionOffset + 2, 'CSG output positions');
  const uvx = requiredNumberAt(store.uvs, uvOffset, 'CSG output uvs');
  const uvy = requiredNumberAt(store.uvs, uvOffset + 1, 'CSG output uvs');
  const qx = quantize(px);
  const qy = quantize(py);
  const qz = quantize(pz);
  const qnx = quantize(nnx);
  const qny = quantize(nny);
  const qnz = quantize(nnz);
  const qu = quantize(uvx);
  const qv = quantize(uvy);
  const hash = vertexHash(qx, qy, qz, qnx, qny, qnz, qu, qv);
  const bucket = vertexMap.get(hash);
  if (bucket) {
    for (const candidate of bucket) {
      const candidatePositionOffset = candidate * 3;
      const candidateUvOffset = candidate * 2;
      if (
        quantize(requiredNumberAt(positions, candidatePositionOffset, 'CSG indexed positions')) === qx &&
        quantize(requiredNumberAt(positions, candidatePositionOffset + 1, 'CSG indexed positions')) === qy &&
        quantize(requiredNumberAt(positions, candidatePositionOffset + 2, 'CSG indexed positions')) === qz &&
        quantize(requiredNumberAt(normals, candidatePositionOffset, 'CSG indexed normals')) === qnx &&
        quantize(requiredNumberAt(normals, candidatePositionOffset + 1, 'CSG indexed normals')) === qny &&
        quantize(requiredNumberAt(normals, candidatePositionOffset + 2, 'CSG indexed normals')) === qnz &&
        quantize(requiredNumberAt(uvs, candidateUvOffset, 'CSG indexed uvs')) === qu &&
        quantize(requiredNumberAt(uvs, candidateUvOffset + 1, 'CSG indexed uvs')) === qv
      ) {
        return candidate;
      }
    }
  }

  const index = positions.length / 3;
  positions.push(px, py, pz);
  normals.push(nnx, nny, nnz);
  uvs.push(uvx, uvy);
  if (bucket) bucket.push(index);
  else vertexMap.set(hash, [index]);
  return index;
}

function pushAll<T>(target: T[], source: readonly T[]): void {
  for (const item of source) {
    target.push(item);
  }
}

function vertexHash(qx: number, qy: number, qz: number, qnx: number, qny: number, qnz: number, qu: number, qv: number): number {
  let hash = 2166136261;
  hash = mixHash(hash, qx);
  hash = mixHash(hash, qy);
  hash = mixHash(hash, qz);
  hash = mixHash(hash, qnx);
  hash = mixHash(hash, qny);
  hash = mixHash(hash, qnz);
  hash = mixHash(hash, qu);
  hash = mixHash(hash, qv);
  return hash >>> 0;
}

function mixHash(hash: number, value: number): number {
  return Math.imul(hash ^ value, 16777619);
}

function quantize(value: number): number {
  return Math.round(value * VERTEX_KEY_SCALE);
}

function makeIndexArray(indices: number[], vertexCount: number): Uint16Array | Uint32Array {
  return vertexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
}

function interpolateArrayValue(
  values: ArrayLike<number>,
  a: number,
  b: number,
  t: number,
  label: string,
): number {
  const start = requiredNumberAt(values, a, label);
  return start + (requiredNumberAt(values, b, label) - start) * t;
}

function validateCSGInputGeometry(geometry: Geometry3D): void {
  if (geometry.topology !== null && geometry.topology !== 'triangle-list') {
    throw csgGeometryError(`CSG requires triangle-list geometry; received ${String(geometry.topology)}.`);
  }

  const { positions, normals, indices } = geometry;
  const uvs = geometry.getTextureCoordinates(0);
  if (!(positions instanceof Float32Array) || positions.length < 9 || positions.length % 3 !== 0) {
    throw csgGeometryError('CSG positions must be a non-empty Float32Array of xyz triplets containing at least one triangle.');
  }
  validateFiniteAttribute(positions, 'CSG input positions');
  const vertexCount = positions.length / 3;

  if (normals) {
    if (!(normals instanceof Float32Array) || normals.length !== positions.length) {
      throw csgGeometryError(`CSG normals length must match positions length ${positions.length}; received ${normals.length}.`);
    }
    validateFiniteAttribute(normals, 'CSG input normals');
  }

  if (uvs) {
    if (!(uvs instanceof Float32Array) || uvs.length !== vertexCount * 2) {
      throw csgGeometryError(`CSG uvs length must equal vertexCount * 2 (${vertexCount * 2}); received ${uvs.length}.`);
    }
    validateFiniteAttribute(uvs, 'CSG input uvs');
  }

  if (indices) {
    if (!(indices instanceof Uint16Array) && !(indices instanceof Uint32Array)) {
      throw csgGeometryError('CSG indices must be Uint16Array or Uint32Array.');
    }
    if (indices.length === 0 || indices.length % 3 !== 0) {
      throw csgGeometryError(`CSG index count must be a non-zero multiple of 3; received ${indices.length}.`);
    }
    for (let i = 0; i < indices.length; i++) {
      const index = requiredNumberAt(indices, i, 'CSG input indices');
      if (index >= vertexCount) {
        throw csgGeometryError(`CSG index ${index} at offset ${i} exceeds vertexCount ${vertexCount}.`);
      }
    }
  } else if (positions.length % 9 !== 0) {
    throw csgGeometryError(`Non-indexed CSG position count must describe complete triangles; received ${vertexCount} vertices.`);
  }
}

function validateFiniteAttribute(values: ArrayLike<number>, label: string): void {
  for (let i = 0; i < values.length; i++) {
    const value = requiredNumberAt(values, i, label);
    if (!Number.isFinite(value)) throw csgGeometryError(`${label} contains a non-finite value at offset ${i}.`);
  }
}

function csgGeometryError(message: string): EngineError {
  return new EngineError(
    EngineErrorCode.GeometryInvalidParameter,
    message,
    {
      hint: 'Provide finite triangle-list geometry with aligned positions, normals, uvs, and indices.',
      docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
    },
  );
}
