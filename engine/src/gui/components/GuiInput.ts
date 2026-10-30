import {GuiTextServices} from '../input/GuiTextServices';
import {admitGuiTextServices} from '../input/GuiTextServiceRegistry';
import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import {notifyGuiExternalTextEdit} from '../GuiExternalPresentation';
import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent, GuiValueChangeHandler } from '../GuiTypes';
import { GuiElement } from './GuiElement';
import type {GuiActionEvent} from '../GuiTypes';
import {GuiTextBuffer,type GuiTextBufferEdit} from '../input/GuiTextBuffer';
import {guiGraphemeBoundaries,guiSnapIndex,guiTextDifference} from '../input/GuiGraphemes';
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
  private static readonly __controlIdentityGuiInput = /* @__PURE__ */ (() => {admitGuiTextServices((context,options,document)=>new GuiTextServices(context,options,document));return admitGuiControl(GuiInput.prototype, 'GuiInput', undefined, paintGuiInput);})();
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
  private editDeltas:GuiTextBufferEdit[]|undefined;
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
    this.buffer = new GuiTextBuffer(options.value??'',options.maxLength??Infinity,edit=>this.editDeltas?.push(edit));
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
    const deltas:GuiTextBufferEdit[]=[],previousDeltas=this.editDeltas;this.editDeltas=deltas;
    try{operation();}finally{this.editDeltas=previousDeltas;}
    if(revision===this.buffer.revision&&!deltas.length)return;
    resetGuiInputCaret(this);
    const changed=before!==this.buffer.value;
    if(changed)cancelGuiInputClick(this);
    this.markDirty(GuiDirtyFlags.Visual|GuiDirtyFlags.Input|((changed||beforeDisplay!==this.buffer.displayValue)?GuiDirtyFlags.Text:0));
    if(emit){const value=this.buffer.value,selectionUtf16=Object.freeze([this.selectionAnchor,this.selectionFocus]) as readonly[number,number];
      const edits=deltas.length?deltas:changed?[Object.freeze({previous:before,value,...guiTextDifference(before,value)})]:[];
      for(const edit of edits)notifyGuiExternalTextEdit(this,Object.freeze({...edit,selectionUtf16}));
      if(changed)this.onChange?.(value);
    }
  }
}

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiInput(context:GuiPaint.GuiControlPaintContext, input: GuiInput, theme: GuiPaint.GuiTheme): void {
    const font = context.activeFont;
    const radius = context.styleFor(input).radius ?? theme.radius;
    const border = GuiPaint.colorToRgba(context.styleFor(input).borderColor, input.focused ? theme.colors.primary : theme.colors.border);
    context.addRect(input.rect.x, input.rect.y, input.rect.width, input.rect.height, radius, border);
    context.addRect(input.rect.x + 1, input.rect.y + 1, input.rect.width - 2, input.rect.height - 2, Math.max(0, radius - 1), GuiPaint.withAlpha(GuiPaint.colorToRgba(context.styleFor(input).backgroundColor, theme.colors.surface), input.disabled ? 0.45 : 1));

    const presentation=GuiPaint.guiInputPresentation(input,text=>context.measureTextWidth(text,theme.fontSize),theme.fontSize,context.measureTextLineHeight(theme.fontSize));
    const previousClip=context.currentClip;context.currentClip=context.clipRect(presentation.clip);
    const color = input.displayValue
      ? GuiPaint.colorToRgba(theme.colors.text, theme.colors.text)
      : GuiPaint.colorToRgba(theme.colors.textMuted, theme.colors.textMuted);

    if (input.focused && input.hasSelection && input.value && font && !input.isComposing) {
      for(const rect of presentation.ranges(input.displaySelectionStart,input.displaySelectionEnd))context.addRect(rect.x,rect.y,rect.width,rect.height,2,GuiPaint.withAlpha(GuiPaint.colorToRgba(theme.colors.primary,theme.colors.primary),0.42));
    }

    const lines=input.displayValue?presentation.lines:input.multiline?input.placeholder.split('\n'):[input.placeholder];
    for(let row=0;row<lines.length;row++)context.currentTextBatch.addText({text:lines[row]!,x:presentation.origin.x,y:presentation.origin.y+(input.multiline?row*presentation.lineHeight:0),width:Math.max(presentation.clip.width,presentation.contentWidth+2),height:input.multiline?presentation.lineHeight:presentation.textHeight,fontSize:theme.fontSize,color,multiline:false,wrap:false,verticalAlign:input.multiline?'top':'center',clip:context.currentClip});

    const composition=input.composition;
    if(input.focused&&composition?.text&&font){
      const range=input.displayCompositionRange!;
      for(const rect of presentation.ranges(...range))context.addRect(rect.x,rect.y+rect.height-2,rect.width,1,0,GuiPaint.colorToRgba(theme.colors.primary,theme.colors.primary));
    }

    if (input.focused && !input.disabled && !input.readOnly && font && !input.hasSelection && (input.isComposing||GuiPaint.guiInputCaretVisible(input))) {
      const rect=presentation.caret;context.addRect(rect.x,rect.y,rect.width,rect.height,0.75,GuiPaint.colorToRgba(theme.colors.text,theme.colors.text));
    }
    context.currentClip=previousClip;context.currentClip=context.clipRect(input.rect);
    const {counter,eye}=presentation.adornments;
    if(counter)context.currentTextBatch.addText({text:counter.text,...counter.rect,fontSize:counter.fontSize,color:GuiPaint.colorToRgba(input.value.length>=input.maxLength?theme.colors.primary:theme.colors.textMuted,theme.colors.textMuted),clip:context.currentClip,verticalAlign:'top'});
    if(eye&&eye.width>0){
      const cx=eye.x+eye.width/2,cy=eye.y+eye.height/2,ink=GuiPaint.colorToRgba(theme.colors.textMuted,theme.colors.textMuted),surface=GuiPaint.colorToRgba(context.styleFor(input).backgroundColor,theme.colors.surface);
      const scale=Math.min(1,eye.width/24),w=20*scale,h=12*scale;
      context.addRect(cx-w/2,cy-h/2,w,h,h/2,ink);
      context.addRect(cx-w/2+1.5,cy-h/2+1.5,Math.max(0,w-3),Math.max(0,h-3),Math.max(0,h/2-1.5),surface);
      context.addRect(cx-3*scale,cy-3*scale,6*scale,6*scale,3*scale,ink);
      if(!GuiPaint.guiPasswordRevealed(input))for(let i=-7;i<=7;i++)context.addRect(cx+i*scale-1,cy+i*.65*scale-1,2,2,1,ink);
    }
    context.currentClip=previousClip;
  }
