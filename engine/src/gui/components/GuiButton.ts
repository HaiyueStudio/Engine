import {finishGuiButtonHover,retargetGuiButtonHover} from '../input/GuiButtonHover';
import { GuiElement } from './GuiElement';
import {activateGuiElement} from '../input/GuiActivation';
import type {GuiActionEvent} from '../GuiTypes';
import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent } from '../GuiTypes';

export interface GuiButtonOptions extends GuiElementOptions {
  text?: string;
  /** Animate hover enter/leave colors. Defaults to false. */
  hoverTransition?: boolean;
  /** Hover color transition duration in milliseconds. Defaults to 180; nonpositive or nonfinite values are instant. */
  hoverTransitionMs?: number;
  variant?: 'default' | 'primary' | 'danger' | 'outline';
  onClick?: (event: GuiPointerEvent) => void;
}

export class GuiButton extends GuiElement {
  static override readonly themeControlType: string = 'GuiButton';
  override handleAction(event: GuiActionEvent): void {
    super.handleAction(event);
    if (!event.consumed && event.action === 'confirm') activateGuiElement(this, event);
  }
  private transitionEnabled: boolean;
  private transitionDuration: number;
  get hoverTransition():boolean {return this.transitionEnabled;}
  set hoverTransition(value:boolean) {this.transitionEnabled=value;finishGuiButtonHover(this);this.markDirty(GuiDirtyFlags.Visual);}
  get hoverTransitionMs():number {return this.transitionDuration;}
  set hoverTransitionMs(value:number) {this.transitionDuration=Number.isFinite(value)?Math.max(0,value):0;finishGuiButtonHover(this);this.markDirty(GuiDirtyFlags.Visual);}
  override handlePointerEnter(event:GuiPointerEvent):void {super.handlePointerEnter(event);retargetGuiButtonHover(this);}
  override handlePointerLeave(event:GuiPointerEvent):void {super.handlePointerLeave(event);retargetGuiButtonHover(this);}
  text: string;
  variant: 'default' | 'primary' | 'danger' | 'outline';

  constructor(options: GuiButtonOptions = {}) {
    super({ width: 96, height: 32, focus: {mode: 'all'}, ...options });
    this.transitionEnabled=options.hoverTransition??false;
    const duration=options.hoverTransitionMs??180;
    this.transitionDuration=Number.isFinite(duration)?Math.max(0,duration):0;
    finishGuiButtonHover(this);
    this.text = options.text ?? 'Button';
    this.variant = options.variant ?? 'default';
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.markDirty(GuiDirtyFlags.Text | GuiDirtyFlags.Visual);
  }
}
