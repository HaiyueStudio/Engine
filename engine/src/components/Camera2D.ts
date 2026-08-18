import { Component, UniqueCheckType } from '../ecs/Component';
import { mat4 } from 'wgpu-matrix';

export type Camera2DViewportMode = 'expand' | 'fit' | 'fill' | 'fixed';

export interface Camera2DOptions {
  width?: number;
  height?: number;
  near?: number;
  far?: number;
  zoom?: number;
  designWidth?: number;
  designHeight?: number;
  viewportMode?: Camera2DViewportMode;
}

export class Camera2D extends Component {
  static override UniqueCheckType =
    UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Camera2D');
  static editor = {
    fields: {
      width: { type: 'number', label: 'Width', min: 1, step: 1 },
      height: { type: 'number', label: 'Height', min: 1, step: 1 },
      zoom: { type: 'number', label: 'Zoom', min: 0.001, step: 0.1 },
      near: { type: 'number', label: 'Near', step: 0.01 },
      far: { type: 'number', label: 'Far', step: 1 },
      viewportMode: {
        type: 'select',
        label: 'Viewport Mode',
        options: [
          { label: 'Expand', value: 'expand' },
          { label: 'Fit', value: 'fit' },
          { label: 'Fill', value: 'fill' },
          { label: 'Fixed', value: 'fixed' },
        ],
      },
      designWidth: { type: 'number', label: 'Design Width', min: 1, step: 1 },
      designHeight: { type: 'number', label: 'Design Height', min: 1, step: 1 },
    },
  };

  private _projMatrix: Float32Array = mat4.identity() as Float32Array;
  private _projDirty = true;
  private _width = 800;
  private _height = 600;
  private _near = -1000;
  private _far = 1000;
  private _zoom = 1;
  private _designWidth = 800;
  private _designHeight = 600;
  private _viewportMode: Camera2DViewportMode = 'expand';

  constructor(options: Camera2DOptions = {}) {
    super('Camera2D');
    this.width  = options.width  ?? 800;
    this.height = options.height ?? 600;
    this.near   = options.near   ?? -1000;
    this.far    = options.far    ??  1000;
    this.zoom   = options.zoom   ?? 1;
    this.designWidth = options.designWidth ?? this.width;
    this.designHeight = options.designHeight ?? this.height;
    this.viewportMode = options.viewportMode ?? 'expand';
  }

  get width(): number { return this._width; }
  set width(value: number) {
    if (this._width === value) return;
    this._width = value;
    this.setDirty();
  }

  get height(): number { return this._height; }
  set height(value: number) {
    if (this._height === value) return;
    this._height = value;
    this.setDirty();
  }

  get near(): number { return this._near; }
  set near(value: number) {
    if (this._near === value) return;
    this._near = value;
    this.setDirty();
  }

  get far(): number { return this._far; }
  set far(value: number) {
    if (this._far === value) return;
    this._far = value;
    this.setDirty();
  }

  get zoom(): number { return this._zoom; }
  set zoom(value: number) {
    if (this._zoom === value) return;
    this._zoom = value;
    this.setDirty();
  }

  get designWidth(): number { return this._designWidth; }
  set designWidth(value: number) {
    if (this._designWidth === value) return;
    this._designWidth = value;
    this.setDirty();
  }

  get designHeight(): number { return this._designHeight; }
  set designHeight(value: number) {
    if (this._designHeight === value) return;
    this._designHeight = value;
    this.setDirty();
  }

  get viewportMode(): Camera2DViewportMode { return this._viewportMode; }
  set viewportMode(value: Camera2DViewportMode) {
    if (this._viewportMode === value) return;
    this._viewportMode = value;
    this.setDirty();
  }

  setDirty(): void {
    this._projDirty = true;
  }

  resize(width: number, height: number): void {
    const displayWidth = Math.max(1, Number(width) || 1);
    const displayHeight = Math.max(1, Number(height) || 1);
    if (this.viewportMode === 'fixed') {
      this.width = this.designWidth;
      this.height = this.designHeight;
      return;
    }

    const designAspect = this.designWidth / this.designHeight;
    const displayAspect = displayWidth / displayHeight;
    if (this.viewportMode === 'fill') {
      if (displayAspect > designAspect) {
        this.width = this.designWidth;
        this.height = this.designWidth / displayAspect;
      } else {
        this.width = this.designHeight * displayAspect;
        this.height = this.designHeight;
      }
      return;
    }

    if (displayAspect > designAspect) {
      this.width = this.designHeight * displayAspect;
      this.height = this.designHeight;
    } else {
      this.width = this.designWidth;
      this.height = this.designWidth / displayAspect;
    }
  }

  setViewportFit(options: {
    designWidth?: number;
    designHeight?: number;
    viewportMode?: Camera2DViewportMode;
  }): this {
    this.designWidth = Math.max(1, Number(options.designWidth ?? this.designWidth) || this.designWidth);
    this.designHeight = Math.max(1, Number(options.designHeight ?? this.designHeight) || this.designHeight);
    this.viewportMode = options.viewportMode ?? this.viewportMode;
    return this;
  }

  get projectionMatrix(): Float32Array {
    if (this._projDirty) {
      const hw = (this.width / 2) / this.zoom;
      const hh = (this.height / 2) / this.zoom;
      mat4.ortho(-hw, hw, -hh, hh, this.near, this.far, this._projMatrix);
      this._projDirty = false;
    }
    return this._projMatrix;
  }

  override clone(): Camera2D {
    const camera = new Camera2D({
      width: this.width,
      height: this.height,
      near: this.near,
      far: this.far,
      zoom: this.zoom,
      designWidth: this.designWidth,
      designHeight: this.designHeight,
      viewportMode: this.viewportMode,
    });
    camera.disabled = this.disabled;
    return camera;
  }
}
