import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent, GuiValueChangeHandler } from '../GuiTypes';
import { GuiElement } from './GuiElement';
import type {GuiActionEvent} from '../GuiTypes';
import {GuiTextBuffer} from '../input/GuiTextBuffer';
import {guiGraphemeBoundaries,guiSnapIndex} from '../input/GuiGraphemes';
import {guiPasswordMasked,guiPasswordPress,guiPasswordRelease,guiPasswordCancel} from '../input/GuiInputAdornments';
import {resetGuiInputCaret} from '../input/GuiInputPresentation';
import {beginGuiInputClick,moveGuiInputClick,finishGuiInputClick,cancelGuiInputClick} from '../input/GuiInputClickSelection';

export interface GuiInputOptions extends GuiElementOptions {
  value?: string;
  placeholder?: string;
  readOnly?: boolean;
  /** UTF-16 ceiling; truncation never divides an extended grapheme. */
  maxLength?: number;
  inputType?: 'text'|'email'|'number'|'password';
  multiline?: boolean;
  onChange?: GuiValueChangeHandler<string>;
  onSubmit?: GuiValueChangeHandler<string>;
}

export class GuiInput extends GuiElement {
  static override readonly themeControlType: string = 'GuiInput';
  override handlePointerCancel(event: GuiPointerEvent): void {
    this.selecting = false;guiPasswordCancel(this);cancelGuiInputClick(this);
    super.handlePointerCancel(event);
  }
  override handleAction(event: GuiActionEvent): void {
    super.handleAction(event);
    if (event.consumed) return;
    if(this.isComposing){if(event.action==='cancel')this.cancelComposition();event.consume();return;}
    if (event.action === 'left' || event.action === 'right') {
      this.moveCaret(event.action === 'left' ? -1 : 1); event.consume();
    } else if (event.action === 'confirm') { this.submit(); event.consume(); }
  }
  private readonly buffer: GuiTextBuffer;
  get value():string{return this.buffer.value;}
  set value(value:string){this.setValue(value);}
  placeholder: string;
  readOnly: boolean;
  get caretIndex():number{return this.buffer.caret;}
  set caretIndex(index:number){this.setCaret(index);}
  get selectionAnchor():number{return this.buffer.selectionAnchor;}
  set selectionAnchor(index:number){this.setSelection(index,this.selectionFocus);}
  get selectionFocus():number{return this.buffer.selectionFocus;}
  set selectionFocus(index:number){this.setSelection(this.selectionAnchor,index);}
  get maxLength():number{return this.buffer.maxLength;}
  set maxLength(value:number){this.edit(()=>this.buffer.setLimit(value),false);}
  readonly inputType:'text'|'email'|'number'|'password';
  readonly multiline:boolean;
  get isComposing():boolean{return this.buffer.composing;}
  get composition(){return this.buffer.composition;}
  get displayValue():string{
    const text=this.buffer.displayValue;if(!guiPasswordMasked(this))return text;
    const boundaries=guiGraphemeBoundaries(text);
    return boundaries.slice(1).map((end,index)=>this.multiline&&/^[\r\n]+$/u.test(text.slice(boundaries[index],end))?'\n':'•').join('');
  }
  get displayCaretIndex():number{return this.displayIndex(this.buffer.displayCaret);}
  get displaySelectionStart():number{return this.displayIndex(this.selectionStart);}
  get displaySelectionEnd():number{return this.displayIndex(this.selectionEnd,true);}
  get displayCompositionRange():readonly [number,number]|null {
    const composition=this.buffer.composition;
    return composition?[this.displayIndex(composition.startUtf16),this.displayIndex(composition.startUtf16+composition.text.length,true)]:null;
  }
  get canUndo():boolean{return this.buffer.canUndo;}
  get canRedo():boolean{return this.buffer.canRedo;}
  selecting = false;
  onChange: GuiValueChangeHandler<string> | null;
  onSubmit: GuiValueChangeHandler<string> | null;

  constructor(options: GuiInputOptions = {}) {
    super({ width: 180, height: 32, focus: {mode: 'all'}, ...options });
    this.buffer = new GuiTextBuffer(options.value??'',options.maxLength??Infinity);
    this.placeholder = options.placeholder ?? '';
    this.readOnly = options.readOnly ?? false;
    this.inputType=options.inputType??'text';this.multiline=options.multiline??false;
    this.onChange = options.onChange ?? null;
    this.onSubmit = options.onSubmit ?? null;
  }

  get selectionStart(): number {
    return Math.min(this.selectionAnchor, this.selectionFocus);
  }

  get selectionEnd(): number {
    return Math.max(this.selectionAnchor, this.selectionFocus);
  }

  get hasSelection(): boolean {
    return this.selectionStart !== this.selectionEnd;
  }

  get selectedText(): string {
    return this.hasSelection ? this.value.slice(this.selectionStart, this.selectionEnd) : '';
  }

  setValue(value: string, emit = false): void {
    this.edit(()=>this.buffer.setValue(value),emit);
  }

  insertText(text: string): void {
    if (this.disabled || this.readOnly || !text) return;
    this.edit(()=>this.buffer.insert(text));
  }

  deleteBackward(): void {
    if (this.disabled || this.readOnly) return;
    this.edit(()=>this.buffer.delete(true));
  }

  deleteForward(): void {
    if (this.disabled || this.readOnly) return;
    this.edit(()=>this.buffer.delete(false));
  }

  moveCaret(delta: number, extendSelection = false): void {
    this.edit(()=>this.buffer.move(delta,extendSelection),false);
  }

  setCaret(index: number, extendSelection = false): void {
    this.edit(()=>this.buffer.setCaret(index,extendSelection),false);
  }

  setSelection(anchor: number, focus: number, markDirty = true): void {
    if(markDirty)this.edit(()=>this.buffer.select(anchor,focus),false);
    else this.buffer.select(anchor,focus);
  }

  selectAll(): void {
    this.setSelection(0, this.value.length);
  }

  clearSelection(): void {
    this.setSelection(this.caretIndex, this.caretIndex);
  }

  getCaretIndexAt(localX: number, measureTextWidth: (text: string) => number, padding = this.style.padding ?? 8): number {
    const x = Math.max(0, localX - padding);
    if (x <= 0) return 0;
    const boundaries=this.buffer.graphemeBoundaries;
    for (let i = 1; i < boundaries.length; i++) {
      const before=boundaries[i-1]!,after=boundaries[i]!;
      const prev = measureTextWidth(guiPasswordMasked(this)?'•'.repeat(i-1):this.value.slice(0, before).replace(/\r\n|\r|\n/gu,' '));
      const next = measureTextWidth(guiPasswordMasked(this)?'•'.repeat(i):this.value.slice(0, after).replace(/\r\n|\r|\n/gu,' '));
      if (x < (prev + next) * 0.5) return before;
    }
    return this.value.length;
  }

  submit(): void {
    this.onSubmit?.(this.value);
  }

  override handlePointerDown(event: GuiPointerEvent): void {
    super.handlePointerDown(event);
    this.selecting = !guiPasswordPress(this,event.x,event.y);
    if(this.selecting)beginGuiInputClick(this,event);else cancelGuiInputClick(this);
  }

  override handlePointerMove(event: GuiPointerEvent): void {
    super.handlePointerMove(event);
    moveGuiInputClick(this,event);
    if (!this.selecting || !(event.buttons & 1)) return;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
  }

  override handlePointerUp(event: GuiPointerEvent): void {
    super.handlePointerUp(event);
    if(guiPasswordRelease(this,event.x,event.y)){resetGuiInputCaret(this);this.markDirty(GuiDirtyFlags.Text|GuiDirtyFlags.Visual|GuiDirtyFlags.Input);}
    if(finishGuiInputClick(this,event))this.selectAll();
    this.selecting = false;
  }

  replaceText(startUtf16:number,endUtf16:number,text:string,selectionUtf16?:readonly [number,number]):void {
    if(this.disabled||this.readOnly)return;
    this.edit(()=>{if(this.buffer.replace(startUtf16,endUtf16,text)&&selectionUtf16)this.buffer.select(...selectionUtf16);});
  }
  beginComposition():void {if(!this.disabled&&!this.readOnly)this.edit(()=>this.buffer.beginComposition(),false);}
  updateComposition(text:string,selectionUtf16?:readonly [number,number]):void {
    if(!this.disabled&&!this.readOnly)this.edit(()=>this.buffer.updateComposition(text,selectionUtf16),false);
  }
  commitComposition(text?:string):void {
    if(this.disabled||this.readOnly){this.cancelComposition();return;}
    this.edit(()=>this.buffer.commitComposition(text));
  }
  cancelComposition():void {this.edit(()=>this.buffer.cancelComposition(),false);}
  undo():void {if(!this.disabled&&!this.readOnly)this.edit(()=>this.buffer.undo());}
  redo():void {if(!this.disabled&&!this.readOnly)this.edit(()=>this.buffer.redo());}
  override handleFocus():void {resetGuiInputCaret(this);super.handleFocus();}
  override handleBlur():void {guiPasswordCancel(this,true);cancelGuiInputClick(this);this.markDirty(GuiDirtyFlags.Text);this.cancelComposition();this.selecting=false;resetGuiInputCaret(this);super.handleBlur();}

  private displayIndex(index:number,forward=false):number {
    const boundaries=guiGraphemeBoundaries(this.buffer.displayValue),offset=guiSnapIndex(boundaries,index,forward);
    return guiPasswordMasked(this)?boundaries.indexOf(offset):offset;
  }

  private edit(operation:()=>void,emit=true):void {
    const before=this.buffer.value,beforeDisplay=this.buffer.displayValue,revision=this.buffer.revision;
    operation();if(revision===this.buffer.revision)return;
    resetGuiInputCaret(this);
    const changed=before!==this.buffer.value;
    if(changed)cancelGuiInputClick(this);
    this.markDirty(GuiDirtyFlags.Visual|GuiDirtyFlags.Input|((changed||beforeDisplay!==this.buffer.displayValue)?GuiDirtyFlags.Text:0));
    if(changed&&emit)this.onChange?.(this.buffer.value);
  }
}
