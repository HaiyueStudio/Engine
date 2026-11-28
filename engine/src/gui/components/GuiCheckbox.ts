import {registerGuiControlSize} from '../GuiControlSize';
import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import { GuiElement } from './GuiElement';
import {activateGuiElement} from '../input/GuiActivation';
import type {GuiActionEvent} from '../GuiTypes';
import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent, GuiValueChangeHandler } from '../GuiTypes';

export interface GuiCheckboxOptions extends GuiElementOptions {
  checked?: boolean;
  indeterminate?: boolean;
  label?: string;
  onChange?: GuiValueChangeHandler<boolean>;
}

export class GuiCheckbox extends GuiElement {
  private static readonly __controlIdentityGuiCheckbox = /* @__PURE__ */ (() => admitGuiControl(GuiCheckbox.prototype, 'GuiCheckbox', undefined, paintGuiCheckbox, (_control,theme,state)=>({focusWidth:2,focusColor:theme.colors.focus??theme.colors.primary,...(state.disabled?{color:theme.colors.disabledText??theme.colors.textMuted}:{})})))();
  static override readonly themeControlType: string = 'GuiCheckbox';
  override handleAction(event: GuiActionEvent): void {
    super.handleAction(event);
    if (!event.consumed && event.action === 'confirm') activateGuiElement(this, event);
  }
  indeterminate: boolean;
  checked: boolean;
  label: string;
  onChange: GuiValueChangeHandler<boolean> | null;

  constructor(options: GuiCheckboxOptions = {}) {
    super({ width: 120, height: 28, focus: {mode: 'all'}, ...options });
    registerGuiControlSize(this,options,28);
    this.checked = options.checked ?? false;
    this.indeterminate=options.indeterminate??false;this.setVisualState({checked:this.checked});
    this.label = options.label ?? '';
    this.onChange = options.onChange ?? null;
  }

  setChecked(checked: boolean, emit = false): void {
    if (this.checked === checked) return;
    this.checked = checked;this.indeterminate=false;this.setVisualState({checked});
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
    if (emit) this.onChange?.(checked);
  }

  setIndeterminate(value:boolean):void {if(this.indeterminate===value)return;this.indeterminate=value;this.markDirty(GuiDirtyFlags.Visual);}

  override handleClick(event: GuiPointerEvent): void {
    super.handleClick(event);
    this.setChecked(!this.checked, true);
  }
}

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiCheckbox(context:GuiPaint.GuiControlPaintContext, checkbox: GuiCheckbox, theme: GuiPaint.GuiTheme): void {
    if(theme.density||checkbox.indeterminate){
      const skin=context.styleFor(checkbox),indicator=GuiPaint.guiPartStyle(context,checkbox,'indicator'),label=GuiPaint.guiPartStyle(context,checkbox,'label'),r=checkbox.rect,size=Math.max(0,Math.min(18,r.height-4)),x=r.x+2,y=r.y+(r.height-size)/2,on=checkbox.checked||checkbox.indeterminate;
      GuiPaint.paintGuiBox(context.currentBatch,{x,y,width:size,height:size},{...skin,radius:skin.radius??4,...indicator},GuiPaint.colorToRgba(indicator.backgroundColor??skin.backgroundColor,checkbox.disabled?theme.colors.disabled:on?theme.colors.primary:theme.colors.input??theme.colors.surface),GuiPaint.colorToRgba(indicator.borderColor??skin.borderColor,on?theme.colors.primary:theme.colors.border),context.currentClip,4);
      const mark=GuiPaint.colorToRgba(indicator.color,checkbox.disabled?theme.colors.disabledText??theme.colors.textMuted:theme.colors.onPrimary??'#fff');
      if(checkbox.indeterminate)GuiPaint.paintGuiLine(context.currentBatch,x+5,y+size/2,x+size-5,y+size/2,2,mark,context.currentClip);
      else if(checkbox.checked){GuiPaint.paintGuiLine(context.currentBatch,x+4,y+size*.5,x+size*.43,y+size*.73,2,mark,context.currentClip);GuiPaint.paintGuiLine(context.currentBatch,x+size*.43,y+size*.73,x+size-4,y+size*.3,2,mark,context.currentClip);}
      if(checkbox.label)context.addText(checkbox.label,x+size+8,r.y,Math.max(0,r.width-size-10),r.height,label.fontSize??theme.fontSize,GuiPaint.colorToRgba(label.color??skin.color,theme.colors.text),true);return;
    }
    const skin = context.styleFor(checkbox), r = skin.contentInsets || skin.nineSlice || skin.icon ? GuiPaint.guiContentBox(checkbox, 0, theme.fontSize).text : checkbox.rect;
    const size = Math.max(0, Math.min(18, r.height - 6, r.width - 4));
    const x = r.x + 2;
    const y = r.y + (r.height - size) * 0.5;
    const border = GuiPaint.colorToRgba(context.styleFor(checkbox).borderColor, checkbox.focused ? theme.colors.primary : theme.colors.border);
    const fill = context.styleFor(checkbox).backgroundColor ?? (checkbox.checked ? theme.colors.primary : theme.colors.surface);
    context.addRect(x, y, size, size, 4, border);
    context.addRect(x + 2, y + 2, size - 4, size - 4, 3, GuiPaint.withAlpha(GuiPaint.colorToRgba(context.styleFor(checkbox).backgroundColor, fill), checkbox.disabled ? 0.45 : 1));
    if (checkbox.checked) {
      const mark = GuiPaint.colorToRgba(theme.colors.text, theme.colors.text);
      context.addRect(x + 5, y + 9, 4, 2, 1, mark);
      context.addRect(x + 8, y + 6, 7, 2, 1, mark);
    }
    if (checkbox.label) {
      context.addText(checkbox.label, x + size + 8, r.y, Math.max(0,r.width - size - 10), r.height, theme.fontSize, GuiPaint.colorToRgba(theme.colors.text, theme.colors.text), true);
    }
  }
