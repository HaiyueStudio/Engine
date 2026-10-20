import type {BitmapFontData} from '../font/BitmapFontData';
import {buildBitmapFont} from '../font/BitmapFontBuilder';
import type {GuiRoot} from './components/GuiRoot';

export interface GuiAtlasOptions {
  readonly canvasFactory?: (width: number, height: number) => HTMLCanvasElement;
  readonly readAtlasPixels?: (canvas: HTMLCanvasElement) => Uint8Array;
  readonly chars?: string; readonly fontSize?: number; readonly fontFamily?: string; readonly padding?: number; readonly atlasSize?: number;
}
/** One atlas per active family. Removed/replaced families are retired by the GPU owner. */
export class GuiFontOwner {
  private readonly fonts = new Map<string, BitmapFontData>();
  private readonly roots = new Map<GuiRoot, string>();
  private readonly defaultFamily: string;
  constructor(private readonly options: GuiAtlasOptions, private readonly retire: (font: BitmapFontData) => void) {this.defaultFamily = options.fontFamily ?? 'sans-serif';}
  private build(family: string): BitmapFontData {
    return buildBitmapFont({
      ...(this.options.canvasFactory ? {canvasFactory: this.options.canvasFactory} : {}),
      chars: this.options.chars ?? ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~年月日今天周一二三四五六重置旋转翻',
      fontSize: this.options.fontSize ?? 32, fontFamily: family, padding: this.options.padding ?? 4, atlasSize: this.options.atlasSize ?? 512,
    }).data;
  }
  prepare(refresh = false): BitmapFontData {
    if (refresh && this.fonts.size) {
      // Build the entire replacement before retiring a single valid family.
      const next = new Map([...this.fonts.keys()].map(family => [family, this.build(family)]));
      const previous = [...this.fonts.values()]; this.fonts.clear();
      for (const [family, font] of next) this.fonts.set(family, font);
      for (const font of previous) this.retire(font);
    }
    let font = this.fonts.get(this.defaultFamily);
    if (!font) {font = this.build(this.defaultFamily); this.fonts.set(this.defaultFamily, font);}
    return font;
  }
  forRoot(root: GuiRoot): BitmapFontData {
    this.prepare();
    const family = root.theme.fontFamily === 'sans-serif' ? this.defaultFamily : root.theme.fontFamily;
    let font = this.fonts.get(family);
    if (!font) {font = this.build(family); this.fonts.set(family, font);}
    this.roots.set(root, family); this.prune(); return font;
  }
  forget(root: GuiRoot): void {this.roots.delete(root); this.prune();}
  retain(roots: ReadonlySet<GuiRoot>): void {for (const root of this.roots.keys()) if (!roots.has(root)) this.roots.delete(root); this.prune();}
  private prune(): void {
    const used = new Set(this.roots.values()); used.add(this.defaultFamily);
    for (const [family, font] of this.fonts) if (!used.has(family)) {this.fonts.delete(family); this.retire(font);}
  }
  destroy(): void {for (const font of this.fonts.values()) this.retire(font); this.fonts.clear(); this.roots.clear();}
}
