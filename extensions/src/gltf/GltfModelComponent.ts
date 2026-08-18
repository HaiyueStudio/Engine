import { Component, Entity } from '@haiyue/engine';
import { UniqueCheckType } from '@haiyue/engine/ecs';
import type { GltfAnimationClip, GltfAnimationInfo, GltfAssetStats } from './GltfLoaderContract';
import type { GltfCompatibilityReport } from './GltfCompatibilityReport';

export interface GltfModelComponentOptions {
  src?: string;
  scene?: number;
  autoLoad?: boolean;
  clearPrevious?: boolean;
  baseColorFactor?: [number, number, number, number];
}

export type GltfModelStatus = 'idle' | 'loading' | 'loaded' | 'error';

export class GltfModelComponent extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('GltfModelComponent');
  static editor = {
    fields: {
      src: {
        type: 'asset-ref',
        label: 'Source',
        assetType: 'gltf',
        placeholder: 'glTF / GLB URL or asset key',
        validate: (value: unknown) => String(value ?? '').trim() ? null : 'Source is required.',
      },
      scene: {
        type: 'number',
        label: 'Scene Index',
        min: 0,
        step: 1,
        visibleWhen: (component: GltfModelComponent) => String(component.src).trim().length > 0,
      },
      autoLoad: { type: 'boolean', label: 'Auto Load' },
      clearPrevious: { type: 'boolean', label: 'Clear Previous' },
      baseColorFactor: {
        type: 'array',
        label: 'Fallback Color',
        rows: 2,
        validate: (value: unknown) => Array.isArray(value) && value.length === 4 ? null : 'Fallback Color must be [r, g, b, a].',
      },
    },
  };

  private _src = '';
  private _scene: number | null = null;
  private _sourceKey = '|';
  private _sourceKeyDirty = false;

  autoLoad: boolean;
  clearPrevious: boolean;
  baseColorFactor: [number, number, number, number];
  status: GltfModelStatus = 'idle';
  error: string | null = null;

  /** Runtime root inserted by GltfModelSystem. Do not serialize. */
  runtimeRoot: Entity | null = null;
  runtimeAnimations: GltfAnimationInfo[] = [];
  runtimeAnimationClips: GltfAnimationClip[] = [];
  runtimeAssetStats: GltfAssetStats | null = null;
  runtimeCompatibilityReport: GltfCompatibilityReport | null = null;
  runtimeMaterialVariants: readonly string[] = [];
  runtimeSourceKey = '';
  loadingSourceKey = '';

  constructor(options: GltfModelComponentOptions = {}) {
    super('GltfModelComponent');
    this.src = options.src ?? '';
    this.scene = options.scene ?? null;
    this.autoLoad = options.autoLoad ?? true;
    this.clearPrevious = options.clearPrevious ?? true;
    this.baseColorFactor = options.baseColorFactor
      ? [...options.baseColorFactor] as [number, number, number, number]
      : [1, 1, 1, 1];
  }

  get src(): string {
    return this._src;
  }

  set src(value: string) {
    if (this._src === value) return;
    this._src = value;
    this._sourceKeyDirty = true;
  }

  get scene(): number | null {
    return this._scene;
  }

  set scene(value: number | null) {
    if (this._scene === value) return;
    this._scene = value;
    this._sourceKeyDirty = true;
  }

  get sourceKey(): string {
    if (this._sourceKeyDirty) {
      this._sourceKey = `${this._src}|${this._scene ?? ''}`;
      this._sourceKeyDirty = false;
    }
    return this._sourceKey;
  }

  override clone(): GltfModelComponent {
    return new GltfModelComponent({
      src: this.src,
      ...(this.scene === null ? {} : { scene: this.scene }),
      autoLoad: this.autoLoad,
      clearPrevious: this.clearPrevious,
      baseColorFactor: this.baseColorFactor,
    });
  }
}
