import type {HaiyueEngine} from '@haiyue/engine';
import {GuiButton,GuiInput,GuiLabel,GuiScrollView,type GuiRoot,type GuiSystem} from '@haiyue/engine/gui';
import {BrowserMultiplayerInput} from '@haiyue/engine/experimental/simulation';

/** Public-import production GUI path for browser IME and cross-host editing acceptance. */
export function attachTextEditing(engine:HaiyueEngine,gui:GuiSystem,root:GuiRoot):()=>void {
  const canvas=engine.canvas!;let disposed=false,tick=0,sceneActions=0,submits=0;
  const changes:Record<string,number>={};
  const trace:{type:string;trusted:boolean;generation:string;data:string|null;inputType:string}[]=[];
  const content=root.add(new GuiScrollView({id:'text-viewport',width:'100%',height:'100%',contentHeight:850,focus:{mode:'none'}}));
  const sampler=new BrowserMultiplayerInput({players:[{id:'scene',bindings:{jump:{keys:['Space']}}}]});
  content.add(new GuiLabel({x:24,y:16,width:900,text:'Unicode / IME text editing',fontSize:26}));
  content.add(new GuiLabel({x:24,y:56,width:1000,text:'Click a field. Use real IME to preview, commit or cancel. Tab switches fields.',fontSize:16}));
  const add=(id:string,label:string,value:string,y:number,maxLength=64,inputType:'text'|'password'='text')=>{
    content.add(new GuiLabel({x:24,y:y-27,width:900,text:label,fontSize:16}));
    return content.add(new GuiInput({id,x:24,y,width:'90%',height:38,value,maxLength,inputType,onChange:()=>{changes[id]=(changes[id]??0)+1;publish();},onSubmit:()=>{submits++;publish();}}));
  };
  const a=add('text-a','A: UTF-16 selection, emoji and real composition','A😀B',128);
  const b=add('text-b','B: combining accents and ZWJ','e\u0301👩🏽‍💻',220);
  const limit=add('text-limit','UTF-16 limit 4; whole graphemes only','A😀B',312,4);
  const password=add('text-password','Password input hint (acceptance text only)','',404,64,'password');
  content.add(new GuiButton({id:'text-reset',x:24,y:478,width:220,text:'Reset test fields',onClick:()=>{
    a.setValue('A😀B');b.setValue('e\u0301👩🏽‍💻');limit.setValue('A😀B');password.setValue('');
    for(const key of Object.keys(changes))delete changes[key];trace.length=0;submits=0;gui.focus.blur();publish();
  }}));
  content.add(new GuiLabel({x:24,y:585,width:900,text:'Multiline: Enter, selection and vertical caret visibility',fontSize:16}));
  const multiline=content.add(new GuiInput({id:'text-multiline',x:24,y:620,width:'90%',height:100,multiline:true,value:'A😀B\né👩🏽‍💻\n中文',onChange:()=>{changes['text-multiline']=(changes['text-multiline']??0)+1;publish();}}));
  const status=content.add(new GuiLabel({x:24,y:760,width:1000,height:70,fontSize:16,text:'Click field A to begin.'}));
  const fields=[a,b,limit,password,multiline];
  const domEvent=(event:Event)=>{
    const target=event.target as HTMLInputElement|HTMLTextAreaElement|null;
    if(!target?.dataset?.haiyueTextInput)return;
    const input=event as InputEvent|CompositionEvent;
    trace.push({type:event.type,trusted:event.isTrusted,generation:target.dataset.haiyueTextInput,data:gui.focus.focused===password?'[redacted]':input.data??null,inputType:'inputType' in input?input.inputType:''});
    if(trace.length>128)trace.shift();
  };
  const events=['compositionstart','compositionupdate','compositionend','beforeinput','input'];
  for(const event of events)document.addEventListener(event,domEvent,true);
  function publish():void {
    const state={schemaVersion:1,disposed,viewport:{width:engine.displayWidth,height:engine.displayHeight},focus:gui.focus.focused?.id??null,submits,sceneActions,changes,trace,
      hostElements:document.querySelectorAll('[data-haiyue-text-input]').length,scrollY:content.scrollY,
      fields:fields.map(field=>({id:field.id,rect:{...field.rect},value:field===password?'•'.repeat(field.value.length):field.value,selection:[field.selectionAnchor,field.selectionFocus],composing:field.isComposing,display:field===password?'[redacted]':field.displayValue,composition:field===password?null:field.composition}))};
    canvas.dataset.textEditing=JSON.stringify(state);
    const message=`Focus ${state.focus??'none'} | Scene actions ${sceneActions} | Submits ${submits} | Host sessions ${state.hostElements}`;
    if(status.text!==message)status.setText(message);
  }
  const update=()=>{const frame=sampler.sample(++tick);for(const action of frame.players[0]!.actions)if(action.pressed)sceneActions++;publish();};
  engine.on('update',update);root.layout(engine.displayWidth,engine.displayHeight);publish();
  return ()=>{if(disposed)return;disposed=true;engine.off('update',update);sampler.dispose();for(const event of events)document.removeEventListener(event,domEvent,true);gui.focus.blur();publish();};
}
