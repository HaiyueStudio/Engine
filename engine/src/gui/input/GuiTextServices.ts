import type {GuiSystemOptions,GuiTextServiceContext} from '../systems/GuiSystem';
import type {GuiInput} from '../components/GuiInput';
import type {GuiElement} from '../components/GuiElement';
import {GuiRoot} from '../components/GuiRoot';
import {isGuiControl} from '../GuiControlIdentity';
import {GuiDirtyFlags} from '../GuiTypes';
import {GuiTextInputConnection} from './GuiTextInputConnection';
import {GuiBrowserTextInputHost} from './GuiBrowserTextInputHost';
import {guiInputPresentation} from './GuiInputPresentation';
import {GuiCaretClock} from './GuiCaretClock';
import {GuiTextViewport} from './GuiTextViewport';
import {guiInputPoint,guiInputHostRect} from './GuiInputProjection';
import {guiPasswordEyeHit} from './GuiInputAdornments';
import {cancelGuiInputClick} from './GuiInputClickSelection';
import type {GuiInputPresentation} from './GuiInputPresentation';
type PendingGuiPointerEvent=Readonly<{x:number;y:number}>;

/** Original editing, responder and caret owners, loaded with GuiInput. No new input listeners. */
export class GuiTextServices {
composing = false;
private compositionTarget:GuiInput|null=null;
private compositionGeneration=0;
private textConnection:GuiTextInputConnection|null=null;

private readonly caretClock=new GuiCaretClock(input=>this.owner.focus.focused===input&&this.owner.inputParticipant.enabled()&&this.owner.validPointerTarget(input));
private textViewportInset={top:0,right:0,bottom:0,left:0};
private readonly textViewport=new GuiTextViewport();
constructor(private readonly owner:GuiTextServiceContext, options:GuiSystemOptions,browserDocument:Document|undefined){
const engine=this.owner.engine;
    if(options.textInputHost){
      const host=options.textInputHost==='browser'?new GuiBrowserTextInputHost(browserDocument!,()=>engine.canvas?.focus({preventScroll:true}),()=>{const r=engine.canvas?.getBoundingClientRect();return r?{x:r.left,y:r.top,width:r.width,height:r.height}:{x:0,y:0,width:browserDocument!.defaultView!.innerWidth,height:browserDocument!.defaultView!.innerHeight};}):options.textInputHost;
      this.textConnection=new GuiTextInputConnection(host,{
        valid:target=>this.owner.inputParticipant.enabled()&&this.owner.validPointerTarget(target),
        keyboard:(event,target)=>this.owner.inputDomain.routeNativeKeyboard(this.owner.inputParticipant,event,target),
        caretRect:target=>this.textCaretRect(target),
        viewportInset:inset=>{this.textViewportInset={...inset};if(!inset.top&&!inset.right&&!inset.bottom&&!inset.left)this.textViewport.clear();this.textConnection?.target?.markDirty(GuiDirtyFlags.Input);options.onViewportInset?.(inset);},
        blur:target=>{if(this.owner.focus.focused===target)this.owner.focus.blur();},
        command:command=>{
          const target=this.owner.focus.focused;
          if(!(isGuiControl<GuiInput>(target, 'GuiInput')))return;
          if(command==='undo')target.undo();else if(command==='redo')target.redo();
          else if(command==='left'||command==='right'||command==='extendLeft'||command==='extendRight')target.moveCaret(command==='left'||command==='extendLeft'?-1:1,command==='extendLeft'||command==='extendRight');
          else if(command==='deleteBackward')target.deleteBackward();else if(command==='deleteForward')target.deleteForward();
          else if(command==='submit')target.submit();else this.owner.dispatchAction(command==='cancel'?'cancel':command,'keyboard');
          this.synchronizeTextInput();
        },
      });
    }


}
beforeBlur():void {

      this.compositionTarget?.cancelComposition();this.compositionTarget=null;this.composing=false;
      const target=this.textConnection?.target;
      this.textConnection?.close(!!target&&this.owner.inputParticipant.enabled()&&this.owner.validPointerTarget(target));

}

onCompositionStart = (): void => {
    const target=this.owner.focus.focused;if(!(isGuiControl<GuiInput>(target, 'GuiInput'))||target.readOnly)return;
    this.composing = true;
    this.compositionTarget=target;this.compositionGeneration=this.owner.focus.generation;target.beginComposition();
  };

onCompositionUpdate = (event:CompositionEvent): void => {
    if(this.compositionTarget&&this.owner.focus.focused===this.compositionTarget&&this.owner.focus.generation===this.compositionGeneration)this.compositionTarget.updateComposition(event.data??'');
  };

onCompositionEnd = (event: CompositionEvent): void => {
    this.composing = false;
    const focused=this.compositionTarget;this.compositionTarget=null;
    if(!focused||this.owner.focus.focused!==focused||this.owner.focus.generation!==this.compositionGeneration){focused?.cancelComposition();return;}
    if(event.data)focused.commitComposition(event.data);else focused.cancelComposition();
    if (this.owner.preventDefault) event.preventDefault();
  };

onCopy = (event: ClipboardEvent): void => {
    const focused = this.owner.focus.focused;
    if (!(isGuiControl<GuiInput>(focused, 'GuiInput')) || !focused.hasSelection) return;
    if(focused.inputType==='password'){event.preventDefault();return;}
    event.clipboardData?.setData('text/plain', focused.selectedText);
    if (this.owner.preventDefault) event.preventDefault();
  };

onCut = (event: ClipboardEvent): void => {
    const focused = this.owner.focus.focused;
    if (!(isGuiControl<GuiInput>(focused, 'GuiInput')) || !focused.hasSelection || focused.readOnly) return;
    if(focused.inputType==='password'){event.preventDefault();return;}
    event.clipboardData?.setData('text/plain', focused.selectedText);
    focused.deleteForward();
    if (this.owner.preventDefault) event.preventDefault();
  };

onPaste = (event: ClipboardEvent): void => {
    const focused = this.owner.focus.focused;
    if (!(isGuiControl<GuiInput>(focused, 'GuiInput')) || focused.readOnly) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) focused.insertText(text);
    if (this.owner.preventDefault) event.preventDefault();
  };

updateInputCaretFromPointer(input: GuiInput, pending: PendingGuiPointerEvent, extendSelection: boolean): void {
    const fontSize = this.findThemeFontSize(input);
    const root = [...this.owner.roots].find(root => root.findById(input.id) === input);
    const presentation=guiInputPresentation(input,text=>this.owner.renderer.measureTextWidth(text,fontSize,root,input),fontSize,this.owner.renderer.measureTextLineHeight(fontSize,root,input));
    const index=presentation.indexAt(pending.x,pending.y);
    if (extendSelection) input.setCaret(index, true);
    else input.setSelection(index, index);
    this.synchronizeTextInput();
  }

findThemeFontSize(element: GuiElement): number {
    const configured = element.getResolvedStyle().fontSize;
    if (configured !== undefined) return configured;
    let current: GuiElement | null = element;
    while (current.parent) current = current.parent;
    for (const root of this.owner.roots) {
      if (root.root === current) return root.theme.fontSize;
    }
    return 14;
  }

async writeClipboard(text: string): Promise<void> {
    if (!text || typeof navigator === 'undefined') return;
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // Clipboard API may be blocked outside a trusted browser gesture.
    }
  }

async readClipboard(): Promise<string> {
    if (typeof navigator === 'undefined') return '';
    try {
      return await navigator.clipboard?.readText() ?? '';
    } catch {
      return '';
    }
  }

getInputPresentation(input:GuiInput):GuiInputPresentation {
    if(this.owner.disposed)throw new Error('Cannot query a disposed GUI system.');
    // prepareRoots temporarily rebuilds the render set while emitting layout invalidations. The original ECS ownership remains authoritative throughout that operation.
    const roots=new Set(this.owner.inputWorld?[]:this.owner.roots);
    for(const world of this.owner.inputWorld?[this.owner.inputWorld]:this.owner.usedBy)if(!world.destroyed)for(const entity of world.iterQueryCandidates(this.owner.queryDescriptor!)){const candidate=entity.getComponent(GuiRoot);if(candidate&&!candidate.destroyed&&(!this.owner.rootFilter||this.owner.rootFilter.has(candidate)))roots.add(candidate);}
    const root=[...roots].find(root=>root.findById(input.id)===input);if(!root)throw new Error('Input belongs to another GUI owner.');
    const size=input.getResolvedStyle().fontSize??root.theme.fontSize;return guiInputPresentation(input,text=>this.owner.renderer.measureTextWidth(text,size,root,input),size,this.owner.renderer.measureTextLineHeight(size,root,input));
  }

synchronizeTextInput():void {
    const target=this.owner.focus.focused;
    if(!(isGuiControl<GuiInput>(target, 'GuiInput')))this.textViewport.clear();
    this.caretClock.synchronize(isGuiControl<GuiInput>(target, 'GuiInput')?target:null);
    this.textConnection?.synchronize(isGuiControl<GuiInput>(target, 'GuiInput')&&this.owner.inputParticipant.enabled()&&this.owner.validPointerTarget(target)?target:null);
  }

textCaretRect(input:GuiInput){
    const root=[...this.owner.roots].find(root=>root.findById(input.id)===input),size=this.findThemeFontSize(input);
    const presentation=()=>guiInputPresentation(input,text=>this.owner.renderer.measureTextWidth(text,size,root,input),size,this.owner.renderer.measureTextLineHeight(size,root,input));
    let local=presentation().caret;
    const projection=this.owner.inputProjection(),canvas=this.owner.engine.canvas;
    if(!projection||!canvas)return local;
    const rect=canvas.getBoundingClientRect(),inset=this.textViewportInset;
    const left=rect.left+inset.left,top=rect.top+inset.top,right=rect.left+rect.width-inset.right,bottom=rect.top+rect.height-inset.bottom;
    const toLocal=(x:number,y:number)=>guiInputPoint(x,y,{x:rect.left,y:rect.top,width:rect.width,height:rect.height},projection);
    const a=toLocal(left,top),b=toLocal(right,bottom);
    if(a&&b){this.textViewport.reveal(input,local,{x:a.x,y:a.y,width:Math.max(0,b.x-a.x),height:Math.max(0,b.y-a.y)});local=presentation().caret;}
    const host=guiInputHostRect(local,projection);
    return {x:rect.left+host.x*rect.width/projection.hostWidth,y:rect.top+host.y*rect.height/projection.hostHeight,width:host.width*rect.width/projection.hostWidth,height:host.height*rect.height/projection.hostHeight};
  }
  beforeKeyboard(event:KeyboardEvent):boolean {
    const focused=this.owner.focus.focused;
    if (isGuiControl<GuiInput>(focused, 'GuiInput') && (this.composing || focused.isComposing || event.isComposing)) return true;
    if(isGuiControl<GuiInput>(focused, 'GuiInput')&&focused.multiline&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&(event.key==='ArrowUp'||event.key==='ArrowDown')){
      const root=[...this.owner.roots].find(root=>root.findById(focused.id)===focused),size=this.findThemeFontSize(focused);
      const presentation=guiInputPresentation(focused,text=>this.owner.renderer.measureTextWidth(text,size,root,focused),size,this.owner.renderer.measureTextLineHeight(size,root,focused));
      focused.setCaret(presentation.indexAt(presentation.caret.x,presentation.caret.y+(event.key==='ArrowUp'?-1:1)*presentation.lineHeight+presentation.lineHeight/2),event.shiftKey);return true;
    }
    return false;
  }

  editKeyboard(event:KeyboardEvent):boolean {
    const focused=this.owner.focus.focused;
    if (!(isGuiControl<GuiInput>(focused, 'GuiInput'))) return false;
    if (this.composing || event.isComposing) return true;
    if (event.altKey) return false;
    const shortcut = event.metaKey || event.ctrlKey;

    if (shortcut) {
      const key = event.key.toLowerCase();
      if(key==='z'){if(event.shiftKey)focused.redo();else focused.undo();return true;}
      if(key==='y'){focused.redo();return true;}
      if (key === 'a') {
        focused.selectAll();
        return true;
      }
      if (key === 'c') {
          if(focused.inputType!=='password')void this.owner.writeClipboard(focused.selectedText);
        return true;
      }
      if (key === 'x') {
          if(focused.inputType==='password')return true;
        void this.owner.writeClipboard(focused.selectedText);
        if (!focused.readOnly && focused.hasSelection) focused.deleteForward();
        return true;
      }
      if (key === 'v') {
        const generation = this.owner.focus.generation;
        void this.owner.readClipboard().then(text => {
            if (text && this.owner.focus.generation === generation && this.owner.focus.focused === focused && !focused.isComposing && !this.owner.disposed){focused.insertText(text);this.synchronizeTextInput();}
        });
        return true;
      }
      return false;
    }

    if (event.key === 'Backspace') {
      focused.deleteBackward();
      return true;
    }
    if (event.key === 'Delete') {
      focused.deleteForward();
      return true;
    }
    if (event.key === 'ArrowLeft') {
      focused.moveCaret(-1, event.shiftKey);
      return true;
    }
    if (event.key === 'ArrowRight') {
      focused.moveCaret(1, event.shiftKey);
      return true;
    }
    if (event.key === 'Home') {
      focused.setCaret(0, event.shiftKey);
      return true;
    }
    if (event.key === 'End') {
      focused.setCaret(focused.value.length, event.shiftKey);
      return true;
    }
    if (event.key === 'Enter') {
      if(focused.multiline)focused.insertText('\n');else if (!event.repeat) focused.submit();
      return true;
    }
    if (event.key.length === 1) {
      focused.insertText(event.key);
      return true;
    }
    return false;
  }

  pointerEye(input:GuiInput,x:number,y:number):boolean{return guiPasswordEyeHit(input,x,y);}

  cancel():void {this.caretClock.stop();this.textViewport.clear();this.textConnection?.close(false);this.compositionTarget?.cancelComposition();this.compositionTarget=null;this.composing=false;}

  cancelSelection(input:GuiInput):void{input.selecting=false;cancelGuiInputClick(input);}

  dispose():void{const errors:unknown[]=[],run=(f:()=>void)=>{try{f();}catch(e){errors.push(e);}};run(()=>this.caretClock.stop());run(()=>this.textConnection?.dispose());this.textConnection=null;if(errors.length)throw new AggregateError(errors,"GUI text services cleanup failed.");}

  get viewportInset(){return this.textViewportInset;}
  get connection(){return this.textConnection;}

}
