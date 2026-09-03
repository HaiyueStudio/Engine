import type { AnimationComposite, AnimationCompositeLayer, AnimationCompositeMode } from '@haiyue/animation-spec';
import { Component, Geometry2D } from '@haiyue/engine';
import { UniqueCheckType } from '@haiyue/engine/ecs';
import type { AssetHandle } from '@haiyue/engine/assets';
import type { AnimationTextRasterizer } from './AnimationTextRasterizer';

export interface AnimationVisual2DOptions {
  geometry: Geometry2D;
  color: readonly [number, number, number, number];
  /** Drawable-local multiply tint. Alpha is retained for pose parity but is not rendered. */
  multiplyColor?: readonly [number, number, number, number];
  /** Drawable-local alpha-aware screen tint. Alpha is retained for pose parity but is not rendered. */
  screenColor?: readonly [number, number, number, number];
  instanceId: number;
  nodeId: string;
  order: number;
  /** Source-neutral draw blend used by deformable meshes and other authored visuals. */
  blendMode?: AnimationVisual2DBlendMode;
  /** Declares whether filtered source texels are already premultiplied. */
  textureAlphaMode?: AnimationVisual2DTextureAlphaMode;
  /** Source-neutral back-face culling. False draws both triangle faces. */
  culling?: boolean;
  /** Optional explicit UV pairs for arbitrary textured triangle meshes. */
  uvs?: Float32Array;
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

export type AnimationVisual2DBlendMode = 'normal' | 'additive' | 'multiplicative' | 'screen';
export type AnimationVisual2DTextureAlphaMode = 'straight' | 'premultiplied' | 'rive-text';

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
  order: number;
  readonly blendMode: AnimationVisual2DBlendMode;
  readonly textureAlphaMode: AnimationVisual2DTextureAlphaMode;
  readonly culling: boolean;
  readonly uvs: Float32Array | null;
  readonly sourceOnly: boolean;
  readonly compositeLayers: readonly Readonly<AnimationCompositeLayer>[];
  readonly compositeKeys: readonly string[];
  /** Compatibility accessors for single-layer renderer diagnostics. */
  readonly compositeSource: string | undefined;
  readonly compositeKey: string | undefined;
  readonly compositeMode: AnimationCompositeMode | undefined;
  readonly uvRect: [number, number, number, number];
  readonly color: [number, number, number, number];
  readonly multiplyColor: [number, number, number, number];
  readonly screenColor: [number, number, number, number];
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
    this.blendMode = options.blendMode ?? 'normal';
    this.textureAlphaMode = options.textureAlphaMode ?? 'straight';
    if (options.culling !== undefined && typeof options.culling !== 'boolean') {
      throw new AnimationVisual2DConfigurationError(
        'E_ANIMATION_2D_CULLING_INVALID',
        'AnimationVisual2D culling must be boolean when present.',
        '$.culling',
      );
    }
    this.culling = options.culling ?? false;
    if (options.uvs && options.uvs.length !== options.geometry.positions.length) {
      throw new RangeError('AnimationVisual2D explicit UV count must match geometry positions.');
    }
    this.uvs = options.uvs ?? null;
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
    this.multiplyColor = drawableColor(options.multiplyColor ?? [1, 1, 1, 1], 'multiplyColor');
    this.screenColor = drawableColor(options.screenColor ?? [0, 0, 0, 0], 'screenColor');
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

  setOrder(order: number): void {
    if (!Number.isSafeInteger(order)) throw new RangeError('AnimationVisual2D order must be a safe integer.');
    this.order = order;
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

  /** Updates caller-owned drawable color state without replacing visual or GPU owners. */
  setDrawableColors(
    multiplyColor: readonly [number, number, number, number] | Float32Array,
    screenColor: readonly [number, number, number, number] | Float32Array,
  ): void {
    assertDrawableColor(multiplyColor, 'multiplyColor');
    assertDrawableColor(screenColor, 'screenColor');
    let changed = false;
    for (let index = 0; index < 4; index++) {
      if (this.multiplyColor[index] !== multiplyColor[index]) { this.multiplyColor[index] = multiplyColor[index]!; changed = true; }
      if (this.screenColor[index] !== screenColor[index]) { this.screenColor[index] = screenColor[index]!; changed = true; }
    }
    if (changed) this.revision++;
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
      multiplyColor: this.multiplyColor,
      screenColor: this.screenColor,
      instanceId: this.instanceId,
      nodeId: this.nodeId,
      order: this.order,
      blendMode: this.blendMode,
      textureAlphaMode: this.textureAlphaMode,
      culling: this.culling,
      ...(this.uvs ? { uvs: this.uvs } : {}),
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

export class AnimationVisual2DConfigurationError extends TypeError {
  constructor(
    readonly code:
      | 'E_ANIMATION_2D_CULLING_INVALID'
      | 'E_ANIMATION_2D_MULTIPLY_COLOR_INVALID'
      | 'E_ANIMATION_2D_SCREEN_COLOR_INVALID',
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'AnimationVisual2DConfigurationError';
  }
}

export interface AnimationDrawableColorPixelInput {
  readonly texture: readonly [number, number, number, number];
  readonly textureAlphaMode?: AnimationVisual2DTextureAlphaMode;
  readonly baseColor?: readonly [number, number, number, number];
  readonly multiplyColor?: readonly [number, number, number, number];
  readonly screenColor?: readonly [number, number, number, number];
  readonly coverage?: number;
  /** Mask setup intentionally ignores drawable tint RGB. */
  readonly outputMask?: boolean;
}

/** CPU oracle for the premultiplied fragment emitted before framebuffer compositing. */
export function composeAnimationDrawableColorPixel(input: AnimationDrawableColorPixelInput): [number, number, number, number] {
  const texture = drawableColor(input.texture, 'texture');
  const baseColor = drawableColor(input.baseColor ?? [1, 1, 1, 1], 'baseColor');
  const multiplyColor = drawableColor(input.multiplyColor ?? [1, 1, 1, 1], 'multiplyColor');
  const screenColor = drawableColor(input.screenColor ?? [0, 0, 0, 0], 'screenColor');
  const coverage = input.coverage ?? 1;
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1) throw new RangeError('Animation drawable coverage must be finite and within [0, 1].');
  const alpha = texture[3];
  const premultiplied = input.textureAlphaMode === 'premultiplied' || input.textureAlphaMode === 'rive-text'
    ? [texture[0], texture[1], texture[2]]
    : [texture[0] * alpha, texture[1] * alpha, texture[2] * alpha];
  if (!input.outputMask) {
    for (let index = 0; index < 3; index++) {
      const multiplied = premultiplied[index]! * multiplyColor[index]!;
      premultiplied[index] = multiplied + screenColor[index]! * alpha - multiplied * screenColor[index]!;
    }
  }
  return [
    premultiplied[0]! * baseColor[0] * baseColor[3] * coverage,
    premultiplied[1]! * baseColor[1] * baseColor[3] * coverage,
    premultiplied[2]! * baseColor[2] * baseColor[3] * coverage,
    alpha * baseColor[3] * coverage,
  ];
}

function drawableColor(
  value: readonly [number, number, number, number] | Float32Array,
  kind: 'multiplyColor' | 'screenColor' | 'texture' | 'baseColor',
): [number, number, number, number] {
  assertDrawableColor(value, kind);
  return [value[0]!, value[1]!, value[2]!, value[3]!];
}

function assertDrawableColor(
  value: readonly [number, number, number, number] | Float32Array,
  kind: 'multiplyColor' | 'screenColor' | 'texture' | 'baseColor',
): void {
  let valid = value.length === 4;
  for (let index = 0; valid && index < 4; index++) {
    const channel = value[index];
    valid = Number.isFinite(channel) && channel! >= 0 && channel! <= 1;
  }
  if (valid) return;
  if (kind === 'multiplyColor' || kind === 'screenColor') {
    throw new AnimationVisual2DConfigurationError(
      kind === 'multiplyColor' ? 'E_ANIMATION_2D_MULTIPLY_COLOR_INVALID' : 'E_ANIMATION_2D_SCREEN_COLOR_INVALID',
      `AnimationVisual2D ${kind} must contain four finite values within [0, 1].`,
      `$.${kind}`,
    );
  }
  throw new RangeError(`Animation drawable ${kind} must contain four finite values within [0, 1].`);
}

export class Animation2DPipelineCreationError extends Error {
  readonly code = 'E_ANIMATION_2D_PIPELINE_CREATION_FAILED' as const;
  readonly path = '$runtime.animation2D.pipeline' as const;

  constructor(readonly pipelineKey: string, readonly cause: unknown) {
    super(`Animation2D render pipeline creation failed for ${pipelineKey}.`);
    this.name = 'Animation2DPipelineCreationError';
  }
}

export function createAnimation2DPipeline<T>(pipelineKey: string, create: () => T): T {
  try {
    return create();
  } catch (cause) {
    throw new Animation2DPipelineCreationError(pipelineKey, cause);
  }
}

/**
 * Source-neutral 2D front faces are CCW in clip space. WebGPU normalizes the
 * viewport convention for front-face classification; callers must not add an
 * extra framebuffer-Y inversion. Real model/world reflections still reverse it.
 */
export const ANIMATION_2D_WEBGPU_FRONT_FACE = 'ccw' as const;

export function animation2DCullingPrimitive(culling: boolean): GPUPrimitiveState {
  return {
    topology: 'triangle-list',
    frontFace: ANIMATION_2D_WEBGPU_FRONT_FACE,
    cullMode: culling ? 'back' : 'none',
  };
}

export function animation2DCullingPipelineKey(culling: boolean): string {
  return culling ? `back:${ANIMATION_2D_WEBGPU_FRONT_FACE}` : `none:${ANIMATION_2D_WEBGPU_FRONT_FACE}`;
}
