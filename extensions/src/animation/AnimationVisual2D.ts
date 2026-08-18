import type { AnimationComposite, AnimationCompositeLayer, AnimationCompositeMode } from '@haiyue/animation-spec';
import { Component, Geometry2D } from '@haiyue/engine';
import { UniqueCheckType } from '@haiyue/engine/ecs';
import type { AssetHandle } from '@haiyue/engine/assets';
import type { AnimationTextRasterizer } from './AnimationTextRasterizer';

export interface AnimationVisual2DOptions {
  geometry: Geometry2D;
  color: readonly [number, number, number, number];
  instanceId: number;
  nodeId: string;
  order: number;
  sourceOnly?: boolean;
  composite?: Readonly<AnimationComposite>;
  texture?: GPUTexture | null;
  textureHandle?: AssetHandle<GPUTexture> | null;
  textMaterial?: AnimationTextRasterizer | null;
  /** Keeps sprites invisible until their asynchronous texture is ready. */
  requiresTexture?: boolean;
  uvRect?: readonly [number, number, number, number];
  gradient?: AnimationVisualGradient | null;
  effects?: readonly AnimationVisualEffect[];
}

export interface AnimationVisualGradient {
  kind: 'linear' | 'radial';
  start: [number, number];
  end: [number, number];
  /** Mutable packed offset,r,g,b,a tuples, bounded to eight stops. */
  stops: Float32Array;
  opacity: number;
}

export type AnimationVisualEffectKind = 'tint' | 'fill' | 'opacity' | 'color-matrix' | 'blur' | 'drop-shadow';

export interface AnimationVisualEffect {
  readonly kind: AnimationVisualEffectKind;
  /** Mutable, kind-specific sampled values owned by the animation runtime. */
  readonly values: Float32Array;
}

/** Runtime-private render item consumed by Animation2DRenderSystem. */
export class AnimationVisual2D extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('AnimationVisual2D');

  readonly geometry: Geometry2D;
  readonly instanceId: number;
  readonly nodeId: string;
  readonly nodeKey: string;
  readonly order: number;
  readonly sourceOnly: boolean;
  readonly compositeLayers: readonly Readonly<AnimationCompositeLayer>[];
  readonly compositeKeys: readonly string[];
  /** Compatibility accessors for single-layer renderer diagnostics. */
  readonly compositeSource: string | undefined;
  readonly compositeKey: string | undefined;
  readonly compositeMode: AnimationCompositeMode | undefined;
  readonly uvRect: [number, number, number, number];
  readonly color: [number, number, number, number];
  texture: GPUTexture | null;
  textureHandle: AssetHandle<GPUTexture> | null;
  readonly textMaterial: AnimationTextRasterizer | null;
  readonly requiresTexture: boolean;
  gradient: AnimationVisualGradient | null;
  readonly effects: readonly AnimationVisualEffect[];
  revision = 0;

  constructor(options: AnimationVisual2DOptions) {
    super('AnimationVisual2D');
    this.geometry = options.geometry;
    this.instanceId = options.instanceId;
    this.nodeId = options.nodeId;
    this.nodeKey = `${options.instanceId}:${options.nodeId}`;
    this.order = options.order;
    this.sourceOnly = options.sourceOnly ?? false;
    this.compositeLayers = Object.freeze(options.composite
      ? ('layers' in options.composite
        ? options.composite.layers.map(layer => ({ ...layer }))
        : [{ ...options.composite }])
      : []);
    this.compositeKeys = Object.freeze(this.compositeLayers.map(layer => `${options.instanceId}:${layer.source}`));
    this.compositeSource = this.compositeLayers[0]?.source;
    this.compositeKey = this.compositeKeys[0];
    this.compositeMode = this.compositeLayers[0]?.mode;
    this.uvRect = [...(options.uvRect ?? [0, 0, 1, 1])];
    this.color = [...options.color];
    this.texture = options.texture ?? null;
    this.textureHandle = options.textureHandle ?? null;
    this.textMaterial = options.textMaterial ?? null;
    this.requiresTexture = options.requiresTexture ?? false;
    this.gradient = options.gradient ?? null;
    this.effects = Object.freeze(options.effects ? [...options.effects] : []);
  }

  setTexture(texture: GPUTexture | null): void {
    if (this.texture === texture) return;
    this.texture = texture;
    this.revision++;
  }

  setTextureHandle(handle: AssetHandle<GPUTexture> | null): void {
    if (this.textureHandle === handle) return;
    this.textureHandle = handle;
    this.revision++;
  }

  setUvRect(value: readonly [number, number, number, number]): void {
    if (this.uvRect.every((current, index) => current === value[index])) return;
    this.uvRect[0] = value[0];
    this.uvRect[1] = value[1];
    this.uvRect[2] = value[2];
    this.uvRect[3] = value[3];
    this.revision++;
  }

  setCompositeExpansion(index: number, value: number): void {
    const layer = this.compositeLayers[index];
    if (!layer || layer.expansion === value) return;
    (layer as AnimationCompositeLayer).expansion = value;
    this.revision++;
  }

  resolveTexture(): GPUTexture | null {
    if (!this.textureHandle) return this.texture;
    try { return this.textureHandle.value; } catch { return null; }
  }

  override clone(): AnimationVisual2D {
    return new AnimationVisual2D({
      geometry: this.geometry,
      color: this.color,
      instanceId: this.instanceId,
      nodeId: this.nodeId,
      order: this.order,
      sourceOnly: this.sourceOnly,
      ...(this.compositeLayers.length === 0 ? {} : { composite: { layers: this.compositeLayers } }),
      texture: this.texture,
      textureHandle: this.textureHandle,
      textMaterial: this.textMaterial,
      requiresTexture: this.requiresTexture,
      uvRect: this.uvRect,
      gradient: this.gradient ? {
        kind: this.gradient.kind,
        start: [...this.gradient.start],
        end: [...this.gradient.end],
        stops: new Float32Array(this.gradient.stops),
        opacity: this.gradient.opacity,
      } : null,
      effects: this.effects.map(effect => ({ kind: effect.kind, values: new Float32Array(effect.values) })),
    });
  }
}
