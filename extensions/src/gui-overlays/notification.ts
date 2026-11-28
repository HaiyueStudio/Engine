import {GuiDirtyFlags} from '@haiyue/engine/gui';
import type {GuiElement} from '@haiyue/engine/gui';
import {Composite,number,choice} from '../gui-common/composite.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import {GuiAlert} from '../gui-display/alert.js';
import type {GuiNotificationOptions,GuiNotificationCenterOptions} from './types.js';
import {GuiCleanup} from '../gui-layout/panel-cleanup.js';
let notificationId=0;
export class GuiNotificationCenter extends Composite {
  private readonly entries=new Map<string,{alert:GuiAlert;stop:()=>void;action:GuiElement|undefined}>();
  private readonly pending=new Set<GuiAlert>();
  private readonly maximum:number;
  constructor(private readonly options:GuiNotificationCenterOptions){
    const placement=choice(options.placement??'top-right',['top-left','top-right','bottom-left','bottom-right'],'notification placement'),maximum=number(options.maxVisible??4,'visible notifications',1,8);if(!Number.isInteger(maximum)||options.root.destroyed)throw new TypeError('Invalid notification host.');number(options.durationMs??4500,'notification duration',0,3600000);
    super('GuiNotificationCenter',{position:'absolute',direction:placement.startsWith('bottom')?'column-reverse':'column',width:360,height:'auto',rowGap:12,inset:{...(placement.endsWith('right')?{right:16}:{left:16}),...(placement.startsWith('bottom')?{bottom:16}:{top:16})}},{style:options.style},undefined,options.focusManager);
    this.maximum=maximum;options.root.add(this.element);this.releases.push(options.root.onDispose(()=>this.dispose()));
  }
  open(options:GuiNotificationOptions):string {
    this.alive();const duration=number(options.durationMs??this.options.durationMs??4500,'notification duration',0,3600000),key=options.key??`notice-${++notificationId}`;if(typeof key!=='string'||!key)throw new TypeError('Invalid notification key.');
    const previous=this.entries.get(key);
    if(previous&&(options.action===undefined||options.action===previous.action)){
      previous.alert.setContent(options);
      if(this.dead||this.entries.get(key)!==previous)return key;
      previous.stop();const stop=this.clock(key,previous.alert,duration);
      if(this.dead||this.entries.get(key)!==previous)stop();else previous.stop=stop;
      return key;
    }
    // Validate before retiring an existing keyed item, including borrowed actions.
    const alert=new GuiAlert({...options,focusManager:this.options.focusManager,closable:true,onClose:()=>{this.close(key);return false;}});
    this.pending.add(alert);
    const entry={alert,stop:()=>{},action:options.action};
    try {
      if(this.entries.has(key))this.close(key);else if(this.entries.size>=this.maximum)this.close(this.entries.keys().next().value!);
      if(this.dead||!this.pending.has(alert)||this.entries.has(key)||this.entries.size>=this.maximum)return key;
      setContainerStyle(alert.element,{width:{percent:100},height:'auto',shrink:0});
      this.entries.set(key,entry);this.pending.delete(alert);
      this.element.add(alert.element);
      if(this.dead||this.entries.get(key)!==entry)return key;
      const stop=this.clock(key,alert,duration);
      if(this.dead||this.entries.get(key)!==entry)stop();else entry.stop=stop;
      if(!this.dead&&this.entries.get(key)===entry)this.element.markDirty(GuiDirtyFlags.Layout);
      return key;
    } catch(error) {
      if(this.entries.get(key)===entry)this.close(key);
      throw error;
    } finally {if(this.pending.delete(alert))alert.dispose();}
  }
  private clock(key:string,alert:GuiAlert,duration:number):()=>void {
    let elapsed=0;return duration>0?alert.element.setActivity(delta=>{const pending=[alert.element];let paused=false;while(pending.length){const n=pending.pop()!;if(n.hovered||n.focused){paused=true;break;}pending.push(...n.children);}if(!paused)elapsed+=delta;if(elapsed>=duration){this.close(key);return false;}},{motion:false}):()=>{};
  }
  get keys():readonly string[]{return Object.freeze([...this.entries.keys()]);}
  close(key:string):void {const entry=this.entries.get(key);if(!entry)return;this.entries.delete(key);try{entry.stop();}finally{entry.alert.dispose();}}
  closeAll():void {const errors:unknown[]=[];for(const key of [...this.entries.keys()])try{this.close(key);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Notification cleanup failed.');}
  override dispose():void {
    if(this.dead)return;
    const cleanup=new GuiCleanup(),pending=[...this.pending];this.pending.clear();
    cleanup.run(()=>super.dispose());cleanup.run(()=>this.closeAll());
    for(const alert of pending)cleanup.run(()=>alert.dispose());
    cleanup.complete('Notification cleanup failed.');
  }
}
