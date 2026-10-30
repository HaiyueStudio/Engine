import type {GuiInput} from '../components/GuiInput';
import type {GuiRect} from '../GuiTypes';
import type {GuiTextInputHost,GuiTextInputRequest,GuiTextInputSession,GuiTextComposition} from './GuiTextInputHost';
import {guiTextDifference,guiWellFormedText} from './GuiGraphemes';

let generation=0;
interface Active {
  readonly target:GuiInput;readonly generation:number;session:GuiTextInputSession|null;
  value:string;selection:string;caret:string;inset:string;composing:boolean;lastEventId:number;
}

/** One generation-owned host lease. No platform polling, DOM creation or renderer ownership. */
export class GuiTextInputConnection {
  private active:Active|null=null;
  private closed=false;
  constructor(private readonly host:GuiTextInputHost,private readonly options:{
    keyboard?(event:KeyboardEvent,target:GuiInput):boolean;
    valid(target:GuiInput):boolean;
    caretRect(target:GuiInput):GuiRect;
    viewportInset(inset:{top:number;right:number;bottom:number;left:number}):void;
    command(command:Parameters<GuiTextInputRequest['onCommand']>[0]):void;
    blur(target:GuiInput):void;
  }){}
  get target():GuiInput|null{return this.active?.target??null;}
  get connected():boolean{return !!this.active?.session;}
  ownsTarget(target:EventTarget|null):boolean{return this.host.ownsTarget?.(target)??false;}

  synchronize(target:GuiInput|null):void {
    if(this.closed)return;
    if(!target||target.disabled||target.readOnly||!this.options.valid(target)){this.close(false);return;}
    if(this.active?.target!==target){
      this.close(false);
      if(!Number.isSafeInteger(++generation))throw new Error('GUI text generation exhausted.');
      const active:Active={target,generation,session:null,value:target.value,selection:'',caret:'',inset:'',composing:false,lastEventId:-1};
      this.active=active;
      const accepts=(token:number)=>{
        if(this.active!==active||active.generation!==token||this.closed||!this.options.valid(target)||target.disabled||target.readOnly)return false;
        // A programmatic cancel/value replacement invalidates the native preedit lease.
        // Drop its callbacks and reopen before any late native snapshot can overwrite the new value.
        if(active.composing&&!target.isComposing){this.flush();return false;}
        return true;
      };
      const once=(eventId:number|undefined):boolean=>{
        if(eventId===undefined)return true;
        if(!Number.isSafeInteger(eventId)||eventId<0||eventId<=active.lastEventId)return false;
        active.lastEventId=eventId;return true;
      };
      const composition=(event:GuiTextComposition):void=>{
        if(!accepts(event.generation))return;
        if(event.phase==='start')target.beginComposition();
        else if(event.phase==='update')target.updateComposition(event.text,event.selectionUtf16);
        else if(event.phase==='cancel')target.cancelComposition();
        else {if(!once(event.eventId))return;target.commitComposition(event.text);}
        active.composing=target.isComposing;
        this.flush(event.phase==='commit'||event.phase==='cancel');
      };
      let session:GuiTextInputSession;
      try{session=this.host.open({value:target.value,selectionUtf16:[target.selectionAnchor,target.selectionFocus],inputType:target.inputType,multiline:target.multiline,generation:active.generation,
        onKeyboard:event=>accepts(active.generation)?this.options.keyboard?.(event,target)??false:false,
        onEdit:edit=>{if(!accepts(edit.generation)||!once(edit.eventId))return;target.replaceText(edit.startUtf16,edit.endUtf16,edit.text,edit.selectionUtf16);this.flush(true);},
        onValue:(value,selection,token,eventId)=>{
          if(!accepts(token)||!once(eventId)||target.isComposing)return;
          const next=guiWellFormedText(value);
          if(next===target.value)target.setSelection(...selection);
          else {const edit=guiTextDifference(target.value,next);target.replaceText(edit.startUtf16,edit.endUtf16,edit.text,selection);}
          this.flush(true);
        },
        onComposition:composition,
        onSelection:(anchor,focus,token)=>{if(accepts(token)&&!target.isComposing){target.setSelection(anchor,focus);this.flush();}},
        onViewportInset:inset=>{if(!accepts(active.generation))return;if(![inset.top,inset.right,inset.bottom,inset.left].every(value=>Number.isFinite(value)&&value>=0))return;const key=JSON.stringify(inset);if(key===active.inset)return;active.inset=key;this.options.viewportInset(inset);},
        onCommand:command=>{if(accepts(active.generation))this.options.command(command);},
        onFocusLost:token=>{if(accepts(token))this.options.blur(target);},
      });}catch(error){if(this.active===active)this.active=null;target.cancelComposition();throw error;}
      if(this.active!==active){session.close();return;}
      active.session=session;
    }
    this.flush();
  }
  close(confirm:boolean):void {
    const active=this.active;if(!active)return;
    // Detach before calling host code: resign/close may synchronously reenter callbacks.
    this.active=null;
    try{
      if(active.inset)this.options.viewportInset({top:0,right:0,bottom:0,left:0});
      const event=confirm?active.session?.finish?.():null;
      if(event?.generation===active.generation&&event.phase==='commit'&&active.target.isComposing)active.target.commitComposition(event.text);
      else active.target.cancelComposition();
    }finally{active.target.cancelComposition();active.session?.close();}
  }
  dispose():void {this.closed=true;this.close(false);}
  private flush(forceValue=false):void {
    const active=this.active,session=active?.session;if(!active||!session)return;
    const target=active.target;
    if(active.composing&&!target.isComposing){this.close(false);this.synchronize(target);return;}
    if(target.value!==active.value||forceValue){
      if(!session.setValue){this.close(false);this.synchronize(target);return;}
      active.value=target.value;active.selection='';session.setValue(target.value);
      if(this.active!==active)return;
    }
    const selection=JSON.stringify([target.selectionAnchor,target.selectionFocus]);
    if(selection!==active.selection&&!target.isComposing){active.selection=selection;session.setSelection(target.selectionAnchor,target.selectionFocus);if(this.active!==active)return;}
    const rect=this.options.caretRect(target),caret=JSON.stringify(rect);
    if(caret!==active.caret){active.caret=caret;session.setCaretRect(rect);}
  }
}
