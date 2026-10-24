import {isGuiControl} from '../GuiControlIdentity';
import {guiControlPrototype,guiControlPainter,guiControlPainterFor} from '../GuiControlIdentity';
import {isGuiExternallyPainted} from '../GuiExternalPresentation';
import type {RenderCommandContext} from '../../core/RenderCommandContext';
import { type GuiScrollView } from '../components/GuiScrollView';
import { type GuiToast } from '../components/GuiToast';
import type { IEngine } from '../../core/IEngine';
import type { BitmapFontData } from '../../font/BitmapFontData';
import { type GuiButton } from '../components/GuiButton';
import { type GuiCheckbox } from '../components/GuiCheckbox';
import { GuiElement } from '../components/GuiElement';
import { type GuiInput } from '../components/GuiInput';
import { type GuiImage } from '../components/GuiImage';
import {type GuiNineSlice} from '../components/GuiNineSlice';
import {computeNineSlicePatches} from '../../geometry/NineSlice';
import type {GuiSkin, GuiNineSliceOptions} from '../GuiThemeTypes';
import { type GuiLabel } from '../components/GuiLabel';
import { type GuiModal } from '../components/GuiModal';
import { type GuiProgress } from '../components/GuiProgress';
import { type GuiRadio } from '../components/GuiRadio';
import { GuiRoot } from '../components/GuiRoot';
import { type GuiSelect } from '../components/GuiSelect';
import { type GuiSlider } from '../components/GuiSlider';
import { type GuiSwitch } from '../components/GuiSwitch';
import { type GuiTooltip } from '../components/GuiTooltip';
import { type GuiTree } from '../components/GuiTree';
import { GuiRect, GuiTheme } from '../GuiTypes';
import { parseGuiColor as colorToRgba, withGuiAlpha as withAlpha } from '../GuiColor';
import {guiPasswordRevealed} from '../input/GuiInputAdornments';
import { GuiBatch } from './GuiBatch';
import { GuiShapeRenderer } from './GuiShapeRenderer';
import { GuiTextBatch, measureGuiTextWidth } from './GuiTextBatch';
import { GuiTextRenderer } from './GuiTextRenderer';
import { GuiImageBatch } from './GuiImageBatch';
import { requiredItemAt } from '../../math/arrayAccess';
import { GuiImageRenderer } from './GuiImageRenderer';
import type { PipelineWarmupPlan } from '../../renderer/PipelineWarmup';
import {consumeGuiFontReload, registerGuiFontProvider, setGuiMeasureFont} from '../GuiMeasure';
import {isGuiLayoutHidden, isGuiLayoutManaged} from '../GuiLayoutState';
import {GuiFontOwner, type GuiAtlasOptions} from '../GuiFontOwner';
import type {GuiRenderSurface} from './GuiRenderSurface';
import type {GuiImageSource} from '../components/GuiImage';
import {guiInputPresentation,guiInputCaretVisible} from '../input/GuiInputPresentation';
import {GuiPaintPlan} from './GuiPaintPlan';
import {guiThemeTreeActive} from '../GuiThemeResolve';
import {guiContentBox} from '../GuiContent';
import {applyGuiOpacity} from './GuiOpacity';
import {guiImageSourceReady} from './GuiImageSources';
import {isGuiOverlayRoot} from './GuiOverlayRoots';

type GuiRendererFontOptions = GuiAtlasOptions;

type GuiElementConstructor<T extends GuiElement = GuiElement> = new (...args: never[]) => T;
type GuiElementRenderer<T extends GuiElement = GuiElement> = (element: T, theme: GuiTheme) => void;

interface FontBatches {textBatch: GuiTextBatch; popupTextBatch: GuiTextBatch; modalTextBatch: GuiTextBatch;}
interface GuiRootRenderCache extends FontBatches {
  extraFonts: Map<BitmapFontData, FontBatches>;
  usedFonts: Set<BitmapFontData>;
  plan: GuiPaintPlan;
  ordered: boolean;
  font: BitmapFontData | null;
  batch: GuiBatch;
  textBatch: GuiTextBatch;
  popupBatch: GuiBatch;
  popupTextBatch: GuiTextBatch;
  imageBatch: GuiImageBatch;
  popupImageBatch: GuiImageBatch;
  modalBatch: GuiBatch;
  modalTextBatch: GuiTextBatch;
  modalImageBatch: GuiImageBatch;
}

export class GuiRenderer {
  readonly batch = new GuiBatch();
  readonly textBatch = new GuiTextBatch();
  readonly popupBatch = new GuiBatch();
  readonly popupTextBatch = new GuiTextBatch();
  readonly imageBatch = new GuiImageBatch();
  readonly popupImageBatch = new GuiImageBatch();

  private shapeRenderer = new GuiShapeRenderer();
  private textRenderer: GuiTextRenderer;
  private imageRenderer = new GuiImageRenderer();
  private prepared = false;
  private preparedDevice: GPUDevice | null = null;
  private needsRebuild = true;
  private defaultFont: BitmapFontData | null = null;
  private currentFont: BitmapFontData | null = null;
  private readonly resolvedStyles = new Map<GuiElement, GuiSkin>();
  private currentRoot: GuiRoot | null = null;
  private currentCache: GuiRootRenderCache | null = null;
  private currentLayer: 0 | 2 = 0;
  private readonly fontOwner: GuiFontOwner;
  private get activeFont(): BitmapFontData | null {return this.currentFont ?? (this.prepared ? this.fontOwner.prepare() : this.defaultFont);}
  private readonly elementRenderers = new Map<Function, GuiElementRenderer>();
  private readonly modalRenderer = (element: GuiElement, theme: GuiTheme): void => {guiControlPainterFor(element,'GuiModal')?.(this.controlPaint,element,theme);};
  private readonly rootCaches = new Map<GuiRoot, GuiRootRenderCache>();
  private activeRootCaches: GuiRootRenderCache[] = [];
  private currentBatch = this.batch;
  private currentTextBatch = this.textBatch;
  private currentPopupBatch = this.popupBatch;
  private currentPopupTextBatch = this.popupTextBatch;
  private currentPopupImageBatch = this.popupImageBatch;
  private currentImageBatch = this.imageBatch;
  private currentModalBatch = this.batch;
  private currentModalTextBatch = this.textBatch;
  private currentModalImageBatch = this.imageBatch;
  private readonly fontOptions: GuiRendererFontOptions;

  private readonly builtinElementRenderers=new WeakMap<object,GuiElementRenderer>();
  private readonly controlPaint=this.createControlPaintContext();

  constructor(fontOptions: GuiRendererFontOptions = {}) {
    this.fontOptions = Object.freeze({ ...fontOptions });
    this.textRenderer = new GuiTextRenderer(fontOptions.readAtlasPixels);
    this.fontOwner = new GuiFontOwner(this.fontOptions, font => this.textRenderer.releaseFont(font));
    registerGuiFontProvider(this, (root, element) => this.fontOwner.forRoot(root, element), root => this.fontOwner.forget(root));
  }

  registerElementRenderer<T extends GuiElement>(constructor: GuiElementConstructor<T>, renderer: GuiElementRenderer<T>): void {
    this.elementRenderers.set(constructor, renderer as GuiElementRenderer);
  }


private addToast(toast: GuiToast, theme: GuiTheme): void {guiControlPainterFor(toast,'GuiToast')?.(this.controlPaint,toast,theme);}
private addImage(image: GuiImage, theme: GuiTheme): void {guiControlPainterFor(image,'GuiImage')?.(this.controlPaint,image,theme);}
private addNineSlice(image: GuiNineSlice): void {guiControlPainterFor(image,'GuiNineSlice')?.(this.controlPaint,image,undefined!);}
private addButton(button: GuiButton, theme: GuiTheme): void {guiControlPainterFor(button,'GuiButton')?.(this.controlPaint,button,theme);}
private addLabel(label: GuiLabel, theme: GuiTheme): void {guiControlPainterFor(label,'GuiLabel')?.(this.controlPaint,label,theme);}
private addModal(modal: GuiModal, theme: GuiTheme): void {guiControlPainterFor(modal,'GuiModal')?.(this.controlPaint,modal,theme);}
private addInput(input: GuiInput, theme: GuiTheme): void {guiControlPainterFor(input,'GuiInput')?.(this.controlPaint,input,theme);}
private addSelect(select: GuiSelect, theme: GuiTheme): void {guiControlPainterFor(select,'GuiSelect')?.(this.controlPaint,select,theme);}
private addTooltip(tooltip: GuiTooltip, theme: GuiTheme): void {guiControlPainterFor(tooltip,'GuiTooltip')?.(this.controlPaint,tooltip,theme);}
private addTree(tree: GuiTree, theme: GuiTheme): void {guiControlPainterFor(tree,'GuiTree')?.(this.controlPaint,tree,theme);}
private addCheckbox(checkbox: GuiCheckbox, theme: GuiTheme): void {guiControlPainterFor(checkbox,'GuiCheckbox')?.(this.controlPaint,checkbox,theme);}
private addRadio(radio: GuiRadio, theme: GuiTheme): void {guiControlPainterFor(radio,'GuiRadio')?.(this.controlPaint,radio,theme);}
private addSwitch(control: GuiSwitch, theme: GuiTheme): void {guiControlPainterFor(control,'GuiSwitch')?.(this.controlPaint,control,theme);}
private addProgress(progress: GuiProgress, theme: GuiTheme): void {guiControlPainterFor(progress,'GuiProgress')?.(this.controlPaint,progress,theme);}
private addSlider(slider: GuiSlider, theme: GuiTheme): void {guiControlPainterFor(slider,'GuiSlider')?.(this.controlPaint,slider,theme);}

  private createControlPaintContext() {
    const owner=this;
    return {
      get activeFont(){return owner.activeFont;},
      addCenteredText:owner.addCenteredText.bind(owner),
      addPopupRect:owner.addPopupRect.bind(owner),
      addPopupText:owner.addPopupText.bind(owner),
      addRect:owner.addRect.bind(owner),
      addSkinPatches:owner.addSkinPatches.bind(owner),
      addText:owner.addText.bind(owner),
      clipRect:owner.clipRect.bind(owner),
      get currentBatch(){return owner.currentBatch;},
      get currentClip(){return owner.currentClip;},
      set currentClip(value:GuiRect|undefined){owner.currentClip=value;},
      get currentImageBatch(){return owner.currentImageBatch;},
      get currentPopupBatch(){return owner.currentPopupBatch;},
      get currentPopupImageBatch(){return owner.currentPopupImageBatch;},
      get currentPopupTextBatch(){return owner.currentPopupTextBatch;},
      get currentTextBatch(){return owner.currentTextBatch;},
      measureTextLineHeight:owner.measureTextLineHeight.bind(owner),
      measureTextWidth:owner.measureTextWidth.bind(owner),
      styleFor:owner.styleFor.bind(owner),
    };
  }
  prepare(engine: IEngine): void {
    const refresh = consumeGuiFontReload(this);
    if (this.prepared && this.preparedDevice === engine.device) {
      if (refresh) {this.defaultFont = this.fontOwner.prepare(true,engine.device.limits?.maxTextureDimension2D); setGuiMeasureFont(this, this.defaultFont); this.needsRebuild = true;}
      return;
    }
    if (this.prepared) this.destroy();
    try {
      this.shapeRenderer.prepare(engine);
      this.textRenderer.prepare(engine);
      this.imageRenderer.prepare(engine);
      this.defaultFont = this.fontOwner.prepare(false,engine.device.limits?.maxTextureDimension2D);
      setGuiMeasureFont(this, this.defaultFont);
      this.preparedDevice = engine.device;
      this.prepared = true;
    } catch (error) {
      this.shapeRenderer.destroy();
      this.textRenderer.destroy();
      this.imageRenderer.destroy();
      this.preparedDevice = null;
      this.prepared = false;
      this.defaultFont = null;
      throw error;
    }
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan, engine: IEngine): void {
    this.prepare(engine);
    for (const renderer of [this.shapeRenderer, this.textRenderer, this.imageRenderer]) {
      renderer.reverseZ = engine.reverseZ;
      renderer.msaaSamples = engine.msaaSamples;
      renderer.contributePipelineWarmup(plan);
    }
  }

  measureTextWidth(text: string, fontSize: number, root?: GuiRoot, element?: GuiElement): number {
    const font = root && this.prepared ? this.fontOwner.forRoot(root, element) : this.activeFont;
    return font ? measureGuiTextWidth(text, font, fontSize) : text.length * fontSize * 0.55;
  }

  measureTextLineHeight(fontSize:number,root?:GuiRoot,element?:GuiElement):number {
    const font=root&&this.prepared?this.fontOwner.forRoot(root,element):this.activeFont;
    return font?font.lineHeight/font.size*fontSize:fontSize*1.2;
  }

  markDirty(): void {
    this.needsRebuild = true;
  }

  destroy(): void {
    for (const cache of this.rootCaches.values()) this.releaseRootCache(cache);
    this.rootCaches.clear();
    this.activeRootCaches = [];
    this.shapeRenderer.destroy();
    this.fontOwner.destroy();
    this.textRenderer.destroy();
    this.imageRenderer.destroy();
    this.prepared = false;
    this.preparedDevice = null;
    this.needsRebuild = true;
    this.defaultFont = null;
    this.currentFont = null;
    this.currentRoot = null; this.currentCache = null;
    this.resolvedStyles.clear();
    setGuiMeasureFont(this, null);
  }

  invalidateImageSource(source:GuiImageSource):void {this.imageRenderer.invalidateSource(source);}

  render(
    passEncoder: GPURenderPassEncoder,
    roots: Iterable<GuiRoot>,
    engine: IEngine,
    reverseZ = engine.reverseZ,
    sampleCount: 1 | 4 = engine.msaaSamples,
    surface: GuiRenderSurface | null = null,
    context?:RenderCommandContext,
  ): void {
    this.prepare(engine);
    this.shapeRenderer.surface = surface; this.textRenderer.surface = surface; this.imageRenderer.surface = surface;
    this.shapeRenderer.reverseZ = reverseZ;
    this.shapeRenderer.msaaSamples = sampleCount;
    this.textRenderer.reverseZ = reverseZ;
    this.textRenderer.msaaSamples = sampleCount;
    this.imageRenderer.reverseZ = reverseZ;
    this.imageRenderer.msaaSamples = sampleCount;

    const rootList = Array.from(roots);
    this.prepareRootCaches(rootList);

    const ordinary = this.activeRootCaches.filter((_, index) => !isGuiOverlayRoot(rootList[index]!));
    const overlays = this.activeRootCaches.filter((_, index) => isGuiOverlayRoot(rootList[index]!));
    for (const layer of [0, 1, 2] as const) for (const cache of ordinary) this.renderLayer(passEncoder, cache, layer, context);
    for (const cache of overlays) for (const layer of [0, 1, 2] as const) this.renderLayer(passEncoder, cache, layer, context);
  }
  private renderLayer(pass: GPURenderPassEncoder, cache: GuiRootRenderCache, layer: 0 | 1 | 2, context?: RenderCommandContext): void {
    if (cache.ordered) {this.renderPlan(pass, cache, layer, context); if (layer === 2) this.renderPlan(pass, cache, 3, context); return;}
    const batch = layer === 0 ? cache.batch : layer === 1 ? cache.popupBatch : cache.modalBatch;
    const image = layer === 0 ? cache.imageBatch : layer === 1 ? cache.popupImageBatch : cache.modalImageBatch;
    const text = layer === 0 ? cache.textBatch : layer === 1 ? cache.popupTextBatch : cache.modalTextBatch;
    this.shapeRenderer.render(pass, batch, context); this.imageRenderer.render(pass, image, context);
    if (cache.font) this.textRenderer.render(pass, text, cache.font, context);
  }

  private prepareRootCaches(roots: GuiRoot[]): void {
    const activeRoots = new Set(roots);
    this.fontOwner.retain(activeRoots);
    for (const [root, cache] of this.rootCaches) {
      if (activeRoots.has(root)) continue;
      this.releaseRootCache(cache);
      this.rootCaches.delete(root);
    }
    this.activeRootCaches = roots.map(root => {
      const cache = this.getRootCache(root);
      const font = this.fontOwner.forRoot(root), changed = font !== cache.font; cache.font = font;
      if (this.needsRebuild || root.dirty || changed) this.rebuildRoot(root, cache);
      return cache;
    });
    this.needsRebuild = false;
  }

  private getRootCache(root: GuiRoot): GuiRootRenderCache {
    let cache = this.rootCaches.get(root);
    if (cache) return cache;
    cache = {
      extraFonts: new Map(), usedFonts: new Set(), plan: new GuiPaintPlan(), ordered: false,
      font: this.prepared ? this.fontOwner.forRoot(root) : this.defaultFont,
      batch: new GuiBatch(),
      textBatch: new GuiTextBatch(),
      popupBatch: new GuiBatch(),
      popupTextBatch: new GuiTextBatch(),
      imageBatch: new GuiImageBatch(),
      popupImageBatch: new GuiImageBatch(),
      modalBatch: new GuiBatch(),
      modalTextBatch: new GuiTextBatch(),
      modalImageBatch: new GuiImageBatch(),
    };
    this.rootCaches.set(root, cache);
    return cache;
  }

  private rebuildRoot(root: GuiRoot, cache: GuiRootRenderCache): void {
    this.resolvedStyles.clear();
    this.currentRoot = root; this.currentCache = cache; this.currentLayer = 0;
    cache.ordered = guiThemeTreeActive(root.root); cache.plan.clear(); cache.usedFonts.clear();
    for (const batches of cache.extraFonts.values()) for (const batch of [batches.textBatch, batches.popupTextBatch, batches.modalTextBatch]) batch.clear();
    this.currentFont = cache.font;
    cache.batch.clear();
    cache.textBatch.clear();
    cache.popupBatch.clear();
    cache.popupTextBatch.clear();
    cache.imageBatch.clear();
    cache.popupImageBatch.clear();
    cache.modalBatch.clear();
    cache.modalTextBatch.clear();
    cache.modalImageBatch.clear();
    this.currentBatch = cache.batch;
    this.currentTextBatch = cache.textBatch;
    this.currentPopupBatch = cache.popupBatch;
    this.currentPopupTextBatch = cache.popupTextBatch;
    this.currentPopupImageBatch = cache.popupImageBatch;
    this.currentImageBatch = cache.imageBatch;
    this.currentModalBatch = cache.modalBatch;
    this.currentModalTextBatch = cache.modalTextBatch;
    this.currentModalImageBatch = cache.modalImageBatch;
    this.collectElement(root.root, root.theme);
    cache.batch.rebuild();
    cache.popupBatch.rebuild();
    cache.imageBatch.rebuild();
    cache.popupImageBatch.rebuild();
    cache.modalBatch.rebuild();
    cache.modalImageBatch.rebuild();
    for (const batch of [cache.imageBatch, cache.popupImageBatch, cache.modalImageBatch]) this.imageRenderer.syncBatch(batch);
    if (cache.font) {cache.textBatch.rebuild(cache.font); cache.popupTextBatch.rebuild(cache.font); cache.modalTextBatch.rebuild(cache.font);}
    for (const [font, batches] of cache.extraFonts) {
      if (!cache.usedFonts.has(font)) {
        for (const batch of [batches.textBatch, batches.popupTextBatch, batches.modalTextBatch]) this.textRenderer.releaseBatch(batch);
        cache.extraFonts.delete(font);
      } else {batches.textBatch.rebuild(font); batches.popupTextBatch.rebuild(font); batches.modalTextBatch.rebuild(font);}
    }
    if (cache.ordered) cache.plan.compile();
    this.resetCurrentBatches();
    this.currentFont = null;
    this.resolvedStyles.clear();
    this.currentRoot = null; this.currentCache = null;
  }

  private releaseRootCache(cache: GuiRootRenderCache): void {
    for (const batches of cache.extraFonts.values()) for (const batch of [batches.textBatch, batches.popupTextBatch, batches.modalTextBatch]) this.textRenderer.releaseBatch(batch);
    cache.extraFonts.clear(); cache.usedFonts.clear(); cache.plan.clear();
    this.shapeRenderer.releaseBatch(cache.batch);
    this.shapeRenderer.releaseBatch(cache.popupBatch);
    this.textRenderer.releaseBatch(cache.textBatch);
    this.textRenderer.releaseBatch(cache.popupTextBatch);
    this.imageRenderer.releaseBatch(cache.imageBatch);
    this.imageRenderer.releaseBatch(cache.popupImageBatch);
    this.shapeRenderer.releaseBatch(cache.modalBatch);
    this.textRenderer.releaseBatch(cache.modalTextBatch);
    this.imageRenderer.releaseBatch(cache.modalImageBatch);
    cache.batch.clear({ releaseVertexData: true });
    cache.popupBatch.clear({ releaseVertexData: true });
    cache.textBatch.clear();
    cache.popupTextBatch.clear();
    cache.imageBatch.clear();
    cache.popupImageBatch.clear();
    cache.modalBatch.clear({ releaseVertexData: true });
    cache.modalTextBatch.clear();
    cache.modalImageBatch.clear();
  }

  private resetCurrentBatches(): void {
    this.currentBatch = this.batch;
    this.currentTextBatch = this.textBatch;
    this.currentPopupBatch = this.popupBatch;
    this.currentPopupTextBatch = this.popupTextBatch;
    this.currentPopupImageBatch = this.popupImageBatch;
    this.currentImageBatch = this.imageBatch;
    this.currentModalBatch = this.batch;
    this.currentModalTextBatch = this.textBatch;
    this.currentModalImageBatch = this.imageBatch;
  }

  private currentClip: GuiRect | undefined;

  private collectElement(element: GuiElement, theme: GuiTheme): void {
    if (!element.visible || isGuiLayoutHidden(element)) return;
    const skin = this.styleFor(element);
    theme = {...theme, fontFamily: skin.fontFamily ?? theme.fontFamily, fontSize: skin.fontSize ?? theme.fontSize,
      colors: {...theme.colors, ...skin.palette, ...(skin.color !== undefined ? {text: skin.color} : {})}};
    const previousFont = this.currentFont, previousText = this.currentTextBatch, previousPopupText = this.currentPopupTextBatch, previousModalText = this.currentModalTextBatch;
    if (this.currentRoot && this.currentCache && this.prepared) {
      const font = this.fontOwner.forRoot(this.currentRoot, element), cache = this.currentCache;
      cache.usedFonts.add(font); this.currentFont = font;
      let batches: FontBatches = cache;
      if (font !== cache.font) {
        let extra = cache.extraFonts.get(font);
        if (!extra) {extra = {textBatch: new GuiTextBatch(), popupTextBatch: new GuiTextBatch(), modalTextBatch: new GuiTextBatch()}; cache.extraFonts.set(font, extra);}
        batches = extra;
      }
      this.currentTextBatch = this.currentLayer === 2 ? batches.modalTextBatch : batches.textBatch;
      this.currentPopupTextBatch = batches.popupTextBatch; this.currentModalTextBatch = batches.modalTextBatch;
    }
    try {this.collectStyledElement(element, theme);}
    finally {this.currentFont = previousFont; this.currentTextBatch = previousText; this.currentPopupTextBatch = previousPopupText; this.currentModalTextBatch = previousModalText;}
  }

  private collectStyledElement(element: GuiElement, theme: GuiTheme): void {
    if (isGuiControl<GuiToast>(element, 'GuiToast')) {
      const shape = this.currentPopupBatch.commands.length, image = this.currentPopupImageBatch.commands.length, text = this.currentPopupTextBatch.commands.length;
      guiControlPainterFor(element,'GuiToast')?.(this.controlPaint,element,theme);
      if (this.currentCache?.ordered) {this.currentCache.plan.shapes(this.currentPopupBatch, shape, 1); this.currentCache.plan.images(this.currentPopupImageBatch, image, 1); this.currentCache.plan.text(this.currentPopupTextBatch, this.currentFont, text, 1);}
      return;
    }
    if (isGuiControl<GuiModal>(element, 'GuiModal')) {
      const previousClip = this.currentClip;
      this.currentClip = undefined;
      const previousBatch = this.currentBatch;
      const previousTextBatch = this.currentTextBatch;
      const previousImageBatch = this.currentImageBatch;
      const previousLayer = this.currentLayer; this.currentLayer = 2;
      this.currentBatch = this.currentModalBatch;
      this.currentTextBatch = this.currentModalTextBatch;
      this.currentImageBatch = this.currentModalImageBatch;
      this.addElementShapes(element, theme);
      for (const child of element.children) this.collectElement(child, theme);
      this.currentClip = previousClip;
      this.currentBatch = previousBatch;
      this.currentTextBatch = previousTextBatch;
      this.currentImageBatch = previousImageBatch;
      this.currentLayer = previousLayer;
      return;
    }
    this.addElementShapes(element, theme);
    const previousClip = this.currentClip;
    if (isGuiControl<GuiScrollView>(element, 'GuiScrollView')) this.currentClip = this.clipRect(element.rect);
    for (const child of element.children) this.collectElement(child, theme);
    if (isGuiControl<GuiScrollView>(element, 'GuiScrollView') && element.showScrollbar && element.maxScrollY > 0) {
      const first = this.currentBatch.commands.length;
      const r = element.rect, height = Math.min(r.height, Math.max(24, r.height*r.height/element.contentHeight));
      this.addRect(r.x+r.width-4,r.y+(r.height-height)*element.scrollY/element.maxScrollY,3,height,1.5,colorToRgba(element.getResolvedStyle().borderColor,theme.colors.border));
      if (this.currentCache?.ordered) this.currentCache.plan.shapes(this.currentBatch, first, this.currentLayer);
    }
    this.currentClip = previousClip;
  }

  private addElementShapes(element: GuiElement, theme: GuiTheme): void {
    if(isGuiExternallyPainted(element))return;
    if (isGuiControl<GuiTooltip>(element, 'GuiTooltip') && (!element.active || !element.content)) return;
    const skin = this.styleFor(element);
    if (isGuiControl<GuiModal>(element, 'GuiModal') && this.getElementRenderer(element) === this.modalRenderer) {
      const first = this.currentBatch.commands.length;
      this.addRect(element.rect.x, element.rect.y, element.rect.width, element.rect.height, 0,
        withAlpha(colorToRgba(element.backdropColor, 'rgba(15,23,42,0.48)'), skin.opacity ?? 1));
      if (this.currentCache?.ordered) this.currentCache.plan.shapes(this.currentBatch, first, this.currentLayer);
    }
    if (skin.nineSlice && !(isGuiControl<GuiNineSlice>(element, 'GuiNineSlice'))) {
      const popup = isGuiControl<GuiTooltip>(element, 'GuiTooltip'), batch = popup ? this.currentPopupImageBatch : this.currentImageBatch;
      const first = batch.commands.length;
      this.addSkinPatches(skin.nineSlice, isGuiControl<GuiModal>(element, 'GuiModal') ? element.dialogRect : isGuiControl<GuiTooltip>(element, 'GuiTooltip') ? element.popupRect : element.rect, skin.opacity ?? 1, batch);
      if (this.currentCache?.ordered) this.currentCache.plan.images(batch, first, popup ? this.currentLayer === 2 ? 3 : 1 : this.currentLayer);
      const focusStart = this.currentBatch.commands.length;
      const focusRect = isGuiControl<GuiModal>(element, 'GuiModal') ? element.dialogRect : element.rect;
      if (element.focused && !element.disabled) this.currentBatch.addShape({...focusRect,
        x: focusRect.x - 2, y: focusRect.y - 2, width: focusRect.width + 4, height: focusRect.height + 4,
        radius: (skin.radius ?? theme.radius) + 2, color: withAlpha(colorToRgba(element.getResolvedStyle().borderColor, theme.colors.primary), skin.opacity ?? 1), strokeWidth: 2, clip: this.currentClip});
      if (this.currentCache?.ordered) this.currentCache.plan.shapes(this.currentBatch, focusStart, this.currentLayer);
    }
    const shape = this.currentBatch.commands.length, image = this.currentImageBatch.commands.length, text = this.currentTextBatch.commands.length;
    const popupShape = this.currentPopupBatch.commands.length, popupImage = this.currentPopupImageBatch.commands.length, popupText = this.currentPopupTextBatch.commands.length;
    const renderer = this.getElementRenderer(element);
    if (renderer) {
      renderer(element, theme);
    } else {
      const background = skin.backgroundColor;
      if (background) this.addRect(element.rect.x, element.rect.y, element.rect.width, element.rect.height, skin.radius ?? theme.radius, colorToRgba(background, theme.colors.surface));
    }
    if (skin.icon && guiImageSourceReady(skin.icon) && !(isGuiControl<GuiToast>(element, 'GuiToast'))) {
      const padding = isGuiControl<GuiLabel>(element, 'GuiLabel') ? 0 : isGuiControl<GuiButton>(element, 'GuiButton') && element.variant === 'outline' ? 4 : 8;
      const fontSize = isGuiControl<GuiLabel>(element, 'GuiLabel') ? element.fontSize ?? theme.fontSize : theme.fontSize;
      const frame = isGuiControl<GuiTooltip>(element, 'GuiTooltip') ? element.popupRect : element.rect;
      const icon = guiContentBox(element, padding, fontSize, frame).icon;
      if (icon) (isGuiControl<GuiTooltip>(element, 'GuiTooltip') ? this.currentPopupImageBatch : this.currentImageBatch).addImage({source: skin.icon, ...icon, uv: [0,0,1,1],
        color: withAlpha(colorToRgba(skin.iconTint, '#ffffff'), isGuiControl<GuiLabel>(element, 'GuiLabel') || isGuiControl<GuiModal>(element, 'GuiModal') || isGuiControl<GuiNineSlice>(element, 'GuiNineSlice') ? skin.opacity ?? 1 : 1), clip: this.clipRect(frame)});
    }
    if (!(isGuiControl<GuiLabel>(element, 'GuiLabel') || isGuiControl<GuiModal>(element, 'GuiModal') || isGuiControl<GuiNineSlice>(element, 'GuiNineSlice'))) applyGuiOpacity([
      {commands: this.currentBatch.commands, first: shape}, {commands: this.currentImageBatch.commands, first: image}, {commands: this.currentTextBatch.commands, first: text},
      {commands: this.currentPopupBatch.commands, first: popupShape}, {commands: this.currentPopupImageBatch.commands, first: popupImage}, {commands: this.currentPopupTextBatch.commands, first: popupText},
    ], skin.opacity ?? 1);
    if (this.currentCache?.ordered) {
      const plan = this.currentCache.plan, popupLayer = this.currentLayer === 2 ? 3 : 1;
      plan.shapes(this.currentBatch, shape, this.currentLayer); plan.images(this.currentImageBatch, image, this.currentLayer); plan.text(this.currentTextBatch, this.currentFont, text, this.currentLayer);
      plan.shapes(this.currentPopupBatch, popupShape, popupLayer); plan.images(this.currentPopupImageBatch, popupImage, popupLayer); plan.text(this.currentPopupTextBatch, this.currentFont, popupText, popupLayer);
    }
  }

  private renderPlan(pass: GPURenderPassEncoder, cache: GuiRootRenderCache, layer: 0 | 1 | 2 | 3, context?: RenderCommandContext): void {
    for (const draw of cache.plan.layer(layer)) {
      if (draw.kind === 'shape') this.shapeRenderer.render(pass, draw.batch, context, draw.range);
      else if (draw.kind === 'image') this.imageRenderer.render(pass, draw.batch, context, {...draw.range, group: draw.group});
      else this.textRenderer.render(pass, draw.batch, draw.font, context, draw.range);
    }
  }

  

  

  private styleFor(element: GuiElement): GuiSkin {
    let skin = this.resolvedStyles.get(element);
    if (!skin) {
      skin = element.getResolvedStyle();
      if (skin.nineSlice && guiImageSourceReady(skin.nineSlice.source)) skin = {...skin, backgroundColor: 'transparent', borderColor: 'transparent'};
      this.resolvedStyles.set(element, skin);
    }
    return skin;
  }

  

  private addSkinPatches(options: GuiNineSliceOptions, rect: GuiRect, opacity: number, batch = this.currentImageBatch): void {
    if (!guiImageSourceReady(options.source)) return;
    const ratio = options.pixelRatio ?? 1;
    if (!Number.isFinite(ratio) || ratio <= 0) throw new RangeError('Nine-slice pixel ratio must be positive.');
    const color = withAlpha(colorToRgba(options.tint, '#ffffff'), opacity);
    const patches = computeNineSlicePatches({width: rect.width * ratio, height: rect.height * ratio,
      sourceWidth: options.sourceWidth, sourceHeight: options.sourceHeight, cuts: options.cuts, ...(options.uv ? {uv: options.uv} : {})});
    for (const patch of patches) batch.addImage({source: options.source,
      x: rect.x + patch.rect.x / ratio, y: rect.y + patch.rect.y / ratio,
      width: patch.rect.width / ratio, height: patch.rect.height / ratio, uv: [...patch.uv], color, clip: this.clipRect(rect)});
  }

  private getElementRenderer(element: GuiElement): GuiElementRenderer | null {
    let prototype = Object.getPrototypeOf(element) as object | null;
    while (prototype) {
      const constructor = (prototype as { constructor?: Function }).constructor;
      const renderer = constructor ? this.elementRenderers.get(constructor) : undefined;
      if (renderer) return renderer;
      const builtin=guiControlPrototype(prototype),paint=guiControlPainter(prototype);
      if(paint){if(builtin==='GuiModal')return this.modalRenderer;let fallback=this.builtinElementRenderers.get(prototype);if(!fallback){fallback=(element,theme)=>paint(this.controlPaint,element,theme);this.builtinElementRenderers.set(prototype,fallback);}return fallback;}
      prototype = Object.getPrototypeOf(prototype);
    }
    return null;
  }

  

  

  

  

  

  

  

  

  

  

  

  

  private clipRect(rect: GuiRect): GuiRect {
    const clip = this.currentClip;
    if (!clip) return rect;
    const x=Math.max(rect.x,clip.x),y=Math.max(rect.y,clip.y);
    return {x,y,width:Math.max(0,Math.min(rect.x+rect.width,clip.x+clip.width)-x),height:Math.max(0,Math.min(rect.y+rect.height,clip.y+clip.height)-y)};
  }

  private addRect(x: number, y: number, width: number, height: number, radius: number, color: [number, number, number, number]): void {
    this.currentBatch.addShape({ x, y, width, height, radius, color, clip: this.currentClip });
  }

  private addPopupRect(x: number, y: number, width: number, height: number, radius: number, color: [number, number, number, number], clip?: GuiRect): void {
    this.currentPopupBatch.addShape({ x, y, width, height, radius, color, clip });
  }

  private addText(
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fontSize: number,
    color: [number, number, number, number],
    singleLine = false,
  ): void {
    this.currentTextBatch.addText({
      text,
      x,
      y,
      width,
      height,
      fontSize,
      color,
      multiline: !singleLine,
      wrap: !singleLine,
      lineHeight: fontSize * 1.2,
      clip: this.clipRect({ x, y, width, height }),
    });
  }

  private addPopupText(
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fontSize: number,
    color: [number, number, number, number],
    clip = { x, y, width, height },
    singleLine = false,
  ): void {
    this.currentPopupTextBatch.addText({
      text,
      x,
      y,
      width,
      height,
      fontSize,
      color,
      multiline: !singleLine,
      wrap: !singleLine,
      lineHeight: fontSize * 1.2,
      clip,
    });
  }

  private addCenteredText(
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fontSize: number,
    color: [number, number, number, number],
  ): void {
    const font = this.activeFont;
    if (!font) {
      this.addText(text, x, y, width, height, fontSize, color);
      return;
    }
    const textWidth = measureGuiTextWidth(text, font, fontSize);
    const textX = x + Math.max(0, (width - textWidth) * 0.5);
    this.currentTextBatch.addText({
      text,
      x: textX,
      y,
      width: Math.max(0, x + width - textX),
      height,
      fontSize,
      color,
      multiline: false,
      wrap: false,
      clip: this.clipRect({ x, y, width, height }),
    });
  }
}

/** Runtime-private typed friend view; no renderer ownership crosses the public API. */
export type GuiControlPaintContext = GuiRenderer['controlPaint'];
