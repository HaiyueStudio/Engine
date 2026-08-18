/// <reference path="../types/external-modules.d.ts" />
import earcut from 'earcut';
import { Geometry2D } from '../geometry/Geometry2D';
import { Material2D } from '../material/Material2D';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { requiredItemAt, requiredNumberAt } from '../math/arrayAccess';

export interface SVG2DMeshData {
  geometry: Geometry2D;
  material: Material2D;
}

export interface SVG2DOptions {
  /** Output height in engine units. Defaults to the SVG viewBox/document height. */
  height?: number;
  /** Center generated geometry around the SVG viewBox center. Defaults to true. */
  center?: boolean;
  /** Curve subdivision count per bezier segment. Defaults to 16. */
  curveSegments?: number;
}

type StrokeLineCap = 'butt' | 'round' | 'square';
type StrokeLineJoin = 'miter' | 'round' | 'bevel';

interface SvgContour {
  points: number[];
  closed: boolean;
}

interface SvgBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SvgStyle {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  strokeLineCap: StrokeLineCap;
  strokeLineJoin: StrokeLineJoin;
  strokeMiterLimit: number;
  opacity: number;
  fillOpacity: number;
  strokeOpacity: number;
}

type Matrix2D = [number, number, number, number, number, number];

interface RawShape {
  contours: SvgContour[];
  style: SvgStyle;
}

interface SVGGeometryBuildData {
  positions: number[];
  indices: number[];
}

interface SVGMeshBatch {
  key: string;
  color: [number, number, number, number];
  positions: number[];
  indices: number[];
}

const IDENTITY_MATRIX: Matrix2D = [1, 0, 0, 1, 0, 0];
const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line']);
const TAU = Math.PI * 2;
const MAX_CURVE_SEGMENTS = 1024;

export function createSVG2DMeshes(svgText: string, options: SVG2DOptions = {}): SVG2DMeshData[] {
  if (typeof DOMParser === 'undefined') {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      'createSVG2DMeshes requires DOMParser.',
      {
        hint: 'Run SVG geometry conversion in a browser-like environment or provide an SVG parsing adapter before calling it.',
        docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
      },
    );
  }
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.tagName.toLowerCase() !== 'svg') {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      'createSVG2DMeshes: input is not an SVG document.',
      {
        hint: 'Pass a valid SVG document string with an <svg> root element.',
        docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
      },
    );
  }
  const curveSegments = normalizeCurveSegments(options.curveSegments ?? 16);
  const rawShapes: RawShape[] = [];
  const meshes: SVG2DMeshData[] = [];
  let activeBatch: SVGMeshBatch | null = null;

  const flushBatch = () => {
    if (!activeBatch || activeBatch.positions.length === 0 || activeBatch.indices.length === 0) {
      activeBatch = null;
      return;
    }
    meshes.push(createMeshFromBatch(activeBatch));
    activeBatch = null;
  };

  const appendToBatch = (key: string, color: [number, number, number, number], data: SVGGeometryBuildData) => {
    if (data.positions.length === 0 || data.indices.length === 0) return;
    if (!activeBatch || activeBatch.key !== key) {
      flushBatch();
      activeBatch = { key, color, positions: [], indices: [] };
    }
    appendGeometryData(activeBatch, data);
  };

  traverse(
    svg,
    {
      fill: '#000000',
      stroke: null,
      strokeWidth: 1,
      strokeLineCap: 'butt',
      strokeLineJoin: 'miter',
      strokeMiterLimit: 4,
      opacity: 1,
      fillOpacity: 1,
      strokeOpacity: 1,
    },
    IDENTITY_MATRIX,
    (element, style, matrix) => {
      const contours = elementToContours(element, curveSegments)
        .map(contour => ({
          points: transformPoints(matrix, contour.points),
          closed: contour.closed,
        }))
        .filter(contour => pointCount(contour.points) >= 2);
      if (contours.length > 0) rawShapes.push({ contours, style });
    },
  );

  const bounds = getSvgBounds(svg, rawShapes);
  const outputHeight = options.height ?? bounds.height;
  if (!Number.isFinite(outputHeight) || outputHeight <= 0) {
    throw svgGeometryError(`SVG output height must be finite and greater than zero; received ${String(outputHeight)}.`);
  }
  const scale = outputHeight / Math.max(0.00001, bounds.height);
  const center = options.center ?? true;
  const originX = center ? bounds.x + bounds.width / 2 : bounds.x;
  const originY = center ? bounds.y + bounds.height / 2 : bounds.y + bounds.height;

  for (const rawShape of rawShapes) {
    const { style } = rawShape;
    const fill = style.fill?.trim().toLowerCase() ?? null;
    const fillColor = fill && fill !== 'none' && style.opacity > 0
      ? parseColor(fill, style.opacity * style.fillOpacity)
      : null;

    for (const contour of rawShape.contours) {
      if (!contour.closed) continue;
      const points = cleanContour(toEnginePoints(contour.points, originX, originY, scale), true);
      if (pointCount(points) < 3) continue;
      if (fillColor) {
        const indices = triangulate(points);
        if (indices.length > 0) {
          appendToBatch(materialKey(fillColor), fillColor, {
            positions: points,
            indices,
          });
        }
      }
    }

    const stroke = style.stroke?.trim().toLowerCase() ?? null;
    const strokeColor = stroke && stroke !== 'none' && style.strokeWidth > 0 && style.opacity > 0
      ? parseColor(stroke, style.opacity * style.strokeOpacity)
      : null;
    if (strokeColor) {
      for (const contour of rawShape.contours) {
        const strokeGeometry = createStrokeGeometry(
          toEnginePoints(contour.points, originX, originY, scale),
          contour.closed,
          style.strokeWidth * scale,
          style.strokeLineCap,
          style.strokeLineJoin,
          style.strokeMiterLimit,
        );
        if (strokeGeometry) appendToBatch(materialKey(strokeColor), strokeColor, strokeGeometry);
      }
    }
  }
  flushBatch();

  return meshes;
}

function traverse(
  element: Element,
  inherited: SvgStyle,
  inheritedMatrix: Matrix2D,
  visit: (element: Element, style: SvgStyle, matrix: Matrix2D) => void,
): void {
  const style = resolveStyle(element, inherited);
  const matrix = multiplyMatrix(inheritedMatrix, parseTransform(element.getAttribute('transform')));
  if (SHAPE_TAGS.has(element.tagName.toLowerCase())) visit(element, style, matrix);
  const children = element.children;
  for (let i = 0; i < children.length; i++) {
    traverse(requiredItemAt(children, i, 'SVG child elements'), style, matrix, visit);
  }
}

function resolveStyle(element: Element, inherited: SvgStyle): SvgStyle {
  const inline = parseStyleAttribute(element.getAttribute('style'));
  const fill = element.getAttribute('fill') ?? inline.fill ?? inherited.fill;
  const stroke = element.getAttribute('stroke') ?? inline.stroke ?? inherited.stroke;
  const strokeWidth = parseNumber(element.getAttribute('stroke-width') ?? inline['stroke-width'], inherited.strokeWidth);
  const strokeLineCap = parseStrokeLineCap(element.getAttribute('stroke-linecap') ?? inline['stroke-linecap'], inherited.strokeLineCap);
  const strokeLineJoin = parseStrokeLineJoin(element.getAttribute('stroke-linejoin') ?? inline['stroke-linejoin'], inherited.strokeLineJoin);
  const strokeMiterLimit = parseNumber(element.getAttribute('stroke-miterlimit') ?? inline['stroke-miterlimit'], inherited.strokeMiterLimit);
  const opacity = parseNumber(element.getAttribute('opacity') ?? inline.opacity, inherited.opacity);
  const fillOpacity = parseNumber(element.getAttribute('fill-opacity') ?? inline['fill-opacity'], inherited.fillOpacity);
  const strokeOpacity = parseNumber(element.getAttribute('stroke-opacity') ?? inline['stroke-opacity'], inherited.strokeOpacity);
  return { fill, stroke, strokeWidth, strokeLineCap, strokeLineJoin, strokeMiterLimit, opacity, fillOpacity, strokeOpacity };
}

function parseStrokeLineCap(value: string | null | undefined, fallback: StrokeLineCap): StrokeLineCap {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'round' || normalized === 'square' || normalized === 'butt' ? normalized : fallback;
}

function parseStrokeLineJoin(value: string | null | undefined, fallback: StrokeLineJoin): StrokeLineJoin {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'round' || normalized === 'bevel' || normalized === 'miter' ? normalized : fallback;
}

function parseStyleAttribute(style: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const item of style.split(';')) {
    const [key, value] = item.split(':');
    if (key && value) out[key.trim()] = value.trim();
  }
  return out;
}

function elementToContours(element: Element, curveSegments: number): SvgContour[] {
  switch (element.tagName.toLowerCase()) {
    case 'path':
      return parsePath(element.getAttribute('d') ?? '', curveSegments);
    case 'rect':
      return rectContour(element);
    case 'circle':
      return ellipseContour(
        parseNumber(element.getAttribute('cx'), 0),
        parseNumber(element.getAttribute('cy'), 0),
        parseNumber(element.getAttribute('r'), 0),
        parseNumber(element.getAttribute('r'), 0),
      );
    case 'ellipse':
      return ellipseContour(
        parseNumber(element.getAttribute('cx'), 0),
        parseNumber(element.getAttribute('cy'), 0),
        parseNumber(element.getAttribute('rx'), 0),
        parseNumber(element.getAttribute('ry'), 0),
      );
    case 'polygon':
      return [{ points: parsePoints(element.getAttribute('points') ?? ''), closed: true }];
    case 'polyline':
      return [{ points: parsePoints(element.getAttribute('points') ?? ''), closed: false }];
    case 'line':
      return lineContour(element);
    default:
      return [];
  }
}

function rectContour(element: Element): SvgContour[] {
  const x = parseNumber(element.getAttribute('x'), 0);
  const y = parseNumber(element.getAttribute('y'), 0);
  const width = parseNumber(element.getAttribute('width'), 0);
  const height = parseNumber(element.getAttribute('height'), 0);
  if (width <= 0 || height <= 0) return [];
  return [{
    closed: true,
    points: [
      x, y,
      x + width, y,
      x + width, y + height,
      x, y + height,
    ],
  }];
}

function ellipseContour(cx: number, cy: number, rx: number, ry: number): SvgContour[] {
  if (rx <= 0 || ry <= 0) return [];
  const points: number[] = [];
  const segments = Math.max(16, Math.min(128, Math.ceil(Math.max(rx, ry) * 0.75)));
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  return [{ points, closed: true }];
}

function lineContour(element: Element): SvgContour[] {
  const x1 = parseNumber(element.getAttribute('x1'), 0);
  const y1 = parseNumber(element.getAttribute('y1'), 0);
  const x2 = parseNumber(element.getAttribute('x2'), 0);
  const y2 = parseNumber(element.getAttribute('y2'), 0);
  return [{ points: [x1, y1, x2, y2], closed: false }];
}

function parsePoints(value: string): number[] {
  const nums = (value.match(/[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?/gi) ?? []).map(Number);
  if (nums.length % 2 !== 0 || !nums.every(Number.isFinite)) {
    throw svgGeometryError('SVG points must contain finite x/y coordinate pairs.');
  }
  const points: number[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    points.push(requiredNumberAt(nums, i, 'SVG point list'), requiredNumberAt(nums, i + 1, 'SVG point list'));
  }
  return points;
}

function parsePath(d: string, curveSegments: number): SvgContour[] {
  const tokens = d.match(/[a-zA-Z]|[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?/g) ?? [];
  const contours: SvgContour[] = [];
  let contour: number[] = [];
  let i = 0;
  let command = '';
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;
  let lastCubicControlX = 0;
  let lastCubicControlY = 0;
  let hasLastCubicControl = false;
  let lastQuadraticControlX = 0;
  let lastQuadraticControlY = 0;
  let hasLastQuadraticControl = false;
  let lastCurveCommand = '';

  const isCommand = (token: string | undefined): token is string => token !== undefined && /^[a-zA-Z]$/.test(token);
  const hasNumber = () => i < tokens.length && !isCommand(tokens[i]);
  const requireNumbers = (count: number) => {
    for (let offset = 0; offset < count; offset++) {
      const parameter = tokens[i + offset];
      if (parameter === undefined || isCommand(parameter)) {
        throw svgGeometryError(`SVG path command ${command || '<unset>'} requires ${count} parameters.`);
      }
    }
  };
  const number = () => {
    const token = tokens[i];
    if (token === undefined) {
      throw svgGeometryError(`SVG path command ${command || '<unset>'} is missing parameters at the end of the path.`);
    }
    if (isCommand(token)) {
      throw svgGeometryError(`SVG path command ${command || '<unset>'} is missing parameters before ${token}.`);
    }
    i++;
    const value = Number(token);
    if (!Number.isFinite(value)) throw svgGeometryError(`SVG path contains a non-finite parameter: ${token}.`);
    return value;
  };
  const point = (relative: boolean): [number, number] => {
    const x = number();
    const y = number();
    return relative ? [currentX + x, currentY + y] : [x, y];
  };
  const push = (x: number, y: number) => {
    currentX = x;
    currentY = y;
    contour.push(x, y);
  };
  const resetCurveControls = () => {
    hasLastCubicControl = false;
    hasLastQuadraticControl = false;
    lastCurveCommand = '';
  };
  const close = () => {
    if (contour.length > 0) {
      contours.push({ points: contour, closed: true });
      contour = [];
    }
    currentX = startX;
    currentY = startY;
    resetCurveControls();
  };

  while (i < tokens.length) {
    const token = requiredItemAt(tokens, i, 'SVG path tokens');
    if (isCommand(token)) {
      command = token;
      i++;
    } else if (!command) {
      throw svgGeometryError('SVG path data must begin with a command.');
    }
    const relative = command === command.toLowerCase();
    switch (command.toLowerCase()) {
      case 'm': {
        const [x, y] = point(relative);
        if (contour.length > 0) contours.push({ points: contour, closed: false });
        contour = [x, y];
        currentX = x;
        currentY = y;
        startX = x;
        startY = y;
        resetCurveControls();
        command = relative ? 'l' : 'L';
        break;
      }
      case 'l':
        requireNumbers(2);
        while (hasNumber()) {
          const [x, y] = point(relative);
          push(x, y);
        }
        resetCurveControls();
        break;
      case 'h':
        requireNumbers(1);
        while (hasNumber()) {
          const x = number();
          push(relative ? currentX + x : x, currentY);
        }
        resetCurveControls();
        break;
      case 'v':
        requireNumbers(1);
        while (hasNumber()) {
          const y = number();
          push(currentX, relative ? currentY + y : y);
        }
        resetCurveControls();
        break;
      case 'c':
        requireNumbers(6);
        while (hasNumber()) {
          const p0x = currentX;
          const p0y = currentY;
          const [p1x, p1y] = point(relative);
          const [p2x, p2y] = point(relative);
          const [p3x, p3y] = point(relative);
          for (let s = 1; s <= curveSegments; s++) {
            const t = s / curveSegments;
            push(cubicX(p0x, p1x, p2x, p3x, t), cubicX(p0y, p1y, p2y, p3y, t));
          }
          lastCubicControlX = p2x;
          lastCubicControlY = p2y;
          hasLastCubicControl = true;
          hasLastQuadraticControl = false;
          lastCurveCommand = 'c';
        }
        break;
      case 's':
        requireNumbers(4);
        while (hasNumber()) {
          const p0x = currentX;
          const p0y = currentY;
          const useReflection = (lastCurveCommand === 'c' || lastCurveCommand === 's') && hasLastCubicControl;
          const p1x = useReflection ? currentX * 2 - lastCubicControlX : currentX;
          const p1y = useReflection ? currentY * 2 - lastCubicControlY : currentY;
          const [p2x, p2y] = point(relative);
          const [p3x, p3y] = point(relative);
          for (let s = 1; s <= curveSegments; s++) {
            const t = s / curveSegments;
            push(cubicX(p0x, p1x, p2x, p3x, t), cubicX(p0y, p1y, p2y, p3y, t));
          }
          lastCubicControlX = p2x;
          lastCubicControlY = p2y;
          hasLastCubicControl = true;
          hasLastQuadraticControl = false;
          lastCurveCommand = 's';
        }
        break;
      case 'q':
        requireNumbers(4);
        while (hasNumber()) {
          const p0x = currentX;
          const p0y = currentY;
          const [p1x, p1y] = point(relative);
          const [p2x, p2y] = point(relative);
          for (let s = 1; s <= curveSegments; s++) {
            const t = s / curveSegments;
            push(quadraticX(p0x, p1x, p2x, t), quadraticX(p0y, p1y, p2y, t));
          }
          lastQuadraticControlX = p1x;
          lastQuadraticControlY = p1y;
          hasLastQuadraticControl = true;
          hasLastCubicControl = false;
          lastCurveCommand = 'q';
        }
        break;
      case 't':
        requireNumbers(2);
        while (hasNumber()) {
          const p0x = currentX;
          const p0y = currentY;
          const useReflection = (lastCurveCommand === 'q' || lastCurveCommand === 't') && hasLastQuadraticControl;
          const p1x = useReflection ? currentX * 2 - lastQuadraticControlX : currentX;
          const p1y = useReflection ? currentY * 2 - lastQuadraticControlY : currentY;
          const [p2x, p2y] = point(relative);
          for (let s = 1; s <= curveSegments; s++) {
            const t = s / curveSegments;
            push(quadraticX(p0x, p1x, p2x, t), quadraticX(p0y, p1y, p2y, t));
          }
          lastQuadraticControlX = p1x;
          lastQuadraticControlY = p1y;
          hasLastQuadraticControl = true;
          hasLastCubicControl = false;
          lastCurveCommand = 't';
        }
        break;
      case 'a':
        requireNumbers(7);
        while (hasNumber()) {
          const p0x = currentX;
          const p0y = currentY;
          const rx = number();
          const ry = number();
          const rotation = number();
          const largeArc = number() !== 0;
          const sweep = number() !== 0;
          const [p1x, p1y] = point(relative);
          const arcPoints = arcToPoints(p0x, p0y, p1x, p1y, rx, ry, rotation, largeArc, sweep, curveSegments);
          for (let j = 0; j < arcPoints.length; j += 2) {
            push(
              requiredNumberAt(arcPoints, j, 'SVG arc points'),
              requiredNumberAt(arcPoints, j + 1, 'SVG arc points'),
            );
          }
          hasLastCubicControl = false;
          hasLastQuadraticControl = false;
          lastCurveCommand = 'a';
        }
        break;
      case 'z':
        close();
        command = '';
        break;
      default:
        throw svgGeometryError(`Unsupported SVG path command: ${command}.`);
    }
  }
  if (contour.length > 0) contours.push({ points: contour, closed: false });
  return contours;
}

function arcToPoints(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  rx: number,
  ry: number,
  xAxisRotation: number,
  largeArc: boolean,
  sweep: boolean,
  curveSegments: number,
): number[] {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx < 1e-8 || ry < 1e-8 || (Math.abs(fromX - toX) < 1e-8 && Math.abs(fromY - toY) < 1e-8)) {
    return [toX, toY];
  }

  const phi = (xAxisRotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (fromX - toX) * 0.5;
  const dy = (fromY - toY) * 0.5;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const rxSq = rx * rx;
  const rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;
  const denom = rxSq * y1pSq + rySq * x1pSq;
  const sign = largeArc === sweep ? -1 : 1;
  const factor = denom <= 0
    ? 0
    : sign * Math.sqrt(Math.max(0, (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / denom));
  const cxp = factor * (rx * y1p) / ry;
  const cyp = factor * (-ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (fromX + toX) * 0.5;
  const cy = sinPhi * cxp + cosPhi * cyp + (fromY + toY) * 0.5;

  const theta1 = vectorAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let deltaTheta = vectorAngle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && deltaTheta > 0) deltaTheta -= Math.PI * 2;
  if (sweep && deltaTheta < 0) deltaTheta += Math.PI * 2;

  const segments = Math.max(1, Math.ceil(Math.abs(deltaTheta) / (Math.PI / Math.max(4, curveSegments))));
  const points: number[] = [];
  for (let i = 1; i <= segments; i++) {
    const theta = theta1 + (deltaTheta * i) / segments;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    points.push(
      cx + cosPhi * rx * cosTheta - sinPhi * ry * sinTheta,
      cy + sinPhi * rx * cosTheta + cosPhi * ry * sinTheta,
    );
  }
  return points;
}

function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const dotProduct = ux * vx + uy * vy;
  const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  const angle = Math.acos(Math.min(1, Math.max(-1, len === 0 ? 1 : dotProduct / len)));
  return ux * vy - uy * vx < 0 ? -angle : angle;
}

function cubicX(a: number, b: number, c: number, d: number, t: number): number {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return a * mt2 * mt + 3 * b * mt2 * t + 3 * c * mt * t2 + d * t2 * t;
}

function quadraticX(a: number, b: number, c: number, t: number): number {
  const mt = 1 - t;
  return a * mt * mt + 2 * b * mt * t + c * t * t;
}

function parseTransform(value: string | null): Matrix2D {
  if (!value) return IDENTITY_MATRIX;
  let matrix: Matrix2D = IDENTITY_MATRIX;
  const commands = value.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi);
  for (const command of commands) {
    const name = requiredItemAt(command, 1, 'SVG transform match').toLowerCase();
    const nums = parseNumberList(requiredItemAt(command, 2, 'SVG transform match'));
    let next: Matrix2D = IDENTITY_MATRIX;
    switch (name) {
      case 'matrix':
        if (nums.length >= 6) {
          next = [
            requiredNumberAt(nums, 0, 'SVG matrix transform'),
            requiredNumberAt(nums, 1, 'SVG matrix transform'),
            requiredNumberAt(nums, 2, 'SVG matrix transform'),
            requiredNumberAt(nums, 3, 'SVG matrix transform'),
            requiredNumberAt(nums, 4, 'SVG matrix transform'),
            requiredNumberAt(nums, 5, 'SVG matrix transform'),
          ];
        }
        break;
      case 'translate':
        next = [1, 0, 0, 1, nums[0] ?? 0, nums[1] ?? 0];
        break;
      case 'scale': {
        const sx = nums[0] ?? 1;
        const sy = nums[1] ?? sx;
        next = [sx, 0, 0, sy, 0, 0];
        break;
      }
      case 'rotate': {
        const angle = ((nums[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const rotate: Matrix2D = [cos, sin, -sin, cos, 0, 0];
        if (nums.length >= 3) {
          const cx = requiredNumberAt(nums, 1, 'SVG rotate transform');
          const cy = requiredNumberAt(nums, 2, 'SVG rotate transform');
          next = multiplyMatrix(multiplyMatrix([1, 0, 0, 1, cx, cy], rotate), [1, 0, 0, 1, -cx, -cy]);
        } else {
          next = rotate;
        }
        break;
      }
      case 'skewx': {
        next = [1, 0, Math.tan(((nums[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      }
      case 'skewy': {
        next = [1, Math.tan(((nums[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
      }
    }
    matrix = multiplyMatrix(matrix, next);
  }
  return matrix;
}

function multiplyMatrix(a: Matrix2D, b: Matrix2D): Matrix2D {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function transformPoints(matrix: Matrix2D, points: number[]): number[] {
  const out = new Array<number>(points.length);
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = requiredNumberAt(points, i, 'SVG transform points');
    const y = requiredNumberAt(points, i + 1, 'SVG transform points');
    out[i] = matrix[0] * x + matrix[2] * y + matrix[4];
    out[i + 1] = matrix[1] * x + matrix[3] * y + matrix[5];
  }
  return out;
}

function toEnginePoints(points: number[], originX: number, originY: number, scale: number): number[] {
  const out = new Array<number>(points.length);
  for (let i = 0; i + 1 < points.length; i += 2) {
    out[i] = (requiredNumberAt(points, i, 'SVG engine points') - originX) * scale;
    out[i + 1] = (originY - requiredNumberAt(points, i + 1, 'SVG engine points')) * scale;
  }
  return out;
}

function pointCount(points: number[]): number {
  return points.length / 2;
}

function appendGeometryData(batch: SVGMeshBatch, data: SVGGeometryBuildData): void {
  const vertexOffset = batch.positions.length / 2;
  for (const value of data.positions) batch.positions.push(value);
  for (const index of data.indices) batch.indices.push(index + vertexOffset);
}

function createMeshFromBatch(batch: SVGMeshBatch): SVG2DMeshData {
  const vertexCount = batch.positions.length / 2;
  return {
    geometry: new Geometry2D(new Float32Array(batch.positions), makeIndexArray(batch.indices, vertexCount)),
    material: new Material2D({ color: batch.color, blending: batch.color[3] < 1 ? 'normal' : 'none' }),
  };
}

function materialKey(color: [number, number, number, number]): string {
  return `${color[0]},${color[1]},${color[2]},${color[3]},${color[3] < 1 ? 'normal' : 'none'}`;
}

interface StrokeSegment {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
}

function createStrokeGeometry(
  points: number[],
  closed: boolean,
  width: number,
  lineCap: StrokeLineCap,
  lineJoin: StrokeLineJoin,
  miterLimit: number,
): SVGGeometryBuildData | null {
  const clean = cleanStrokeContour(points, closed);
  if (clean.length < 2) return null;
  const halfWidth = Math.max(0.0001, width * 0.5);
  const segments = buildStrokeSegments(clean, closed, halfWidth, lineCap);
  if (segments.length === 0) return null;
  const positions: number[] = [];
  const indices: number[] = [];

  for (const segment of segments) {
    addQuad(
      positions,
      indices,
      segment.startX + segment.nx, segment.startY + segment.ny,
      segment.startX - segment.nx, segment.startY - segment.ny,
      segment.endX - segment.nx, segment.endY - segment.ny,
      segment.endX + segment.nx, segment.endY + segment.ny,
    );
  }

  if (closed) {
    for (let i = 0; i < segments.length; i++) {
      const centerIndex = ((i + 1) % pointCount(clean)) * 2;
      addStrokeJoin(
        positions,
        indices,
        requiredNumberAt(clean, centerIndex, 'SVG closed stroke points'),
        requiredNumberAt(clean, centerIndex + 1, 'SVG closed stroke points'),
        requiredItemAt(segments, i, 'SVG closed stroke segments'),
        requiredItemAt(segments, (i + 1) % segments.length, 'SVG closed stroke segments'),
        halfWidth,
        lineJoin,
        miterLimit,
      );
    }
  } else {
    for (let i = 0; i + 1 < segments.length; i++) {
      const centerIndex = (i + 1) * 2;
      addStrokeJoin(
        positions,
        indices,
        requiredNumberAt(clean, centerIndex, 'SVG open stroke points'),
        requiredNumberAt(clean, centerIndex + 1, 'SVG open stroke points'),
        requiredItemAt(segments, i, 'SVG open stroke segments'),
        requiredItemAt(segments, i + 1, 'SVG open stroke segments'),
        halfWidth,
        lineJoin,
        miterLimit,
      );
    }
    if (lineCap === 'round') {
      const lastIndex = clean.length - 2;
      addRoundCap(
        positions,
        indices,
        requiredNumberAt(clean, 0, 'SVG stroke cap points'),
        requiredNumberAt(clean, 1, 'SVG stroke cap points'),
        requiredItemAt(segments, 0, 'SVG stroke cap segments'),
        halfWidth,
        true,
      );
      addRoundCap(
        positions,
        indices,
        requiredNumberAt(clean, lastIndex, 'SVG stroke cap points'),
        requiredNumberAt(clean, lastIndex + 1, 'SVG stroke cap points'),
        requiredItemAt(segments, segments.length - 1, 'SVG stroke cap segments'),
        halfWidth,
        false,
      );
    }
  }

  if (positions.length === 0) return null;
  return { positions, indices };
}

function buildStrokeSegments(points: number[], closed: boolean, halfWidth: number, lineCap: StrokeLineCap): StrokeSegment[] {
  const segments: StrokeSegment[] = [];
  const pointTotal = pointCount(points);
  const count = closed ? pointTotal : pointTotal - 1;
  for (let i = 0; i < count; i++) {
    const ai = i * 2;
    const bi = ((i + 1) % pointTotal) * 2;
    const ax = requiredNumberAt(points, ai, 'SVG stroke points');
    const ay = requiredNumberAt(points, ai + 1, 'SVG stroke points');
    const bx = requiredNumberAt(points, bi, 'SVG stroke points');
    const by = requiredNumberAt(points, bi + 1, 'SVG stroke points');
    const vx = bx - ax;
    const vy = by - ay;
    const len = Math.hypot(vx, vy);
    if (len < 1e-6) continue;
    const dx = vx / len;
    const dy = vy / len;
    const nx = -dy * halfWidth;
    const ny = dx * halfWidth;
    const extendStart = !closed && lineCap === 'square' && i === 0;
    const extendEnd = !closed && lineCap === 'square' && i === count - 1;
    segments.push({
      startX: ax - (extendStart ? dx * halfWidth : 0),
      startY: ay - (extendStart ? dy * halfWidth : 0),
      endX: bx + (extendEnd ? dx * halfWidth : 0),
      endY: by + (extendEnd ? dy * halfWidth : 0),
      dx,
      dy,
      nx,
      ny,
    });
  }
  return segments;
}

function addStrokeJoin(
  positions: number[],
  indices: number[],
  centerX: number,
  centerY: number,
  prev: StrokeSegment,
  next: StrokeSegment,
  halfWidth: number,
  lineJoin: StrokeLineJoin,
  miterLimit: number,
): void {
  const turn = prev.dx * next.dy - prev.dy * next.dx;
  if (Math.abs(turn) < 1e-6) return;
  const outsideLeft = turn < 0;
  const prevOuterX = outsideLeft ? centerX + prev.nx : centerX - prev.nx;
  const prevOuterY = outsideLeft ? centerY + prev.ny : centerY - prev.ny;
  const nextOuterX = outsideLeft ? centerX + next.nx : centerX - next.nx;
  const nextOuterY = outsideLeft ? centerY + next.ny : centerY - next.ny;

  if (lineJoin === 'round') {
    addArcFan(positions, indices, centerX, centerY, prevOuterX, prevOuterY, nextOuterX, nextOuterY, turn > 0, Math.max(4, Math.ceil(Math.abs(angleBetween(centerX, centerY, prevOuterX, prevOuterY, nextOuterX, nextOuterY)) * halfWidth / 3)));
    return;
  }

  if (lineJoin === 'miter') {
    const miter = lineIntersection(
      prevOuterX, prevOuterY,
      prevOuterX + prev.dx, prevOuterY + prev.dy,
      nextOuterX, nextOuterY,
      nextOuterX + next.dx, nextOuterY + next.dy,
    );
    if (miter && Math.hypot(miter.x - centerX, miter.y - centerY) <= Math.max(1, miterLimit) * halfWidth) {
      addTriangle(positions, indices, centerX, centerY, prevOuterX, prevOuterY, miter.x, miter.y);
      addTriangle(positions, indices, centerX, centerY, miter.x, miter.y, nextOuterX, nextOuterY);
      return;
    }
  }

  addTriangle(positions, indices, centerX, centerY, prevOuterX, prevOuterY, nextOuterX, nextOuterY);
}

function addRoundCap(
  positions: number[],
  indices: number[],
  centerX: number,
  centerY: number,
  segment: StrokeSegment,
  halfWidth: number,
  start: boolean,
): void {
  const theta = Math.atan2(segment.dy, segment.dx);
  const fromX = start ? centerX + segment.nx : centerX - segment.nx;
  const fromY = start ? centerY + segment.ny : centerY - segment.ny;
  const toX = start ? centerX - segment.nx : centerX + segment.nx;
  const toY = start ? centerY - segment.ny : centerY + segment.ny;
  const midpointAngle = start ? theta + Math.PI : theta;
  addArcFanThroughAngle(positions, indices, centerX, centerY, fromX, fromY, toX, toY, midpointAngle, Math.max(8, Math.ceil(Math.PI * halfWidth / 3)));
}

function addArcFanThroughAngle(
  positions: number[],
  indices: number[],
  centerX: number,
  centerY: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  throughAngle: number,
  segments: number,
): void {
  const radius = Math.hypot(fromX - centerX, fromY - centerY);
  if (radius < 1e-6) return;
  const a0 = Math.atan2(fromY - centerY, fromX - centerX);
  let a1 = Math.atan2(toY - centerY, toX - centerX);
  const through = normalizeAngleNear(throughAngle, a0);
  while (a1 < a0) a1 += TAU;
  if (through < a0 || through > a1) {
    while (a1 > a0) a1 -= TAU;
  }
  addArcFanAngles(positions, indices, centerX, centerY, radius, a0, a1, Math.max(1, segments));
}

function addArcFan(
  positions: number[],
  indices: number[],
  centerX: number,
  centerY: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  counterClockwise: boolean,
  segments: number,
): void {
  const radius = Math.hypot(fromX - centerX, fromY - centerY);
  if (radius < 1e-6) return;
  const a0 = Math.atan2(fromY - centerY, fromX - centerX);
  let a1 = Math.atan2(toY - centerY, toX - centerX);
  if (counterClockwise) {
    while (a1 < a0) a1 += TAU;
    if (a1 - a0 > Math.PI) a1 -= TAU;
  } else {
    while (a1 > a0) a1 -= TAU;
    if (a0 - a1 > Math.PI) a1 += TAU;
  }
  addArcFanAngles(positions, indices, centerX, centerY, radius, a0, a1, Math.max(1, segments));
}

function addArcFanAngles(
  positions: number[],
  indices: number[],
  centerX: number,
  centerY: number,
  radius: number,
  a0: number,
  a1: number,
  segments: number,
): void {
  const steps = Math.max(1, Math.ceil(Math.abs(a1 - a0) / Math.PI * segments));
  let prevX = centerX + Math.cos(a0) * radius;
  let prevY = centerY + Math.sin(a0) * radius;
  for (let i = 1; i <= steps; i++) {
    const angle = a0 + ((a1 - a0) * i) / steps;
    const nextX = centerX + Math.cos(angle) * radius;
    const nextY = centerY + Math.sin(angle) * radius;
    addTriangle(positions, indices, centerX, centerY, prevX, prevY, nextX, nextY);
    prevX = nextX;
    prevY = nextY;
  }
}

function addQuad(
  positions: number[],
  indices: number[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): void {
  const base = positions.length / 2;
  positions.push(ax, ay, bx, by, cx, cy, dx, dy);
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function addTriangle(
  positions: number[],
  indices: number[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): void {
  const base = positions.length / 2;
  positions.push(ax, ay, bx, by, cx, cy);
  indices.push(base, base + 1, base + 2);
}

function angleBetween(centerX: number, centerY: number, ax: number, ay: number, bx: number, by: number): number {
  const a0 = Math.atan2(ay - centerY, ax - centerX);
  let a1 = Math.atan2(by - centerY, bx - centerX);
  a1 = normalizeAngleNear(a1, a0);
  return Math.abs(a1 - a0);
}

function normalizeAngleNear(angle: number, reference: number): number {
  let out = angle;
  while (out - reference > Math.PI) out -= TAU;
  while (out - reference < -Math.PI) out += TAU;
  return out;
}

function lineIntersection(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): { x: number; y: number } | null {
  const bax = bx - ax;
  const bay = by - ay;
  const dcx = dx - cx;
  const dcy = dy - cy;
  const denom = bax * dcy - bay * dcx;
  if (Math.abs(denom) < 1e-8) return null;
  const t = ((cx - ax) * dcy - (cy - ay) * dcx) / denom;
  return { x: ax + bax * t, y: ay + bay * t };
}

function triangulate(points: number[]): number[] {
  const earcutIndices = earcut(points, undefined, 2);
  if (earcutIndices.length > 0) return earcutIndices;

  const indices = new Array<number>(pointCount(points));
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  if (signedArea(points) < 0) indices.reverse();
  return fanTriangulate(indices);
}

function fanTriangulate(indices: number[]): number[] {
  const out: number[] = [];
  const root = requiredNumberAt(indices, 0, 'SVG triangulation indices');
  for (let i = 1; i + 1 < indices.length; i++) {
    out.push(
      root,
      requiredNumberAt(indices, i, 'SVG triangulation indices'),
      requiredNumberAt(indices, i + 1, 'SVG triangulation indices'),
    );
  }
  return out;
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function signedArea(points: number[]): number {
  let area = 0;
  const count = pointCount(points);
  for (let i = 0; i < count; i++) {
    const ai = i * 2;
    const bi = ((i + 1) % count) * 2;
    area += requiredNumberAt(points, ai, 'SVG contour points') * requiredNumberAt(points, bi + 1, 'SVG contour points')
      - requiredNumberAt(points, bi, 'SVG contour points') * requiredNumberAt(points, ai + 1, 'SVG contour points');
  }
  return area * 0.5;
}

function cleanContour(points: number[], closed: boolean): number[] {
  return removeCollinearPoints(removeDuplicatePoints(points, closed), closed);
}

function cleanStrokeContour(points: number[], closed: boolean): number[] {
  return cleanContour(points, closed);
}

function removeDuplicatePoints(points: number[], closed: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = requiredNumberAt(points, i, 'SVG contour points');
    const y = requiredNumberAt(points, i + 1, 'SVG contour points');
    const last = out.length - 2;
    if (last < 0 || Math.hypot(
      requiredNumberAt(out, last, 'SVG cleaned contour') - x,
      requiredNumberAt(out, last + 1, 'SVG cleaned contour') - y,
    ) > 1e-6) out.push(x, y);
  }
  if (closed && out.length > 2 && Math.hypot(
    requiredNumberAt(out, 0, 'SVG cleaned contour') - requiredNumberAt(out, out.length - 2, 'SVG cleaned contour'),
    requiredNumberAt(out, 1, 'SVG cleaned contour') - requiredNumberAt(out, out.length - 1, 'SVG cleaned contour'),
  ) < 1e-6) {
    out.length -= 2;
  }
  return out;
}

function removeCollinearPoints(points: number[], closed: boolean): number[] {
  const count = pointCount(points);
  if (count < 3) return points;
  if (!closed) {
    const out: number[] = [
      requiredNumberAt(points, 0, 'SVG collinear points'),
      requiredNumberAt(points, 1, 'SVG collinear points'),
    ];
    for (let i = 1; i + 1 < count; i++) {
      const prev = (i - 1) * 2;
      const current = i * 2;
      const next = (i + 1) * 2;
      if (Math.abs(cross(
        requiredNumberAt(points, prev, 'SVG collinear points'),
        requiredNumberAt(points, prev + 1, 'SVG collinear points'),
        requiredNumberAt(points, current, 'SVG collinear points'),
        requiredNumberAt(points, current + 1, 'SVG collinear points'),
        requiredNumberAt(points, next, 'SVG collinear points'),
        requiredNumberAt(points, next + 1, 'SVG collinear points'),
      )) > 1e-7) {
        out.push(
          requiredNumberAt(points, current, 'SVG collinear points'),
          requiredNumberAt(points, current + 1, 'SVG collinear points'),
        );
      }
    }
    out.push(
      requiredNumberAt(points, points.length - 2, 'SVG collinear points'),
      requiredNumberAt(points, points.length - 1, 'SVG collinear points'),
    );
    return out;
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const prev = ((i + count - 1) % count) * 2;
    const current = i * 2;
    const next = ((i + 1) % count) * 2;
    if (Math.abs(cross(
      requiredNumberAt(points, prev, 'SVG collinear points'),
      requiredNumberAt(points, prev + 1, 'SVG collinear points'),
      requiredNumberAt(points, current, 'SVG collinear points'),
      requiredNumberAt(points, current + 1, 'SVG collinear points'),
      requiredNumberAt(points, next, 'SVG collinear points'),
      requiredNumberAt(points, next + 1, 'SVG collinear points'),
    )) > 1e-7) {
      out.push(
        requiredNumberAt(points, current, 'SVG collinear points'),
        requiredNumberAt(points, current + 1, 'SVG collinear points'),
      );
    }
  }
  return out;
}

function makeIndexArray(indices: number[], vertexCount: number): Uint16Array | Uint32Array {
  return vertexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
}

function getSvgBounds(svg: Element, shapes: RawShape[]): SvgBounds {
  const viewBox = svg.getAttribute('viewBox');
  if (viewBox) {
    const nums = parseNumberList(viewBox);
    if (nums.length >= 4 && nums.every(Number.isFinite)) {
      const x = requiredNumberAt(nums, 0, 'SVG viewBox');
      const y = requiredNumberAt(nums, 1, 'SVG viewBox');
      const width = requiredNumberAt(nums, 2, 'SVG viewBox');
      const height = requiredNumberAt(nums, 3, 'SVG viewBox');
      if (width > 0 && height > 0) return { x, y, width, height };
    }
  }
  const contentBounds = getContentBounds(shapes);
  if (contentBounds) return contentBounds;
  return {
    x: 0,
    y: 0,
    width: parseNumber(svg.getAttribute('width'), 100),
    height: parseNumber(svg.getAttribute('height'), 100),
  };
}

function getContentBounds(shapes: RawShape[]): SvgBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    for (const contour of shape.contours) {
      for (let i = 0; i + 1 < contour.points.length; i += 2) {
        const x = requiredNumberAt(contour.points, i, 'SVG bounds points');
        const y = requiredNumberAt(contour.points, i + 1, 'SVG bounds points');
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  return {
    x: minX,
    y: minY,
    width: Math.max(0.00001, maxX - minX),
    height: Math.max(0.00001, maxY - minY),
  };
}

function parseNumber(value: string | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseNumberList(value: string): number[] {
  return (value.match(/[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?/gi) ?? []).map(Number);
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  blue: [0, 0, 255],
  cyan: [0, 255, 255],
  gray: [128, 128, 128],
  green: [0, 128, 0],
  grey: [128, 128, 128],
  lime: [0, 255, 0],
  magenta: [255, 0, 255],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  red: [255, 0, 0],
  transparent: [0, 0, 0],
  white: [255, 255, 255],
  yellow: [255, 255, 0],
};

function parseColor(value: string, opacity: number): [number, number, number, number] | null {
  const color = value.trim().toLowerCase();
  if (color === 'none') return null;
  const named = NAMED_COLORS[color];
  if (named) return [
    requiredNumberAt(named, 0, 'SVG named color') / 255,
    requiredNumberAt(named, 1, 'SVG named color') / 255,
    requiredNumberAt(named, 2, 'SVG named color') / 255,
    color === 'transparent' ? 0 : opacity,
  ];
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full = hex.length === 3
      ? hex.split('').map(ch => ch + ch).join('')
      : hex.slice(0, 6);
    const n = Number.parseInt(full, 16);
    if (!Number.isFinite(n)) return null;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, opacity];
  }
  const rgb = color.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const nums = requiredItemAt(rgb, 1, 'SVG rgb color').split(/[\s,\/]+/).filter(Boolean).map(Number);
    if (nums.length >= 3 && nums.every(Number.isFinite)) return [
      requiredNumberAt(nums, 0, 'SVG rgb color') / 255,
      requiredNumberAt(nums, 1, 'SVG rgb color') / 255,
      requiredNumberAt(nums, 2, 'SVG rgb color') / 255,
      nums[3] !== undefined ? requiredNumberAt(nums, 3, 'SVG rgb color') * opacity : opacity,
    ];
  }
  return null;
}

function normalizeCurveSegments(value: number): number {
  if (!Number.isFinite(value) || value > MAX_CURVE_SEGMENTS) {
    throw svgGeometryError(
      `SVG curveSegments must be finite and no greater than ${MAX_CURVE_SEGMENTS}; received ${String(value)}.`,
    );
  }
  return Math.max(2, Math.floor(value));
}

function svgGeometryError(message: string): EngineError {
  return new EngineError(
    EngineErrorCode.GeometryInvalidParameter,
    message,
    {
      hint: 'Validate SVG geometry input and subdivision options before conversion.',
      docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
    },
  );
}
