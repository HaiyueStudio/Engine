import {GuiLabel} from '@haiyue/engine/gui';
import {Composite,textElement,show,fail} from '../gui-common/composite.js';
import {LatestRequest} from '../gui-common/latest.js';
import {ownContentFrame} from '../gui-layout/presets.js';
import {GuiCleanup} from '../gui-layout/panel-cleanup.js';
import type {GuiFormOptions,GuiFormItemOptions,GuiFormField,GuiFormValidation} from './types.js';
export class GuiFormItem extends Composite {
  readonly label:GuiLabel;readonly feedback:GuiLabel;
  private error:string|null=null;
  constructor(private readonly options:GuiFormItemOptions){
    super('GuiFormItem',{direction:'column',rowGap:5,width:320},options,undefined,options.focusManager);
    this.label=this.part('label',textElement((options.required?'* ':'')+options.label,{height:24}));
    this.label.setDefaultSkin(theme=>({color:theme.colors.text,fontWeight:600}));
    try{this.mount([{name:'control',node:options.control,parent:this.element,layout:{width:{percent:100}}}]);}catch(error){this.dispose();throw error;}
    this.feedback=this.part('feedback',textElement(options.help??'',{height:22}));
    this.feedback.setDefaultSkin((theme,state)=>({color:state.invalid?theme.colors.danger:theme.colors.textMuted,fontSize:12}));
    const invalid=options.control.getVisualState().invalid??false;this.releases.push(()=>options.control.setVisualState({invalid}));
    this.setFeedback(null);this.finish();
  }
  setFeedback(error:string|null):void {this.alive();this.error=error;this.options.control.setVisualState({invalid:!!error});this.feedback.setVisualState({invalid:!!error});this.feedback.setText(error??this.options.help??'');show(this.feedback,!!(error||this.options.help));}
}
type Field={read:()=>unknown;write:(value:unknown)=>void;validate:((value:unknown,signal:AbortSignal)=>string|null|Promise<string|null>)|undefined;item:GuiFormItem;initial:unknown;release:()=>void};
export class GuiForm extends Composite {
  private readonly fields=new Map<string,Field>();private readonly request=new LatestRequest();
  constructor(private readonly options:GuiFormOptions={}){super('GuiForm',{direction:'column',rowGap:16,width:360},options,undefined,options.focusManager);this.releases.push(()=>{const cleanup=new GuiCleanup();for(const field of [...this.fields.values()])cleanup.run(field.release);cleanup.complete('Form field cleanup failed.');});this.finish();}
  register<T>(definition:GuiFormField<T>):()=>void {
    this.alive();if(!definition.key||this.fields.has(definition.key)||this.fields.size>=256||definition.item.element.parent)fail('Form fields require unique keys and unattached items (maximum 256).');
    const initial=definition.read();this.alive();if(definition.item.element.parent)fail('A form field was reparented during value acquisition.');const releaseFrame=ownContentFrame(definition.item.element,{width:{percent:100}});let off=()=>{};
    const field:Field={read:definition.read,write:value=>definition.write(value as T),validate:definition.validate?((value,signal)=>definition.validate!(value as T,signal)):undefined,item:definition.item,initial,release:()=>{}};
    try{this.element.add(definition.item.element);off=definition.subscribe?.(()=>{this.request.cancel();if(!this.dead)definition.item.setFeedback(null);})??off;this.alive();if(this.fields.has(definition.key)||this.fields.size>=256||definition.item.element.parent!==this.element)fail('Form changed during field acquisition.');}catch(error){const cleanup=new GuiCleanup();cleanup.run(off);cleanup.run(()=>{if(definition.item.element.parent===this.element)this.element.remove(definition.item.element);});cleanup.run(releaseFrame);try{cleanup.complete('Field acquisition rollback failed.');}catch(releaseError){throw new AggregateError([error,releaseError],'Field acquisition and rollback failed.');}throw error;}
    let active=true;field.release=()=>{if(!active)return;active=false;this.request.cancel();this.fields.delete(definition.key);const cleanup=new GuiCleanup();cleanup.run(()=>this.blurWithin(definition.item.element));cleanup.run(off);cleanup.run(()=>{if(definition.item.element.parent===this.element)this.element.remove(definition.item.element);});cleanup.run(releaseFrame);cleanup.complete('Field release failed.');};
    this.fields.set(definition.key,field);return field.release;
  }
  getValues():Readonly<Record<string,unknown>> {this.alive();return Object.freeze(Object.fromEntries([...this.fields].map(([key,field])=>[key,field.read()])));}
  async validate():Promise<GuiFormValidation> {
    this.alive();const signal=this.request.begin(),fields=[...this.fields],values=this.getValues(),errors:Record<string,string>=Object.create(null) as Record<string,string>;
    for(const [key,field]of fields){let error:string|null=null;try{error=await field.validate?.(values[key],signal)??null;}catch(cause){if(!this.request.current(signal))return {status:'cancelled',errors:Object.freeze({}),values};error=cause instanceof Error?cause.message:'Validation failed.';}
      if(!this.request.current(signal)||fields.some(([name,entry])=>entry.read()!==values[name])){this.request.cancel();return {status:'cancelled',errors:Object.freeze({}),values};}if(error!==null&&typeof error!=='string')error='Validator must return a message or null.';if(error)errors[key]=error;field.item.setFeedback(error);
    }
    return Object.freeze({status:Object.keys(errors).length?'invalid':'valid',errors:Object.freeze(errors),values});
  }
  async submit():Promise<GuiFormValidation> {const result=await this.validate();if(!this.dead&&result.status==='valid')await this.options.onSubmit?.(result.values);return result;}
  reset():void {this.alive();this.request.cancel();for(const field of this.fields.values()){field.write(field.initial);if(this.dead)return;field.item.setFeedback(null);}}
  override dispose():void {this.request.cancel();super.dispose();}
}
