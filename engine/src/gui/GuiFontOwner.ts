import {isGuiControl} from './GuiControlIdentity';
import type {BitmapFontData} from '../font/BitmapFontData';
import {buildBitmapFontGlyphs} from '../font/BitmapFontBuilder';
import {guiTextClusters,registerGuiTextGlyphs} from './rendering/GuiTextGlyphs';
import type {GuiRoot} from './components/GuiRoot';
import {type GuiInput} from './components/GuiInput';
import {guiInputCounterText} from './input/GuiInputAdornments';
import type {GuiElement} from './components/GuiElement';
import {resolveGuiSkin} from './GuiThemeResolve';

interface InputGlyphs {dirty:boolean; families:Map<string,Set<string>>; off:()=>void;}

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
    for(const state of this.roots.values())for(const glyph of state.families.get(family)??[])required.add(glyph);
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
  forRoot(root: GuiRoot, element: GuiElement = root.root): BitmapFontData {
    this.prepare();
    const requested = resolveGuiSkin(element).fontFamily ?? root.theme.fontFamily;
    const family = requested === 'sans-serif' ? this.defaultFamily : requested;
    let state=this.roots.get(root);
    if(!state){
      state={dirty:true,families:new Map(),off:()=>{}};
      const observed=state;state.off=root.onInvalidation(()=>{observed.dirty=true;});this.roots.set(root,state);
    }
    if(!state.families.has(family))state.dirty=true;
    let changed = state.dirty;
    if(state.dirty){
      const families=new Map<string,Set<string>>();
      const visit=(element:GuiElement):void=>{
        const requested = resolveGuiSkin(element).fontFamily ?? root.theme.fontFamily;
        const family = requested === 'sans-serif' ? this.defaultFamily : requested;
        let glyphs = families.get(family); if (!glyphs) {glyphs = new Set(); families.set(family, glyphs);}
        const texts = isGuiControl<GuiInput>(element, 'GuiInput') ? [element.displayValue,element.placeholder,guiInputCounterText(element)??''] : [];
        if (!(isGuiControl<GuiInput>(element, 'GuiInput'))) {
          for (const key of ['text', 'label', 'content', 'displayText'] as const) {
            if (key in element) {const text = (element as unknown as Record<string, unknown>)[key]; if (typeof text === 'string') texts.push(text);}
          }
          if ('visibleNodes' in element) for (const row of (element as unknown as {visibleNodes: readonly {node: {label: string}}[]}).visibleNodes) texts.push(row.node.label);
        }
        for(const text of texts)for(const glyph of guiTextClusters(text))if(!/^[\r\n]+$/u.test(glyph))glyphs.add(glyph);
        for(const child of element.children)visit(child);
      };
      visit(root.root);state.families=families;state.dirty=false;
    }
    let font = this.fonts.get(family);
    const coverage=font&&this.coverage.get(font);
    if(!font||[...state.families.get(family)??[]].some(glyph=>!coverage?.has(glyph))){
      // Build before replacement; old recorded/submitted draws retain their atlas through the GPU owner.
      const next=this.build(family);this.fonts.set(family,next);if(font)this.retire(font);font=next;
      changed = true;
    }
    if (changed) this.prune();return font;
  }
  forget(root: GuiRoot): void {this.roots.get(root)?.off();this.roots.delete(root);this.prune();}
  retain(roots: ReadonlySet<GuiRoot>): void {for(const root of this.roots.keys())if(!roots.has(root))this.forget(root);this.prune();}
  private prune(): void {
    const used = new Set([...this.roots.values()].flatMap(state=>[...state.families.keys()])); used.add(this.defaultFamily);
    for (const [family, font] of this.fonts) if (!used.has(family)) {this.fonts.delete(family); this.retire(font);}
  }
  destroy(): void {for (const font of this.fonts.values()) this.retire(font); this.fonts.clear(); for(const state of this.roots.values())state.off();this.roots.clear();}
}
