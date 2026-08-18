import type { SampleableTextureSource } from '../../material/BasicMaterial';
import { GuiDirtyFlags, GuiElementOptions } from '../GuiTypes';
import { GuiElement } from './GuiElement';

export type GuiImageSource = HTMLCanvasElement | HTMLImageElement | ImageBitmap | GPUTexture | SampleableTextureSource | null;

export interface GuiImageOptions extends GuiElementOptions {
  source?: GuiImageSource | undefined;
  sourceKey?: string | undefined;
  uv?: [number, number, number, number];
  tint?: string;
}

export class GuiImage extends GuiElement {
  source: GuiImageSource;
  sourceKey: string | null;
  uv: [number, number, number, number];
  tint: string;

  constructor(options: GuiImageOptions = {}) {
    super({ width: 64, height: 64, ...options });
    this.source = options.source ?? null;
    this.sourceKey = options.sourceKey ?? null;
    this.uv = options.uv ? [...options.uv] : [0, 0, 1, 1];
    this.tint = options.tint ?? '#ffffff';
  }

  setSource(source: GuiImageSource, sourceKey = this.sourceKey): void {
    if (this.source === source && this.sourceKey === sourceKey) return;
    this.source = source;
    this.sourceKey = sourceKey;
    this.markDirty(GuiDirtyFlags.Visual);
  }

  setUv(uv: [number, number, number, number]): void {
    this.uv = [...uv];
    this.markDirty(GuiDirtyFlags.Visual);
  }

  setTint(tint: string): void {
    if (this.tint === tint) return;
    this.tint = tint;
    this.markDirty(GuiDirtyFlags.Visual);
  }
}
