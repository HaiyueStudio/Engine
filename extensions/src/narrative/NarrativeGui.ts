import { GuiButton, GuiElement, GuiImage, GuiLabel, GuiScrollView, type GuiElementOptions } from '@haiyue/engine/gui';
import type { I18n } from '../i18n/I18n';
import { bindI18nImage, type I18nImageBinding, type I18nImageLoader } from '../i18n/bindings';
import type { NarrativeRuntime } from './NarrativeRuntime';
import type { NarrativeArtwork } from './types';

export interface NarrativeGuiOptions {
  parent: GuiElement;
  i18n: I18n;
  imageLoader?: I18nImageLoader;
  bounds?: GuiElementOptions;
  continueKey: string;
  waitingKey: string;
  fontSize?: number;
  /** Optional font-accurate metrics; default uses conservative Unicode-width estimates. */
  measureText?: (text: string, fontSize: number) => number;
  signal?: AbortSignal;
}
/** Optional GPU GUI presenter. Runtime and action handlers remain owned by the host. */
export class NarrativeGui {
  readonly panel: GuiScrollView;
  private readonly image = new GuiImage();
  private readonly fallback = new GuiLabel({ textAlign: 'center', fontSize: 16 });
  private readonly content = new GuiElement({ width: '100%', height: '100%' });
  private binding: I18nImageBinding | undefined;
  private artwork: NarrativeArtwork | undefined;
  private dead = false;
  private lastWidth = -1;
  private readonly stop: (() => void)[] = [];
  private readonly abort = () => this.dispose();
  constructor(private readonly runtime: NarrativeRuntime, private readonly options: NarrativeGuiOptions) {
    const fontSize = options.fontSize ?? 18;
    if (!Number.isFinite(fontSize) || fontSize < 1) throw new RangeError('fontSize must be positive');
    this.panel = new GuiScrollView({ width: '100%', height: '100%', style: { backgroundColor: '#101e31' }, ...options.bounds });
    this.panel.add(this.image); this.panel.add(this.fallback); this.panel.add(this.content);
    const layout = this.panel.layout.bind(this.panel);
    this.panel.layout = rect => {
      layout(rect);
      if (!this.dead && this.lastWidth !== this.panel.rect.width) {
        this.lastWidth = this.panel.rect.width; this.renderText(); layout(rect);
      }
    };
    if (runtime.disposed || options.i18n.disposed || options.signal?.aborted) { this.dead = true; return; }
    try {
      options.parent.add(this.panel);
      this.stop.push(runtime.subscribe(event => {
        if (event.type === 'dispose') this.dispose(); else if (event.type === 'change') { this.panel.scrollTo(0); this.refresh(); }
      }));
      this.stop.push(options.i18n.subscribe(event => { if (event.type === 'dispose') this.dispose(); else this.renderText(); }));
      options.signal?.addEventListener('abort', this.abort, { once: true });
      this.refresh();
    } catch (error) { this.dispose(); throw error; }
  }
  get ready(): Promise<void> { return this.binding?.ready ?? Promise.resolve(); }
  get imageError(): unknown { return this.binding?.error; }
  refresh(): void {
    if (this.dead) return;
    const node = this.runtime.view?.node;
    const artwork = node && 'artwork' in node ? node.artwork : undefined;
    if (artwork?.assetKey !== this.artwork?.assetKey || artwork?.textKey !== this.artwork?.textKey) {
      this.binding?.dispose(); this.binding = undefined; this.artwork = artwork;
      if (artwork && this.options.imageLoader) this.binding = bindI18nImage(this.options.i18n, this.image, artwork.assetKey, {
        textKey: artwork.textKey, load: this.options.imageLoader, fallbackLabel: this.fallback,
      });
    }
    this.image.setVisible(!!artwork);
    if (!this.binding) {
      this.fallback.setVisible(!!artwork);
      if (artwork) this.fallback.setText(this.options.i18n.text(artwork.textKey));
    }
    this.renderText();
  }
  dispose(): void {
    if (this.dead) return;
    this.dead = true; this.binding?.dispose(); this.binding = undefined;
    for (const unsubscribe of this.stop) unsubscribe(); this.stop.length = 0;
    this.options.signal?.removeEventListener('abort', this.abort);
    this.options.parent.remove(this.panel);
  }
  private renderText(): void {
    if (this.dead) return;
    const view = this.runtime.view;
    for (const child of [...this.content.children]) this.content.remove(child);
    const width = Math.max(48, this.panel.rect.width || 600), usable = Math.max(1, width - 48);
    const fontSize = this.options.fontSize ?? 18, lineHeight = Math.ceil(fontSize * 1.5);
    const params = Object.fromEntries(Object.entries(view?.variables ?? {}).map(([key, value]) => [key, typeof value === 'boolean' ? String(value) : value]));
    const translate = (key: string) => this.options.i18n.text(key, params);
    const imageHeight = this.artwork ? Math.min(190, usable * 0.5) : 0;
    this.image.layout = r => { this.image.rect = { x: r.x + 24, y: r.y + 20, width: usable, height: imageHeight }; };
    this.fallback.layout = r => { this.fallback.rect = { x: r.x + 24, y: r.y + 20 + imageHeight / 2 - 16, width: usable, height: 32 }; };
    let y = imageHeight ? imageHeight + 44 : 24;
    const label = (value: string, color: string, size = fontSize) => {
      for (const line of this.wrap(value, usable, size)) {
        this.content.add(new GuiLabel({ x: 24, y, width: usable, height: lineHeight, text: line, fontSize: size, style: { color } })); y += lineHeight;
      }
    };
    if (view) {
      const node = view.node;
      if ('speakerKey' in node && node.speakerKey) { label(translate(node.speakerKey), '#71d6e6', Math.max(1, fontSize - 2)); y += 8; }
      if ('textKey' in node && node.textKey) label(translate(node.textKey), '#edf4ff');
      y += 20;
      const button = (id: string, value: string, enabled: boolean, action: () => void) => {
        const lines = this.wrap(value, Math.max(1, usable - 32), Math.max(1, fontSize - 2)), height = Math.max(44, lines.length * lineHeight + 16);
        const b = this.content.add(new GuiButton({ id: `${this.panel.id}:${id}`, x: 24, y, width: usable, height, text: '', disabled: !enabled, onClick: () => { if (!this.dead) action(); } }));
        lines.forEach((line, index) => b.add(new GuiLabel({ x: 16, y: 8 + index * lineHeight, width: Math.max(1, usable - 32), height: lineHeight, text: line, fontSize: Math.max(1, fontSize - 2), style: { color: enabled ? '#edf4ff' : '#77899e' } })));
        y += height + 12;
      };
      if (node.type === 'dialogue') button('continue', translate(this.options.continueKey), true, () => { this.runtime.advance(view.revision); });
      else if (node.type === 'choice') for (const choice of view.choices) button(`choice:${choice.id}`, translate(choice.textKey), choice.enabled, () => { this.runtime.choose(choice.id, view.revision); });
      else if (node.type === 'action') label(translate(this.options.waitingKey), '#9bb2ca', Math.max(1, fontSize - 2));
    }
    this.panel.setContentHeight(y + 20);
    if (this.artwork && !this.binding) this.fallback.setText(translate(this.artwork.textKey));
  }
  private wrap(text: string, width: number, size: number): string[] {
    const measure = this.options.measureText ?? ((value: string, font: number) => [...value].reduce((sum, c) => sum + (c.codePointAt(0)! > 255 ? 1.12 : 0.75) * font, 0));
    const result: string[] = [];
    for (const paragraph of text.split('\n')) {
      let rest = [...paragraph];
      if (!rest.length) result.push('');
      while (rest.length) {
        let count = 1;
        while (count < rest.length && measure(rest.slice(0, count + 1).join(''), size) <= width) count++;
        const prefix = rest.slice(0, count).join('');
        const space = prefix.lastIndexOf(' ');
        if (count < rest.length && space > 0) count = [...prefix.slice(0, space + 1)].length;
        result.push(rest.splice(0, count).join('').trimEnd());
      }
    }
    return result;
  }
}
