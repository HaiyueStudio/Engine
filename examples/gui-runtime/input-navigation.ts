import type {HaiyueEngine} from '@haiyue/engine';
import {GuiButton,GuiCheckbox,GuiLabel,GuiModal,GuiSlider,type GuiRoot,type GuiSystem} from '@haiyue/engine/gui';
import {BrowserMultiplayerInput,InputActionMap} from '@haiyue/engine/experimental/simulation';

type Action = Parameters<GuiSystem['dispatchAction']>[0];
const actions = new Set(['next','previous','left','right','up','down','confirm','cancel']);

/** One host-owned sampler for the playground, including the explicit controller workflow. */
export function attachInputNavigation(engine: HaiyueEngine, gui: GuiSystem, root: GuiRoot, workflow: boolean): () => void {
  const canvas=engine.canvas!;
  let tick=0,sceneActions=0,disposed=false,saveCount=0,cancelCount=0,initialFocus=workflow;
  const trace: {tick:number;action:string;source:string;consumed:boolean;focus:string|null;raw:typeof rawGamepads}[]=[];
  let devices: {index:number;id:string;mapping:string}[]=[];
  let rawGamepads: {index:number;axes:number[];buttons:number[]}[]=[];
  const buttonHolds=new Map<number,number[]>(),maxButtonHoldFrames=new Map<number,number[]>();
  const sceneTrace: {tick:number;action:string;value:number;raw:typeof rawGamepads}[]=[];
  const sampler=new BrowserMultiplayerInput({players:[{id:'scene',gamepadIndex:0,bindings:{jump:{keys:['Space'],gamepadButtons:[0]},move:{gamepadAxes:[{axis:0}]}}}],getGamepads:()=>{
    const pads=navigator.getGamepads();devices=Array.from(pads).flatMap((pad,index)=>pad?.connected?[{index,id:pad.id,mapping:pad.mapping}]:[]);
    rawGamepads=Array.from(pads).flatMap((pad,index)=>pad?.connected?[{index,axes:[...pad.axes],buttons:pad.buttons.map(button=>button.value)}]:[]);
    for(const raw of rawGamepads){
      const previous=buttonHolds.get(raw.index)??[],max=maxButtonHoldFrames.get(raw.index)??[];
      const held=raw.buttons.map((value,i)=>value>=0.5?(previous[i]??0)+1:0);
      buttonHolds.set(raw.index,held);maxButtonHoldFrames.set(raw.index,held.map((frames,i)=>Math.max(frames,max[i]??0)));
    }
    for(const index of buttonHolds.keys())if(!rawGamepads.some(raw=>raw.index===index))buttonHolds.delete(index);
    return pads;
  }});
  const off=sampler.addGamepadLayer(InputActionMap.guiNavigation(),(action,index)=>{
    if(index!==0||!actions.has(action))return false;
    const consumed=gui.dispatchAction(action as Action,'gamepad');
    trace.push({tick,action,source:'physical-gamepad-sampler',consumed,focus:gui.focus.focused?.id??null,raw:rawGamepads});if(trace.length>256)trace.shift();
    return consumed;
  },{capture:index=>index===0&&(workflow||!!gui.focus.focused||!!gui.focus.modal)});
  let slider: GuiSlider|undefined,check: GuiCheckbox|undefined,modal: GuiModal|undefined,output: GuiLabel|undefined;
  if(workflow) {
    root.add(new GuiLabel({id:'input-title',x:32,y:24,width:680,text:'Controller settings workflow',fontSize:28}));
    root.add(new GuiLabel({x:32,y:68,width:900,text:'D-pad/stick: direction | RB/LB: next/back | A: confirm | B: cancel',fontSize:16}));
    root.add(new GuiLabel({x:32,y:108,width:1000,text:'Hold D-pad RIGHT for 0.5s (5 to 6), release. RB, A, RB, A, A, A, B; release each.',fontSize:16}));
    slider=root.add(new GuiSlider({id:'volume',x:32,y:174,width:300,min:0,max:10,step:1,value:5,focus:{mode:'all',tabIndex:0},onChange:()=>publish()}));
    check=root.add(new GuiCheckbox({id:'hints',x:32,y:232,width:260,label:'Enable hints',focus:{mode:'all',tabIndex:1},onChange:()=>publish()}));
    const open=root.add(new GuiButton({id:'review-settings',x:32,y:294,width:260,text:'Review settings',focus:{mode:'all',tabIndex:2},onClick:()=>{
      modal!.setMessage(`Volume ${slider!.value}; hints ${check!.checked?'on':'off'}`);modal!.show();publish();
    }}));
    modal=root.add(new GuiModal({id:'settings-review',title:'Save settings?',showCloseButton:false,onConfirm:()=>{saveCount++;publish();},onCancel:()=>{cancelCount++;publish();}}));
    modal.confirmButton.setFocusOptions({mode:'all',tabIndex:0});
    modal.cancelButton.setFocusOptions({mode:'all',tabIndex:1});
    output=root.add(new GuiLabel({id:'input-progress',x:32,y:370,width:1000,height:96,fontSize:16,text:'Connect a controller and press a button to expose it to the browser.'}));
    root.layout(engine.displayWidth,engine.displayHeight);gui.focus.focus(slider);
    canvas.focus();
    // Keep the opening control available for explicit focus restoration verification.
    void open;
  }
  function publish(): void {
    const data={schemaVersion:1,workflow,devices,sceneActions,sceneTrace,maxButtonHoldFrames:Object.fromEntries(maxButtonHoldFrames),saveCount,cancelCount,volume:slider?.value,hints:check?.checked,modal:modal?.visible??false,focus:gui.focus.focused?.id??null,trace,disposed};
    canvas.dataset.inputNavigation=JSON.stringify(data);
    const message=`${devices.length?devices[0]!.id:'No controller detected'} | Volume ${slider?.value??'-'} | Hints ${check?.checked?'on':'off'} | Saved ${saveCount} | Cancelled ${cancelCount} | Scene actions ${sceneActions}`;
    if(output&&output.text!==message)output.setText(message);
  }
  const update=()=>{
    if(initialFocus&&slider){gui.focus.focus(slider);if(gui.focus.focused===slider)initialFocus=false;}
    const frame=sampler.sample(++tick);
    for(const action of frame.players[0]!.actions)if(action.pressed){sceneActions++;sceneTrace.push({tick,action:action.action,value:action.value,raw:rawGamepads});if(sceneTrace.length>128)sceneTrace.shift();}
    if(workflow)publish();
  };
  engine.on('update',update);
  return ()=>{if(disposed)return;disposed=true;engine.off('update',update);off();sampler.dispose();publish();};
}
