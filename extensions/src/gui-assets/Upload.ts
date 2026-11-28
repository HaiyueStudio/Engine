import {GuiButton,GuiLabel} from '@haiyue/engine/gui';
import {Composite,button,textElement,number,fail,surface} from '../gui-common/composite.js';
import {LatestRequest} from '../gui-common/latest.js';
import {createGuiVirtualList} from '../gui-collections.js';
import type {GuiVirtualList} from '../gui-collections.js';
import type {GuiUploadFile,GuiUploadOptions} from './types.js';
type Entry={file:GuiUploadFile;state:'queued'|'uploading'|'complete'|'cancelled'|'error';progress:number;result?:string;error?:string};
/** File picking and transport are explicit host capabilities, never implicit DOM or fetch globals. */
export class GuiUpload extends Composite {
 readonly choose:GuiButton;readonly feedback:GuiLabel;readonly list:GuiVirtualList<Entry>;
 private readonly picker=new LatestRequest();private entries:Entry[]=[];private active:{entry:Entry;abort:AbortController}|null=null;private draining:Promise<void>|null=null;private readonly rows=new Set<()=>void>();private readonly max:number;private readonly bytes:number;
 constructor(private readonly options:GuiUploadOptions){
  super('GuiUpload',{direction:'column',rowGap:6,width:360},options,undefined,options.focusManager);
  if(typeof options.host?.pick!=='function'||typeof options.host.upload!=='function')fail('Upload requires a picker and transport host.');this.max=number(options.maxFiles??20,'upload count',1,1000);this.bytes=number(options.maxFileBytes??33554432,'upload bytes',1,Number.MAX_SAFE_INTEGER);if(!Number.isInteger(this.max))fail('Upload count must be integral.');
  this.choose=this.part('choose',button('Choose files',this.action(()=>{void this.pick();}),{height:32}));this.part('start',button('Upload queued files',this.action(()=>{void this.start();}),{height:32}));this.feedback=this.part('feedback',textElement('Files stay with your host.',{height:24}));
  this.list=createGuiVirtualList<Entry>({items:[],keyOf:item=>item.file.key,rowHeight:56,height:168,maxItems:this.max,...(options.focusManager?{focus:options.focusManager}:{}),createRow:()=>{
   let entry:Entry|undefined;const element=surface('GuiUploadRow',{direction:'row',height:56,columnGap:4}),caption=textElement('',{grow:1,basis:0,height:52},{style:{textOverflow:'ellipsis'}}),action=button('Cancel',()=>{if(entry){if(entry.state==='error'||entry.state==='cancelled')this.retry(entry.file.key);else this.cancel(entry.file.key);}},{width:80,height:32});element.add(caption);element.add(action);
   const render=()=>{if(entry){caption.setText(entry.file.name+'\n'+entry.state+' · '+Math.round(entry.progress*100)+'%'+(entry.error?' · '+entry.error:''));action.setText(entry.state==='error'||entry.state==='cancelled'?'Retry':'Cancel');action.setDisabled(entry.state==='complete');}};this.rows.add(render);
   return{element,bind:value=>{entry=value;render();return()=>{entry=undefined;};},dispose:()=>{this.rows.delete(render);action.removeAllListeners();}};
  }});this.element.add(this.list.element);this.releases.push(()=>this.list.dispose());this.finish();
 }
 get items():readonly Readonly<{key:string;name:string;state:Entry['state'];progress:number;result?:string;error?:string}>[]{return Object.freeze(this.entries.map(e=>Object.freeze({key:e.file.key,name:e.file.name,state:e.state,progress:e.progress,...(e.result===undefined?{}:{result:e.result}),...(e.error===undefined?{}:{error:e.error})})));}
 add(files:readonly GuiUploadFile[]):void {
  this.alive();if(!Array.isArray(files)||files.length+this.entries.length>this.max)fail('Upload file count exceeded.');const keys=new Set(this.entries.map(e=>e.file.key));
  for(const file of files){if(!file||typeof file.key!=='string'||!file.key||keys.has(file.key)||typeof file.name!=='string'||!file.name||typeof file.type!=='string'||!Number.isSafeInteger(file.size)||file.size<0||file.size>this.bytes)fail('Invalid, duplicate or oversized upload file.');keys.add(file.key);const accept=this.options.accept;if(accept?.length&&!accept.some(pattern=>pattern.startsWith('.')?file.name.toLowerCase().endsWith(pattern.toLowerCase()):pattern.endsWith('/*')?file.type.startsWith(pattern.slice(0,-1)):file.type===pattern))fail('Upload file type is not accepted.');}
  this.entries.push(...files.map(file=>({file:{...file},state:'queued' as const,progress:0})));this.list.setItems(this.entries);
 }
 async pick():Promise<boolean> {this.alive();const signal=this.picker.begin();this.feedback.setText('Choosing files…');try{const files=await this.options.host.pick(signal);if(!this.picker.current(signal))return false;this.add(files);this.feedback.setText(files.length+' files added');return true;}catch(error){if(!this.picker.current(signal))return false;this.feedback.setText(error instanceof Error?error.message:'File selection failed.');return false;}}
 start():Promise<void> {this.alive();if(this.draining)return this.draining;const task=this.drain().finally(()=>{if(this.draining===task)this.draining=null;});this.draining=task;return task;}
 private async drain():Promise<void> {
  // Await once before work so the serialized lease exists even for a synchronous host failure.
  await Promise.resolve();while(!this.dead){const entry=this.entries.find(e=>e.state==='queued');if(!entry)return;const abort=new AbortController();this.active={entry,abort};entry.state='uploading';delete entry.error;this.render();
   try{const result=await this.options.host.upload(entry.file,abort.signal,fraction=>{if(this.dead||this.active?.abort!==abort||abort.signal.aborted)return;if(!Number.isFinite(fraction))return;entry.progress=Math.max(entry.progress,Math.min(1,Math.max(0,fraction)));this.render();});if(this.dead||abort.signal.aborted||!this.entries.includes(entry))continue;if(typeof result!=='string')fail('Upload host must return a result string.');entry.state='complete';entry.progress=1;entry.result=result;this.render();this.options.onComplete?.(entry.file,result);}
   catch(error){if(!this.dead&&!abort.signal.aborted&&this.entries.includes(entry)){if(entry.state==='complete')this.feedback.setText('Upload completed; callback failed: '+(error instanceof Error?error.message:'unknown error'));else{entry.state='error';entry.error=error instanceof Error?error.message:'Upload failed';this.render();}}}
   finally{if(this.active?.abort===abort)this.active=null;}
  }
 }
 cancel(key:string):void {this.alive();const entry=this.entries.find(e=>e.file.key===key);if(!entry||entry.state==='complete')return;entry.state='cancelled';if(this.active?.entry===entry)this.active.abort.abort();this.render();}
 retry(key:string):void {this.alive();const entry=this.entries.find(e=>e.file.key===key);if(!entry||entry.state==='uploading'||entry.state==='complete')return;entry.state='queued';entry.progress=0;delete entry.error;this.render();}
 remove(key:string):void {this.alive();this.cancel(key);this.entries=this.entries.filter(e=>e.file.key!==key);this.list.setItems(this.entries);}
 private render():void {for(const render of this.rows)render();}
 override dispose():void {if(this.dead)return;this.picker.cancel();this.active?.abort.abort();this.active=null;this.entries=[];super.dispose();}
}
