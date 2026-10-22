import {consumeInputEvent} from '../../input/InputEventConsumption';
import type {GuiTextInputHost,GuiTextInputRequest,GuiTextInputSession} from './GuiTextInputHost';
import {GuiNativeTextProjection} from './GuiNativeTextProjection';
import {guiTextDifference} from './GuiGraphemes';
import type {GuiRect} from '../GuiTypes';

/** Browser-native editing/IME responder. The GPU GUI remains the visible control. */
export class GuiBrowserTextInputHost implements GuiTextInputHost {
  private target:HTMLInputElement|HTMLTextAreaElement|null=null;
  private session:GuiTextInputSession|null=null;
  constructor(private readonly document:Document,private readonly restoreFocus:()=>void=()=>{},private readonly surfaceBounds?:()=>GuiRect){}
  ownsTarget(target:EventTarget|null):boolean{return !!this.target&&target===this.target;}

  open(request:GuiTextInputRequest):GuiTextInputSession {
    this.session?.close();
    const document=this.document,view=document.defaultView;
    if(!view||!document.body)throw new Error('Browser text host requires a live document.');
    const element=request.multiline?document.createElement('textarea'):document.createElement('input');
    if(element instanceof view.HTMLInputElement)element.type=request.inputType==='password'?'password':'text';
    element.inputMode=request.inputType==='number'?'decimal':request.inputType==='email'?'email':'text';
    element.autocomplete='off';element.spellcheck=false;element.setAttribute('aria-label','Active GUI text input');
    element.dataset.haiyueTextInput=String(request.generation);
    Object.assign(element.style,{position:'fixed',left:'0px',top:'0px',width:'1px',height:'18px',padding:'0',margin:'0',border:'0',opacity:'0.01',color:'transparent',caretColor:'transparent',background:'transparent',pointerEvents:'none',zIndex:'2147483647',resize:'none',overflow:'hidden',fontSize:'16px'});
    let closed=false,synchronizing=false,composing=false,committed=request.value,originStart=0,originEnd=0,eventId=0;
    let projection=new GuiNativeTextProjection(committed,request.multiline),requestedSelection:readonly [number,number]|null=null;
    element.value=projection.value;
    const storedSelection=():readonly [number,number]=>{
      const start=element.selectionStart??0,end=element.selectionEnd??start;
      if(requestedSelection){
        const [a,b]=requestedSelection;
        if(projection.toNative(Math.min(a,b))===start&&projection.toNative(Math.max(a,b))===end&&(start===end||element.selectionDirection===(a>b?'backward':'forward')))return requestedSelection;
      }
      const a=projection.toStored(start),b=projection.toStored(end);return element.selectionDirection==='backward'?[b,a]:[a,b];
    };
    const removals:(()=>void)[]=[];
    const listen=(target:EventTarget,name:string,handler:EventListener)=>{target.addEventListener(name,handler);removals.push(()=>target.removeEventListener(name,handler));};
    const emitComposition=(phase:'start'|'update'|'commit'|'cancel',text:string)=>{
      const start=Math.max(0,Math.min(text.length,(element.selectionStart??originStart)-originStart));
      const end=Math.max(start,Math.min(text.length,(element.selectionEnd??originStart)-originStart));
      request.onComposition({generation:request.generation,phase,text,selectionUtf16:[start,end],...(phase==='commit'?{eventId:++eventId}:{})});
    };
    const preview=()=>element.value.slice(originStart,Math.max(originStart,element.value.length-(projection.value.length-originEnd)));
    const selection=()=>{
      if(closed||synchronizing||composing||document.activeElement!==element||element.value!==projection.value)return;
      request.onSelection(...storedSelection(),request.generation);
    };
    const replace=(text:string)=>{const [a,b]=storedSelection();request.onEdit({startUtf16:Math.min(a,b),endUtf16:Math.max(a,b),text,generation:request.generation,eventId:++eventId});};
    listen(element,'compositionstart',()=>{
      if(closed)return;selection();composing=true;originStart=element.selectionStart??0;originEnd=element.selectionEnd??originStart;emitComposition('start','');
    });
    listen(element,'compositionupdate',event=>{if(!closed&&composing)emitComposition('update',(event as CompositionEvent).data??preview());});
    listen(element,'compositionend',event=>{
      if(closed||!composing)return;
      const text=(event as CompositionEvent).data??preview();composing=false;
      emitComposition(text?'commit':'cancel',text);
    });
    listen(element,'beforeinput',event=>{
      const input=event as InputEvent;
      if(closed||composing||input.isComposing)return;
      if(input.inputType==='historyUndo'||input.inputType==='historyRedo'){
        input.preventDefault();consumeInputEvent(input);request.onCommand(input.inputType==='historyUndo'?'undo':'redo');
      }else if(input.inputType==='deleteContentBackward'||input.inputType==='deleteContentForward'){
        input.preventDefault();consumeInputEvent(input);selection();request.onCommand(input.inputType==='deleteContentBackward'?'deleteBackward':'deleteForward');
      }else if((input.inputType==='insertText'||input.inputType==='insertReplacementText')&&input.data!==null){
        input.preventDefault();consumeInputEvent(input);replace(input.data);
      }else if(input.inputType==='insertLineBreak'||input.inputType==='insertParagraph'){
        input.preventDefault();consumeInputEvent(input);if(request.multiline)replace('\n');else request.onCommand('submit');
      }
    });
    listen(element,'paste',event=>{
      if(closed||composing)return;const clipboard=event as ClipboardEvent;
      if(!clipboard.clipboardData)return;clipboard.preventDefault();consumeInputEvent(clipboard);replace(clipboard.clipboardData.getData('text/plain'));
    });
    for(const name of ['copy','cut'])listen(element,name,event=>{
      if(closed||composing)return;const clipboard=event as ClipboardEvent;
      if(!clipboard.clipboardData)return;
      clipboard.preventDefault();consumeInputEvent(clipboard);
      if(request.inputType==='password')return;
      const [a,b]=storedSelection();clipboard.clipboardData.setData('text/plain',committed.slice(Math.min(a,b),Math.max(a,b)));
      if(name==='cut')replace('');
    });
    listen(element,'input',event=>{
      if(closed||synchronizing)return;
      consumeInputEvent(event);
      if(composing||(event as InputEvent).isComposing){if(composing)emitComposition('update',preview());return;}
      const value=element.value;if(value===projection.value){selection();return;}
      const a=element.selectionStart??value.length,b=element.selectionEnd??a;
      const edit=guiTextDifference(projection.value,value),selected=requestedSelection;
      let start=projection.toStored(edit.startUtf16),end=projection.toStored(edit.endUtf16);
      if(selected&&projection.toNative(Math.min(...selected))===edit.startUtf16&&projection.toNative(Math.max(...selected))===edit.endUtf16){start=Math.min(...selected);end=Math.max(...selected);}
      committed=committed.slice(0,start)+edit.text+committed.slice(end);projection=new GuiNativeTextProjection(committed,request.multiline);requestedSelection=null;
      const rawA=projection.toStored(a),rawB=projection.toStored(b),postSelection:readonly [number,number]=element.selectionDirection==='backward'?[rawB,rawA]:[rawA,rawB];
      request.onValue(committed,postSelection,request.generation,++eventId);
    });
    listen(element,'keydown',event=>{
      const key=event as KeyboardEvent;consumeInputEvent(key);
      if(composing||key.isComposing||key.keyCode===229)return;
      if(!request.multiline&&!key.ctrlKey&&!key.metaKey&&!key.altKey&&(key.key==='Home'||key.key==='End')){
        key.preventDefault();selection();const index=key.key==='Home'?0:committed.length;request.onSelection(key.shiftKey?storedSelection()[0]:index,index,request.generation);return;
      }
      let command:Parameters<GuiTextInputRequest['onCommand']>[0]|null=null;
      if(key.key==='Tab')command=key.shiftKey?'previous':'next';
      else if(key.key==='Enter'&&!request.multiline)command='submit';
      else if(key.key==='Escape')command='cancel';
      else if(!key.ctrlKey&&!key.metaKey&&!key.altKey&&(key.key==='ArrowLeft'||key.key==='ArrowRight'))command=key.shiftKey?(key.key==='ArrowLeft'?'extendLeft':'extendRight'):(key.key==='ArrowLeft'?'left':'right');
      else if((key.ctrlKey||key.metaKey)&&key.key.toLowerCase()==='z')command=key.shiftKey?'redo':'undo';
      else if((key.ctrlKey||key.metaKey)&&key.key.toLowerCase()==='y')command='redo';
      if(command){key.preventDefault();selection();if(!key.repeat||command==='left'||command==='right'||command==='extendLeft'||command==='extendRight')request.onCommand(command);}
    });
    listen(element,'select',selection);listen(document,'selectionchange',selection);
    listen(element,'blur',()=>{if(!closed)request.onFocusLost(request.generation);});
    const viewport=()=>{
      if(closed)return;const visual=view.visualViewport;
      const top=Math.max(0,visual?.offsetTop??0),left=Math.max(0,visual?.offsetLeft??0);
      const bounds=this.surfaceBounds?.()??{x:0,y:0,width:view.innerWidth,height:view.innerHeight};
      request.onViewportInset({top:Math.max(0,top-bounds.y),left:Math.max(0,left-bounds.x),right:Math.max(0,bounds.x+bounds.width-left-(visual?.width??view.innerWidth)),bottom:Math.max(0,bounds.y+bounds.height-top-(visual?.height??view.innerHeight))});
    };
    listen(view,'resize',viewport);listen(view,'orientationchange',viewport);
    if(view.visualViewport){listen(view.visualViewport,'resize',viewport);listen(view.visualViewport,'scroll',viewport);}
    const session:GuiTextInputSession={
      setValue:value=>{if(closed)return;committed=value;projection=new GuiNativeTextProjection(value,request.multiline);requestedSelection=null;if(!composing&&element.value!==projection.value){synchronizing=true;try{element.value=projection.value;}finally{synchronizing=false;}}},
      setSelection:(anchor,focus)=>{
        if(closed||composing)return;
        requestedSelection=[anchor,focus];
        const start=projection.toNative(Math.min(anchor,focus)),end=projection.toNative(Math.max(anchor,focus)),direction=anchor>focus?'backward':'forward';
        if(element.selectionStart===start&&element.selectionEnd===end&&element.selectionDirection===direction)return;
        synchronizing=true;try{element.setSelectionRange(start,end,direction);}finally{synchronizing=false;}
      },
      setCaretRect:rect=>{if(closed)return;Object.assign(element.style,{left:`${rect.x}px`,top:`${rect.y}px`,height:`${Math.max(1,rect.height)}px`});},
      // DOM does not reliably confirm pending native preedit on programmatic blur.
      finish:()=>null,
      close:()=>{
        if(closed)return;const restore=document.activeElement===element&&document.hasFocus();closed=true;
        for(const off of removals)off();element.remove();
        if(this.target===element){this.target=null;this.session=null;}
        if(restore)this.restoreFocus();
      },
    };
    this.target=element;this.session=session;
    try{document.body.appendChild(element);session.setSelection(...request.selectionUtf16);element.focus({preventScroll:true});viewport();}
    catch(error){session.close();throw error;}
    return session;
  }
}
