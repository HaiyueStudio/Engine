import type {BitmapFontData} from '../font/BitmapFontData';
import {buildBitmapFontGlyphs} from '../font/BitmapFontBuilder';
import {guiTextClusters,registerGuiTextGlyphs} from './rendering/GuiTextGlyphs';
import type {GuiRoot} from './components/GuiRoot';
import {GuiInput} from './components/GuiInput';
import {guiInputCounterText} from './input/GuiInputAdornments';
import type {GuiElement} from './components/GuiElement';

interface InputGlyphs {family:string; dirty:boolean; glyphs:Set<string>; off:()=>void;}

export interface GuiAtlasOptions {
  readonly canvasFactory?: (width: number, height: number) => HTMLCanvasElement;
  readonly readAtlasPixels?: (canvas: HTMLCanvasElement) => Uint8Array;
  readonly chars?: string; readonly fontSize?: number; readonly fontFamily?: string; readonly padding?: number; readonly atlasSize?: number;
}
/** One atlas per active family. Removed/replaced families are retired by the GPU owner. */
export class GuiFontOwner {
  private readonly fonts = new Map<string, BitmapFontData>();
  private readonly roots = new Map<GuiRoot, InputGlyphs>();
  private readonly coverage = new WeakMap<BitmapFontData, ReadonlySet<string>>();
  private maxAtlasSize=4096;
  private readonly defaultFamily: string;
  constructor(private readonly options: GuiAtlasOptions, private readonly retire: (font: BitmapFontData) => void) {this.defaultFamily = options.fontFamily ?? 'sans-serif';}
  private build(family: string): BitmapFontData {
    const chars=this.options.chars ?? ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~年月日今天周一二三四五六重置旋转翻';
    const required=new Set(guiTextClusters(chars));
    for(const state of this.roots.values())if(state.family===family)for(const glyph of state.glyphs)required.add(glyph);
    let size=this.options.atlasSize??512;
    if(!Number.isSafeInteger(size)||size<=0)throw new RangeError('GUI atlasSize must be a positive integer.');
    for(;;){
      const built=buildBitmapFontGlyphs({
        ...(this.options.canvasFactory ? {canvasFactory: this.options.canvasFactory} : {}),
        fontSize:this.options.fontSize??32,fontFamily:family,padding:this.options.padding??4,atlasSize:size,
      },[...required]);
      if(built.glyphs.size===required.size || size>=this.maxAtlasSize){
        registerGuiTextGlyphs(built.data,built.glyphs,built.atlas);
        // Remember attempted coverage too, so a full bounded atlas does not rebuild every frame.
        this.coverage.set(built.data,required);
        return built.data;
      }
      size=Math.min(size*2,this.maxAtlasSize);
    }
  }
  prepare(refresh = false, maxAtlasSize?:number): BitmapFontData {
    if(maxAtlasSize!==undefined)this.maxAtlasSize=Math.min(4096,maxAtlasSize);
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
    let state=this.roots.get(root);
    if(!state){
      state={family,dirty:true,glyphs:new Set(),off:()=>{}};
      const observed=state;state.off=root.onInvalidation(()=>{observed.dirty=true;});this.roots.set(root,state);
    }
    if(state.family!==family){state.family=family;state.dirty=true;}
    if(state.dirty){
      const glyphs=new Set<string>();
      const visit=(element:GuiElement):void=>{
        if(element instanceof GuiInput)for(const text of [element.displayValue,element.placeholder,guiInputCounterText(element)??''])for(const glyph of guiTextClusters(text))if(!/^[\r\n]+$/u.test(glyph))glyphs.add(glyph);
        for(const child of element.children)visit(child);
      };
      visit(root.root);state.glyphs=glyphs;state.dirty=false;
    }
    let font = this.fonts.get(family);
    const coverage=font&&this.coverage.get(font);
    if(!font||[...state.glyphs].some(glyph=>!coverage?.has(glyph))){
      // Build before replacement; old recorded/submitted draws retain their atlas through the GPU owner.
      const next=this.build(family);this.fonts.set(family,next);if(font)this.retire(font);font=next;
    }
    this.prune();return font;
  }
  forget(root: GuiRoot): void {this.roots.get(root)?.off();this.roots.delete(root);this.prune();}
  retain(roots: ReadonlySet<GuiRoot>): void {for(const root of this.roots.keys())if(!roots.has(root))this.forget(root);this.prune();}
  private prune(): void {
    const used = new Set([...this.roots.values()].map(state=>state.family)); used.add(this.defaultFamily);
    for (const [family, font] of this.fonts) if (!used.has(family)) {this.fonts.delete(family); this.retire(font);}
  }
  destroy(): void {for (const font of this.fonts.values()) this.retire(font); this.fonts.clear(); for(const state of this.roots.values())state.off();this.roots.clear();}
}
