import { GuiDirtyFlags, type GuiElementOptions } from '../GuiTypes';
import { GuiElement } from './GuiElement';
import type { GuiImageSource } from './GuiImage';

export interface GuiToastOptions extends GuiElementOptions {
  text?: string;
  /** Borrowed image; hiding or destroying the toast does not destroy this source. */
  icon?: GuiImageSource;
  iconKey?: string;
  iconSize?: number;
  fontSize?: number;
  /** Fully visible hold time in milliseconds, excluding entry and exit. Default: 2200. */
  durationMs?: number;
  /** Duration of each fade/slide transition. 0 disables transitions. Default: 180. */
  animationMs?: number;
}

/** A non-interactive, single-message popup. show() replaces and restarts the current message. */
export class GuiToast extends GuiElement {
  static override readonly themeControlType: string = 'GuiToast';
  text: string;
  icon: GuiImageSource;
  iconKey: string | undefined;
  iconSize: number;
  fontSize: number;
  durationMs: number;
  animationMs: number;
  private elapsed = 0;
  private fresh = true;

  constructor(options: GuiToastOptions = {}) {
    super({ width: 280, height: 48, ...options, visible: options.visible ?? false });
    this.text = options.text ?? '';
    this.icon = options.icon ?? null;
    this.iconKey = options.iconKey;
    this.iconSize = options.iconSize ?? 22;
    this.fontSize = options.fontSize ?? 15;
    this.durationMs = options.durationMs ?? 2200;
    this.animationMs = options.animationMs ?? 180;
  }

  show(options: Pick<GuiToastOptions, 'text' | 'icon' | 'iconKey' | 'durationMs' | 'animationMs'> = {}): void {
    if (options.text !== undefined) this.text = options.text;
    if (options.icon !== undefined) this.icon = options.icon;
    if (options.iconKey !== undefined) this.iconKey = options.iconKey;
    if (options.durationMs !== undefined) this.durationMs = options.durationMs;
    if (options.animationMs !== undefined) this.animationMs = options.animationMs;
    this.elapsed = 0;
    this.fresh = true;
    this.setVisible(true);
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Text);
  }

  hide(): void {
    this.setVisible(false);
    this.elapsed = 0;
    this.fresh = true;
  }

  get animating(): boolean { return this.visible && !this.disabled; }

  get progress(): number {
    if (!this.visible) return 0;
    const transition = milliseconds(this.animationMs);
    if (transition === 0) return 1;
    const entering = Math.min(1, this.elapsed / transition);
    const leaving = Math.min(1, Math.max(0, (transition * 2 + milliseconds(this.durationMs) - this.elapsed) / transition));
    const t = Math.min(entering, leaving);
    return t * t * (3 - 2 * t);
  }

  advanceAnimation(deltaMs: number): void {
    if (!this.animating) return;
    // An on-demand renderer may have been idle for minutes before show().
    if (this.fresh) { this.fresh = false; return; }
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    const before = this.progress;
    this.elapsed += deltaMs;
    if (this.elapsed >= milliseconds(this.durationMs) + milliseconds(this.animationMs) * 2) this.hide();
    else if (this.progress !== before) this.markDirty(GuiDirtyFlags.Visual);
  }

  override hitTest(): GuiElement | null { return null; }
}

function milliseconds(value: number): number { return Number.isFinite(value) ? Math.max(0, value) : 0; }
