import { EngineError, EngineErrorCode } from '../core/EngineError';
import { requiredNumberAt } from '../math/arrayAccess';

let _geo2dIdCounter = 0;

export interface Geometry2DOptions {
  topology?: GPUPrimitiveTopology | null;
}

export class Geometry2D {
  readonly id: number = ++_geo2dIdCounter;
  version = 0;

  positions: Float32Array;               // x,y interleaved (stride 2)
  indices: Uint16Array | Uint32Array | null;
  topology: GPUPrimitiveTopology | null;

  constructor(
    positions: Float32Array,
    indices?: Uint16Array | Uint32Array,
    options: Geometry2DOptions = {},
  ) {
    validateGeometry2DOptions(positions, indices);
    this.positions = positions;
    this.indices   = indices ?? null;
    this.topology  = options.topology ?? null;
  }

  get vertexCount(): number { return this.positions.length / 2; }
  get indexCount():  number { return this.indices?.length ?? 0; }

  markDirty(): this {
    this.version++;
    return this;
  }

  setPositions(positions: Float32Array): this {
    validateGeometry2DOptions(positions, this.indices ?? undefined);
    this.positions = positions;
    return this.markDirty();
  }

  setIndices(indices: Uint16Array | Uint32Array | null): this {
    validateGeometry2DOptions(this.positions, indices ?? undefined);
    this.indices = indices;
    return this.markDirty();
  }

  setData(
    positions: Float32Array,
    indices: Uint16Array | Uint32Array | null = this.indices,
  ): this {
    validateGeometry2DOptions(positions, indices ?? undefined);
    this.positions = positions;
    this.indices = indices;
    return this.markDirty();
  }
}

function validateGeometry2DOptions(positions: Float32Array, indices?: Uint16Array | Uint32Array): void {
  if (!(positions instanceof Float32Array) || positions.length < 2 || positions.length % 2 !== 0) {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      'Geometry2D positions must be a non-empty Float32Array with xy pairs.',
      {
        hint: 'Pass positions as Float32Array([x, y, ...]) with length divisible by 2.',
        docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
      },
    );
  }
  for (let i = 0; i < positions.length; i++) {
    const value = requiredNumberAt(positions, i, 'Geometry2D positions');
    if (!Number.isFinite(value)) {
      throw new EngineError(
        EngineErrorCode.GeometryInvalidParameter,
        `Geometry2D position at offset ${i} must be finite; received ${String(value)}.`,
        {
          hint: 'Replace NaN or infinite position values before updating geometry.',
          docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
        },
      );
    }
  }
  if (indices && !(indices instanceof Uint16Array) && !(indices instanceof Uint32Array)) {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      'Geometry2D indices must be Uint16Array or Uint32Array.',
      {
        hint: 'Use typed-array indices or omit indices for non-indexed geometry.',
        docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
      },
    );
  }
  if (!indices) return;
  const vertexCount = positions.length / 2;
  for (let i = 0; i < indices.length; i++) {
    const index = requiredNumberAt(indices, i, 'Geometry2D indices');
    if (index >= vertexCount) {
      throw new EngineError(
        EngineErrorCode.GeometryInvalidParameter,
        `Geometry2D index ${index} at offset ${i} exceeds vertexCount ${vertexCount}.`,
        {
          hint: 'Ensure every index references an existing vertex.',
          docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
        },
      );
    }
  }
}
