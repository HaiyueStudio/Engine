import type {RenderCommandContext} from '../../core/RenderCommandContext';
import { GuiScrollView } from '../components/GuiScrollView';
import { GuiToast } from '../components/GuiToast';
import type { IEngine } from '../../core/IEngine';
import type { BitmapFontData } from '../../font/BitmapFontData';
import { GuiButton } from '../components/GuiButton';
import { GuiCheckbox } from '../components/GuiCheckbox';
import { GuiElement } from '../components/GuiElement';
import { GuiInput } from '../components/GuiInput';
import { GuiImage } from '../components/GuiImage';
import {GuiNineSlice} from '../components/GuiNineSlice';
import {computeNineSlicePatches} from '../../geometry/NineSlice';
import type {GuiSkin, GuiNineSliceOptions} from '../GuiThemeTypes';
import { GuiLabel } from '../components/GuiLabel';
import { GuiModal } from '../components/GuiModal';
import { GuiProgress } from '../components/GuiProgress';
import { GuiRadio } from '../components/GuiRadio';
import { GuiRoot } from '../components/GuiRoot';
import { GuiSelect } from '../components/GuiSelect';
import { GuiSlider } from '../components/GuiSlider';
import { GuiSwitch } from '../components/GuiSwitch';
import { GuiTooltip } from '../components/GuiTooltip';
import { GuiTree } from '../components/GuiTree';
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
  private readonly modalRenderer = (element: GuiModal, theme: GuiTheme): void => this.addModal(element, theme);
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

  constructor(fontOptions: GuiRendererFontOptions = {}) {
    this.fontOptions = Object.freeze({ ...fontOptions });
    this.textRenderer = new GuiTextRenderer(fontOptions.readAtlasPixels);
    this.fontOwner = new GuiFontOwner(this.fontOptions, font => this.textRenderer.releaseFont(font));
    registerGuiFontProvider(this, (root, element) => this.fontOwner.forRoot(root, element), root => this.fontOwner.forget(root));
    this.registerElementRenderer(GuiButton, (element, theme) => this.addButton(element, theme));
    this.registerElementRenderer(GuiLabel, (element, theme) => this.addLabel(element, theme));
    this.registerElementRenderer(GuiModal, this.modalRenderer);
    this.registerElementRenderer(GuiInput, (element, theme) => this.addInput(element, theme));
    this.registerElementRenderer(GuiSelect, (element, theme) => this.addSelect(element, theme));
    this.registerElementRenderer(GuiTooltip, (element, theme) => this.addTooltip(element, theme));
    this.registerElementRenderer(GuiTree, (element, theme) => this.addTree(element, theme));
    this.registerElementRenderer(GuiImage, (element, theme) => this.addImage(element, theme));
    this.registerElementRenderer(GuiNineSlice, element => this.addNineSlice(element));
    this.registerElementRenderer(GuiSwitch, (element, theme) => this.addSwitch(element, theme));
    this.registerElementRenderer(GuiRadio, (element, theme) => this.addRadio(element, theme));
    this.registerElementRenderer(GuiCheckbox, (element, theme) => this.addCheckbox(element, theme));
    this.registerElementRenderer(GuiSlider, (element, theme) => this.addSlider(element, theme));
    this.registerElementRenderer(GuiProgress, (element, theme) => this.addProgress(element, theme));
  }

  registerElementRenderer<T extends GuiElement>(constructor: GuiElementConstructor<T>, renderer: GuiElementRenderer<T>): void {
    this.elementRenderers.set(constructor, renderer as GuiElementRenderer);
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
    if (element instanceof GuiToast) {
      const shape = this.currentPopupBatch.commands.length, image = this.currentPopupImageBatch.commands.length, text = this.currentPopupTextBatch.commands.length;
      this.addToast(element, theme);
      if (this.currentCache?.ordered) {this.currentCache.plan.shapes(this.currentPopupBatch, shape, 1); this.currentCache.plan.images(this.currentPopupImageBatch, image, 1); this.currentCache.plan.text(this.currentPopupTextBatch, this.currentFont, text, 1);}
      return;
    }
    if (element instanceof GuiModal) {
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
    if (element instanceof GuiScrollView) this.currentClip = this.clipRect(element.rect);
    for (const child of element.children) this.collectElement(child, theme);
    if (element instanceof GuiScrollView && element.showScrollbar && element.maxScrollY > 0) {
      const first = this.currentBatch.commands.length;
      const r = element.rect, height = Math.min(r.height, Math.max(24, r.height*r.height/element.contentHeight));
      this.addRect(r.x+r.width-4,r.y+(r.height-height)*element.scrollY/element.maxScrollY,3,height,1.5,colorToRgba(element.getResolvedStyle().borderColor,theme.colors.border));
      if (this.currentCache?.ordered) this.currentCache.plan.shapes(this.currentBatch, first, this.currentLayer);
    }
    this.currentClip = previousClip;
  }

  private addElementShapes(element: GuiElement, theme: GuiTheme): void {
    if (element instanceof GuiTooltip && (!element.active || !element.content)) return;
    const skin = this.styleFor(element);
    if (element instanceof GuiModal && this.getElementRenderer(element) === this.modalRenderer) {
      const first = this.currentBatch.commands.length;
      this.addRect(element.rect.x, element.rect.y, element.rect.width, element.rect.height, 0,
        withAlpha(colorToRgba(element.backdropColor, 'rgba(15,23,42,0.48)'), skin.opacity ?? 1));
      if (this.currentCache?.ordered) this.currentCache.plan.shapes(this.currentBatch, first, this.currentLayer);
    }
    if (skin.nineSlice && !(element instanceof GuiNineSlice)) {
      const popup = element instanceof GuiTooltip, batch = popup ? this.currentPopupImageBatch : this.currentImageBatch;
      const first = batch.commands.length;
      this.addSkinPatches(skin.nineSlice, element instanceof GuiModal ? element.dialogRect : element instanceof GuiTooltip ? element.popupRect : element.rect, skin.opacity ?? 1, batch);
      if (this.currentCache?.ordered) this.currentCache.plan.images(batch, first, popup ? this.currentLayer === 2 ? 3 : 1 : this.currentLayer);
      const focusStart = this.currentBatch.commands.length;
      const focusRect = element instanceof GuiModal ? element.dialogRect : element.rect;
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
    if (skin.icon && guiImageSourceReady(skin.icon) && !(element instanceof GuiToast)) {
      const padding = element instanceof GuiLabel ? 0 : element instanceof GuiButton && element.variant === 'outline' ? 4 : 8;
      const fontSize = element instanceof GuiLabel ? element.fontSize ?? theme.fontSize : theme.fontSize;
      const frame = element instanceof GuiTooltip ? element.popupRect : element.rect;
      const icon = guiContentBox(element, padding, fontSize, frame).icon;
      if (icon) (element instanceof GuiTooltip ? this.currentPopupImageBatch : this.currentImageBatch).addImage({source: skin.icon, ...icon, uv: [0,0,1,1],
        color: withAlpha(colorToRgba(skin.iconTint, '#ffffff'), element instanceof GuiLabel || element instanceof GuiModal || element instanceof GuiNineSlice ? skin.opacity ?? 1 : 1), clip: this.clipRect(frame)});
    }
    if (!(element instanceof GuiLabel || element instanceof GuiModal || element instanceof GuiNineSlice)) applyGuiOpacity([
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

  private addToast(toast: GuiToast, theme: GuiTheme): void {
    const skin = this.styleFor(toast), p = toast.progress, opacity = p * (skin.opacity ?? 1);
    if (opacity <= 0) return;
    const r = { ...toast.rect, y: toast.rect.y + 8 * (1 - p) };
    const padding = Math.max(0, this.styleFor(toast).padding ?? 14);
    const iconSource = skin.icon ?? toast.icon, fontSize = skin.fontSize ?? toast.fontSize;
    const icon = iconSource ? Math.max(0, Math.min(skin.iconSize ?? toast.iconSize, r.height - padding, r.width - padding * 2)) : 0;
    const box = guiContentBox(toast, 14, fontSize, r), custom = !!(skin.contentInsets || skin.nineSlice || skin.icon);
    if (skin.nineSlice) this.addSkinPatches(skin.nineSlice, r, opacity, this.currentPopupImageBatch);
    this.currentPopupBatch.addShape({ ...r, radius: this.styleFor(toast).radius ?? theme.radius,
      color: withAlpha(colorToRgba(this.styleFor(toast).backgroundColor, theme.colors.surface), opacity) });
    if (icon > 0) this.currentPopupImageBatch.addImage({ source: iconSource,
      ...(skin.icon ? box.icon ?? {x:r.x,y:r.y,width:0,height:0} : {x:r.x + padding,y:r.y + (r.height - icon) / 2,width:icon,height:icon}), uv: [0, 0, 1, 1],
      color: withAlpha(colorToRgba(skin.iconTint ?? skin.color, skin.icon ? '#ffffff' : theme.colors.text), opacity), clip: r });
    const offset = padding + (icon > 0 ? icon + 10 : 0);
    this.currentPopupTextBatch.addText({ text: toast.text,
      ...(custom ? box.text : {x:r.x + offset,y:r.y,width:Math.max(0,r.width-offset-padding),height:r.height}), fontSize,
      color: withAlpha(colorToRgba(this.styleFor(toast).color, theme.colors.text), opacity),
      multiline: false, wrap: false, clip: r });
  }

  private addImage(image: GuiImage, theme: GuiTheme): void {
    this.currentImageBatch.addImage({
      source: image.source,
      x: image.rect.x,
      y: image.rect.y,
      width: image.rect.width,
      height: image.rect.height,
      uv: image.uv,
      color: colorToRgba(image.tint, theme.colors.text),
      clip: this.clipRect(image.rect),
    });
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

  private addNineSlice(image: GuiNineSlice): void {
    const color = withAlpha(colorToRgba(image.tint, '#ffffff'), this.styleFor(image).opacity ?? 1);
    for (const patch of image.patches) this.currentImageBatch.addImage({source: image.source,
      x: image.rect.x + patch.rect.x, y: image.rect.y + patch.rect.y, width: patch.rect.width, height: patch.rect.height,
      uv: [...patch.uv], color, clip: this.clipRect(image.rect)});
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
      prototype = Object.getPrototypeOf(prototype);
    }
    return null;
  }

  private addButton(button: GuiButton, theme: GuiTheme): void {
    const style = this.styleFor(button), padding = style.padding ?? (button.variant === 'outline' ? 4 : 8);
    const box = guiContentBox(button, button.variant === 'outline' ? 4 : 8, theme.fontSize);
    const textRect = style.contentInsets || style.nineSlice || style.icon ? box.text : {x: button.rect.x + padding, y: button.rect.y, width: button.rect.width - padding * 2, height: button.rect.height};
    const radius = this.styleFor(button).radius ?? theme.radius;
    const border = colorToRgba(this.styleFor(button).borderColor, button.focused ? theme.colors.primary : theme.colors.border);
    const baseSurface = button.variant === 'primary'
      ? theme.colors.primary
      : button.variant === 'danger'
        ? theme.colors.danger
        : theme.colors.surface;
    const surface = button.pressed
      ? theme.colors.active
      : button.hovered
        ? theme.colors.hover
        : baseSurface;
    const background = button.hovered
      ? this.styleFor(button).hoverBackgroundColor ?? this.styleFor(button).backgroundColor
      : this.styleFor(button).backgroundColor;
    const textColor = button.hovered
      ? this.styleFor(button).hoverColor ?? this.styleFor(button).color
      : this.styleFor(button).color;
    if (button.variant === 'outline') {
      this.currentBatch.addShape({ ...button.rect, radius, color: border, strokeWidth: 1.5, clip: this.currentClip });
      this.addCenteredText(button.text, textRect.x, textRect.y, textRect.width, textRect.height, theme.fontSize, colorToRgba(textColor,theme.colors.text));
      return;
    }
    this.addRect(button.rect.x, button.rect.y, button.rect.width, button.rect.height, radius, border);
    this.addRect(button.rect.x + 1, button.rect.y + 1, button.rect.width - 2, button.rect.height - 2, Math.max(0, radius - 1), withAlpha(colorToRgba(background, surface), button.disabled ? 0.45 : 1));
    this.addCenteredText(button.text, textRect.x, textRect.y, textRect.width, textRect.height, theme.fontSize, colorToRgba(textColor, theme.colors.text));
  }

  private addLabel(label: GuiLabel, theme: GuiTheme): void {
    const font = this.activeFont;
    const opacity = this.styleFor(label).opacity ?? 1;
    const radius = this.styleFor(label).radius ?? theme.radius;
    const border = this.styleFor(label).borderColor;
    const background = this.styleFor(label).backgroundColor;
    const inset = border ? 1 : 0;
    if (border) {
      this.addRect(
        label.rect.x,
        label.rect.y,
        label.rect.width,
        label.rect.height,
        radius,
        withAlpha(colorToRgba(border, theme.colors.border), opacity),
      );
    }
    if (background || border) {
      this.addRect(
        label.rect.x + inset,
        label.rect.y + inset,
        Math.max(0, label.rect.width - inset * 2),
        Math.max(0, label.rect.height - inset * 2),
        Math.max(0, radius - inset),
        withAlpha(colorToRgba(background, theme.colors.surface), opacity),
      );
    }

    const padding = this.styleFor(label).padding ?? 0;
    const fontSize = label.fontSize ?? theme.fontSize;
    const style = this.styleFor(label), box = guiContentBox(label, 0, fontSize);
    const customContent = !!(style.contentInsets || style.nineSlice || style.icon);
    const x = customContent ? box.text.x : label.rect.x + padding;
    const width = customContent ? box.text.width : Math.max(0, label.rect.width - padding * 2);
    let textX = x;
    if (font && label.textAlign !== 'left') {
      const textWidth = measureGuiTextWidth(label.text, font, fontSize);
      textX = label.textAlign === 'center'
        ? x + Math.max(0, (width - textWidth) * 0.5)
        : x + Math.max(0, width - textWidth);
    }
    this.currentTextBatch.addText({
      text: label.text,
      x: textX,
      y: customContent ? box.text.y : label.rect.y + (isGuiLayoutManaged(label) ? padding : 0),
      width: Math.max(0, x + width - textX),
      height: customContent ? box.text.height : Math.max(0, label.rect.height - (isGuiLayoutManaged(label) ? padding * 2 : 0)),
      fontSize,
      color: withAlpha(colorToRgba(this.styleFor(label).color, theme.colors.text), opacity),
      multiline: isGuiLayoutManaged(label),
      wrap: isGuiLayoutManaged(label),
      clip: this.clipRect(label.rect),
    });
  }

  private addModal(modal: GuiModal, theme: GuiTheme): void {
    const opacity = this.styleFor(modal).opacity ?? 1;
    const rect = modal.dialogRect;
    const radius = this.styleFor(modal).radius ?? theme.radius;
    const border = colorToRgba(this.styleFor(modal).borderColor, theme.colors.border);
    const background = colorToRgba(this.styleFor(modal).backgroundColor, theme.colors.surface);
    this.addRect(rect.x, rect.y, rect.width, rect.height, radius, withAlpha(border, opacity));
    this.addRect(
      rect.x + 1,
      rect.y + 1,
      Math.max(0, rect.width - 2),
      Math.max(0, rect.height - 2),
      Math.max(0, radius - 1),
      withAlpha(background, opacity),
    );
  }

  private addInput(input: GuiInput, theme: GuiTheme): void {
    const font = this.activeFont;
    const radius = this.styleFor(input).radius ?? theme.radius;
    const border = colorToRgba(this.styleFor(input).borderColor, input.focused ? theme.colors.primary : theme.colors.border);
    this.addRect(input.rect.x, input.rect.y, input.rect.width, input.rect.height, radius, border);
    this.addRect(input.rect.x + 1, input.rect.y + 1, input.rect.width - 2, input.rect.height - 2, Math.max(0, radius - 1), withAlpha(colorToRgba(this.styleFor(input).backgroundColor, theme.colors.surface), input.disabled ? 0.45 : 1));

    const presentation=guiInputPresentation(input,text=>this.measureTextWidth(text,theme.fontSize),theme.fontSize,this.measureTextLineHeight(theme.fontSize));
    const previousClip=this.currentClip;this.currentClip=this.clipRect(presentation.clip);
    const color = input.displayValue
      ? colorToRgba(theme.colors.text, theme.colors.text)
      : colorToRgba(theme.colors.textMuted, theme.colors.textMuted);

    if (input.focused && input.hasSelection && input.value && font && !input.isComposing) {
      for(const rect of presentation.ranges(input.displaySelectionStart,input.displaySelectionEnd))this.addRect(rect.x,rect.y,rect.width,rect.height,2,withAlpha(colorToRgba(theme.colors.primary,theme.colors.primary),0.42));
    }

    const lines=input.displayValue?presentation.lines:input.multiline?input.placeholder.split('\n'):[input.placeholder];
    for(let row=0;row<lines.length;row++)this.currentTextBatch.addText({text:lines[row]!,x:presentation.origin.x,y:presentation.origin.y+(input.multiline?row*presentation.lineHeight:0),width:Math.max(presentation.clip.width,presentation.contentWidth+2),height:input.multiline?presentation.lineHeight:presentation.textHeight,fontSize:theme.fontSize,color,multiline:false,wrap:false,verticalAlign:input.multiline?'top':'center',clip:this.currentClip});

    const composition=input.composition;
    if(input.focused&&composition?.text&&font){
      const range=input.displayCompositionRange!;
      for(const rect of presentation.ranges(...range))this.addRect(rect.x,rect.y+rect.height-2,rect.width,1,0,colorToRgba(theme.colors.primary,theme.colors.primary));
    }

    if (input.focused && !input.disabled && !input.readOnly && font && !input.hasSelection && (input.isComposing||guiInputCaretVisible(input))) {
      const rect=presentation.caret;this.addRect(rect.x,rect.y,rect.width,rect.height,0.75,colorToRgba(theme.colors.text,theme.colors.text));
    }
    this.currentClip=previousClip;this.currentClip=this.clipRect(input.rect);
    const {counter,eye}=presentation.adornments;
    if(counter)this.currentTextBatch.addText({text:counter.text,...counter.rect,fontSize:counter.fontSize,color:colorToRgba(input.value.length>=input.maxLength?theme.colors.primary:theme.colors.textMuted,theme.colors.textMuted),clip:this.currentClip,verticalAlign:'top'});
    if(eye&&eye.width>0){
      const cx=eye.x+eye.width/2,cy=eye.y+eye.height/2,ink=colorToRgba(theme.colors.textMuted,theme.colors.textMuted),surface=colorToRgba(this.styleFor(input).backgroundColor,theme.colors.surface);
      const scale=Math.min(1,eye.width/24),w=20*scale,h=12*scale;
      this.addRect(cx-w/2,cy-h/2,w,h,h/2,ink);
      this.addRect(cx-w/2+1.5,cy-h/2+1.5,Math.max(0,w-3),Math.max(0,h-3),Math.max(0,h/2-1.5),surface);
      this.addRect(cx-3*scale,cy-3*scale,6*scale,6*scale,3*scale,ink);
      if(!guiPasswordRevealed(input))for(let i=-7;i<=7;i++)this.addRect(cx+i*scale-1,cy+i*.65*scale-1,2,2,1,ink);
    }
    this.currentClip=previousClip;
  }

  private addSelect(select: GuiSelect, theme: GuiTheme): void {
    const style = this.styleFor(select), custom = !!(style.contentInsets || style.nineSlice || style.icon), box = guiContentBox(select, 8, theme.fontSize).text;
    const radius = this.styleFor(select).radius ?? theme.radius;
    const border = colorToRgba(this.styleFor(select).borderColor, select.focused || select.open ? theme.colors.primary : theme.colors.border);
    this.addRect(select.rect.x, select.rect.y, select.rect.width, select.rect.height, radius, border);
    this.addRect(select.rect.x + 1, select.rect.y + 1, select.rect.width - 2, select.rect.height - 2, Math.max(0, radius - 1), withAlpha(colorToRgba(this.styleFor(select).backgroundColor, theme.colors.surface), select.disabled ? 0.45 : 1));
    const textColor = select.selectedOption
      ? colorToRgba(theme.colors.text, theme.colors.text)
      : colorToRgba(theme.colors.textMuted, theme.colors.textMuted);
    this.addText(select.displayText, custom ? box.x : select.rect.x + 8, custom ? box.y : select.rect.y,
      Math.max(0, custom ? box.width - 22 : select.rect.width - 30), custom ? box.height : select.rect.height, theme.fontSize, textColor, true);

    const arrowX = select.rect.x + select.rect.width - 18;
    const arrowY = select.rect.y + select.rect.height * 0.5;
    this.addRect(arrowX, arrowY - 1, 10, 2, 1, colorToRgba(theme.colors.textMuted, theme.colors.textMuted));
    this.addRect(arrowX + 2, arrowY + 3, 6, 2, 1, colorToRgba(theme.colors.textMuted, theme.colors.textMuted));

    if (!select.open) return;
    const popup = select.popupRect;
    this.addPopupRect(popup.x, popup.y, popup.width, popup.height, radius, colorToRgba(theme.colors.border, theme.colors.border));
    this.addPopupRect(popup.x + 1, popup.y + 1, popup.width - 2, popup.height - 2, Math.max(0, radius - 1), colorToRgba(theme.colors.surface, theme.colors.surface));

    const firstIndex = Math.max(0, Math.floor(select.scrollY / select.optionHeight));
    const localOffset = select.scrollY - firstIndex * select.optionHeight;
    const visibleCount = Math.min(
      select.options.length - firstIndex,
      select.maxVisibleOptions + (localOffset > 0 ? 1 : 0),
    );
    for (let i = 0; i < visibleCount; i++) {
      const optionIndex = firstIndex + i;
      const option = requiredItemAt(select.options, optionIndex, 'GUI select options');
      const y = popup.y + i * select.optionHeight - localOffset;
      const selected = option.value === select.value;
      if (selected) {
        this.addPopupRect(popup.x + 2, y + 2, popup.width - 4, select.optionHeight - 4, Math.max(0, radius - 2), withAlpha(colorToRgba(theme.colors.primary, theme.colors.primary), 0.32), popup);
      }
      this.addPopupText(option.label, popup.x + 8, y, popup.width - 18, select.optionHeight, theme.fontSize, withAlpha(colorToRgba(option.disabled ? theme.colors.textMuted : theme.colors.text, theme.colors.text), option.disabled ? 0.55 : 1), popup, true);
    }
    if (select.maxScrollY > 0) {
      const trackH = popup.height - 8;
      const thumbH = Math.max(18, trackH * (popup.height / (select.options.length * select.optionHeight)));
      const thumbY = popup.y + 4 + (trackH - thumbH) * (select.scrollY / select.maxScrollY);
      this.addPopupRect(popup.x + popup.width - 7, popup.y + 4, 3, trackH, 1.5, withAlpha(colorToRgba(theme.colors.border, theme.colors.border), 0.55), popup);
      this.addPopupRect(popup.x + popup.width - 8, thumbY, 5, thumbH, 2.5, withAlpha(colorToRgba(theme.colors.textMuted, theme.colors.textMuted), 0.75), popup);
    }
  }

  private addTooltip(tooltip: GuiTooltip, theme: GuiTheme): void {
    if (!tooltip.active || !tooltip.content) return;
    const rect = tooltip.popupRect;
    const radius = this.styleFor(tooltip).radius ?? theme.radius;
    const style = this.styleFor(tooltip), box = guiContentBox(tooltip, 8, theme.fontSize, rect);
    const textRect = style.contentInsets || style.nineSlice || style.icon ? box.text : {x:rect.x + 8,y:rect.y,width:rect.width - 16,height:rect.height};
    this.addPopupRect(rect.x, rect.y, rect.width, rect.height, radius, withAlpha(colorToRgba(this.styleFor(tooltip).backgroundColor, theme.colors.background), 0.96));
    this.currentPopupTextBatch.addText({
      text: tooltip.content,
      ...textRect,
      fontSize: theme.fontSize,
      color: colorToRgba(theme.colors.text, theme.colors.text),
      multiline: true, wrap: true, verticalAlign: 'center',
      clip: rect,
    });
  }

  private addTree(tree: GuiTree, theme: GuiTheme): void {
    const content = guiContentBox(tree, 0, theme.fontSize), textOffset = content.text.x - content.rect.x;
    const radius = this.styleFor(tree).radius ?? theme.radius;
    this.addRect(tree.rect.x, tree.rect.y, tree.rect.width, tree.rect.height, radius, colorToRgba(this.styleFor(tree).borderColor, theme.colors.border));
    this.addRect(tree.rect.x + 1, tree.rect.y + 1, tree.rect.width - 2, tree.rect.height - 2, Math.max(0, radius - 1), colorToRgba(this.styleFor(tree).backgroundColor, theme.colors.surface));

    for (const row of tree.visibleNodes) {
      if (row.rowRect.y + row.rowRect.height > content.rect.y + content.rect.height) continue;
      const selected = row.node.key === tree.selectedKey;
      if (selected) {
        this.addRect(row.rowRect.x + 2, row.rowRect.y + 2, row.rowRect.width - 4, row.rowRect.height - 4, Math.max(0, radius - 2), withAlpha(colorToRgba(theme.colors.primary, theme.colors.primary), 0.34));
      }

      const baseX = row.rowRect.x + textOffset + row.depth * tree.indent + 8;
      if (row.node.children?.length) {
        const arrowColor = colorToRgba(theme.colors.textMuted, theme.colors.textMuted);
        const cy = row.rowRect.y + row.rowRect.height * 0.5;
        if (tree.expandedKeys.has(row.node.key)) {
          this.addRect(baseX, cy - 1, 10, 2, 1, arrowColor);
        } else {
          this.addRect(baseX + 2, cy - 5, 2, 10, 1, arrowColor);
          this.addRect(baseX - 2, cy - 1, 10, 2, 1, arrowColor);
        }
      }

      const labelX = baseX + 18;
      const color = row.node.disabled
        ? withAlpha(colorToRgba(theme.colors.textMuted, theme.colors.textMuted), 0.55)
        : colorToRgba(theme.colors.text, theme.colors.text);
      this.addText(row.node.label, labelX, row.rowRect.y, Math.max(0, row.rowRect.x + row.rowRect.width - labelX - 8), row.rowRect.height, theme.fontSize, color, true);
    }
  }

  private addCheckbox(checkbox: GuiCheckbox, theme: GuiTheme): void {
    const skin = this.styleFor(checkbox), r = skin.contentInsets || skin.nineSlice || skin.icon ? guiContentBox(checkbox, 0, theme.fontSize).text : checkbox.rect;
    const size = Math.max(0, Math.min(18, r.height - 6, r.width - 4));
    const x = r.x + 2;
    const y = r.y + (r.height - size) * 0.5;
    const border = colorToRgba(this.styleFor(checkbox).borderColor, checkbox.focused ? theme.colors.primary : theme.colors.border);
    const fill = this.styleFor(checkbox).backgroundColor ?? (checkbox.checked ? theme.colors.primary : theme.colors.surface);
    this.addRect(x, y, size, size, 4, border);
    this.addRect(x + 2, y + 2, size - 4, size - 4, 3, withAlpha(colorToRgba(this.styleFor(checkbox).backgroundColor, fill), checkbox.disabled ? 0.45 : 1));
    if (checkbox.checked) {
      const mark = colorToRgba(theme.colors.text, theme.colors.text);
      this.addRect(x + 5, y + 9, 4, 2, 1, mark);
      this.addRect(x + 8, y + 6, 7, 2, 1, mark);
    }
    if (checkbox.label) {
      this.addText(checkbox.label, x + size + 8, r.y, Math.max(0,r.width - size - 10), r.height, theme.fontSize, colorToRgba(theme.colors.text, theme.colors.text), true);
    }
  }

  private addRadio(radio: GuiRadio, theme: GuiTheme): void {
    const skin = this.styleFor(radio), r = skin.contentInsets || skin.nineSlice || skin.icon ? guiContentBox(radio, 0, theme.fontSize).text : radio.rect;
    const size = Math.max(0, Math.min(18, r.height - 6, r.width - 4));
    const x = r.x + 2;
    const y = r.y + (r.height - size) * 0.5;
    const radius = size * 0.5;
    const border = colorToRgba(this.styleFor(radio).borderColor, radio.focused ? theme.colors.primary : theme.colors.border);
    const fill = radio.checked ? theme.colors.primary : theme.colors.surface;
    this.addRect(x, y, size, size, radius, border);
    this.addRect(x + 2, y + 2, size - 4, size - 4, Math.max(0, radius - 2), withAlpha(colorToRgba(this.styleFor(radio).backgroundColor, theme.colors.surface), radio.disabled ? 0.45 : 1));
    if (radio.checked) {
      this.addRect(x + 5, y + 5, size - 10, size - 10, Math.max(0, radius - 5), withAlpha(colorToRgba(theme.colors.primary, fill), radio.disabled ? 0.45 : 1));
    }
    if (radio.label) {
      this.addText(radio.label, x + size + 8, r.y, Math.max(0,r.width - size - 10), r.height, theme.fontSize, colorToRgba(theme.colors.text, theme.colors.text), true);
    }
  }

  private addSwitch(control: GuiSwitch, theme: GuiTheme): void {
    const off = colorToRgba(this.styleFor(control).backgroundColor, theme.colors.border);
    const on = colorToRgba(this.styleFor(control).backgroundColor, theme.colors.primary);
    const amount = control.colorProgress;
    const track = withAlpha(off.map((value, i) => value + (on[i]! - value) * amount) as [number, number, number, number], control.disabled ? 0.45 : 1);
    const thumb = colorToRgba(theme.colors.text, theme.colors.text);
    const radius = control.rect.height * 0.5;
    this.currentBatch.addShape({ ...control.rect, radius, color: track, roundedMesh: true, clip: this.currentClip });
    const thumbSize = Math.max(4, control.rect.height - 6);
    const thumbX = control.rect.x + 3 + Math.max(0, control.rect.width - thumbSize - 6) * control.thumbProgress;
    this.currentBatch.addShape({ x: thumbX, y: control.rect.y + 3, width: thumbSize, height: thumbSize, radius: thumbSize * 0.5, color: withAlpha(thumb, control.disabled ? 0.45 : 1), roundedMesh: true, clip: this.currentClip });
  }

  private addProgress(progress: GuiProgress, theme: GuiTheme): void {
    const radius = this.styleFor(progress).radius ?? progress.rect.height * 0.5;
    this.addRect(progress.rect.x, progress.rect.y, progress.rect.width, progress.rect.height, radius, colorToRgba(this.styleFor(progress).backgroundColor, theme.colors.border));
    this.addRect(progress.rect.x, progress.rect.y, progress.rect.width * progress.ratio, progress.rect.height, radius, colorToRgba(theme.colors.primary, theme.colors.primary));
    if (progress.showText) {
      const skin = this.styleFor(progress), r = skin.contentInsets || skin.nineSlice || skin.icon ? guiContentBox(progress, 0, theme.fontSize).text : progress.rect;
      this.addCenteredText(`${Math.round(progress.ratio * 100)}%`, r.x, r.y, r.width, r.height, theme.fontSize, colorToRgba(theme.colors.text, theme.colors.text));
    }
  }

  private addSlider(slider: GuiSlider, theme: GuiTheme): void {
    const trackHeight = 4;
    const trackY = slider.rect.y + (slider.rect.height - trackHeight) * 0.5;
    const thumbSize = Math.min(18, slider.rect.height);
    const thumbX = slider.rect.x + slider.rect.width * slider.ratio - thumbSize * 0.5;
    this.addRect(slider.rect.x, trackY, slider.rect.width, trackHeight, trackHeight * 0.5, colorToRgba(this.styleFor(slider).backgroundColor, theme.colors.border));
    this.addRect(slider.rect.x, trackY, slider.rect.width * slider.ratio, trackHeight, trackHeight * 0.5, colorToRgba(theme.colors.primary, theme.colors.primary));
    this.addRect(thumbX, slider.rect.y + (slider.rect.height - thumbSize) * 0.5, thumbSize, thumbSize, thumbSize * 0.5, colorToRgba(slider.focused ? theme.colors.active : theme.colors.text, theme.colors.text));
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
