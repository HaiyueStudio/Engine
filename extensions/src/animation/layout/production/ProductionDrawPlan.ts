import {createRect2D, Geometry2D} from '@haiyue/engine/geometry';
import {AnimationVisual2D, type AnimationVisualGradient, type AnimationVisual2DTextureAlphaMode} from '../../AnimationVisual2D.js';
import {tessellateAnimationPath, tessellateVectorStrokePath} from '../../AnimationPathTessellator.js';
import type {RuntimeColor, RuntimePaintSource} from '../../text/parameterized/runtime-types.js';
import type {ProductionGlyph} from '../../text/production/types.js';
import type {ProductionLayoutFrame, ProductionLayoutNode} from './types.js';
import {multiplyLayoutTransforms,identityLayoutTransform} from './ProductionLayoutGeometry.js';

type Rect = readonly [number, number, number, number];
type Affine = readonly [number, number, number, number, number, number];
export interface ProductionDrawTexture {
  readonly texture: GPUTexture; readonly alphaMode: AnimationVisual2DTextureAlphaMode;
  readonly sampling?: NonNullable<AnimationVisual2D['textureSampling']>;
  /** One acquired lease, never a borrowed resource's destroy method. */
  release(): void;
}
export interface ProductionDrawTextures {
  readonly revision?: number;
  prepare?(frames: readonly ProductionLayoutFrame[]): void;
  image(node: ProductionLayoutNode): ProductionDrawTexture;
  bitmap(source: Extract<ProductionGlyph['paint'], {kind: 'bitmap'}>['source']): ProductionDrawTexture;
}
export interface ProductionDrawPlan {
  readonly viewport: readonly [number, number]; readonly dpr: number;
  readonly maskSources?: readonly string[];
  readonly visuals: readonly AnimationVisual2D[]; readonly geometryBytes: number;
  assertReady(): void;
  release(): void;
}
export class ProductionDrawError extends Error {
  override readonly name = 'ProductionDrawError';
  constructor(readonly code: string, readonly path: string, message: string) {super(`${message} (${path})`);}
}
const fail = (code: string, path: string, message: string): never => {throw new ProductionDrawError(code, path, message);};
const white: RuntimeColor = [1, 1, 1, 1], zero: Rect = [0, 0, 0, 0];

/** Lowers real prepared geometry/paint into the existing animation renderer, without another shader or sampler. */
export function compileProductionDrawPlan(frames: readonly ProductionLayoutFrame[], textures?: ProductionDrawTextures, maxGeometryBytes = 512 * 1024 * 1024): ProductionDrawPlan {
  if (!frames.length) fail('E_HYA_RUNTIME_DRAW', '$.layouts', 'a layout draw plan needs its viewport');
  if (!Number.isSafeInteger(maxGeometryBytes) || maxGeometryBytes < 0) fail('E_HYA_RUNTIME_LIMIT', '$.draw.geometryBytes', 'invalid geometry-byte ceiling');
  const viewport = frames[0]!.viewport, dpr = frames[0]!.dpr;
  for (const frame of frames) if (frame.viewport.some((value, index) => value !== viewport[index]) || frame.dpr !== dpr)
    fail('E_HYA_RUNTIME_DRAW', '$.layouts', 'composed layouts must share one viewport and DPR');
  const visuals: AnimationVisual2D[] = [], leases: ProductionDrawTexture[] = [], clipIds = new Map<string, string>();
  const imageLeases = new Map<string, ProductionDrawTexture>(), bitmapLeases = new Map<unknown, Map<number, ProductionDrawTexture>>();
  let geometryBytes = 0, order = 0, released = false;
  const release = (): void => {
    if (released) return; released = true; const errors: unknown[] = [];
    for (const lease of leases) try {lease.release();} catch (error) {errors.push(error);} leases.length = 0;
    if (errors.length) throw new AggregateError(errors, 'Prepared draw texture leases failed to release');
  };
  const lease = (value: ProductionDrawTexture): ProductionDrawTexture => {
    // Register ownership before validating so an invalid host return is unwound too.
    if (value && typeof value.release === 'function') leases.push(value);
    if (!value || typeof value.release !== 'function' || typeof value.texture?.createView !== 'function'
      || !['straight', 'premultiplied'].includes(value.alphaMode)) fail('E_HYA_RUNTIME_HOST_PORT', '$.draw.textures', 'a ready texture and acquired release lease are required');
    return value;
  };
  const add = (geometry: Geometry2D, id: string, color: RuntimeColor, transform: Affine, clip?: string, texture?: ProductionDrawTexture, gradient?: AnimationVisualGradient, sourceOnly = false, uv: Rect = [0, 0, 1, 1]): void => {
    // The existing renderer uploads xy+uv floats and the original typed indices.
    geometryBytes += geometry.positions.byteLength * 2 + (geometry.indices?.byteLength ?? 0);
    if (!Number.isSafeInteger(geometryBytes) || geometryBytes > maxGeometryBytes) fail('E_HYA_RUNTIME_LIMIT', '$.draw.geometryBytes', 'draw geometry exceeds the private staging ceiling');
    visuals.push(new AnimationVisual2D({geometry, color, instanceId: 0, nodeId: id, order: order++, localTransform: transform,
      sourceOnly, ...(clip ? {composite: {kind: 'mask', source: clip, mode: 'alpha'}} : {}),
      ...(texture ? {textureHandle: {key: id, get value() {return texture.texture;}, release() {/* The plan owns the acquired lease. */}}, textureAlphaMode: texture.alphaMode, ...(texture.sampling ? {textureSampling: texture.sampling} : {}), requiresTexture: true, uvs: screenUvs(geometry)} : {}),
      ...(gradient ? {gradient} : {}), uvRect: uv}));
  };
  const clipFor = (node: ProductionLayoutNode): string | undefined => {
    let prior: string | undefined;
    for (const shape of node.clipShapes ?? (node.clip ? [{rect: node.clip, radii: zero}] : [])) {
      const key = JSON.stringify([prior ?? null, shape.rect, shape.radii, node.transform ?? identityLayoutTransform]);
      let id = clipIds.get(key);
      if (!id) {
        id = `clip:${clipIds.size}`; clipIds.set(key, id);
        if (shape.rect[2] > 0 && shape.rect[3] > 0) add(roundedGeometry(shape.rect[2], shape.rect[3], shape.radii, dpr), id, white, nodeTransform(node,translate(shape.rect)), prior, undefined, undefined, true);
        else add(rectangle([0, 0, 1, 1]), id, [0, 0, 0, 0], nodeTransform(node,translate(shape.rect)), undefined, undefined, undefined, true);
      }
      prior = id;
    }
    return prior;
  };
  try {
    for (const frame of frames) for (const node of frame.nodes) {
      if (node.opacity === 0 || node.rect[2] === 0 || node.rect[3] === 0) continue;
      const base = JSON.stringify([node.part, node.instance, node.node]), clip = clipFor(node), opacity = node.opacity;
      const box = (suffix: string, rect: Rect, color: RuntimeColor, radii: Rect = zero): void => {
        if (rect[2] > 0 && rect[3] > 0 && color[3] > 0) add(roundedGeometry(rect[2], rect[3], radii, dpr), base + suffix, alpha(color, opacity), nodeTransform(node,translate(rect)), clip);
      };
      if (node.background) box('/background', node.rect, node.background, node.cornerRadius);
      if (node.borderColor && node.borderWidth.some(value => value > 0)) {
        const border = borderGeometry(node.rect[2], node.rect[3], node.cornerRadius, node.borderWidth, dpr);
        if (border) add(border, base + '/border', alpha(node.borderColor, opacity), nodeTransform(node,translate(node.rect)), clip);
      }
      if (node.source) {
        const ready = textures ?? fail('E_HYA_RUNTIME_HOST_PORT', base + '.source', 'image materialization is required before drawing');
        const key = JSON.stringify([node.part, node.instance, node.source]);
        let resource = imageLeases.get(key);
        if (!resource) {resource = lease(ready.image(node)); imageLeases.set(key, resource);}
        for (const [index, patch] of (node.nSlice ?? [{rect: node.rect, uv: [0, 0, 1, 1] as Rect}]).entries()) {
          if (patch.rect[2] <= 0 || patch.rect[3] <= 0) continue;
          add(rectangle([0, 0, patch.rect[2], patch.rect[3]]), base + '/image/' + index, [1, 1, 1, opacity], nodeTransform(node,translate(patch.rect)), clip, resource, undefined, false, patch.uv);
        }
      }
      const control = (kind: 'selection' | 'cursor'): void => {
        for (const [index, value] of (node.text?.controls ?? []).entries()) if (value.kind === kind)
          box('/' + kind + '/' + index, [node.rect[0] + value.rect[0], node.rect[1] + value.rect[1], value.rect[2], value.rect[3]], kind === 'selection' ? [0.2, 0.4, 1, 0.35] : white, [value.radius ?? 0, value.radius ?? 0, value.radius ?? 0, value.radius ?? 0]);
      };
      control('selection');
      for (const [runIndex, run] of (node.text?.runs ?? []).entries()) for (const [glyphIndex, glyph] of run.glyphs.entries()) {
        if (run.style.background) fail('E_HYA_RUNTIME_CAPABILITY', '$.text.style.background', 'run background cells still require the original text geometry bridge');
        if (!glyph.opacity || !glyph.rect[2] || !glyph.rect[3]) continue;
        const id = base + `/glyph/${runIndex}/${glyphIndex}`;
        const matrix = nodeTransform(node,[glyph.transform[0], glyph.transform[1], glyph.transform[2], glyph.transform[3], glyph.transform[4] + node.rect[0], glyph.transform[5] + node.rect[1]]);
        if (glyph.paint.kind === 'bitmap') {
          const ready = textures ?? fail('E_HYA_RUNTIME_HOST_PORT', id, 'bitmap materialization is required before drawing');
          const {source, uv} = glyph.paint, generations = bitmapLeases.get(source.value) ?? new Map<number, ProductionDrawTexture>();
          let resource = generations.get(source.generation);
          if (!resource) {resource = lease(ready.bitmap(source)); generations.set(source.generation, resource); bitmapLeases.set(source.value, generations);}
          add(rectangle([0, 0, 1, 1]), id, [1, 1, 1, opacity * glyph.opacity], matrix, clip, resource, undefined, false, uv);
          continue;
        }
        if (!glyph.paint.commands) continue;
        const path = {type: 'path2d' as const, commands: glyph.paint.commands, values: screenPathValues(glyph.paint.values), fillRule: 'nonzero' as const, fill: white, tolerance: 0.1 / dpr};
        const fillGeometry = tessellateAnimationPath(path), bounds = geometryBounds(fillGeometry), normalizedTransform = composeBasis(matrix, bounds);
        const drawPaint = (geometry: Geometry2D, paint: RuntimePaintSource, paintOpacity: number, suffix: string): void => {
          const normalized = normalizeGeometry(geometry, bounds);
          const color: RuntimeColor = paint.kind === 'solid' ? alpha(paint.color, opacity * glyph.opacity * paintOpacity) : [1, 1, 1, opacity * glyph.opacity * paintOpacity];
          add(normalized, id + suffix, color, normalizedTransform, clip, undefined, gradient(paint));
        };
        for (const [index, fill] of run.style.fills.entries()) drawPaint(fillGeometry, fill.source, fill.opacity ?? 1, '/fill/' + index);
        for (const [index, stroke] of (run.style.strokes ?? []).entries()) drawPaint(tessellateVectorStrokePath({...path, type: 'org.haiyue.vector-stroke@1', color: white, width: stroke.width, lineCap: 'butt', lineJoin: stroke.join ?? 'miter', miterLimit: 10}), stroke.source, stroke.opacity ?? 1, '/stroke/' + index);
      }
      for(const[index,r]of (node.text?.presentation?.composition??[]).entries())box('/composition/'+index,[node.rect[0]+r[0],node.rect[1]+r[1],r[2],r[3]],[0.2,0.4,1,1]);
      control('cursor');
    }
    return Object.freeze({viewport, dpr, visuals: Object.freeze(visuals), geometryBytes, release, assertReady() {
      if (released) fail('E_HYA_RUNTIME_DISPOSED', '$.draw', 'draw plan resources were released');
      for (const resource of leases) if (!resource.texture) fail('E_HYA_RUNTIME_HOST_PORT', '$.draw.textures', 'a required texture is not ready');
    }});
  } catch (error) {
    try {release();} catch (cleanup) {throw new AggregateError([error, cleanup], 'Draw preparation and cleanup failed');} throw error;
  }
}

const translate = (rect: Rect): Affine => [1, 0, 0, 1, rect[0], rect[1]];
const nodeTransform = (node:ProductionLayoutNode,matrix:Affine):Affine => multiplyLayoutTransforms(node.transform ?? identityLayoutTransform,matrix);
const rectangle = (rect: Rect): Geometry2D => createRect2D({x: rect[0] + rect[2] / 2, y: rect[1] + rect[3] / 2, width: rect[2], height: rect[3]});
const alpha = (color: RuntimeColor, opacity: number): RuntimeColor => [color[0], color[1], color[2], color[3] * opacity];
function gradient(paint: RuntimePaintSource): AnimationVisualGradient | undefined {
  if (paint.kind === 'solid') return undefined;
  if (paint.stops.length > 8) fail('E_HYA_RUNTIME_CAPABILITY', '$.text.paint.stops', 'full gradient-stop drawing is not yet connected; do not truncate the admitted paint');
  return {kind: paint.kind === 'linear-gradient' ? 'linear' : 'radial', opacity: 1,
    start: paint.kind === 'linear-gradient' ? [...paint.start] : [...paint.center],
    end: paint.kind === 'linear-gradient' ? [...paint.end] : [paint.center[0] + paint.radius, paint.center[1]],
    stops: Float32Array.from(paint.stops.flatMap(stop => [stop.offset, ...stop.color]))};
}
function geometryBounds(geometry: Geometry2D): Rect {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let index = 0; index < geometry.positions.length; index += 2) {left = Math.min(left, geometry.positions[index]!); right = Math.max(right, geometry.positions[index]!); top = Math.min(top, geometry.positions[index + 1]!); bottom = Math.max(bottom, geometry.positions[index + 1]!);}
  return [left, top, Math.max(right - left, 1e-12), Math.max(bottom - top, 1e-12)];
}
function screenUvs(geometry: Geometry2D): Float32Array {
  const bounds = geometryBounds(geometry), values = new Float32Array(geometry.positions.length);
  for (let index = 0; index < values.length; index += 2) {values[index] = (geometry.positions[index]! - bounds[0]) / bounds[2]; values[index + 1] = (geometry.positions[index + 1]! - bounds[1]) / bounds[3];}
  return values;
}
function normalizeGeometry(geometry: Geometry2D, bounds: Rect): Geometry2D {
  const positions = new Float32Array(geometry.positions.length);
  for (let index = 0; index < positions.length; index += 2) {positions[index] = (geometry.positions[index]! - bounds[0]) / bounds[2]; positions[index + 1] = (geometry.positions[index + 1]! - bounds[1]) / bounds[3];}
  // Geometry2D itself validates finite positions/indices and belongs to the public Engine core.
  return new Geometry2D(positions, geometry.indices ?? undefined);
}
function composeBasis(matrix: Affine, bounds: Rect): Affine {
  const [a, b, c, d, x, y] = matrix;
  return [a * bounds[2], b * bounds[2], c * bounds[3], d * bounds[3], a * bounds[0] + c * bounds[1] + x, b * bounds[0] + d * bounds[1] + y];
}
interface RoundedPath {commands: string; values: number[];}
/** Original animation paths decode Y-up; production font/layout geometry is Y-down. */
function screenPathValues(values: readonly number[]): Float32Array {return Float32Array.from(values, (value, index) => index % 2 ? -value : value);}
/** Exact cubic quarter-circle convention, flattened by the original path tessellator. */
function roundedPath(width: number, height: number, radiiX: Rect, radiiY: Rect = radiiX, x = 0, y = 0): RoundedPath {
  const [tl, tr, br, bl] = radiiX, [tyl, tyr, byr, byl] = radiiY, k = 0.5522847498307936;
  return {commands: 'MLCLCLCLCZ', values: [x + tl, y, x + width - tr, y,
    x + width - tr + tr * k, y, x + width, y + tyr - tyr * k, x + width, y + tyr,
    x + width, y + height - byr, x + width, y + height - byr + byr * k, x + width - br + br * k, y + height, x + width - br, y + height,
    x + bl, y + height, x + bl - bl * k, y + height, x, y + height - byl + byl * k, x, y + height - byl,
    x, y + tyl, x, y + tyl - tyl * k, x + tl - tl * k, y, x + tl, y]};
}
function clampedRadii(width: number, height: number, radii: Rect): Rect {return radii.map(value => Math.max(0, Math.min(value, width / 2, height / 2))) as unknown as Rect;}
function roundedGeometry(width: number, height: number, radii: Rect, dpr: number): Geometry2D {
  if (radii.every(value => value === 0)) return rectangle([0, 0, width, height]);
  const path = roundedPath(width, height, clampedRadii(width, height, radii));
  return tessellateAnimationPath({type: 'path2d', ...path, values: screenPathValues(path.values), fill: white, tolerance: 0.1 / dpr});
}
function borderGeometry(width: number, height: number, radii: Rect, widths: Rect, dpr: number): Geometry2D | undefined {
  const [left, top, right, bottom] = widths, r = clampedRadii(width, height, radii), outer = roundedPath(width, height, r);
  const innerWidth = width - left - right, innerHeight = height - top - bottom;
  if (innerWidth > 0 && innerHeight > 0) {
    const rx = [r[0] - left, r[1] - right, r[2] - right, r[3] - left].map(value => Math.max(0, Math.min(innerWidth / 2, value))) as unknown as Rect;
    const ry = [r[0] - top, r[1] - top, r[2] - bottom, r[3] - bottom].map(value => Math.max(0, Math.min(innerHeight / 2, value))) as unknown as Rect;
    const inner = roundedPath(innerWidth, innerHeight, rx, ry, left, top); outer.commands += inner.commands; outer.values.push(...inner.values);
  }
  return tessellateAnimationPath({type: 'path2d', ...outer, values: screenPathValues(outer.values), fillRule: 'evenodd', fill: white, tolerance: 0.1 / dpr});
}
