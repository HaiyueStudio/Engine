import type { IEngine } from '../../core/IEngine';
import type { BitmapFontData } from '../../font/BitmapFontData';
import { buildBitmapFont } from '../../font/BitmapFontBuilder';
import { GuiButton } from '../components/GuiButton';
import { GuiCheckbox } from '../components/GuiCheckbox';
import { GuiElement } from '../components/GuiElement';
import { GuiInput } from '../components/GuiInput';
import { GuiImage } from '../components/GuiImage';
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
import { GuiBatch } from './GuiBatch';
import { GuiShapeRenderer } from './GuiShapeRenderer';
import { GuiTextBatch, measureGuiTextWidth } from './GuiTextBatch';
import { GuiTextRenderer } from './GuiTextRenderer';
import { GuiImageBatch } from './GuiImageBatch';
import { requiredItemAt } from '../../math/arrayAccess';
import { GuiImageRenderer } from './GuiImageRenderer';
import type { PipelineWarmupPlan } from '../../renderer/PipelineWarmup';

type GuiElementConstructor<T extends GuiElement = GuiElement> = new (...args: never[]) => T;
type GuiElementRenderer<T extends GuiElement = GuiElement> = (element: T, theme: GuiTheme) => void;

interface GuiRootRenderCache {
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
  private textRenderer = new GuiTextRenderer();
  private imageRenderer = new GuiImageRenderer();
  private prepared = false;
  private preparedDevice: GPUDevice | null = null;
  private needsRebuild = true;
  private defaultFont: BitmapFontData | null = null;
  private readonly elementRenderers = new Map<Function, GuiElementRenderer>();
  private readonly rootCaches = new Map<GuiRoot, GuiRootRenderCache>();
  private activeRootCaches: GuiRootRenderCache[] = [];
  private currentBatch = this.batch;
  private currentTextBatch = this.textBatch;
  private currentPopupBatch = this.popupBatch;
  private currentPopupTextBatch = this.popupTextBatch;
  private currentImageBatch = this.imageBatch;
  private currentModalBatch = this.batch;
  private currentModalTextBatch = this.textBatch;
  private currentModalImageBatch = this.imageBatch;

  constructor() {
    this.registerElementRenderer(GuiButton, (element, theme) => this.addButton(element, theme));
    this.registerElementRenderer(GuiLabel, (element, theme) => this.addLabel(element, theme));
    this.registerElementRenderer(GuiModal, (element, theme) => this.addModal(element, theme));
    this.registerElementRenderer(GuiInput, (element, theme) => this.addInput(element, theme));
    this.registerElementRenderer(GuiSelect, (element, theme) => this.addSelect(element, theme));
    this.registerElementRenderer(GuiTooltip, (element, theme) => this.addTooltip(element, theme));
    this.registerElementRenderer(GuiTree, (element, theme) => this.addTree(element, theme));
    this.registerElementRenderer(GuiImage, (element, theme) => this.addImage(element, theme));
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
    if (this.prepared && this.preparedDevice === engine.device) return;
    if (this.prepared) this.destroy();
    try {
      this.shapeRenderer.prepare(engine);
      this.textRenderer.prepare(engine);
      this.imageRenderer.prepare(engine);
      this.defaultFont = buildBitmapFont({
      chars: ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~年月日今天周一二三四五六重置旋转翻',
      fontSize: 32,
      fontFamily: 'sans-serif',
      padding: 4,
      atlasSize: 512,
      }).data;
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

  measureTextWidth(text: string, fontSize: number): number {
    return this.defaultFont ? measureGuiTextWidth(text, this.defaultFont, fontSize) : text.length * fontSize * 0.55;
  }

  markDirty(): void {
    this.needsRebuild = true;
  }

  destroy(): void {
    for (const cache of this.rootCaches.values()) this.releaseRootCache(cache);
    this.rootCaches.clear();
    this.activeRootCaches = [];
    this.shapeRenderer.destroy();
    this.textRenderer.destroy();
    this.imageRenderer.destroy();
    this.prepared = false;
    this.preparedDevice = null;
    this.needsRebuild = true;
    this.defaultFont = null;
  }

  render(
    passEncoder: GPURenderPassEncoder,
    roots: Iterable<GuiRoot>,
    engine: IEngine,
    reverseZ = engine.reverseZ,
    sampleCount: 1 | 4 = engine.msaaSamples,
  ): void {
    this.prepare(engine);
    this.shapeRenderer.reverseZ = reverseZ;
    this.shapeRenderer.msaaSamples = sampleCount;
    this.textRenderer.reverseZ = reverseZ;
    this.textRenderer.msaaSamples = sampleCount;
    this.imageRenderer.reverseZ = reverseZ;
    this.imageRenderer.msaaSamples = sampleCount;

    const rootList = Array.from(roots);
    this.prepareRootCaches(rootList);

    for (const cache of this.activeRootCaches) {
      this.shapeRenderer.render(passEncoder, cache.batch);
      this.imageRenderer.render(passEncoder, cache.imageBatch);
      if (this.defaultFont) this.textRenderer.render(passEncoder, cache.textBatch, this.defaultFont);
    }
    for (const cache of this.activeRootCaches) {
      this.shapeRenderer.render(passEncoder, cache.popupBatch);
      this.imageRenderer.render(passEncoder, cache.popupImageBatch);
      if (this.defaultFont) this.textRenderer.render(passEncoder, cache.popupTextBatch, this.defaultFont);
    }
    for (const cache of this.activeRootCaches) {
      this.shapeRenderer.render(passEncoder, cache.modalBatch);
      this.imageRenderer.render(passEncoder, cache.modalImageBatch);
      if (this.defaultFont) this.textRenderer.render(passEncoder, cache.modalTextBatch, this.defaultFont);
    }
  }

  private prepareRootCaches(roots: GuiRoot[]): void {
    const activeRoots = new Set(roots);
    for (const [root, cache] of this.rootCaches) {
      if (activeRoots.has(root)) continue;
      this.releaseRootCache(cache);
      this.rootCaches.delete(root);
    }
    this.activeRootCaches = roots.map(root => {
      const cache = this.getRootCache(root);
      if (this.needsRebuild || root.dirty) this.rebuildRoot(root, cache);
      return cache;
    });
    this.needsRebuild = false;
  }

  private getRootCache(root: GuiRoot): GuiRootRenderCache {
    let cache = this.rootCaches.get(root);
    if (cache) return cache;
    cache = {
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
    if (this.defaultFont) cache.textBatch.rebuild(this.defaultFont);
    if (this.defaultFont) cache.popupTextBatch.rebuild(this.defaultFont);
    if (this.defaultFont) cache.modalTextBatch.rebuild(this.defaultFont);
    this.resetCurrentBatches();
  }

  private releaseRootCache(cache: GuiRootRenderCache): void {
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
    this.currentImageBatch = this.imageBatch;
    this.currentModalBatch = this.batch;
    this.currentModalTextBatch = this.textBatch;
    this.currentModalImageBatch = this.imageBatch;
  }

  private collectElement(element: GuiElement, theme: GuiTheme): void {
    if (!element.visible) return;
    if (element instanceof GuiModal) {
      const previousBatch = this.currentBatch;
      const previousTextBatch = this.currentTextBatch;
      const previousImageBatch = this.currentImageBatch;
      this.currentBatch = this.currentModalBatch;
      this.currentTextBatch = this.currentModalTextBatch;
      this.currentImageBatch = this.currentModalImageBatch;
      this.addElementShapes(element, theme);
      for (const child of element.children) this.collectElement(child, theme);
      this.currentBatch = previousBatch;
      this.currentTextBatch = previousTextBatch;
      this.currentImageBatch = previousImageBatch;
      return;
    }
    this.addElementShapes(element, theme);
    for (const child of element.children) this.collectElement(child, theme);
  }

  private addElementShapes(element: GuiElement, theme: GuiTheme): void {
    const renderer = this.getElementRenderer(element);
    if (renderer) {
      renderer(element, theme);
      return;
    }

    const background = element.style.backgroundColor;
    if (background) this.addRect(element.rect.x, element.rect.y, element.rect.width, element.rect.height, element.style.radius ?? theme.radius, colorToRgba(background, theme.colors.surface));
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
      clip: image.rect,
    });
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
    const radius = button.style.radius ?? theme.radius;
    const border = colorToRgba(button.style.borderColor, button.focused ? theme.colors.primary : theme.colors.border);
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
      ? button.style.hoverBackgroundColor ?? button.style.backgroundColor
      : button.style.backgroundColor;
    const textColor = button.hovered
      ? button.style.hoverColor ?? button.style.color
      : button.style.color;
    this.addRect(button.rect.x, button.rect.y, button.rect.width, button.rect.height, radius, border);
    this.addRect(button.rect.x + 1, button.rect.y + 1, button.rect.width - 2, button.rect.height - 2, Math.max(0, radius - 1), withAlpha(colorToRgba(background, surface), button.disabled ? 0.45 : 1));
    this.addCenteredText(button.text, button.rect.x + 8, button.rect.y, button.rect.width - 16, button.rect.height, theme.fontSize, colorToRgba(textColor, theme.colors.text));
  }

  private addLabel(label: GuiLabel, theme: GuiTheme): void {
    const opacity = label.style.opacity ?? 1;
    const radius = label.style.radius ?? theme.radius;
    const border = label.style.borderColor;
    const background = label.style.backgroundColor;
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

    const padding = label.style.padding ?? 0;
    const x = label.rect.x + padding;
    const width = Math.max(0, label.rect.width - padding * 2);
    const fontSize = label.fontSize ?? theme.fontSize;
    let textX = x;
    if (this.defaultFont && label.textAlign !== 'left') {
      const textWidth = measureGuiTextWidth(label.text, this.defaultFont, fontSize);
      textX = label.textAlign === 'center'
        ? x + Math.max(0, (width - textWidth) * 0.5)
        : x + Math.max(0, width - textWidth);
    }
    this.currentTextBatch.addText({
      text: label.text,
      x: textX,
      y: label.rect.y,
      width: Math.max(0, x + width - textX),
      height: label.rect.height,
      fontSize,
      color: withAlpha(colorToRgba(label.style.color, theme.colors.text), opacity),
      multiline: false,
      wrap: false,
      clip: label.rect,
    });
  }

  private addModal(modal: GuiModal, theme: GuiTheme): void {
    const opacity = modal.style.opacity ?? 1;
    this.addRect(
      modal.rect.x,
      modal.rect.y,
      modal.rect.width,
      modal.rect.height,
      0,
      withAlpha(colorToRgba(modal.backdropColor, 'rgba(15,23,42,0.48)'), opacity),
    );
    const rect = modal.dialogRect;
    const radius = modal.style.radius ?? theme.radius;
    const border = colorToRgba(modal.style.borderColor, theme.colors.border);
    const background = colorToRgba(modal.style.backgroundColor, theme.colors.surface);
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
    const radius = input.style.radius ?? theme.radius;
    const border = colorToRgba(input.style.borderColor, input.focused ? theme.colors.primary : theme.colors.border);
    this.addRect(input.rect.x, input.rect.y, input.rect.width, input.rect.height, radius, border);
    this.addRect(input.rect.x + 1, input.rect.y + 1, input.rect.width - 2, input.rect.height - 2, Math.max(0, radius - 1), withAlpha(colorToRgba(input.style.backgroundColor, theme.colors.surface), input.disabled ? 0.45 : 1));

    const padding = input.style.padding ?? 8;
    const text = input.value || input.placeholder;
    const color = input.value
      ? colorToRgba(theme.colors.text, theme.colors.text)
      : colorToRgba(theme.colors.textMuted, theme.colors.textMuted);

    if (input.focused && input.hasSelection && input.value && this.defaultFont) {
      const selectionStartX = measureGuiTextWidth(input.value.slice(0, input.selectionStart), this.defaultFont, theme.fontSize);
      const selectionEndX = measureGuiTextWidth(input.value.slice(0, input.selectionEnd), this.defaultFont, theme.fontSize);
      const x = input.rect.x + padding + selectionStartX;
      const maxWidth = Math.max(0, input.rect.x + input.rect.width - padding - x);
      const width = Math.min(Math.max(1, selectionEndX - selectionStartX), maxWidth);
      if (width > 0) {
        this.addRect(
          x,
          input.rect.y + 5,
          width,
          Math.max(10, input.rect.height - 10),
          2,
          withAlpha(colorToRgba(theme.colors.primary, theme.colors.primary), 0.42),
        );
      }
    }

    this.addText(text, input.rect.x + padding, input.rect.y, input.rect.width - padding * 2, input.rect.height, theme.fontSize, color);

    if (input.focused && !input.disabled && !input.readOnly && this.defaultFont) {
      const beforeCaret = input.value.slice(0, input.selectionFocus);
      const caretX = input.rect.x + padding + measureGuiTextWidth(beforeCaret, this.defaultFont, theme.fontSize);
      this.addRect(caretX, input.rect.y + 7, 1.5, Math.max(10, input.rect.height - 14), 0.75, colorToRgba(theme.colors.text, theme.colors.text));
    }
  }

  private addSelect(select: GuiSelect, theme: GuiTheme): void {
    const radius = select.style.radius ?? theme.radius;
    const border = colorToRgba(select.style.borderColor, select.focused || select.open ? theme.colors.primary : theme.colors.border);
    this.addRect(select.rect.x, select.rect.y, select.rect.width, select.rect.height, radius, border);
    this.addRect(select.rect.x + 1, select.rect.y + 1, select.rect.width - 2, select.rect.height - 2, Math.max(0, radius - 1), withAlpha(colorToRgba(select.style.backgroundColor, theme.colors.surface), select.disabled ? 0.45 : 1));
    const textColor = select.selectedOption
      ? colorToRgba(theme.colors.text, theme.colors.text)
      : colorToRgba(theme.colors.textMuted, theme.colors.textMuted);
    this.addText(select.displayText, select.rect.x + 8, select.rect.y, Math.max(0, select.rect.width - 30), select.rect.height, theme.fontSize, textColor);

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
      this.addPopupText(option.label, popup.x + 8, y, popup.width - 18, select.optionHeight, theme.fontSize, withAlpha(colorToRgba(option.disabled ? theme.colors.textMuted : theme.colors.text, theme.colors.text), option.disabled ? 0.55 : 1), popup);
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
    const radius = tooltip.style.radius ?? theme.radius;
    this.addPopupRect(rect.x, rect.y, rect.width, rect.height, radius, withAlpha(colorToRgba(tooltip.style.backgroundColor, theme.colors.background), 0.96));
    this.addPopupText(tooltip.content, rect.x + 8, rect.y, rect.width - 16, rect.height, theme.fontSize, colorToRgba(theme.colors.text, theme.colors.text));
  }

  private addTree(tree: GuiTree, theme: GuiTheme): void {
    const radius = tree.style.radius ?? theme.radius;
    this.addRect(tree.rect.x, tree.rect.y, tree.rect.width, tree.rect.height, radius, colorToRgba(tree.style.borderColor, theme.colors.border));
    this.addRect(tree.rect.x + 1, tree.rect.y + 1, tree.rect.width - 2, tree.rect.height - 2, Math.max(0, radius - 1), colorToRgba(tree.style.backgroundColor, theme.colors.surface));

    for (const row of tree.visibleNodes) {
      if (row.rowRect.y + row.rowRect.height > tree.rect.y + tree.rect.height) continue;
      const selected = row.node.key === tree.selectedKey;
      if (selected) {
        this.addRect(row.rowRect.x + 2, row.rowRect.y + 2, row.rowRect.width - 4, row.rowRect.height - 4, Math.max(0, radius - 2), withAlpha(colorToRgba(theme.colors.primary, theme.colors.primary), 0.34));
      }

      const baseX = tree.rect.x + row.depth * tree.indent + 8;
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
      this.addText(row.node.label, labelX, row.rowRect.y, Math.max(0, tree.rect.x + tree.rect.width - labelX - 8), row.rowRect.height, theme.fontSize, color);
    }
  }

  private addCheckbox(checkbox: GuiCheckbox, theme: GuiTheme): void {
    const size = Math.min(18, checkbox.rect.height - 6);
    const x = checkbox.rect.x + 2;
    const y = checkbox.rect.y + (checkbox.rect.height - size) * 0.5;
    const border = colorToRgba(checkbox.style.borderColor, checkbox.focused ? theme.colors.primary : theme.colors.border);
    const fill = checkbox.checked ? theme.colors.primary : theme.colors.surface;
    this.addRect(x, y, size, size, 4, border);
    this.addRect(x + 2, y + 2, size - 4, size - 4, 3, withAlpha(colorToRgba(checkbox.style.backgroundColor, fill), checkbox.disabled ? 0.45 : 1));
    if (checkbox.checked) {
      const mark = colorToRgba(theme.colors.text, theme.colors.text);
      this.addRect(x + 5, y + 9, 4, 2, 1, mark);
      this.addRect(x + 8, y + 6, 7, 2, 1, mark);
    }
    if (checkbox.label) {
      this.addText(checkbox.label, x + size + 8, checkbox.rect.y, checkbox.rect.width - size - 10, checkbox.rect.height, theme.fontSize, colorToRgba(theme.colors.text, theme.colors.text));
    }
  }

  private addRadio(radio: GuiRadio, theme: GuiTheme): void {
    const size = Math.min(18, radio.rect.height - 6);
    const x = radio.rect.x + 2;
    const y = radio.rect.y + (radio.rect.height - size) * 0.5;
    const radius = size * 0.5;
    const border = colorToRgba(radio.style.borderColor, radio.focused ? theme.colors.primary : theme.colors.border);
    const fill = radio.checked ? theme.colors.primary : theme.colors.surface;
    this.addRect(x, y, size, size, radius, border);
    this.addRect(x + 2, y + 2, size - 4, size - 4, Math.max(0, radius - 2), withAlpha(colorToRgba(radio.style.backgroundColor, theme.colors.surface), radio.disabled ? 0.45 : 1));
    if (radio.checked) {
      this.addRect(x + 5, y + 5, size - 10, size - 10, Math.max(0, radius - 5), withAlpha(colorToRgba(theme.colors.primary, fill), radio.disabled ? 0.45 : 1));
    }
    if (radio.label) {
      this.addText(radio.label, x + size + 8, radio.rect.y, radio.rect.width - size - 10, radio.rect.height, theme.fontSize, colorToRgba(theme.colors.text, theme.colors.text));
    }
  }

  private addSwitch(control: GuiSwitch, theme: GuiTheme): void {
    const trackColor = control.checked ? theme.colors.primary : theme.colors.border;
    const track = withAlpha(colorToRgba(control.style.backgroundColor, trackColor), control.disabled ? 0.45 : 1);
    const thumb = colorToRgba(theme.colors.text, theme.colors.text);
    const radius = control.rect.height * 0.5;
    this.addRect(control.rect.x, control.rect.y, control.rect.width, control.rect.height, radius, track);
    const thumbSize = Math.max(4, control.rect.height - 8);
    const thumbX = control.checked
      ? control.rect.x + control.rect.width - thumbSize - 4
      : control.rect.x + 4;
    this.addRect(thumbX, control.rect.y + 4, thumbSize, thumbSize, thumbSize * 0.5, thumb);
  }

  private addProgress(progress: GuiProgress, theme: GuiTheme): void {
    const radius = progress.style.radius ?? progress.rect.height * 0.5;
    this.addRect(progress.rect.x, progress.rect.y, progress.rect.width, progress.rect.height, radius, colorToRgba(progress.style.backgroundColor, theme.colors.border));
    this.addRect(progress.rect.x, progress.rect.y, progress.rect.width * progress.ratio, progress.rect.height, radius, colorToRgba(theme.colors.primary, theme.colors.primary));
    if (progress.showText) {
      this.addCenteredText(`${Math.round(progress.ratio * 100)}%`, progress.rect.x, progress.rect.y, progress.rect.width, progress.rect.height, theme.fontSize, colorToRgba(theme.colors.text, theme.colors.text));
    }
  }

  private addSlider(slider: GuiSlider, theme: GuiTheme): void {
    const trackHeight = 4;
    const trackY = slider.rect.y + (slider.rect.height - trackHeight) * 0.5;
    const thumbSize = Math.min(18, slider.rect.height);
    const thumbX = slider.rect.x + slider.rect.width * slider.ratio - thumbSize * 0.5;
    this.addRect(slider.rect.x, trackY, slider.rect.width, trackHeight, trackHeight * 0.5, colorToRgba(slider.style.backgroundColor, theme.colors.border));
    this.addRect(slider.rect.x, trackY, slider.rect.width * slider.ratio, trackHeight, trackHeight * 0.5, colorToRgba(theme.colors.primary, theme.colors.primary));
    this.addRect(thumbX, slider.rect.y + (slider.rect.height - thumbSize) * 0.5, thumbSize, thumbSize, thumbSize * 0.5, colorToRgba(slider.focused ? theme.colors.active : theme.colors.text, theme.colors.text));
  }

  private addRect(x: number, y: number, width: number, height: number, radius: number, color: [number, number, number, number]): void {
    this.currentBatch.addShape({ x, y, width, height, radius, color });
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
  ): void {
    this.currentTextBatch.addText({
      text,
      x,
      y,
      width,
      height,
      fontSize,
      color,
      multiline: true,
      wrap: true,
      lineHeight: fontSize * 1.2,
      clip: { x, y, width, height },
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
  ): void {
    this.currentPopupTextBatch.addText({
      text,
      x,
      y,
      width,
      height,
      fontSize,
      color,
      multiline: true,
      wrap: true,
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
    if (!this.defaultFont) {
      this.addText(text, x, y, width, height, fontSize, color);
      return;
    }
    const textWidth = measureGuiTextWidth(text, this.defaultFont, fontSize);
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
      clip: { x, y, width, height },
    });
  }
}
