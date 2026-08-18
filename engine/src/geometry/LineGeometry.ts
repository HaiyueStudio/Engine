let _lineGeoIdCounter = 0;

export type LineGeometryTopology = 'strip' | 'segments';

export interface LineGeometryOptions {
  topology?: LineGeometryTopology;
}

export class LineGeometry {
  readonly id: number = ++_lineGeoIdCounter;

  private _points: Float32Array;
  readonly topology: LineGeometryTopology;
  dirty = true;

  constructor(points: Float32Array | number[] = new Float32Array(0), options: LineGeometryOptions = {}) {
    this._points = points instanceof Float32Array ? points : new Float32Array(points);
    this.topology = options.topology ?? 'strip';
  }

  get points(): Float32Array {
    return this._points;
  }

  get pointCount(): number {
    return this._points.length / 3;
  }

  setPoints(points: Float32Array | number[]): this {
    this._points = points instanceof Float32Array ? points : new Float32Array(points);
    this.dirty = true;
    return this;
  }
}
