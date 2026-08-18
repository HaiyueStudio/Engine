import { GuiElementOptions, GuiRect } from '../GuiTypes';
import { GuiElement } from './GuiElement';

export type GuiTooltipPlacement = 'top' | 'right' | 'bottom' | 'left';

export interface GuiTooltipOptions extends GuiElementOptions {
  target: GuiElement;
  content?: string;
  placement?: GuiTooltipPlacement;
  delay?: number;
}

export class GuiTooltip extends GuiElement {
  target: GuiElement;
  content: string;
  placement: GuiTooltipPlacement;
  delay: number;
  private activeSince = 0;

  constructor(options: GuiTooltipOptions) {
    super({
      width: options.width ?? 180,
      height: options.height ?? 30,
      visible: options.visible ?? true,
      disabled: true,
      style: options.style,
      id: options.id,
    });
    this.target = options.target;
    this.content = options.content ?? '';
    this.placement = options.placement ?? 'top';
    this.delay = options.delay ?? 0;
  }

  get active(): boolean {
    const targetActive = this.visible && (this.target.hovered || this.target.focused);
    if (!targetActive) {
      this.activeSince = 0;
      return false;
    }
    if (this.delay <= 0) return true;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this.activeSince === 0) {
      this.activeSince = now;
      return false;
    }
    return now - this.activeSince >= this.delay;
  }

  get popupRect(): GuiRect {
    const gap = 8;
    const target = this.target.rect;
    const width = this.rect.width;
    const height = this.rect.height;
    if (this.placement === 'right') {
      return { x: target.x + target.width + gap, y: target.y + (target.height - height) * 0.5, width, height };
    }
    if (this.placement === 'bottom') {
      return { x: target.x + (target.width - width) * 0.5, y: target.y + target.height + gap, width, height };
    }
    if (this.placement === 'left') {
      return { x: target.x - width - gap, y: target.y + (target.height - height) * 0.5, width, height };
    }
    return { x: target.x + (target.width - width) * 0.5, y: target.y - height - gap, width, height };
  }

  override hitTest(): GuiElement | null {
    return null;
  }
}
