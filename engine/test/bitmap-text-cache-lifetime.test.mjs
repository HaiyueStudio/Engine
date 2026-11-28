import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const {BitmapTextRenderer,withBitmapTextRecording}=await importEngineSource('renderer/BitmapTextRenderer.ts');
const {BitmapText}=await importEngineSource('components/BitmapText.ts');
// The original upload path distinguishes canvas images through this DOM constructor.
globalThis.HTMLCanvasElement ??= class {};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const identity=()=>Float32Array.from([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
function font(options={}){return{id:1,size:10,lineHeight:10,scaleW:8,scaleH:8,pages:[],chars:new Map([[65,{id:65,x:0,y:0,width:4,height:8,xoffset:0,yoffset:0,xadvance:4,page:0}]]),kernings:new Map(),...options};}
function fixture({device=createAuditGpuDevice(),assets}={}){
 const renderer=new BitmapTextRenderer(),engine={device,format:'rgba8unorm',assetManager:assets,getDepthFormat:()=> 'depth24plus'};
 renderer.prepare(engine);const pass=device.createCommandEncoder().beginRenderPass({colorAttachments:[]});
 return{renderer,engine,device,pass,audit:getAuditGpuDeviceState(device),draw(component,id=1,matrix=identity(),context){return context?withBitmapTextRecording(renderer,context,()=>renderer.render(pass,id,component,matrix)):renderer.render(pass,id,component,matrix);},async dispose(){pass.end();renderer.destroy();await settle();}};
}
function recording(device){const submits=[],cancels=[];let finished=false;return{device,encoder:device.createCommandEncoder(),afterSubmit:cb=>submits.push(cb),afterCancel:cb=>cancels.push(cb),submit(){if(finished)return;finished=true;for(const cb of submits)cb(device.queue);},cancel(){if(finished)return;finished=true;for(const cb of cancels)cb();}};}

test('BitmapText shared component changes reach each entity and renderer consumer',async()=>{
 const first=fixture(),second=fixture(),component=new BitmapText(font(),'A');
 try{
  first.draw(component,1);first.draw(component,2);second.draw(component,1);component.text='AA';
  first.draw(component,1);first.draw(component,2);second.draw(component,1);
  assert.equal(first.renderer.entityCache.get(1).vertexCount,12);assert.equal(first.renderer.entityCache.get(2).vertexCount,12);assert.equal(second.renderer.entityCache.get(1).vertexCount,12);
  assert.equal(component.dirty,false);
 }finally{await first.dispose();await second.dispose();}
});
test('BitmapText observes direct font, size, spacing, glyph and kerning changes without rebuilding for color or empty static text',async()=>{
 const f=fixture(),component=new BitmapText(font(),'A\nA');
 try{
  f.draw(component);let previous=f.renderer.entityCache.get(1).vertexBuf;
  for(const mutate of [()=>component.fontSize=20,()=>component.lineSpacing=2,()=>component.letterSpacing=3,()=>component.font=font({id:2}),()=>component.font.chars.get(65).width++,()=>component.font.lineHeight++]){
   mutate();f.draw(component);const next=f.renderer.entityCache.get(1).vertexBuf;assert.notEqual(next,previous);previous=next;
  }
  component.text='AA';f.draw(component);previous=f.renderer.entityCache.get(1).vertexBuf;component.font.kernings.set(65*65536+65,-1);f.draw(component);assert.notEqual(f.renderer.entityCache.get(1).vertexBuf,previous);
  previous=f.renderer.entityCache.get(1).vertexBuf;component.color=[1,0,0,1];component.mode='sdf';component.threshold=.6;f.draw(component);assert.equal(f.renderer.entityCache.get(1).vertexBuf,previous,'uniform-only changes preserve geometry');
  const replacement=new BitmapText(component.font,'AA');f.draw(replacement);assert.notEqual(f.renderer.entityCache.get(1).vertexBuf,previous,'a replacement component has its own identity');
  replacement.text='';f.draw(replacement);const before=f.audit.snapshot();for(let i=0;i<8;i++)f.draw(replacement);assert.equal(f.audit.snapshot().resources.buffer.created,before.resources.buffer.created);assert.equal(f.audit.snapshot().uploads.calls,before.uploads.calls);
 }finally{await f.dispose();}
});
for(const action of ['evict','destroy','prepare-again'])test(`BitmapText closes a late decoded bitmap after ${action} without installing an atlas`,async()=>{
 const f=fixture(),original={fetch:globalThis.fetch,createImageBitmap:globalThis.createImageBitmap};let finishDecode,closes=0,requestSignal;
 try{
  globalThis.fetch=async(_url,options)=>{requestSignal=options.signal;return{ok:true,blob:async()=>new Blob(['atlas'])};};
  globalThis.createImageBitmap=()=>new Promise(resolve=>finishDecode=resolve);
  f.draw(new BitmapText(font({pages:['font.png']}),'A'));await settle();
  if(action==='evict')f.renderer.releaseFontsNotIn(new Set());else f.renderer.destroy();
  let nextAudit;
  if(action==='prepare-again'){const nextDevice=createAuditGpuDevice();nextAudit=getAuditGpuDeviceState(nextDevice);f.renderer.prepare({...f.engine,device:nextDevice});}
  const oldTextures=f.audit.snapshot().resources.texture.created,newTextures=nextAudit?.snapshot().resources.texture.created;
  finishDecode({width:32,height:32,close(){closes++;}});await settle();
  assert.equal(requestSignal.aborted,true);assert.equal(closes,1);assert.equal(f.renderer.fontCache.size,0);assert.equal(f.audit.snapshot().resources.texture.created,oldTextures);if(nextAudit)assert.equal(nextAudit.snapshot().resources.texture.created,newTextures);
 }finally{Object.assign(globalThis,original);await f.dispose();}
});
test('BitmapText aborts a pending fetch before decoding and closes successful self-decoded images only',async()=>{
 const f=fixture(),original={fetch:globalThis.fetch,createImageBitmap:globalThis.createImageBitmap};let finishFetch,decodes=0,closes=0;
 try{
  globalThis.fetch=()=>new Promise(resolve=>finishFetch=resolve);
  globalThis.createImageBitmap=async()=>{decodes++;return{width:8,height:8,close(){closes++;}};};
  f.draw(new BitmapText(font({pages:['slow.png']}),'A'));f.renderer.releaseFontsNotIn(new Set());finishFetch({ok:true,blob:async()=>new Blob()});await settle();assert.equal(decodes,0);
  globalThis.fetch=async()=>({ok:true,blob:async()=>new Blob()});f.draw(new BitmapText(font({pages:['fast.png']}),'A'));await settle();assert.equal(decodes,1);assert.equal(closes,1);assert.equal(f.renderer.fontCache.get(1).loaded,true);
  const borrowed={width:8,height:8,close(){closes++;}};f.draw(new BitmapText(font({pageImages:[borrowed]}),'A'));await settle();f.renderer.releaseFontsNotIn(new Set());await settle();assert.equal(closes,1,'borrowed pageImages remain owned by the caller');
 }finally{Object.assign(globalThis,original);await f.dispose();}
});
test('BitmapText manager leases reject late generations and current leases retire after the last recording',async()=>{
 const requests=[],f=fixture({assets:{loadTexture:(source,options)=>new Promise(resolve=>requests.push({source,signal:options.signal,resolve}))}});
 const texture=f.device.createTexture({size:[8,8],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING});let staleReleases=0,currentReleases=0;
 try{
  const component=new BitmapText(font({pages:['same.png']}),'A');f.draw(component);f.renderer.releaseFontsNotIn(new Set());f.draw(component);
  requests[1].resolve({value:texture,release(){currentReleases++;}});await settle();const current=f.renderer.fontCache.get(1),group=current.bindGroup2;
  requests[0].resolve({value:texture,release(){staleReleases++;}});await settle();assert.equal(staleReleases,1);assert.equal(current.bindGroup2,group);assert.equal(requests[0].signal.aborted,true);
  const a=recording(f.device),b=recording(f.device);f.draw(component,1,identity(),a);f.draw(component,1,identity(),b);f.renderer.releaseFontsNotIn(new Set());assert.equal(currentReleases,0);a.cancel();await settle();assert.equal(currentReleases,0);b.cancel();await settle();assert.equal(currentReleases,1);
 }finally{await f.dispose();texture.destroy();}
});
test('BitmapText atlas retirement waits for submission queue completion as well as cancellation',async()=>{
 const fences=[],device=createAuditGpuDevice({behaviors:{'queue.onSubmittedWorkDone':()=>new Promise(resolve=>fences.push(resolve))}}),f=fixture({device});
 try{
  const component=new BitmapText(font({pageImages:[{width:8,height:8}]}),'A'),a=recording(device),b=recording(device);
  f.draw(component,1,identity(),a);f.draw(component,1,identity(),b);const texture=f.renderer.fontCache.get(1).texture;
  f.renderer.releaseFontsNotIn(new Set());a.cancel();await settle();assert.equal(texture.destroyed,false);b.submit();await settle();assert.equal(texture.destroyed,false);assert.ok(fences.length>0);
  for(const finish of fences.splice(0))finish();await settle();assert.equal(texture.destroyed,true);
 }finally{f.pass.end();f.renderer.destroy();for(let i=0;i<4;i++){for(const finish of fences.splice(0))finish();await settle();}}
 assert.equal(f.audit.snapshot().resources.texture.live,0);assert.equal(f.audit.snapshot().resources.buffer.live,0);
});
test('BitmapText changed pending geometry and uniforms preserve previous versions through cancel',async()=>{
 const f=fixture(),a=recording(f.device),b=recording(f.device),component=new BitmapText(font(),'A');
 try{
  withBitmapTextRecording(f.renderer,a,()=>{f.renderer.updateCamera(identity());f.draw(component,1,identity(),a);});
  const first=f.renderer.entityCache.get(1),old={vertex:first.vertexBuf,model:first.modelBuf,param:first.paramBuf,camera:f.renderer.cameraBuf};
  component.text='AA';component.color=[1,0,0,1];const translated=identity();translated[12]=4;
  withBitmapTextRecording(f.renderer,b,()=>{f.renderer.updateCamera(translated);f.draw(component,1,translated,b);});
  const next=f.renderer.entityCache.get(1);assert.notEqual(next.vertexBuf,old.vertex);assert.notEqual(next.modelBuf,old.model);assert.notEqual(next.paramBuf,old.param);assert.notEqual(f.renderer.cameraBuf,old.camera);
  for(const resource of Object.values(old))assert.equal(resource.destroyed,false);
  f.renderer.destroy();a.cancel();await settle();for(const resource of Object.values(old))assert.equal(resource.destroyed,true);assert.equal(next.vertexBuf.destroyed,false);b.cancel();await settle();assert.equal(next.vertexBuf.destroyed,true);
 }finally{a.cancel();b.cancel();await f.dispose();}
 assert.equal(f.audit.snapshot().resources.buffer.live,0);assert.equal(f.audit.snapshot().resources.texture.live,0);
});
test('BitmapText teardown abandons pending recordings on device loss and remains idempotent',async()=>{
 const device=createAuditGpuDevice();let lose;device.lost=new Promise(resolve=>lose=resolve);
 const f=fixture({device}),context=recording(device),component=new BitmapText(font({pageImages:[{width:8,height:8}]}),'A');
 f.draw(component,1,identity(),context);f.renderer.destroy();assert.ok(f.audit.snapshot().resources.texture.live>0);
 lose({reason:'destroyed'});await settle();assert.equal(f.audit.snapshot().resources.texture.live,0);assert.equal(f.audit.snapshot().resources.buffer.live,0);
 const counts=f.audit.snapshot();f.renderer.destroy();context.cancel();await f.dispose();assert.equal(f.audit.snapshot().resources.texture.destroyed,counts.resources.texture.destroyed);assert.equal(f.audit.snapshot().resources.buffer.destroyed,counts.resources.buffer.destroyed);
});
test('BitmapText legacy hosts release resources even when the queue fence throws synchronously',async()=>{
 const device=createAuditGpuDevice({behaviors:{'queue.onSubmittedWorkDone':()=>{throw new Error('lost queue');}}}),f=fixture({device});
 f.draw(new BitmapText(font({pageImages:[{width:8,height:8}]}),'A'));await f.dispose();assert.equal(f.audit.snapshot().resources.texture.live,0);assert.equal(f.audit.snapshot().resources.buffer.live,0);
});
