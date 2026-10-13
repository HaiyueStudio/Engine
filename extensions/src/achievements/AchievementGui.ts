import { GuiElement, GuiImage, GuiLabel, GuiScrollView, type GuiElementOptions } from '@haiyue/engine/gui';
import type { I18n } from '../i18n/I18n';
import { bindI18nImage, type I18nImageBinding, type I18nImageLoader } from '../i18n/bindings';
import type { AchievementRuntime } from './AchievementRuntime';

export interface AchievementGuiOptions {
  parent: GuiElement;
  i18n: I18n;
  hiddenKey: string;
  lockedKey: string;
  unlockedKey: string;
  /** Optional translated sync labels, e.g. queued vs local-only. */
  syncKeys?: Readonly<Partial<Record<'local-only' | 'queued' | 'provider-accepted' | 'reconciled' | 'failed', string>>>;
  imageLoader?: I18nImageLoader;
  bounds?: GuiElementOptions;
  toastParent?: GuiElement;
  /** Disable when the platform's native completion banners are enabled. */
  toast?: boolean;
  toastDurationMs?: number;
  signal?: AbortSignal;
}
/** Optional event-driven GPU GUI. No platform callback grants a reward or replays a toast. */
export class AchievementGui {
  readonly panel: GuiScrollView;
  readonly toast: GuiLabel;
  private dead = false;
  private toastId: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly stops: (() => void)[] = [];
  private readonly images: I18nImageBinding[] = [];
  private readonly abort = () => this.dispose();
  constructor(private readonly runtime: AchievementRuntime, private readonly options: AchievementGuiOptions) {
    const duration = options.toastDurationMs ?? 3500;
    if (!Number.isFinite(duration) || duration < 1) throw new Error('Invalid toast duration');
    this.panel = new GuiScrollView({ width: '100%', height: '100%', style: { backgroundColor: '#112238' }, ...options.bounds });
    this.toast = new GuiLabel({ x: 12, y: 12, width: '90%', height: 46, visible: false, fontSize: 18, textAlign: 'center', style: { color: '#b8f6d7', backgroundColor: '#133c3b' } });
    if (runtime.disposed || options.i18n.disposed || options.signal?.aborted) { this.dead = true; return; }
    try {
      options.parent.add(this.panel); (options.toastParent ?? options.parent).add(this.toast);
      this.stops.push(runtime.subscribe(e => {
        if (e.type === 'dispose') this.dispose();
        else if (e.type === 'change' || e.type === 'sync') this.refresh();
        else if (e.type === 'unlocked' && options.toast !== false) {
          this.toastId = e.id; this.renderToast(); this.toast.setVisible(true); if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => { this.toastId = undefined; this.toast.setVisible(false); }, duration);
        }
      }));
      this.stops.push(options.i18n.subscribe(e => { if (e.type === 'dispose') this.dispose(); else { this.refresh(); this.renderToast(); } }));
      options.signal?.addEventListener('abort', this.abort, { once: true }); this.refresh();
    } catch (error) { this.dispose(); throw error; }
  }
  refresh(): void {
    if (this.dead) return;
    for (const binding of this.images) binding.dispose(); this.images.length = 0;
    for (const child of [...this.panel.children]) this.panel.remove(child);
    const records = this.runtime.snapshot().records, i18n = this.options.i18n;
    this.runtime.definitions.forEach((d, index) => {
      const r = records.find(r => r.id === d.id)!, unlocked = r.value === d.target, hidden = d.hidden && !unlocked;
      const row = this.panel.add(new GuiElement({ x: 12, y: 12 + index * 104, width: '94%', height: 94, style: { backgroundColor: '#1c3149' } }));
      const title = hidden ? i18n.text(this.options.hiddenKey) : i18n.text(d.titleKey);
      row.add(new GuiLabel({ x: 60, y: 6, width: '80%', height: 26, text: title, fontSize: 18, style: { color: unlocked ? '#92ebbf' : '#e9f4ff' } }));
      row.add(new GuiLabel({ x: 60, y: 32, width: '80%', height: 22, text: hidden ? '' : i18n.text(d.descriptionKey), fontSize: 12, style: { color: '#adc1d8' } }));
      const syncKey = this.options.syncKeys?.[r.sync];
      row.add(new GuiLabel({ x: 60, y: 57, width: '80%', height: 24, fontSize: 12, text: hidden ? i18n.text(this.options.lockedKey) : `${unlocked ? i18n.text(this.options.unlockedKey) : `${r.value} / ${d.target}`}${syncKey ? ` · ${i18n.text(syncKey)}` : ''}`, style: { color: '#adc1d8' } }));
      const track = row.add(new GuiElement({ x: 60, y: 84, width: '78%', height: 3, style: { backgroundColor: '#0b1729' } }));
      track.add(new GuiElement({ width: `${hidden ? 0 : r.value / d.target * 100}%`, height: 3, style: { backgroundColor: '#57cfaf' } }));
      if (!hidden && d.iconKey && this.options.imageLoader) {
        const icon = row.add(new GuiImage({ x: 10, y: 16, width: 40, height: 40 }));
        this.images.push(bindI18nImage(i18n, icon, d.iconKey, { textKey: d.titleKey, load: this.options.imageLoader }));
      } else row.add(new GuiLabel({ x: 10, y: 21, width: 40, height: 30, text: hidden ? '?' : unlocked ? '+' : '-', textAlign: 'center', fontSize: 26, style: { color: '#57cfaf' } }));
    });
    this.panel.setContentHeight(this.runtime.definitions.length * 104 + 24);
  }
  dispose(): void {
    if (this.dead) return; this.dead = true;
    if (this.timer) clearTimeout(this.timer); for (const stop of this.stops) stop(); this.stops.length = 0;
    for (const image of this.images) image.dispose(); this.images.length = 0;
    this.options.signal?.removeEventListener('abort', this.abort); this.options.parent.remove(this.panel); (this.options.toastParent ?? this.options.parent).remove(this.toast);
  }
  private renderToast() { const d = this.runtime.definitions.find(d => d.id === this.toastId); if (d) this.toast.setText(`${this.options.i18n.text(this.options.unlockedKey)} · ${this.options.i18n.text(d.titleKey)}`); }
}
