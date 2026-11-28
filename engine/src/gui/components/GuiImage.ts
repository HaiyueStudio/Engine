import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import type { SampleableTextureSource } from '../../material/BasicMaterial';
import { GuiDirtyFlags, GuiElementOptions } from '../GuiTypes';
import { GuiElement } from './GuiElement';

export type GuiImageSource = HTMLCanvasElement | HTMLImageElement | ImageBitmap | GPUTexture | SampleableTextureSource | null;

export interface GuiImageOptions extends GuiElementOptions {
  source?: GuiImageSource | undefined;
  sourceKey?: string | undefined;
  uv?: [number, number, number, number];
  tint?: string;
  fit?: 'fill'|'contain'|'cover'|'none';
}

export class GuiImage extends GuiElement {
  private static readonly __controlIdentityGuiImage = /* @__PURE__ */ (() => admitGuiControl(GuiImage.prototype, 'GuiImage', undefined, paintGuiImage))();
  static override readonly themeControlType: string = 'GuiImage';
  source: GuiImageSource;
  sourceKey: string | null;
  uv: [number, number, number, number];
  tint: string;
  fit:'fill'|'contain'|'cover'|'none';

  constructor(options: GuiImageOptions = {}) {
    super({ width: 64, height: 64, ...options });
    this.source = options.source ?? null;
    this.sourceKey = options.sourceKey ?? null;
    this.uv = options.uv ? [...options.uv] : [0, 0, 1, 1];
    this.tint = options.tint ?? '#ffffff';
    this.fit=options.fit??'fill';if(!['fill','contain','cover','none'].includes(this.fit))throw new TypeError('Invalid GUI image fit.');
  }

  setSource(source: GuiImageSource, sourceKey = this.sourceKey): void {
    if (this.source === source && this.sourceKey === sourceKey) return;
    this.source = source;
    this.sourceKey = sourceKey;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Layout);
  }

  setUv(uv: [number, number, number, number]): void {
    if (uv.every((value, index) => value === this.uv[index])) return;
    this.uv = [...uv];
    this.markDirty(GuiDirtyFlags.Visual);
  }

  setTint(tint: string): void {
    if (this.tint === tint) return;
    this.tint = tint;
    this.markDirty(GuiDirtyFlags.Visual);
  }
  setFit(fit:GuiImage['fit']):void {if(!['fill','contain','cover','none'].includes(fit))throw new TypeError('Invalid GUI image fit.');if(this.fit!==fit){this.fit=fit;this.markDirty(GuiDirtyFlags.Visual);}}
}

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiImage(context:GuiPaint.GuiControlPaintContext, image: GuiImage, theme: GuiPaint.GuiTheme): void {
    const source=image.source&&'texture'in image.source?image.source.texture:image.source;
    const sw=source?('naturalWidth'in source?source.naturalWidth:'width'in source?source.width:0)*image.uv[2]:0,sh=source?('naturalHeight'in source?source.naturalHeight:'height'in source?source.height:0)*image.uv[3]:0;
    const rect={...image.rect},uv=[...image.uv] as [number,number,number,number];
    if(sw>0&&sh>0&&image.fit!=='fill'){
      if(image.fit==='cover'){
        const scale=Math.max(rect.width/sw,rect.height/sh),uw=scale>0?rect.width/(sw*scale):0,vh=scale>0?rect.height/(sh*scale):0;
        uv[0]+=uv[2]*(1-uw)/2;uv[1]+=uv[3]*(1-vh)/2;uv[2]*=uw;uv[3]*=vh;
      }else {const scale=image.fit==='none'?1:Math.min(rect.width/sw,rect.height/sh),width=sw*scale,height=sh*scale;rect.x+=(rect.width-width)/2;rect.y+=(rect.height-height)/2;rect.width=width;rect.height=height;}
    }
    context.currentImageBatch.addImage({
      source: image.source,
      ...rect,
      uv,
      color: GuiPaint.colorToRgba(image.tint, theme.colors.text),
      clip: context.clipRect(image.rect),
    });
  }
