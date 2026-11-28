import assert from 'node:assert/strict';
import test from 'node:test';
import { importAnimationSource } from './helpers/private-animation-source.mjs';
import { createAuditGpuDevice, getAuditGpuDeviceState } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const { Spine2DGpuRenderer } = await importAnimationSource('spine/Spine2DGpuRenderer.ts');
const { Spine2DComponent } = await importAnimationSource('spine/Spine2DComponent.ts');
const { loadSpineRuntime } = await importAnimationSource('spine/Spine2DRuntime.ts');
const { parseSpineAssetPayload } = await importAnimationSource('spine/SpineAssetParser.ts');
const component = new Spine2DComponent({jsonUrl:'https://test.invalid/data.json',atlasUrl:'https://test.invalid/asset.atlas'});
const region = page => ({name:page,page,x:0,y:0,width:4,height:4,originalWidth:4,originalHeight:4,offsetX:0,offsetY:0,rotate:0});
const parsed = () => parseSpineAssetPayload({json:{bones:[{name:'root'}],slots:[],skins:{default:{}},animations:{}},atlasText:'first.png\nsize: 4,4\nfirst\n bounds: 0,0,4,4\n'});
function environment(behaviors = {}) {
 const device=createAuditGpuDevice({behaviors}),renderer=new Spine2DGpuRenderer();renderer.prepare({device});
 return {device,renderer,resources:()=>getAuditGpuDeviceState(device).snapshot().resources};
}
function images(t, callback) {
 const original=globalThis.Image;
 globalThis.Image=class {width=4;height=4;naturalWidth=4;naturalHeight=4;set src(url){if(url)queueMicrotask(()=>callback(this,url));}};
 t.after(()=>{globalThis.Image=original;});
}
test('Spine rolls back earlier pages when a later image fails',async t=>{
 images(t,(image,url)=>url.endsWith('second.png')?image.onerror?.():image.onload?.());
 const f=environment();
 await assert.rejects(f.renderer.loadAtlasPages(component,new Map([['first',region('first.png')],['second',region('second.png')]])),e=>e.code==='E_ASSET_LOAD_FAILED');
 f.renderer.destroy();assert.equal(f.resources().texture.live,0);assert.equal(f.resources().buffer.live,0);
});
for(const phase of ['before','pending','resolved'])test(`Spine cancellation ${phase} image completion releases the temporary owner`,async t=>{
 const controller=new AbortController();
 images(t,image=>{if(phase==='pending')controller.abort();else{image.onload?.();if(phase==='resolved')controller.abort();}});
 if(phase==='before')controller.abort();
 const f=environment();await assert.rejects(loadSpineRuntime(f.renderer,component,{signal:controller.signal,assetWorker:{loadParsedAsset:async()=>parsed()}}));
 f.renderer.destroy();assert.equal(f.resources().texture.live,0);assert.equal(f.resources().buffer.live,0);
});
for(const operation of ['queue.copyExternalImageToTexture','createBindGroup','createBuffer'])test(`Spine ${operation} failure rolls back resources acquired before handoff`,async t=>{
 images(t,image=>image.onload?.());const failure=new Error('admission failed');let armed=false,calls=0;
 const f=environment();
 const owner=operation.startsWith('queue.')?f.device.queue:f.device,key=operation.split('.').at(-1),original=owner[key];
 owner[key]=(...args)=>{if(armed&&++calls===(operation==='createBuffer'?2:1))throw failure;return original.apply(owner,args);};armed=true;
 await assert.rejects(loadSpineRuntime(f.renderer,component,{assetWorker:{loadParsedAsset:async()=>parsed()}}));
 f.renderer.destroy();assert.equal(f.resources().texture.live,0);assert.equal(f.resources().buffer.live,0);
});
test('Spine renderer destruction during an image request prevents late allocation',async t=>{
 const f=environment();images(t,image=>{f.renderer.destroy();image.onload?.();});
 await assert.rejects(loadSpineRuntime(f.renderer,component,{assetWorker:{loadParsedAsset:async()=>parsed()}}));
 assert.equal(f.resources().texture.live,0);assert.equal(f.resources().buffer.live,0);
});
test('Spine successful handoff retains pages until runtime destruction',async t=>{
 images(t,image=>image.onload?.());const f=environment();
 const runtime=await loadSpineRuntime(f.renderer,component,{assetWorker:{loadParsedAsset:async()=>parsed()}});
 assert.equal(runtime.pages.size,1);assert.equal(f.resources().texture.live,2);
 f.renderer.destroyRuntime(runtime);f.renderer.destroy();assert.equal(f.resources().texture.live,0);assert.equal(f.resources().buffer.live,0);
});
test('Spine cancellation after atlas handoff releases the pages before runtime ownership',async t=>{
 images(t,image=>image.onload?.());const f=environment(),controller=new AbortController(),original=f.renderer.loadAtlasPages.bind(f.renderer);
 f.renderer.loadAtlasPages=async(...args)=>{const pages=await original(...args);controller.abort();return pages;};
 await assert.rejects(loadSpineRuntime(f.renderer,component,{signal:controller.signal,assetWorker:{loadParsedAsset:async()=>parsed()}}));
 f.renderer.destroy();assert.equal(f.resources().texture.live,0);assert.equal(f.resources().buffer.live,0);
});
test('Spine runtime-state failure releases both admitted buffers and atlas pages',async t=>{
 images(t,image=>image.onload?.());const f=environment(),invalid=parsed();invalid.data.animations=null;
 await assert.rejects(loadSpineRuntime(f.renderer,component,{assetWorker:{loadParsedAsset:async()=>invalid}}));
 f.renderer.destroy();assert.equal(f.resources().texture.live,0);assert.equal(f.resources().buffer.live,0);
});
