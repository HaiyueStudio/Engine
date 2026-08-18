import { Geometry2D } from './Geometry2D';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { requiredItemAt } from '../math/arrayAccess';

const MAX_2D_SEGMENTS = 1_000_000;

// ── Rectangle ─────────────────────────────────────────────────────────────────

export interface RectGeometry2DOptions {
  width:   number;
  height:  number;
  /** Center offset (default 0). */
  x?: number;
  y?: number;
}

export function createRect2D(options: RectGeometry2DOptions): Geometry2D {
  const cx = options.x ?? 0;
  const cy = options.y ?? 0;
  const hw = options.width  / 2;
  const hh = options.height / 2;

  // CCW winding, Y-up
  const positions = new Float32Array([
    cx - hw, cy - hh,   // 0 bottom-left
    cx + hw, cy - hh,   // 1 bottom-right
    cx + hw, cy + hh,   // 2 top-right
    cx - hw, cy + hh,   // 3 top-left
  ]);
  const indices = new Uint16Array([0, 1, 2,  0, 2, 3]);
  return new Geometry2D(positions, indices);
}

// ── Circle ────────────────────────────────────────────────────────────────────

export interface CircleGeometry2DOptions {
  radius:    number;
  segments?: number;
  /** Center offset (default 0). */
  x?: number;
  y?: number;
}

export function createCircle2D(options: CircleGeometry2DOptions): Geometry2D {
  const cx  = options.x ?? 0;
  const cy  = options.y ?? 0;
  const r   = options.radius;
  const n = normalizeSegmentCount(options.segments ?? 48, 3, 'circle segments');

  // vertex 0: center, vertices 1..n: ring
  const positions = new Float32Array((n + 1) * 2);
  positions[0] = cx;
  positions[1] = cy;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    positions[(i + 1) * 2]     = cx + Math.cos(a) * r;
    positions[(i + 1) * 2 + 1] = cy + Math.sin(a) * r;
  }

  // triangle fan: [0, i+1, i+2] with wrap
  const indices = createShapeIndexArray(n * 3, n + 1);
  for (let i = 0; i < n; i++) {
    indices[i * 3]     = 0;
    indices[i * 3 + 1] = i + 1;
    indices[i * 3 + 2] = i + 2 > n ? 1 : i + 2;
  }
  return new Geometry2D(positions, indices);
}

// ── Triangle ──────────────────────────────────────────────────────────────────

export interface TriangleGeometry2DOptions {
  p1: [number, number];
  p2: [number, number];
  p3: [number, number];
}

export function createTriangle2D(options: TriangleGeometry2DOptions): Geometry2D {
  const { p1, p2, p3 } = options;
  const positions = new Float32Array([
    p1[0], p1[1],
    p2[0], p2[1],
    p3[0], p3[1],
  ]);
  const indices = new Uint16Array([0, 1, 2]);
  return new Geometry2D(positions, indices);
}

// ── Polygon ───────────────────────────────────────────────────────────────────

export interface RegularPolygonOptions {
  /** Number of sides (≥ 3). */
  sides:     number;
  radius:    number;
  /** Center offset (default 0). */
  x?: number;
  y?: number;
  /** Initial rotation offset in radians (default 0). */
  rotation?: number;
}

export interface CustomPolygonOptions {
  /** Convex polygon vertices in order (CCW). */
  points: [number, number][];
}

export function createPolygon2D(options: RegularPolygonOptions | CustomPolygonOptions): Geometry2D {
  if ('points' in options) {
    // Custom convex polygon: triangle fan from vertex 0
    const pts = options.points;
    const n = pts.length;
    if (n < 3) {
      throw new EngineError(
        EngineErrorCode.GeometryInvalidParameter,
        'createPolygon2D requires at least 3 points.',
        {
          hint: 'Provide a convex polygon with 3 or more points.',
          docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
        },
      );
    }

    const positions = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const point = requiredItemAt(pts, i, 'polygon points');
      positions[i * 2] = point[0];
      positions[i * 2 + 1] = point[1];
    }
    const triCount = n - 2;
    const indices = createShapeIndexArray(triCount * 3, n);
    for (let i = 0; i < triCount; i++) {
      indices[i * 3]     = 0;
      indices[i * 3 + 1] = i + 1;
      indices[i * 3 + 2] = i + 2;
    }
    return new Geometry2D(positions, indices);
  }

  // Regular n-gon: reuse createCircle2D logic
  const cx  = options.x ?? 0;
  const cy  = options.y ?? 0;
  const r   = options.radius;
  const n = normalizeSegmentCount(options.sides, 3, 'polygon sides');
  const rot = options.rotation ?? 0;

  const positions = new Float32Array((n + 1) * 2);
  positions[0] = cx;
  positions[1] = cy;
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    positions[(i + 1) * 2]     = cx + Math.cos(a) * r;
    positions[(i + 1) * 2 + 1] = cy + Math.sin(a) * r;
  }

  const indices = createShapeIndexArray(n * 3, n + 1);
  for (let i = 0; i < n; i++) {
    indices[i * 3]     = 0;
    indices[i * 3 + 1] = i + 1;
    indices[i * 3 + 2] = i + 2 > n ? 1 : i + 2;
  }
  return new Geometry2D(positions, indices);
}

function normalizeSegmentCount(value: number, minimum: number, label: string): number {
  if (!Number.isFinite(value) || value > MAX_2D_SEGMENTS) {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      `${label} must be finite and no greater than ${MAX_2D_SEGMENTS}; received ${String(value)}.`,
      {
        hint: `Use an integer ${label} value between ${minimum} and ${MAX_2D_SEGMENTS}.`,
        docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
      },
    );
  }
  return Math.max(minimum, Math.floor(value));
}

function createShapeIndexArray(length: number, vertexCount: number): Uint16Array | Uint32Array {
  return vertexCount > 65535 ? new Uint32Array(length) : new Uint16Array(length);
}
