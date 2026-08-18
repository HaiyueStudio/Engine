import type { ColorValue } from '../color/Color';
import type { ColorLike } from '../color/ColorLike';
import { GEOMETRY3D_UV_CHANNEL_CAPACITY } from '../geometry/Geometry3D';
import type { MaterialTextureSource } from './BasicMaterial';
import { Material, type MaterialShaderContract } from './Material';
import {
  booleanValue,
  clampedNumber,
  enumValue,
  finiteNumber,
  materialColor,
  sameMaterialColor,
  sameSamplerDescriptor,
  samplerDescriptor,
} from './materialValidation';

export const TOON_MAX_LAYERS = 4;

export type ToonAlphaMode = 'opaque' | 'blend';

export interface ToonTextureMappingOptions {
  texCoord?: 0 | 1;
  offset?: readonly [number, number];
  rotation?: number;
  scale?: readonly [number, number];
}

export interface ToonTextureMapping {
  readonly texCoord: 0 | 1;
  readonly offset: readonly [number, number];
  readonly rotation: number;
  readonly scale: readonly [number, number];
}

export interface ToonLayerOptions {
  /** Inclusive lower bound of the shadow-aware light level, in [0, 1]. */
  minLight: number;
  color?: ColorLike;
  texture?: MaterialTextureSource;
  sampler?: GPUSamplerDescriptor | null;
  textureMapping?: ToonTextureMappingOptions;
}

export interface ToonLayer {
  readonly minLight: number;
  readonly color: ColorValue;
  readonly texture: MaterialTextureSource;
  readonly sampler: GPUSamplerDescriptor | null;
  readonly textureMapping: ToonTextureMapping;
}

export interface ToonMaterialState {
  baseColor?: ColorLike;
  /** Width of the smooth transition around a threshold. Zero produces a hard band. */
  bandSoftness?: number;
  layers?: readonly ToonLayerOptions[];
  alphaMode?: ToonAlphaMode;
  doubleSided?: boolean;
}

export type ToonMaterialOptions = ToonMaterialState;

export interface ToonCompatibilityContract {
  readonly maxTextureLayers: typeof TOON_MAX_LAYERS;
  readonly supportedUvSets: readonly [0, 1];
  readonly uvChannelCapacity: typeof GEOMETRY3D_UV_CHANNEL_CAPACITY;
  readonly samplerScope: 'per-layer';
  readonly runtimeImageMipmaps: 'generated-full-chain';
  readonly textureFormat: 'rgba8unorm-srgb';
}

export const TOON_COMPATIBILITY_CONTRACT: ToonCompatibilityContract = Object.freeze({
  maxTextureLayers: TOON_MAX_LAYERS,
  supportedUvSets: Object.freeze([0, 1] as [0, 1]),
  uvChannelCapacity: GEOMETRY3D_UV_CHANNEL_CAPACITY,
  samplerScope: 'per-layer',
  runtimeImageMipmaps: 'generated-full-chain',
  textureFormat: 'rgba8unorm-srgb',
});

export const TOON_SHADER_CONTRACT: MaterialShaderContract = Object.freeze({
  id: 'haiyue.material.toon',
  version: 1,
  shadingModel: 'toon',
  vertexSemantics: Object.freeze(['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1'] as const),
  features: Object.freeze([
    'shadow-aware-light-bands',
    'four-independent-layer-textures',
    'per-layer-uv-transform',
    'per-layer-sampler',
    'directional-shadow',
  ]),
});

const DEFAULT_LAYERS: readonly ToonLayerOptions[] = Object.freeze([
  Object.freeze({ minLight: 0, color: Object.freeze([0.35, 0.38, 0.5, 1] as const) }),
  Object.freeze({ minLight: 0.45, color: Object.freeze([0.72, 0.75, 0.85, 1] as const) }),
  Object.freeze({ minLight: 0.78, color: Object.freeze([1, 1, 1, 1] as const) }),
]);

export class ToonMaterial extends Material {
  readonly type = 'toon';

  private _baseColor: ColorValue;
  private _bandSoftness: number;
  private _layers: readonly ToonLayer[];
  private _alphaMode: ToonAlphaMode;
  private _doubleSided: boolean;

  constructor(options: ToonMaterialOptions = {}) {
    super();
    this._baseColor = materialColor(options.baseColor ?? [1, 1, 1, 1], 'ToonMaterial.baseColor');
    this._bandSoftness = clampedNumber(options.bandSoftness ?? 0, 0, 0.25, 'ToonMaterial.bandSoftness');
    this._layers = resolveLayers(options.layers ?? DEFAULT_LAYERS);
    this._alphaMode = enumValue(options.alphaMode ?? 'opaque', ['opaque', 'blend'], 'ToonMaterial.alphaMode');
    this._doubleSided = booleanValue(options.doubleSided ?? false, 'ToonMaterial.doubleSided');
  }

  get baseColor(): ColorValue { return this._baseColor; }
  set baseColor(value: ColorLike) {
    const next = materialColor(value, 'ToonMaterial.baseColor');
    if (sameMaterialColor(this._baseColor, next)) return;
    this._baseColor = next;
    this._stateChanged();
  }

  get bandSoftness(): number { return this._bandSoftness; }
  set bandSoftness(value: number) {
    const next = clampedNumber(value, 0, 0.25, 'ToonMaterial.bandSoftness');
    if (this._bandSoftness === next) return;
    this._bandSoftness = next;
    this._stateChanged();
  }

  get layers(): readonly ToonLayer[] { return this._layers; }
  set layers(value: readonly ToonLayerOptions[]) {
    const next = resolveLayers(value);
    if (sameLayers(this._layers, next)) return;
    this._layers = next;
    this._stateChanged();
  }

  get alphaMode(): ToonAlphaMode { return this._alphaMode; }
  set alphaMode(value: ToonAlphaMode) {
    const next = enumValue(value, ['opaque', 'blend'], 'ToonMaterial.alphaMode');
    if (this._alphaMode === next) return;
    this._alphaMode = next;
    this._stateChanged();
  }

  get doubleSided(): boolean { return this._doubleSided; }
  set doubleSided(value: boolean) {
    const next = booleanValue(value, 'ToonMaterial.doubleSided');
    if (this._doubleSided === next) return;
    this._doubleSided = next;
    this._stateChanged();
  }

  setLayer(index: number, layer: ToonLayerOptions): this {
    if (!Number.isInteger(index) || index < 0 || index >= this._layers.length) {
      throw new RangeError(`ToonMaterial layer index must be in [0, ${this._layers.length - 1}]; received ${index}.`);
    }
    const layers = this.snapshot().layers!;
    this.layers = layers.map((current, layerIndex) => layerIndex === index ? layer : current);
    return this;
  }

  applyState(state: ToonMaterialState): this {
    this.mutateState(() => {
      if (state.baseColor !== undefined) this.baseColor = state.baseColor;
      if (state.bandSoftness !== undefined) this.bandSoftness = state.bandSoftness;
      if (state.layers !== undefined) this.layers = state.layers;
      if (state.alphaMode !== undefined) this.alphaMode = state.alphaMode;
      if (state.doubleSided !== undefined) this.doubleSided = state.doubleSided;
    });
    return this;
  }

  snapshot(): ToonMaterialState {
    return Object.freeze({
      baseColor: this.baseColor.clone(),
      bandSoftness: this.bandSoftness,
      layers: Object.freeze(this.layers.map(layer => Object.freeze({
        minLight: layer.minLight,
        color: layer.color.clone(),
        texture: layer.texture,
        sampler: layer.sampler,
        textureMapping: layer.textureMapping,
      }))),
      alphaMode: this.alphaMode,
      doubleSided: this.doubleSided,
    });
  }

  clone(): ToonMaterial { return new ToonMaterial(this.snapshot()); }
  override getShaderContract(): MaterialShaderContract { return TOON_SHADER_CONTRACT; }
}

function resolveLayers(value: readonly ToonLayerOptions[]): readonly ToonLayer[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > TOON_MAX_LAYERS) {
    throw new RangeError(`ToonMaterial.layers must contain between 1 and ${TOON_MAX_LAYERS} layers.`);
  }
  const result: ToonLayer[] = [];
  for (let index = 0; index < value.length; index++) {
    const layer = value[index]!;
    if (!layer || typeof layer !== 'object') throw new TypeError(`ToonMaterial.layers[${index}] must be an object.`);
    const minLight = clampedNumber(layer.minLight, 0, 1, `ToonMaterial.layers[${index}].minLight`);
    if (index === 0 && minLight !== 0) throw new RangeError('ToonMaterial.layers[0].minLight must be 0.');
    if (index > 0 && minLight <= result[index - 1]!.minLight) {
      throw new RangeError('ToonMaterial layer minLight values must be strictly increasing.');
    }
    result.push(Object.freeze({
      minLight,
      color: materialColor(layer.color ?? [1, 1, 1, 1], `ToonMaterial.layers[${index}].color`),
      texture: layer.texture ?? null,
      sampler: samplerDescriptor(layer.sampler ?? null, `ToonMaterial.layers[${index}].sampler`),
      textureMapping: resolveTextureMapping(layer.textureMapping, `ToonMaterial.layers[${index}].textureMapping`),
    }));
  }
  return Object.freeze(result);
}

function resolveTextureMapping(value: ToonTextureMappingOptions = {}, property: string): ToonTextureMapping {
  const texCoord = value.texCoord ?? 0;
  if (texCoord !== 0 && texCoord !== 1) throw new RangeError(`${property}.texCoord must be 0 or 1.`);
  return Object.freeze({
    texCoord,
    offset: resolveVec2(value.offset ?? [0, 0], `${property}.offset`),
    rotation: finiteNumber(value.rotation ?? 0, `${property}.rotation`),
    scale: resolveVec2(value.scale ?? [1, 1], `${property}.scale`),
  });
}

function resolveVec2(value: readonly [number, number], property: string): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new RangeError(`${property} must contain exactly 2 numbers.`);
  return Object.freeze([
    finiteNumber(value[0], `${property}[0]`),
    finiteNumber(value[1], `${property}[1]`),
  ] as [number, number]);
}

function sameLayers(a: readonly ToonLayer[], b: readonly ToonLayer[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.minLight !== right.minLight || left.texture !== right.texture) return false;
    if (!sameMaterialColor(left.color, right.color) || !sameSamplerDescriptor(left.sampler, right.sampler)) return false;
    if (left.textureMapping.texCoord !== right.textureMapping.texCoord
      || left.textureMapping.rotation !== right.textureMapping.rotation
      || left.textureMapping.offset[0] !== right.textureMapping.offset[0]
      || left.textureMapping.offset[1] !== right.textureMapping.offset[1]
      || left.textureMapping.scale[0] !== right.textureMapping.scale[0]
      || left.textureMapping.scale[1] !== right.textureMapping.scale[1]) return false;
  }
  return true;
}
