import type { RuntimeBlendMode, RuntimeColor, RuntimeContour, RuntimeDrawOperation, RuntimeDrawPlan, RuntimeGeometryResult, RuntimePaintSource, RuntimePoint } from './runtime-types.js';

export interface CpuImageData { readonly width: number; readonly height: number; readonly pixels: Uint8Array | Uint8ClampedArray | Float32Array; }
export interface VectorCpuRenderOptions { readonly samples?: 1 | 4; readonly maxPixels?: number; readonly resolveImage?: (resource: string) => CpuImageData | undefined; }
export interface VectorCpuImage { readonly width: number; readonly height: number; readonly pixels: Float32Array; }

export function renderVectorCpu(plan: RuntimeDrawPlan, options: VectorCpuRenderOptions = {}): VectorCpuImage {
  const width = Math.ceil(plan.width), height = Math.ceil(plan.height);
  const pixels = width * height;
  if (pixels > (options.maxPixels ?? 268_435_456)) throw new Error('E_VECTOR_CPU_PIXEL_LIMIT');
  const output = new Float32Array(pixels * 4);
  const sampleOffsets: readonly RuntimePoint[] = options.samples === 4 ? [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] : [[0.5, 0.5]];
  for (const operation of plan.operations) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let source: RuntimeColor = [0, 0, 0, 0];
      for (const offset of sampleOffsets) source = addColor(source, shadeOperation(plan, operation, x + offset[0], y + offset[1], options.resolveImage));
      source = scaleColor(source, 1 / sampleOffsets.length);
      if (source[3] <= 0) continue;
      const pixelIndex = (y * width + x) * 4;
      const destination: RuntimeColor = [output[pixelIndex]!, output[pixelIndex + 1]!, output[pixelIndex + 2]!, output[pixelIndex + 3]!];
      const mode = operation.effectGroups.at(-1)?.blendMode ?? operation.paint.blendMode ?? 'normal';
      const blended = composite(source, destination, mode);
      output.set(blended, pixelIndex);
    }
  }
  return Object.freeze({ width, height, pixels: output });
}

function shadeOperation(plan: RuntimeDrawPlan, operation: RuntimeDrawOperation, x: number, y: number, resolveImage?: VectorCpuRenderOptions['resolveImage']): RuntimeColor {
  const inverse = invert(operation.transform);
  if (!inverse) return [0, 0, 0, 0];
  let point = transform(inverse, [x, y]);
  let feather = 0;
  let opacity = operation.opacity;
  let matrix: readonly number[] | undefined;
  let shadow: { x: number; y: number; blur: number; color: RuntimeColor } | undefined;
  for (const group of operation.effectGroups) for (const effect of group.effects) {
    if (effect.kind === 'opacity') opacity *= effect.value;
    else if (effect.kind === 'color-matrix') matrix = effect.values;
    else if (effect.kind === 'feather') { feather = Math.max(feather, effect.radiusX, effect.radiusY); point = [point[0] - (effect.offsetX ?? 0), point[1] - (effect.offsetY ?? 0)]; }
    else if (effect.kind === 'blur') feather = Math.max(feather, effect.radiusX, effect.radiusY);
    else if (effect.kind === 'drop-shadow') shadow = { x: effect.offsetX, y: effect.offsetY, blur: effect.blur, color: effect.color };
  }
  let coverage = paintCoverage(operation.geometry, operation.paint.kind, operation.paint.kind === 'stroke' ? operation.paint.width : 0, point, operation.paint.kind === 'fill' ? operation.paint.fillRule : undefined, operation.paint.kind === 'stroke' ? operation.paint.dash : undefined, operation.paint.kind === 'stroke' ? operation.paint.dashOffset ?? 0 : 0, operation.paint.kind === 'stroke' ? operation.paint.trim : undefined);
  if (feather > 0 && coverage > 0) coverage *= Math.min(1, boundaryDistance(operation.geometry.contours, point) / Math.max(0.0001, feather));
  coverage *= clipCoverage(plan, operation.clips, x, y, new Set());
  let color = sampleOperationColor(plan, operation, point, resolveImage);
  color = [color[0], color[1], color[2], color[3] * opacity * coverage];
  if (matrix) color = applyColorMatrix(color, matrix);
  if (shadow) {
    const shadowPoint: RuntimePoint = [point[0] - shadow.x, point[1] - shadow.y];
    let shadowCoverage = paintCoverage(operation.geometry, operation.paint.kind, operation.paint.kind === 'stroke' ? operation.paint.width : 0, shadowPoint);
    if (shadow.blur > 0 && shadowCoverage > 0) shadowCoverage *= Math.min(1, boundaryDistance(operation.geometry.contours, shadowPoint) / shadow.blur);
    color = composite(color, [shadow.color[0], shadow.color[1], shadow.color[2], shadow.color[3] * opacity * shadowCoverage], 'normal');
  }
  return clampColor(color);
}

function sampleOperationColor(plan: RuntimeDrawPlan, operation: RuntimeDrawOperation, point: RuntimePoint, resolveImage?: VectorCpuRenderOptions['resolveImage']): RuntimeColor {
  const imageGeometry = operation.geometry.image;
  const resourceId = imageGeometry?.kind === 'image' ? imageGeometry.resource : imageGeometry?.source.kind === 'image' ? imageGeometry.source.resource : undefined;
  if (imageGeometry && resourceId && resolveImage) {
    const image = resolveImage(resourceId);
    if (image) {
      const metadata = plan.resources.get(resourceId);
      const coordinates = imageGeometry.kind === 'image' ? imageCoordinates(imageGeometry, image, point) : nSliceCoordinates(imageGeometry, point);
      if (!coordinates) return [0, 0, 0, 0];
      const sampled = sampleImage(image, coordinates[0], coordinates[1], metadata?.filter ?? 'linear', metadata?.wrapX ?? 'clamp', metadata?.wrapY ?? 'clamp');
      const tint = samplePaint(operation.paint.source, point);
      return [sampled[0] * tint[0], sampled[1] * tint[1], sampled[2] * tint[2], sampled[3] * tint[3]];
    }
  }
  return samplePaint(operation.paint.source, point);
}

function clipCoverage(plan: RuntimeDrawPlan, ids: readonly string[], x: number, y: number, active: Set<string>): number {
  let result = 1;
  for (const id of ids) {
    const clip = plan.clips.get(id);
    if (!clip || active.has(id)) return 0;
    active.add(id);
    const geometries = plan.nodeGeometry.get(clip.source) ?? [];
    const inverse = invert(plan.nodeTransforms.get(clip.source) ?? [1, 0, 0, 1, 0, 0]);
    const point = inverse ? transform(inverse, [x, y]) : [Infinity, Infinity] as const;
    let own = geometries.some(geometry => paintCoverage(geometry, 'fill', 0, point, clip.fillRule) > 0) ? 1 : 0;
    if (clip.inverted) own = 1 - own;
    for (const child of clip.children ?? []) {
      const childValue = clipCoverage(plan, [child], x, y, active);
      own = combineCoverage(own, childValue, plan.clips.get(child)?.operation ?? 'add');
    }
    active.delete(id);
    result *= own;
  }
  return result;
}

function paintCoverage(geometry: RuntimeGeometryResult, kind: 'fill' | 'stroke', width: number, point: RuntimePoint, fillRule: 'nonzero' | 'evenodd' = 'nonzero', dash?: readonly number[], dashOffset = 0, trim?: { readonly start: number; readonly end: number; readonly offset?: number }): number {
  if (kind === 'fill') return insideContours(geometry.contours, point, fillRule) ? 1 : 0;
  const half = width / 2;
  for (const contour of geometry.contours) {
    const metrics = contourMetrics(contour);
    for (let index = 0; index < metrics.segments.length; index++) {
      const segment = metrics.segments[index]!;
      const nearest = nearestOnSegment(point, segment.a, segment.b);
      if (nearest.distance > half) continue;
      const progress = (segment.start + nearest.t * segment.length) / Math.max(0.0001, metrics.length);
      if (trim && !inTrim(progress, trim.start, trim.end, trim.offset ?? 0)) continue;
      if (dash && dash.length > 0 && !inDash(segment.start + nearest.t * segment.length + dashOffset, dash)) continue;
      return 1;
    }
  }
  return 0;
}

function insideContours(contours: readonly RuntimeContour[], point: RuntimePoint, rule: 'nonzero' | 'evenodd'): boolean {
  let winding = 0, crossings = 0;
  for (const contour of contours) {
    if (!contour.closed || contour.points.length < 3) continue;
    let local = 0;
    for (let index = 0; index < contour.points.length; index++) {
      const a = contour.points[index]!, b = contour.points[(index + 1) % contour.points.length]!;
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) crossings++;
      if (a[1] <= point[1] && b[1] > point[1] && cross(a, b, point) > 0) local++;
      else if (a[1] > point[1] && b[1] <= point[1] && cross(a, b, point) < 0) local--;
    }
    winding += contour.isHole ? -Math.abs(local) : local;
  }
  return rule === 'evenodd' ? crossings % 2 === 1 : winding !== 0;
}

function samplePaint(source: RuntimePaintSource, point: RuntimePoint): RuntimeColor {
  if (source.kind === 'solid') return source.color;
  let amount: number;
  if (source.kind === 'linear-gradient') { const dx = source.end[0] - source.start[0], dy = source.end[1] - source.start[1]; amount = ((point[0] - source.start[0]) * dx + (point[1] - source.start[1]) * dy) / Math.max(0.000001, dx * dx + dy * dy); }
  else amount = Math.hypot(point[0] - (source.focal?.[0] ?? source.center[0]), point[1] - (source.focal?.[1] ?? source.center[1])) / source.radius;
  const t = clamp01(amount);
  let left = source.stops[0]!, right = source.stops.at(-1)!;
  for (let index = 1; index < source.stops.length; index++) if (source.stops[index]!.offset >= t) { left = source.stops[index - 1]!; right = source.stops[index]!; break; }
  const mix = left === right ? 0 : (t - left.offset) / Math.max(0.000001, right.offset - left.offset);
  return lerpColor(left.color, right.color, mix);
}

function composite(source: RuntimeColor, destination: RuntimeColor, mode: RuntimeBlendMode): RuntimeColor {
  const sa = clamp01(source[3]), da = clamp01(destination[3]);
  const blend = blendRgb(source, destination, mode);
  const alpha = sa + da * (1 - sa);
  if (mode === 'subtract') return clampColor([destination[0] - source[0] * sa, destination[1] - source[1] * sa, destination[2] - source[2] * sa, alpha]);
  const denominator = Math.max(alpha, 0.000001);
  const channel = (index: 0 | 1 | 2): number => ((1 - da) * source[index] * sa + (1 - sa) * destination[index] * da + sa * da * blend[index]) / denominator;
  const color: RuntimeColor = [channel(0), channel(1), channel(2), alpha];
  return clampColor(color);
}

function blendRgb(s: RuntimeColor, d: RuntimeColor, mode: RuntimeBlendMode): RuntimeColor {
  if (mode === 'hue' || mode === 'saturation' || mode === 'color' || mode === 'luminosity') { const sh = rgbToHsl(s), dh = rgbToHsl(d); const hsl: readonly [number, number, number] = mode === 'hue' ? [sh[0], dh[1], dh[2]] : mode === 'saturation' ? [dh[0], sh[1], dh[2]] : mode === 'color' ? [sh[0], sh[1], dh[2]] : [dh[0], dh[1], sh[2]]; const rgb = hslToRgb(hsl); return [rgb[0], rgb[1], rgb[2], 1]; }
  const channel = (a: number, b: number): number => mode === 'multiply' ? a * b : mode === 'screen' ? a + b - a * b : mode === 'overlay' ? (b <= 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b)) : mode === 'darken' ? Math.min(a, b) : mode === 'lighten' ? Math.max(a, b) : mode === 'color-dodge' ? (a >= 1 ? 1 : Math.min(1, b / (1 - a))) : mode === 'color-burn' ? (a <= 0 ? 0 : 1 - Math.min(1, (1 - b) / a)) : mode === 'hard-light' ? (a <= 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b)) : mode === 'soft-light' ? ((1 - 2 * a) * b * b + 2 * a * b) : mode === 'difference' ? Math.abs(b - a) : mode === 'exclusion' ? a + b - 2 * a * b : mode === 'add' ? Math.min(1, a + b) : a;
  return [channel(s[0], d[0]), channel(s[1], d[1]), channel(s[2], d[2]), 1];
}

function applyColorMatrix(color: RuntimeColor, matrix: readonly number[]): RuntimeColor { return clampColor([color[0] * matrix[0]! + color[1] * matrix[1]! + color[2] * matrix[2]! + color[3] * matrix[3]! + matrix[4]!, color[0] * matrix[5]! + color[1] * matrix[6]! + color[2] * matrix[7]! + color[3] * matrix[8]! + matrix[9]!, color[0] * matrix[10]! + color[1] * matrix[11]! + color[2] * matrix[12]! + color[3] * matrix[13]! + matrix[14]!, color[0] * matrix[15]! + color[1] * matrix[16]! + color[2] * matrix[17]! + color[3] * matrix[18]! + matrix[19]!]); }
function imageCoordinates(geometry: Extract<NonNullable<RuntimeGeometryResult['image']>, { kind: 'image' }>, image: CpuImageData, point: RuntimePoint): RuntimePoint | null {
  const crop = geometry.crop ?? [0, 0, image.width, image.height];
  if (geometry.mesh) {
    for (let index = 0; index < geometry.mesh.indices.length; index += 3) {
      const ia = geometry.mesh.indices[index]!, ib = geometry.mesh.indices[index + 1]!, ic = geometry.mesh.indices[index + 2]!;
      const weights = barycentric(point, [geometry.mesh.positions[ia * 2]!, geometry.mesh.positions[ia * 2 + 1]!], [geometry.mesh.positions[ib * 2]!, geometry.mesh.positions[ib * 2 + 1]!], [geometry.mesh.positions[ic * 2]!, geometry.mesh.positions[ic * 2 + 1]!]);
      if (!weights) continue;
      const u = geometry.mesh.uvs[ia * 2]! * weights[0] + geometry.mesh.uvs[ib * 2]! * weights[1] + geometry.mesh.uvs[ic * 2]! * weights[2];
      const v = geometry.mesh.uvs[ia * 2 + 1]! * weights[0] + geometry.mesh.uvs[ib * 2 + 1]! * weights[1] + geometry.mesh.uvs[ic * 2 + 1]! * weights[2];
      return [crop[0] + u * crop[2], crop[1] + v * crop[3]];
    }
    return null;
  }
  const fit = geometry.fit ?? 'fill', alignment = geometry.alignment ?? [0, 0];
  const contain = Math.min(geometry.width / crop[2], geometry.height / crop[3]);
  const scale = fit === 'fill' ? null : fit === 'cover' ? Math.max(geometry.width / crop[2], geometry.height / crop[3]) : fit === 'none' ? 1 : fit === 'scale-down' ? Math.min(1, contain) : contain;
  if (scale === null) return [crop[0] + (point[0] - geometry.x) / Math.max(0.0001, geometry.width) * crop[2], crop[1] + (point[1] - geometry.y) / Math.max(0.0001, geometry.height) * crop[3]];
  const renderedWidth = crop[2] * scale, renderedHeight = crop[3] * scale;
  const left = geometry.x + (geometry.width - renderedWidth) * (alignment[0] + 1) / 2, top = geometry.y + (geometry.height - renderedHeight) * (alignment[1] + 1) / 2;
  if (point[0] < left || point[0] > left + renderedWidth || point[1] < top || point[1] > top + renderedHeight) return null;
  return [crop[0] + (point[0] - left) / scale, crop[1] + (point[1] - top) / scale];
}
function nSliceCoordinates(geometry: Extract<NonNullable<RuntimeGeometryResult['image']>, { kind: 'n-slice' }>, point: RuntimePoint): RuntimePoint | null { if (point[0] < geometry.x || point[0] > geometry.x + geometry.width || point[1] < geometry.y || point[1] > geometry.y + geometry.height) return null; return [mapNSliceAxis(point[0] - geometry.x, geometry.width, geometry.sourceSize[0], geometry.xCuts), mapNSliceAxis(point[1] - geometry.y, geometry.height, geometry.sourceSize[1], geometry.yCuts)]; }
function mapNSliceAxis(position: number, destinationSize: number, sourceSize: number, cuts: readonly number[]): number { const boundaries = [0, ...cuts, sourceSize]; let fixed = 0, stretch = 0; for (let index = 0; index < boundaries.length - 1; index++) (index % 2 === 0 ? fixed += boundaries[index + 1]! - boundaries[index]! : stretch += boundaries[index + 1]! - boundaries[index]!); const fixedScale = destinationSize < fixed && fixed > 0 ? destinationSize / fixed : 1, stretchScale = stretch > 0 ? Math.max(0, destinationSize - fixed * fixedScale) / stretch : 0; let destinationCursor = 0; for (let index = 0; index < boundaries.length - 1; index++) { const sourceLength = boundaries[index + 1]! - boundaries[index]!, scale = index % 2 === 0 ? fixedScale : stretchScale, destinationLength = sourceLength * scale; if (position <= destinationCursor + destinationLength || index === boundaries.length - 2) return boundaries[index]! + (scale > 0 ? (position - destinationCursor) / scale : 0); destinationCursor += destinationLength; } return sourceSize; }
function sampleImage(image: CpuImageData, x: number, y: number, filter: 'nearest' | 'linear', wrapX: string, wrapY: string): RuntimeColor { const wrappedX = wrapCoordinate(x, image.width, wrapX), wrappedY = wrapCoordinate(y, image.height, wrapY); if (filter === 'nearest') return readImage(image, Math.floor(wrappedX), Math.floor(wrappedY)); const x0 = Math.floor(wrappedX - 0.5), y0 = Math.floor(wrappedY - 0.5), tx = wrappedX - 0.5 - x0, ty = wrappedY - 0.5 - y0; return lerpColor(lerpColor(readImage(image, wrappedIndex(x0, image.width, wrapX), wrappedIndex(y0, image.height, wrapY)), readImage(image, wrappedIndex(x0 + 1, image.width, wrapX), wrappedIndex(y0, image.height, wrapY)), tx), lerpColor(readImage(image, wrappedIndex(x0, image.width, wrapX), wrappedIndex(y0 + 1, image.height, wrapY)), readImage(image, wrappedIndex(x0 + 1, image.width, wrapX), wrappedIndex(y0 + 1, image.height, wrapY)), tx), ty); }
function readImage(image: CpuImageData, x: number, y: number): RuntimeColor { const ix = Math.max(0, Math.min(image.width - 1, x)), iy = Math.max(0, Math.min(image.height - 1, y)), index = (iy * image.width + ix) * 4, scale = image.pixels instanceof Float32Array ? 1 : 1 / 255; return [image.pixels[index]! * scale, image.pixels[index + 1]! * scale, image.pixels[index + 2]! * scale, image.pixels[index + 3]! * scale]; }
function wrapCoordinate(value: number, size: number, mode: string): number { if (mode === 'repeat') return ((value % size) + size) % size; if (mode === 'mirror-repeat') { const period = size * 2, repeated = ((value % period) + period) % period; return repeated < size ? repeated : period - repeated - Number.EPSILON; } return Math.max(0, Math.min(size - Number.EPSILON, value)); }
function wrappedIndex(value: number, size: number, mode: string): number { return Math.floor(wrapCoordinate(value, size, mode)); }
function barycentric(point: RuntimePoint, a: RuntimePoint, b: RuntimePoint, c: RuntimePoint): readonly [number, number, number] | null { const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]); if (Math.abs(denominator) < 1e-12) return null; const u = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator, v = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator, w = 1 - u - v; return u >= -1e-6 && v >= -1e-6 && w >= -1e-6 ? [u, v, w] : null; }
function combineCoverage(a: number, b: number, operation: 'add' | 'subtract' | 'intersect' | 'difference'): number { return operation === 'add' ? Math.max(a, b) : operation === 'subtract' ? Math.max(0, a - b) : operation === 'intersect' ? Math.min(a, b) : Math.abs(a - b); }
function boundaryDistance(contours: readonly RuntimeContour[], point: RuntimePoint): number { let result = Infinity; for (const contour of contours) for (const segment of contourMetrics(contour).segments) result = Math.min(result, nearestOnSegment(point, segment.a, segment.b).distance); return result; }
function contourMetrics(contour: RuntimeContour): { length: number; segments: Array<{ a: RuntimePoint; b: RuntimePoint; start: number; length: number }> } { const segments: Array<{ a: RuntimePoint; b: RuntimePoint; start: number; length: number }> = []; let total = 0; const count = contour.closed ? contour.points.length : contour.points.length - 1; for (let index = 0; index < count; index++) { const a = contour.points[index]!, b = contour.points[(index + 1) % contour.points.length]!, length = Math.hypot(b[0] - a[0], b[1] - a[1]); segments.push({ a, b, start: total, length }); total += length; } return { length: total, segments }; }
function nearestOnSegment(p: RuntimePoint, a: RuntimePoint, b: RuntimePoint): { distance: number; t: number } { const dx = b[0] - a[0], dy = b[1] - a[1], denominator = dx * dx + dy * dy, t = denominator === 0 ? 0 : clamp01(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / denominator); return { t, distance: Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t)) }; }
function inTrim(progress: number, start: number, end: number, offset: number): boolean { const value = ((progress - offset) % 1 + 1) % 1; return start <= end ? value >= start && value <= end : value >= start || value <= end; }
function inDash(distance: number, dash: readonly number[]): boolean { const period = dash.reduce((sum, value) => sum + value, 0); let value = ((distance % period) + period) % period; for (let index = 0; index < dash.length; index++) { if (value <= dash[index]!) return index % 2 === 0; value -= dash[index]!; } return true; }
function transform(matrix: readonly [number, number, number, number, number, number], point: RuntimePoint): RuntimePoint { return [matrix[0] * point[0] + matrix[2] * point[1] + matrix[4], matrix[1] * point[0] + matrix[3] * point[1] + matrix[5]]; }
function invert(matrix: readonly [number, number, number, number, number, number]): readonly [number, number, number, number, number, number] | null { const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2]; if (Math.abs(determinant) < 1e-12) return null; return [matrix[3] / determinant, -matrix[1] / determinant, -matrix[2] / determinant, matrix[0] / determinant, (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / determinant, (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / determinant]; }
function cross(a: RuntimePoint, b: RuntimePoint, p: RuntimePoint): number { return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); }
function addColor(a: RuntimeColor, b: RuntimeColor): RuntimeColor { return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]; }
function scaleColor(value: RuntimeColor, scale: number): RuntimeColor { return [value[0] * scale, value[1] * scale, value[2] * scale, value[3] * scale]; }
function lerpColor(a: RuntimeColor, b: RuntimeColor, t: number): RuntimeColor { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]; }
function clampColor(value: RuntimeColor): RuntimeColor { return [clamp01(value[0]), clamp01(value[1]), clamp01(value[2]), clamp01(value[3])]; }
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function rgbToHsl(color: RuntimeColor): readonly [number, number, number] { const max = Math.max(color[0], color[1], color[2]), min = Math.min(color[0], color[1], color[2]), lightness = (max + min) / 2; if (max === min) return [0, 0, lightness]; const delta = max - min, saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min); const hue = max === color[0] ? ((color[1] - color[2]) / delta + (color[1] < color[2] ? 6 : 0)) : max === color[1] ? ((color[2] - color[0]) / delta + 2) : ((color[0] - color[1]) / delta + 4); return [hue / 6, saturation, lightness]; }
function hslToRgb(hsl: readonly [number, number, number]): readonly [number, number, number] { if (hsl[1] === 0) return [hsl[2], hsl[2], hsl[2]]; const q = hsl[2] < 0.5 ? hsl[2] * (1 + hsl[1]) : hsl[2] + hsl[1] - hsl[2] * hsl[1], p = 2 * hsl[2] - q; const hue = (t: number): number => { const n = ((t % 1) + 1) % 1; return n < 1 / 6 ? p + (q - p) * 6 * n : n < 1 / 2 ? q : n < 2 / 3 ? p + (q - p) * (2 / 3 - n) * 6 : p; }; return [hue(hsl[0] + 1 / 3), hue(hsl[0]), hue(hsl[0] - 1 / 3)]; }
