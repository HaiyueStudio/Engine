import { Component } from '@haiyue/engine';
import { UniqueCheckType } from '@haiyue/engine/ecs';

export interface Spine2DComponentOptions {
  jsonUrl?: string;
  atlasUrl?: string;
  imageUrl?: string;
  imageUrls?: Record<string, string>;
  skin?: string;
  animation?: string;
  loop?: boolean;
  timeScale?: number;
  scale?: number;
  premultipliedAlpha?: boolean;
  debugMesh?: boolean;
  debugBones?: boolean;
  mixDuration?: number;
}

export type Spine2DStatus = 'idle' | 'loading' | 'loaded' | 'error';

export class Spine2DComponent extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Spine2DComponent');
  static editor = {
    fields: {
      jsonUrl: { type: 'text', label: 'Skeleton JSON URL' },
      atlasUrl: { type: 'text', label: 'Atlas URL' },
      imageUrl: { type: 'text', label: 'Image URL Override' },
      skin: { type: 'text', label: 'Skin' },
      animation: { type: 'text', label: 'Animation' },
      loop: { type: 'boolean', label: 'Loop' },
      timeScale: { type: 'number', label: 'Time Scale', step: 0.1 },
      scale: { type: 'number', label: 'Scale', min: 0.001, step: 0.1 },
      premultipliedAlpha: { type: 'boolean', label: 'Premultiplied Alpha' },
      debugMesh: { type: 'boolean', label: 'Debug Mesh' },
      debugBones: { type: 'boolean', label: 'Debug Bones' },
      mixDuration: { type: 'number', label: 'Mix Duration', min: 0, step: 0.05 },
    },
  };

  private _jsonUrl = '';
  private _atlasUrl = '';
  private _imageUrl = '';
  private _imageUrls: Record<string, string> = {};
  private _imageUrlsKey = '{}';
  private _skin = 'default';
  private _sourceKey = '';
  private _sourceKeyDirty = true;

  animation: string;
  loop: boolean;
  timeScale: number;
  scale: number;
  premultipliedAlpha: boolean;
  debugMesh: boolean;
  debugBones: boolean;
  mixDuration: number;

  status: Spine2DStatus = 'idle';
  error: string | null = null;
  elapsed = 0;
  previousAnimation = '';
  previousElapsed = 0;
  mixElapsed = 0;
  runtimeKey = '';
  loadingKey = '';

  constructor(options: Spine2DComponentOptions = {}) {
    super('Spine2DComponent');
    this.jsonUrl = options.jsonUrl ?? '';
    this.atlasUrl = options.atlasUrl ?? '';
    this.imageUrl = options.imageUrl ?? '';
    this.imageUrls = options.imageUrls ?? {};
    this.skin = options.skin ?? 'default';
    this.animation = options.animation ?? '';
    this.loop = options.loop ?? true;
    this.timeScale = options.timeScale ?? 1;
    this.scale = options.scale ?? 1;
    this.premultipliedAlpha = options.premultipliedAlpha ?? false;
    this.debugMesh = options.debugMesh ?? false;
    this.debugBones = options.debugBones ?? false;
    this.mixDuration = options.mixDuration ?? 0;
  }

  get jsonUrl(): string {
    return this._jsonUrl;
  }

  set jsonUrl(value: string) {
    if (this._jsonUrl === value) return;
    this._jsonUrl = value;
    this.invalidateSourceKey(false);
  }

  get atlasUrl(): string {
    return this._atlasUrl;
  }

  set atlasUrl(value: string) {
    if (this._atlasUrl === value) return;
    this._atlasUrl = value;
    this.invalidateSourceKey(false);
  }

  get imageUrl(): string {
    return this._imageUrl;
  }

  set imageUrl(value: string) {
    if (this._imageUrl === value) return;
    this._imageUrl = value;
    this.invalidateSourceKey(false);
  }

  get imageUrls(): Record<string, string> {
    return this._imageUrls;
  }

  set imageUrls(value: Record<string, string>) {
    if (this._imageUrls === value) return;
    this._imageUrls = value;
    this._imageUrlsKey = JSON.stringify(value);
    this.invalidateSourceKey(false);
  }

  get skin(): string {
    return this._skin;
  }

  set skin(value: string) {
    if (this._skin === value) return;
    this._skin = value;
    this.invalidateSourceKey(false);
  }

  get sourceKey(): string {
    if (this._sourceKeyDirty) {
      this._sourceKey = `${this._jsonUrl}|${this._atlasUrl}|${this._imageUrl}|${this._imageUrlsKey}|${this._skin}`;
      this._sourceKeyDirty = false;
    }
    return this._sourceKey;
  }

  invalidateSourceKey(refreshImageUrlsKey = true): this {
    if (refreshImageUrlsKey) this._imageUrlsKey = JSON.stringify(this._imageUrls);
    this._sourceKeyDirty = true;
    return this;
  }

  override clone(): Spine2DComponent {
    return new Spine2DComponent({
      jsonUrl: this.jsonUrl,
      atlasUrl: this.atlasUrl,
      imageUrl: this.imageUrl,
      imageUrls: { ...this.imageUrls },
      skin: this.skin,
      animation: this.animation,
      loop: this.loop,
      timeScale: this.timeScale,
      scale: this.scale,
      premultipliedAlpha: this.premultipliedAlpha,
      debugMesh: this.debugMesh,
      debugBones: this.debugBones,
      mixDuration: this.mixDuration,
    });
  }
}
