import {EngineError,EngineErrorCode} from '@haiyue/engine/core';
import {InputActionMap} from '@haiyue/engine/input';
import type {GamepadAxisBinding,InputActionBinding,InputActionMapDescriptor} from '@haiyue/engine/input';
import type {InputBindingProfile,InputBindingProfileOptions,InputBindingProfileData,InputBindingSample,InputBindingConflict} from './types.js';

const invalid=(message:string,cause?:unknown)=>new EngineError(EngineErrorCode.InputProfileInvalid,message,{docsPath:'errors/E_INPUT_PROFILE_INVALID',...(cause===undefined?{}:{cause})});
type Kind='button'|'negative'|'positive';
type Control={device:'keyboard';code:string}|{device:'pointer';button:number}|{device:'gamepad-button';button:number}|{device:'gamepad-axis';axis:number;direction:'negative'|'positive'};
type Capture={action:string;kind:Kind;buttonsReady:boolean;padsReady:Set<number>};

/** Borrows one action map. The host supplies original input samples and owns storage. */
export class BindingProfile implements InputBindingProfile {
  private map:InputActionMap|undefined;
  private capture:Capture|undefined;
  private onConflict:InputBindingProfileOptions['onConflict'];
  private onChange:InputBindingProfileOptions['onChange'];
  private readonly maximum:number;
  private readonly threshold:number;
  private readonly conflict:'reject'|'share'|'replace';
  constructor(options:InputBindingProfileOptions){
    const maximum=options?.maxActions??256,threshold=options?.captureAxisThreshold??.5,conflict=options?.conflict??'reject';
    if(!(options?.map instanceof InputActionMap)||!Number.isSafeInteger(maximum)||maximum<1||maximum>4096||!Number.isFinite(threshold)||threshold<=.15||threshold>1||!['reject','share','replace'].includes(conflict)
      ||(options.onChange!==undefined&&typeof options.onChange!=='function')||(options.onConflict!==undefined&&typeof options.onConflict!=='function'))throw invalid('Invalid input profile options.');
    if(options.map.actionNames().length>maximum)throw invalid('Input profile action limit exceeded.');
    this.map=options.map;this.maximum=maximum;this.threshold=threshold;this.conflict=conflict;this.onConflict=options.onConflict;this.onChange=options.onChange;
  }
  beginRebind(action:string,kind:Kind):void {
    const map=this.live();
    if(typeof action!=='string'||!/^[A-Za-z][A-Za-z0-9._:-]{0,95}$/u.test(action)||!['button','negative','positive'].includes(kind))throw invalid('Invalid action or rebind kind.');
    if(!map.hasAction(action)&&map.actionNames().length>=this.maximum)throw invalid('Input profile action limit exceeded.');
    this.capture={action,kind,buttonsReady:false,padsReady:new Set()};
  }
  offer(value:InputBindingSample):boolean {
    this.live();const capture=this.capture;if(!capture)return false;
    const sample=copySample(value),control=this.choose(capture,sample);if(!control)return true;
    capture.buttonsReady=false;if(sample.device==='gamepad')capture.padsReady.delete(sample.index);
    const map=this.live(),bindings=map.toJSON(),others=Object.keys(bindings).filter(action=>action!==capture.action&&uses(bindings[action]!,control));
    if(others.length){
      const detail:InputBindingConflict=Object.freeze({action:capture.action,otherActions:Object.freeze(others),sample});this.onConflict?.(detail);
      if(this.capture!==capture||!this.map||map.toJSON()!==bindings)return true;
      if(this.conflict==='reject')throw new EngineError(EngineErrorCode.InputBindingConflict,'The physical control is already bound to another action.',{docsPath:'errors/E_INPUT_BINDING_CONFLICT',context:{action:capture.action,otherActions:others}});
    }
    const next:Record<string,InputActionBinding>=Object.fromEntries(Object.entries(map.toJSON()));
    if(this.conflict==='replace')for(const action of others)next[action]=without(next[action]!,control);
    next[capture.action]=bind(without(next[capture.action]??{},control),control,capture.kind);
    this.commit(next,true);return true;
  }
  cancelRebind():void {this.capture=undefined;}
  exportData():InputBindingProfileData {return Object.freeze({format:'haiyue-input-profile',version:1,bindings:this.live().toJSON()});}
  restore(data:InputBindingProfileData):void {
    this.live();if(!data||data.format!=='haiyue-input-profile'||data.version!==1||!data.bindings||typeof data.bindings!=='object'||Array.isArray(data.bindings))throw invalid('Invalid input profile format/version/bindings.');
    this.commit(data.bindings);
  }
  dispose():void {this.capture=undefined;this.map=undefined;this.onChange=undefined;this.onConflict=undefined;}
  private live():InputActionMap {if(!this.map)throw invalid('Input profile has been disposed.');return this.map;}
  private commit(bindings:InputActionMapDescriptor,patch=false):void {
    const map=this.live();if(Object.keys(bindings).length>this.maximum)throw invalid('Input profile action limit exceeded.');
    try{
      if(patch){
        // Validate the whole transaction using the original normalizer before any write.
        const validated=new InputActionMap(bindings).toJSON(),before=map.toJSON();
        for(const action of Object.keys(bindings))if(bindings[action]!==before[action])map.setAction(action,validated[action]!);
      }else map.setBindings(bindings);
    }catch(cause){throw invalid('Invalid input profile bindings.',cause);}
    this.capture=undefined;this.onChange?.(this.exportData());
  }
  private choose(capture:Capture,sample:InputBindingSample):Control|undefined {
    if(sample.device!=='gamepad'){
      if(!sample.down){capture.buttonsReady=true;return;}
      if(!capture.buttonsReady)return;
      if(sample.device==='keyboard')return{device:'keyboard',code:sample.code};
      if(capture.kind==='button')return{device:'pointer',button:sample.button};
      return;
    }
    const pad=sample.snapshot;
    if(!pad.connected){capture.padsReady.delete(sample.index);return;}
    if(pad.buttons.every(b=>b.value<=.15&&!b.pressed)&&pad.axes.every(v=>Math.abs(v)<=.15)){capture.padsReady.add(sample.index);return;}
    if(!capture.padsReady.has(sample.index))return;
    if(capture.kind==='button'){
      const button=pad.buttons.findIndex(b=>b.pressed||b.value>=this.threshold);return button<0?undefined:{device:'gamepad-button',button};
    }
    const axis=pad.axes.findIndex(v=>Math.abs(v)>=this.threshold);return axis<0?undefined:{device:'gamepad-axis',axis,direction:pad.axes[axis]!<0?'negative':'positive'};
  }
}

function split(axes:readonly GamepadAxisBinding[]=[]):GamepadAxisBinding[]{
  return axes.flatMap(axis=>(axis.direction??'both')==='both'?[{...axis,direction:'negative',scale:-(axis.scale??1)},{...axis,direction:'positive',scale:axis.scale??1}]:[{...axis}]);
}
function uses(binding:InputActionBinding,c:Control):boolean {
  switch(c.device){
    case'keyboard':return !!binding.keys?.includes(c.code)||!!binding.keyboardAxes?.some(a=>a.negative.includes(c.code)||a.positive.includes(c.code));
    case'pointer':return !!binding.pointerButtons?.includes(c.button);
    case'gamepad-button':return !!binding.gamepadButtons?.includes(c.button);
    case'gamepad-axis':return !!binding.gamepadAxes?.some(a=>a.axis===c.axis&&((a.direction??'both')==='both'||a.direction===c.direction));
  }
}
function without(binding:InputActionBinding,c:Control):InputActionBinding {
  switch(c.device){
    case'keyboard':return{...binding,...(binding.keys?{keys:binding.keys.filter(k=>k!==c.code)}:{}),...(binding.keyboardAxes?{keyboardAxes:binding.keyboardAxes.map(a=>({...a,negative:a.negative.filter(k=>k!==c.code),positive:a.positive.filter(k=>k!==c.code)}))}:{})};
    case'pointer':return{...binding,...(binding.pointerButtons?{pointerButtons:binding.pointerButtons.filter(b=>b!==c.button)}:{})};
    case'gamepad-button':return{...binding,...(binding.gamepadButtons?{gamepadButtons:binding.gamepadButtons.filter(b=>b!==c.button)}:{})};
    case'gamepad-axis':return{...binding,...(binding.gamepadAxes?{gamepadAxes:split(binding.gamepadAxes).filter(a=>a.axis!==c.axis||a.direction!==c.direction)}:{})};
  }
}
function bind(binding:InputActionBinding,c:Control,kind:Kind):InputActionBinding {
  if(c.device==='keyboard'){
    if(kind==='button')return{...binding,keys:[c.code]};
    const axes=binding.keyboardAxes??[{negative:[],positive:[]}];
    return{...binding,keyboardAxes:axes.map((axis,i)=>({...axis,[kind]:i===0?[c.code]:[]}))};
  }
  if(c.device==='pointer')return{...binding,pointerButtons:[c.button]};
  if(c.device==='gamepad-button')return{...binding,gamepadButtons:[c.button]};
  const sign=kind==='negative'?-1:1,remaining=split(binding.gamepadAxes).filter(a=>Math.sign(a.scale??1)!==sign);
  return{...binding,gamepadAxes:[...remaining,{axis:c.axis,direction:c.direction,deadZone:.15,scale:sign}]};
}
function copySample(sample:InputBindingSample):InputBindingSample {
  if(!sample||typeof sample!=='object')throw invalid('Invalid input sample.');
  if(sample.device==='keyboard'){
    if(typeof sample.code!=='string'||!sample.code||sample.code.length>64||typeof sample.down!=='boolean')throw invalid('Invalid keyboard sample.');return Object.freeze({device:'keyboard',code:sample.code,down:sample.down});
  }
  if(sample.device==='pointer'){
    if(!Number.isSafeInteger(sample.button)||sample.button<0||sample.button>31||typeof sample.down!=='boolean')throw invalid('Invalid pointer sample.');return Object.freeze({device:'pointer',button:sample.button,down:sample.down});
  }
  if(sample.device!=='gamepad'||!Number.isSafeInteger(sample.index)||sample.index<0||sample.index>31||!sample.snapshot||typeof sample.snapshot.connected!=='boolean'||!Array.isArray(sample.snapshot.axes)||sample.snapshot.axes.length>64||!Array.isArray(sample.snapshot.buttons)||sample.snapshot.buttons.length>256)throw invalid('Invalid gamepad sample.');
  const axes=Array.from(sample.snapshot.axes).map(value=>{if(!Number.isFinite(value)||Math.abs(value)>1)throw invalid('Invalid gamepad axis value.');return value;});
  const buttons=Array.from(sample.snapshot.buttons).map(button=>{const value=button?.value,pressed=button?.pressed;if(typeof pressed!=='boolean'||!Number.isFinite(value)||value<0||value>1)throw invalid('Invalid gamepad button value.');return Object.freeze({pressed,value});});
  return Object.freeze({device:'gamepad',index:sample.index,snapshot:Object.freeze({connected:sample.snapshot.connected,axes:Object.freeze(axes),buttons:Object.freeze(buttons)})});
}
