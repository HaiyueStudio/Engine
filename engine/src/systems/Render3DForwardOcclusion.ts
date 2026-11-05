import type { RenderViewSnapshot } from '../core/RenderView';
import { BasicMaterial } from '../material/BasicMaterial';
import { BlinnPhongMaterial } from '../material/BlinnPhongMaterial';
import { DepthMaterial } from '../material/DepthMaterial';
import type { Material } from '../material/Material';
import { NormalMaterial } from '../material/NormalMaterial';
import { PbrMaterial } from '../material/PbrMaterial';
import { VolumeMaterial } from '../material/VolumeMaterial';
import type { MaterialRendererRegistration, MaterialRendererRegistry } from '../renderer/MaterialRendererRegistry';
import type { Render3DRenderItem } from './Render3DContracts';

const builtInForwardRenderers = new WeakSet<object>();

/** Only registrations with known depth, coverage, and vertex semantics may participate. */
export function registerForwardOcclusionRenderer<M extends Material>(
  registry: MaterialRendererRegistry,
  registration: MaterialRendererRegistration<M>,
): void {
  builtInForwardRenderers.add(registration);
  registry.register(registration);
}

const TILE_SIZE = 2;
const MAX_VIEW_PIXELS = 4 * 1024 * 1024;
const MAX_TRIANGLES_PER_ITEM = 8;
const MAX_TRIANGLES = 32768;
const MAX_TILE_VISITS = 8 * 1024 * 1024;
const MIN_ITEMS = 512;
// Allow for raster subpixel snapping and depth interpolation/storage rounding.
const RASTER_GUARD = 1 / 16;
const DEPTH_GUARD = 4e-6;
const FLOAT_ERROR = 2 ** -20;

interface Edge {
  x: number;
  y: number;
  constant: number;
  guard: number;
  sampleGuard: number;
}

interface Triangle {
  item: number;
  occluder: boolean;
  nearest: number;
  farthest: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  a: Edge;
  b: Edge;
  c: Edge;
}

function edge(): Edge {
  return { x: 0, y: 0, constant: 0, guard: 0, sampleGuard: 0 };
}

function triangle(): Triangle {
  return {
    item: 0, occluder: false, nearest: 0, farthest: 0, left: 0, right: 0, top: 0, bottom: 0,
    a: edge(), b: edge(), c: edge(),
  };
}

/**
 * The software adapter shades before rejecting covered fragments. A small CPU
 * depth mask lets the forward pass omit completely covered low-poly meshes.
 * Partial coverage, ties, and unsupported projections keep their original draws.
 */
export class Render3DForwardOcclusion {
  private _depth = new Float32Array(0);
  private _sampleDepth = new Float32Array(0);
  private _remaining = new Uint8Array(0);
  private readonly _pool: Triangle[] = [];
  private readonly _triangles: Triangle[] = [];
  private readonly _projected = new Float64Array(16);
  private readonly _opaqueItems: Render3DRenderItem[] = [];
  private readonly _transparentItems: Render3DRenderItem[] = [];

  get opaqueItems(): readonly Render3DRenderItem[] { return this._opaqueItems; }
  get transparentItems(): readonly Render3DRenderItem[] { return this._transparentItems; }

  prepare(
    opaque: readonly Render3DRenderItem[],
    transparent: readonly Render3DRenderItem[],
    view: RenderViewSnapshot,
    viewProjection: Float32Array,
    registry: MaterialRendererRegistry,
  ): boolean {
    this.clear();
    const { width, height } = view;
    if (opaque.length < MIN_ITEMS || width * height > MAX_VIEW_PIXELS
        || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return false;

    // A custom registration can observe draw order or use nonstandard depth.
    // Leave the entire view alone if it contains one.
    const count = opaque.length + transparent.length;
    if (count > MAX_TRIANGLES) return false;
    for (const items of [opaque, transparent]) {
      for (const { material } of items) {
        const registration = material && registry.resolve(material);
        if (!registration || !builtInForwardRenderers.has(registration)) return false;
      }
    }

    if (this._remaining.length < count) this._remaining = new Uint8Array(count);
    this._remaining.fill(0, 0, count);
    const columns = Math.ceil(width / TILE_SIZE);
    const rows = Math.ceil(height / TILE_SIZE);
    let visits = 0;
    for (let i = 0; i < count; i++) {
      const isOpaque = i < opaque.length;
      const item = isOpaque ? opaque[i]! : transparent[i - opaque.length]!;
      const added = this._append(item, i, isOpaque, viewProjection, width, height, columns, rows);
      if (added === 0) continue;
      // Zero denotes an unsupported item. One denotes a proven hidden item.
      this._remaining[i] = added + 1;
      for (let j = this._triangles.length - added; j < this._triangles.length; j++) {
        const projected = this._triangles[j]!;
        visits += (projected.right - projected.left + 1) * (projected.bottom - projected.top + 1);
      }
      if (this._triangles.length > MAX_TRIANGLES || visits > MAX_TILE_VISITS) {
        this._triangles.length = 0;
        return false;
      }
    }
    if (this._triangles.length === 0) return false;

    const tileCount = columns * rows;
    if (this._depth.length < tileCount) this._depth = new Float32Array(tileCount);
    if (this._sampleDepth.length < tileCount * 4) this._sampleDepth = new Float32Array(tileCount * 4);
    this._depth.fill(1, 0, tileCount);
    this._sampleDepth.fill(1, 0, tileCount * 4);
    this._triangles.sort((a, b) => Number(b.occluder) - Number(a.occluder) || a.nearest - b.nearest);
    // An item is removable only if every one of its triangles is covered.
    for (const t of this._triangles) {
      if (this._rasterize(t, columns)) this._remaining[t.item] = this._remaining[t.item]! - 1;
    }
    this._triangles.length = 0;
    for (let i = 0; i < opaque.length; i++) {
      if (this._remaining[i] !== 1) this._opaqueItems.push(opaque[i]!);
    }
    for (let i = 0; i < transparent.length; i++) {
      if (this._remaining[opaque.length + i] !== 1) this._transparentItems.push(transparent[i]!);
    }
    return this._opaqueItems.length + this._transparentItems.length < count;
  }

  clear(): void {
    this._opaqueItems.length = 0;
    this._transparentItems.length = 0;
  }

  private _append(
    { geometry, material, clippingPlanes, worldMatrix }: Render3DRenderItem,
    item: number, opaque: boolean, viewProjection: Float32Array,
    width: number, height: number, columns: number, rows: number,
  ): number {
    if (!geometry || !material || !worldMatrix || clippingPlanes
        || geometry.morphTargets.length || geometry.skinning || geometry.instanceCount !== 1
        || geometry.instanceAttributes.size || geometry.customAttributes.size
        || (geometry.topology !== null && geometry.topology !== 'triangle-list')) return 0;
    const { positions, indices } = geometry;
    const triangleCount = (indices?.length ?? geometry.vertexCount) / 3;
    if (!Number.isInteger(triangleCount) || triangleCount < 1 || triangleCount > MAX_TRIANGLES_PER_ITEM) return 0;

    let cullMode = geometry.cullMode ?? 'back';
    let frontFace = geometry.frontFace ?? 'ccw';
    if (material instanceof BasicMaterial) {
      cullMode = material.cullMode ?? cullMode;
      frontFace = material.frontFace ?? frontFace;
      if (material.depthWrite !== opaque) return 0;
    } else if (material instanceof PbrMaterial) {
      if (material.alphaMode !== 'opaque' || material.transmissionFactor > 0 || !opaque) return 0;
      if (material.doubleSided) cullMode = 'none';
    } else if (material instanceof VolumeMaterial) {
      if (opaque) return 0;
      cullMode = 'none';
    } else if (!(material instanceof BlinnPhongMaterial)
        && !(opaque && (material instanceof DepthMaterial || material instanceof NormalMaterial))) return 0;

    const first = this._triangles.length;
    for (let tri = 0; tri < triangleCount; tri++) {
      const t = this._pool[first + tri] ??= triangle();
      for (let vertex = 0; vertex < 3; vertex++) {
        const offset = 3 * (indices?.[3 * tri + vertex] ?? 3 * tri + vertex);
        projectVertex(this._projected, vertex * 4, positions, offset, worldMatrix, viewProjection, width, height);
      }
      const projected = this._projected;
      const ax = projected[0]!, ay = projected[1]!;
      const bx = projected[4]!, by = projected[5]!;
      const cx = projected[8]!, cy = projected[9]!;
      const nearest = Math.min(projected[2]!, projected[6]!, projected[10]!);
      const farthest = Math.max(projected[2]!, projected[6]!, projected[10]!);
      const guard = Math.max(projected[3]!, projected[7]!, projected[11]!) + RASTER_GUARD;
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const longest = Math.max(Math.hypot(bx - ax, by - ay), Math.hypot(cx - bx, cy - by), Math.hypot(ax - cx, ay - cy));
      if (!(nearest > DEPTH_GUARD && farthest < 1 - DEPTH_GUARD && guard < 0.5 && Math.abs(area) > 8 * guard * longest)) {
        this._triangles.length = first;
        return 0;
      }
      const front = frontFace === 'ccw' ? area < 0 : area > 0;
      t.item = item;
      t.occluder = opaque && (cullMode === 'none' || front === (cullMode === 'back'));
      t.nearest = nearest;
      t.farthest = farthest;
      t.left = Math.max(0, Math.floor((Math.min(ax, bx, cx) - guard) / TILE_SIZE));
      t.right = Math.min(columns - 1, Math.floor((Math.max(ax, bx, cx) + guard) / TILE_SIZE));
      t.top = Math.max(0, Math.floor((Math.min(ay, by, cy) - guard) / TILE_SIZE));
      t.bottom = Math.min(rows - 1, Math.floor((Math.max(ay, by, cy) + guard) / TILE_SIZE));
      if (t.left > t.right || t.top > t.bottom) {
        this._triangles.length = first;
        return 0;
      }
      const winding = Math.sign(area);
      setEdge(t.a, ax, ay, bx, by, winding, guard, longest);
      setEdge(t.b, bx, by, cx, cy, winding, guard, longest);
      setEdge(t.c, cx, cy, ax, ay, winding, guard, longest);
      this._triangles.push(t);
    }
    return triangleCount;
  }

  private _rasterize(t: Triangle, columns: number): boolean {
    const { a, b, c, nearest, farthest, occluder } = t;
    const threshold = nearest - DEPTH_GUARD;
    const depth = this._depth;
    let covered = true;
    for (let y = t.top; y <= t.bottom; y++) {
      const centerY = y * TILE_SIZE + TILE_SIZE / 2;
      const aRow = a.y * centerY + a.constant;
      const bRow = b.y * centerY + b.constant;
      const cRow = c.y * centerY + c.constant;
      const row = y * columns;
      for (let x = t.left; x <= t.right; x++) {
        const index = row + x;
        if (depth[index]! < threshold) continue;
        const centerX = x * TILE_SIZE + TILE_SIZE / 2;
        const aValue = a.x * centerX + aRow;
        const bValue = b.x * centerX + bRow;
        const cValue = c.x * centerX + cRow;
        if (aValue < -a.guard || bValue < -b.guard || cValue < -c.guard) continue;
        if (aValue > a.guard && bValue > b.guard && cValue > c.guard) {
          covered = false;
          if (!occluder) return false;
          depth[index] = Math.min(depth[index]!, farthest);
          continue;
        }

        // A coarse tile can have samples covered by different nearer triangles.
        // Inspect its four pixel centers only when the coarse proof fails.
        const samples = this._sampleDepth;
        const first = index * 4;
        for (let sample = 0; sample < 4; sample++) {
          const at = first + sample;
          if (samples[at]! < threshold) continue;
          const dx = (sample & 1) - 0.5, dy = (sample >> 1) - 0.5;
          const as = aValue + a.x * dx + a.y * dy;
          const bs = bValue + b.x * dx + b.y * dy;
          const cs = cValue + c.x * dx + c.y * dy;
          if (as < -a.sampleGuard || bs < -b.sampleGuard || cs < -c.sampleGuard) continue;
          covered = false;
          if (!occluder) return false;
          if (as > a.sampleGuard && bs > b.sampleGuard && cs > c.sampleGuard) {
            samples[at] = Math.min(samples[at]!, farthest);
          }
        }
        if (occluder) depth[index] = Math.min(depth[index]!, Math.max(
          samples[first]!, samples[first + 1]!, samples[first + 2]!, samples[first + 3]!,
        ));
      }
    }
    return covered;
  }
}

function setEdge(edge: Edge, ax: number, ay: number, bx: number, by: number, winding: number, guard: number, longest: number): void {
  edge.x = (ay - by) * winding;
  edge.y = (bx - ax) * winding;
  edge.constant = -edge.x * ax - edge.y * ay;
  // Guard the pixel centers in this tile and both perturbed endpoints.
  edge.sampleGuard = guard * (4 * longest + 4 * guard);
  edge.guard = (Math.abs(edge.x) + Math.abs(edge.y)) * (TILE_SIZE / 2 - 0.5) + edge.sampleGuard;
}

function projectVertex(
  out: Float64Array, dest: number, positions: Float32Array, offset: number,
  model: Float32Array, viewProjection: Float32Array, width: number, height: number,
): void {
  const x = positions[offset]!, y = positions[offset + 1]!, z = positions[offset + 2]!;
  // Bound f32 error using the absolute products so cancellation in a translated
  // scene cannot make the guard artificially small.
  for (let row = 0; row < 4; row++) {
    const a = model[row]! * x, b = model[row + 4]! * y, c = model[row + 8]! * z, d = model[row + 12]!;
    out[dest + row] = a + b + c + d;
    out[12 + row] = Math.abs(a) + Math.abs(b) + Math.abs(c) + Math.abs(d);
  }
  const wx = out[dest]!, wy = out[dest + 1]!, wz = out[dest + 2]!, ww = out[dest + 3]!;
  let clipError = 0;
  for (let row = 0; row < 4; row++) {
    const a = viewProjection[row]!, b = viewProjection[row + 4]!, c = viewProjection[row + 8]!, d = viewProjection[row + 12]!;
    out[dest + row] = a * wx + b * wy + c * wz + d * ww;
    clipError = Math.max(clipError, FLOAT_ERROR * (
      Math.abs(a) * out[12]! + Math.abs(b) * out[13]! + Math.abs(c) * out[14]! + Math.abs(d) * out[15]!
    ));
  }
  const w = out[dest + 3]!;
  const ndcX = out[dest]! / w, ndcY = out[dest + 1]! / w, ndcZ = out[dest + 2]! / w;
  const error = clipError * (1 + Math.max(Math.abs(ndcX), Math.abs(ndcY), Math.abs(ndcZ))) / (w - clipError);
  out[dest] = (ndcX + 1) * width / 2;
  out[dest + 1] = (1 - ndcY) * height / 2;
  out[dest + 2] = ndcZ;
  // Clipped, numerically unstable and very distant vertices use the normal path.
  const worldMagnitude = Math.max(out[12]!, out[13]!, out[14]!, out[15]!);
  out[dest + 3] = worldMagnitude < 1e30 && clipError < 1e24 && w > clipError && error < DEPTH_GUARD / 2
    && Math.abs(ndcX) < 1 - error && Math.abs(ndcY) < 1 - error
    ? error * Math.max(width, height) : Infinity;
}
