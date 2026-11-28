import {isGuiControl} from './GuiControlIdentity';
import type {BitmapFontData} from '../font/BitmapFontData';
import {buildBitmapFontGlyphs} from '../font/BitmapFontBuilder';
import {guiTextClusters,registerGuiTextGlyphs} from './rendering/GuiTextGlyphs';
import type {GuiRoot} from './components/GuiRoot';
import {type GuiInput} from './components/GuiInput';
import {guiInputCounterText} from './input/GuiInputAdornments';
import type {GuiElement} from './components/GuiElement';
import {resolveGuiSkin} from './GuiThemeResolve';
import {guiPaintOnly} from './GuiInvalidationState';
import {GuiGlyphCoverage} from './GuiGlyphCoverage';
import {guiThemeTreeActive} from './GuiThemeResolve';

interface InputGlyphs {dirty:boolean; families:Map<string,Set<string>>; checked:Map<string,BitmapFontData>; off:()=>void; primitive?:{family:string;coverage:GuiGlyphCoverage}|undefined;}

export interface GuiAtlasOptions {
  readonly canvasFactory?: (width: number, height: number) => HTMLCanvasElement;
  readonly readAtlasPixels?: (canvas: HTMLCanvasElement) => Uint8Array;
  readonly chars?: string; readonly fontSize?: number; readonly fontFamily?: string; readonly padding?: number; readonly atlasSize?: number;
}
/** One atlas per active family. Removed/replaced families are retired by the GPU owner. */
export class GuiFontOwner {
  private readonly requests = new Map<string,{family:string;size:number;weight:number;precise:boolean}>();
  private readonly fonts = new Map<string, BitmapFontData>();
  private readonly roots = new Map<GuiRoot, InputGlyphs>();
  private readonly coverage = new WeakMap<BitmapFontData, ReadonlySet<string>>();
  private maxAtlasSize=4096;
  private pixelRatio=1;
  private lastRequest:{family:string;weight:number;size:number;scalable:boolean;key:string}|undefined;
  private readonly defaultFamily: string;
  constructor(private readonly options: GuiAtlasOptions, private readonly retire: (font: BitmapFontData) => void) {this.defaultFamily = options.fontFamily ?? 'sans-serif';}
  setPixelRatio(ratio:number):void {const value=Number.isFinite(ratio)&&ratio>0?Math.min(3,Math.max(1,ratio)):1;if(value===this.pixelRatio)return;this.pixelRatio=value;for(const state of this.roots.values())state.dirty=true;}
  hasVariants(root:GuiRoot):boolean{return (this.roots.get(root)?.families.size??0)>1;}
  private build(family: string): BitmapFontData {
    const request=this.requests.get(family);
    const chars=this.options.chars ?? ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~年月日今天周一二三四五六重置旋转翻';
    const required=new Set(guiTextClusters(chars));if(request?.precise)required.add('…');
    for(const state of this.roots.values())for(const glyph of state.families.get(family)??[])required.add(glyph);
    let size=this.options.atlasSize??512;
    if(!Number.isSafeInteger(size)||size<=0)throw new RangeError('GUI atlasSize must be a positive integer.');
    for(;;){
      const built=buildBitmapFontGlyphs({
        ...(this.options.canvasFactory ? {canvasFactory: this.options.canvasFactory} : {}),
        fontSize:request?.size??this.options.fontSize??32,fontFamily:request?.family??family,fontWeight:String(request?.weight??400),metrics:request?.precise?'font':'ink',padding:this.options.padding??4,atlasSize:size,
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
    const skin=resolveGuiSkin(element);
    return this.forFamily(root,skin.fontFamily??root.theme.fontFamily,{fontWeight:skin.fontWeight??root.theme.fontWeight,fontSize:this.elementSize(element,skin.fontSize??root.theme.fontSize)});
  }
  /** Reuse the collector's already-resolved stock skin, without a second tree lookup. */
  forFamily(root:GuiRoot,requested:string,style:{fontWeight?:number|undefined;fontSize?:number|undefined}={}):BitmapFontData {
    this.prepare();
    const family = this.requestKey(requested,style.fontWeight??root.theme.fontWeight,style.fontSize??root.theme.fontSize,!!root.theme.density);
    let state=this.roots.get(root);
    if(!state){
      state={dirty:true,families:new Map(),checked:new Map(),off:()=>{}};
      const observed=state;state.off=root.onInvalidation(change=>{if(!guiPaintOnly(change))observed.dirty=true;});this.roots.set(root,state);
    }
    if(!state.families.has(family))state.dirty=true;
    let changed = state.dirty;
    if(state.dirty){
      const rootFamily=this.requestKey(root.theme.fontFamily,root.theme.fontWeight,root.theme.fontSize,!!root.theme.density);
      const primitive=state.primitive;
      const simple=!guiThemeTreeActive(root.root)&&family===rootFamily&&![...state.families.keys()].some(key=>key!==rootFamily);
      if(simple&&primitive?.family===rootFamily&&primitive.coverage.update()){
        state.checked.clear();state.dirty=false;
      }else{
      const coverage=simple?GuiGlyphCoverage.capture(root.root):null;
      if(coverage){state.families=new Map([[rootFamily,coverage.glyphs]]);state.primitive={family:rootFamily,coverage};state.checked.clear();state.dirty=false;}
      else{
      const families=new Map<string,Set<string>>();
      const visit=(element:GuiElement):void=>{
        const skin=resolveGuiSkin(element);
        const family=this.requestKey(skin.fontFamily??root.theme.fontFamily,skin.fontWeight??root.theme.fontWeight,this.elementSize(element,skin.fontSize??root.theme.fontSize),!!root.theme.density);
        let glyphs = families.get(family); if (!glyphs) {glyphs = new Set(); families.set(family, glyphs);}
        const texts = isGuiControl<GuiInput>(element, 'GuiInput') ? [element.displayValue,element.placeholder,element.prefix,element.suffix,element.helpText,guiInputCounterText(element)??''] : [];
        if (!(isGuiControl<GuiInput>(element, 'GuiInput'))) {
          for (const key of ['text', 'label', 'content', 'displayText', 'prefix', 'suffix', 'helpText'] as const) {
            if (key in element) {const text = (element as unknown as Record<string, unknown>)[key]; if (typeof text === 'string') texts.push(text);}
          }
          if ('visibleNodes' in element) for (const row of (element as unknown as {visibleNodes: readonly {node: {label: string}}[]}).visibleNodes) texts.push(row.node.label);
        }
        for(const text of texts)for(const glyph of guiTextClusters(text))if(!/^[\r\n]+$/u.test(glyph))glyphs.add(glyph);
        for(const child of element.children)visit(child);
      };
      visit(root.root);state.families=families;state.checked.clear();state.dirty=false;
      state.primitive=undefined;
      }
      }
    }
    let font = this.fonts.get(family);
    const coverage=font&&this.coverage.get(font);
    if(!font||state.checked.get(family)!==font&&[...state.families.get(family)??[]].some(glyph=>!coverage?.has(glyph))){
      // Build before replacement; old recorded/submitted draws retain their atlas through the GPU owner.
      const next=this.build(family);this.fonts.set(family,next);if(font)this.retire(font);font=next;
      changed = true;
    }
    state.checked.set(family,font);
    if (changed) this.prune();return font;
  }
  private elementSize(element:GuiElement,fallback:number):number {const size=Object.getOwnPropertyDescriptor(element,'fontSize')?.value;return typeof size==='number'&&Number.isFinite(size)&&size>=0?size:fallback;}
  private requestKey(requested:string,weight=400,fontSize=14,scalable=true):string {
    const family=requested==='sans-serif'?this.defaultFamily:requested;
    const dpr=this.pixelRatio;
    const size=scalable?Math.min(128,Math.max(this.options.fontSize??32,Math.ceil(fontSize*dpr/16)*16)):this.options.fontSize??32;
    if(!scalable&&weight===400&&size===(this.options.fontSize??32))return family;
    const last=this.lastRequest;if(last&&last.family===family&&last.weight===weight&&last.size===size&&last.scalable===scalable&&this.requests.has(last.key))return last.key;
    const key='@gui:'+family.length+':'+family+':'+weight+':'+size+':'+Number(scalable);if(!this.requests.has(key))this.requests.set(key,{family,weight,size,precise:scalable});this.lastRequest={family,weight,size,scalable,key};return key;
  }
  forget(root: GuiRoot): void {this.roots.get(root)?.off();this.roots.delete(root);this.prune();}
  retain(roots: ReadonlySet<GuiRoot>): void {for(const root of this.roots.keys())if(!roots.has(root))this.forget(root);this.prune();}
  private prune(): void {
    const used = new Set([...this.roots.values()].flatMap(state=>[...state.families.keys()])); used.add(this.defaultFamily);
    for (const [family, font] of this.fonts) if (!used.has(family)) {this.fonts.delete(family); this.requests.delete(family); this.retire(font);}
  }
  destroy(): void {for (const font of this.fonts.values()) this.retire(font); this.fonts.clear(); for(const state of this.roots.values())state.off();this.roots.clear();}
}
