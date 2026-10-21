import assert from 'node:assert/strict';
import test from 'node:test';
import {GuiRoot,GuiLabel,GuiSystem,GuiHelpDialog} from '../dist/gui.js';
import {World} from '../dist/ecs.js';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';

class FontEvents extends EventTarget {
 live=0;ready=new Promise(()=>{});
 addEventListener(...args){this.live++;super.addEventListener(...args)}removeEventListener(...args){this.live--;super.removeEventListener(...args)}
}
function fixture() {
 const device=createAuditGpuDevice(),audit=getAuditGpuDeviceState(device);let advance=5;
 const engine={device,format:'rgba8unorm',displayWidth:300,displayHeight:200,getDepthFormat:()=> 'depth24plus'};
 const system=new GuiSystem(engine,{font:{chars:'AB? i',fontSize:10,atlasSize:64,readAtlasPixels:canvas=>new Uint8Array(canvas.width*canvas.height*4),canvasFactory(width,height){
  const context={font:'',measureText:text=>({width:text.length*advance*(context.font.includes('Wide')?2:1),actualBoundingBoxAscent:8,actualBoundingBoxDescent:2}),clearRect(){},fillText(){}};
  return {width,height,getContext:()=>context};
 }}});
 const world=new World('GUI native font lifecycle'),root=new GuiRoot({theme:{fontFamily:'Narrow',fontSize:10}}),label=root.add(new GuiLabel({text:'AB'}));world.createEntity('gui').add(root);world.add(system);
 const prepare=()=>system.prepareRoots(world);
 const draw=()=>{const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[]});system.renderer.render(pass,[root],engine);pass.end();device.queue.submit([encoder.finish()]);};
 return {device,audit,system,world,root,label,prepare,draw,setAdvance(value){advance=value},measure:()=>root.measureElement(label,{mode:'unbounded'},{mode:'unbounded'})};
}
test('root families and theme font size use the same metrics as retained draw batches',()=>{
 // BitmapFontBuilder deliberately adds one logical atlas pixel to each advance.
 const f=fixture();f.prepare();assert.equal(f.measure().width,12);assert.equal(f.measure().minWidth,6);f.draw();
 const before=f.system.renderer.rootCaches.get(f.root).font;
 f.root.clearDirty();f.root.theme.fontFamily='Wide';f.prepare();assert.equal(f.measure().width,22);f.draw();assert.notEqual(f.system.renderer.rootCaches.get(f.root).font.id,before.id);
 f.root.clearDirty();f.root.theme.fontSize=20;f.prepare();assert.equal(f.measure().width,44);assert.equal(f.measure().minWidth,22);f.draw();
 f.system.destroy();assert.equal(f.audit.snapshot().resources.texture.live,0);assert.equal(f.audit.snapshot().resources.buffer.live,0);
});
test('font readiness refreshes metrics, defers atlas retirement and detaches listeners on pause/destroy',async()=>{
 const previous=globalThis.document,fonts=new FontEvents();globalThis.document={fonts};
 try{
  const f=fixture();assert.equal(fonts.live,2);f.prepare();f.draw();const before=f.audit.snapshot().resources.texture.live;
  f.root.clearDirty();f.setAdvance(8);fonts.dispatchEvent(new Event('loadingdone'));f.prepare();assert.equal(f.measure().width,18);
  assert.equal(f.audit.snapshot().resources.texture.live,before);f.draw();assert.equal(f.audit.snapshot().resources.texture.live,before+1);
  await f.device.queue.onSubmittedWorkDone();await Promise.resolve();assert.equal(f.audit.snapshot().resources.texture.live,before);
  f.system.stopAnimations();assert.equal(fonts.live,0);f.setAdvance(9);fonts.dispatchEvent(new Event('loadingdone'));f.prepare();assert.equal(fonts.live,2);assert.equal(f.measure().width,20);
  f.system.destroy();assert.equal(fonts.live,0);assert.equal(f.audit.snapshot().resources.texture.live,0);assert.equal(f.audit.snapshot().resources.buffer.live,0);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
test('manual autoWidth and help wrapping skip static measurements and invalidate on native font generations',()=>{
 const f=fixture(),help=f.root.add(new GuiHelpDialog({visible:true,message:'AB'.repeat(60)}));f.label.setAutoWidth(true);
 let calls=0;const measure=f.system.renderer.measureTextWidth.bind(f.system.renderer);f.system.renderer.measureTextWidth=(...args)=>{calls++;return measure(...args)};
 f.prepare();f.root.clearDirty();const initial=calls,lines=help.body.children.length;
 for(let i=0;i<10;i++)f.prepare();assert.equal(calls,initial);
 f.root.theme.fontFamily='Wide';f.prepare();assert.ok(calls>initial);assert.ok(help.body.children.length>lines);f.root.clearDirty();const changed=calls;f.prepare();assert.equal(calls,changed);
 f.system.destroy();assert.equal(f.audit.snapshot().resources.buffer.live,0);assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('already-loaded native font readiness does not invalidate the first retained GUI frame again',async()=>{
 const previous=globalThis.document,fonts=new FontEvents();fonts.status='loaded';fonts.ready=Promise.resolve(fonts);globalThis.document={fonts};
 try{
  const f=fixture();f.prepare();f.root.clearDirty();await Promise.resolve();assert.equal(f.root.dirty,false);
  fonts.dispatchEvent(new Event('loadingdone'));assert.equal(f.root.dirty,true);f.system.destroy();assert.equal(fonts.live,0);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
