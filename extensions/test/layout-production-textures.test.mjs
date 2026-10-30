import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AssetManager} from '@haiyue/engine/assets';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {buildProductionDrawCandidate} from './layout-production-draw-fixture.mjs';
const candidate=await buildProductionDrawCandidate(),{ProductionTextureOwner,ProductionTexturePending,LayoutAssetOwner,createProductionOutlineFontPort}=await candidate.load();
globalThis.GPUTextureUsage??={TEXTURE_BINDING:4,COPY_DST:8,RENDER_ATTACHMENT:16};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve()};
const source=bytes=>({kind:'embedded',data:bytes,integrity:'sha256-'+createHash('sha256').update(Uint8Array.from(bytes)).digest('base64')});
const image=(id='image',bytes=[1])=>({id,kind:'image',width:2,height:2,source:source(bytes)});
const node=(id='image',part='p')=>({part,instance:'root',artboard:'a',node:id,kind:'image',rect:[0,0,2,2],opacity:1,source:{kind:'asset',id},cornerRadius:[0,0,0,0],borderWidth:[0,0,0,0]});
const frame=nodes=>({viewport:[10,10],dpr:1,revision:1,nodes,instances:[]});
const bitmap=(value,generation=1)=>({value,generation,bytes:value.width*value.height*4});
const glyphNode=s=>({...node(),source:undefined,kind:'text',text:{runs:[{glyphs:[{paint:{kind:'bitmap',source:s}}]}]}});
function setup(options={},documents=new Map([['p',[image(),image('other',[2])]]]),assetOptions={policy:{mode:'deny'}}){
 const device=createAuditGpuDevice(),manager=new AssetManager(device),engine={device,assetManager:manager};
 const assets=new Map([...documents].map(([p,values])=>[p,new LayoutAssetOwner({assets:values},assetOptions)]));
 const images=[],invalidations=[],errors=[];
 const decoded=token=>{const value={width:2,height:2,token},entry={value,closed:0,release(){this.closed++}};images.push(entry);return entry;};
 const host={async decode(bytes){return decoded(bytes[0]);},async snapshot(value){return decoded(value.token);}};
 const owner=new ProductionTextureOwner(engine,assets,{maxTextureBytes:1024,maxBitmapBytes:1024,maxEntries:64,maxConcurrent:2,host,invalidate:r=>invalidations.push(r),diagnostic:e=>errors.push(e),...options});
 return {device,manager,engine,assets,owner,host,images,decoded,invalidations,errors,snapshot:()=>getAuditGpuDeviceState(engine.device).snapshot(),async close(){owner.dispose();await settle();for(const a of assets.values())a.dispose();manager.dispose();}};
}
async function ready(owner,frames){try{owner.prepare(frames);}catch(error){if(!(error instanceof ProductionTexturePending))throw error;await error.ready;owner.prepare(frames);}}

test('actual Engine upload leases deduplicate static resources and borrowed SHA owners remain alive',async()=>{
 const f=setup();try{const frames=[frame([node(),node()])];await ready(f.owner,frames);const before=f.snapshot().calls.length,revision=f.owner.revision;
  const a=f.owner.image(node()),b=f.owner.image(node());assert.equal(a.texture,b.texture);a.release();a.release();b.release();
  await ready(f.owner,frames);assert.equal(f.snapshot().calls.length,before);assert.equal(f.owner.revision,revision);assert.equal(f.owner.stats.acquired,2);assert.equal(f.owner.stats.released,2);
  f.owner.dispose();assert.equal(f.owner.stats.retainedTextures,0);assert.equal(f.images[0].closed,1);assert.equal(f.assets.get('p').stats.disposed,false);assert.equal(f.assets.get('p').stats.references,0);
 }finally{await f.close();}
});
test('latest requested frame bounds the bitmap cache through many generations',async()=>{
 const f=setup({maxEntries:2,maxTextureBytes:32,maxBitmapBytes:32});try{for(let i=0;i<60;i++){const s=bitmap({width:2,height:2,token:i});await ready(f.owner,[frame([glyphNode(s)])]);const lease=f.owner.bitmap(s);lease.release();assert.equal(f.owner.stats.retainedTextures,1);assert.equal(f.owner.stats.textureBytes,16);}
  f.owner.dispose();assert.ok(f.images.every(image=>image.closed===1));assert.equal(f.owner.stats.bitmapBytes,0);
 }finally{await f.close();}
});
test('replacement retains old GPU/CPU generation until the final acquired lease releases',async()=>{
 const f=setup();try{await ready(f.owner,[frame([node()])]);const a=f.owner.image(node()),old=a.texture;
  f.owner.replaceImage('p','image',source([9]));await ready(f.owner,[frame([node()])]);const b=f.owner.image(node());assert.notEqual(a.texture,b.texture);assert.equal(a.texture,old);assert.deepEqual(f.images.map(i=>i.value.token),[1,9]);assert.equal(f.images[0].closed,0);
  a.release();assert.equal(f.images[0].closed,1);b.release();f.owner.dispose();assert.ok(f.images.every(i=>i.closed===1));assert.equal(f.owner.stats.refs,0);
 }finally{await f.close();}
});
test('same asset ID in different parts resolves through its own original asset owner',async()=>{
 const f=setup({},new Map([['p',[image()]],['q',[image('image',[7])]]]));try{await ready(f.owner,[frame([node(),node('image','q')])]);const a=f.owner.image(node()),b=f.owner.image(node('image','q'));assert.notEqual(a.texture,b.texture);assert.deepEqual(f.images.map(i=>i.value.token).sort(),[1,7]);a.release();b.release();}finally{await f.close();}
});
test('hosted fallback replacements reuse SHA resolution and preserve acquired fallback pixels',async()=>{
 const hosted={...image('hosted'),source:{kind:'hosted',slot:'hero',fallbackAsset:'image'}};
 const f=setup({},new Map([['p',[image(),hosted]]]));try{await ready(f.owner,[frame([node('hosted')])]);const a=f.owner.image(node('hosted')),old=a.texture;f.owner.setHostedReplacement('p','hero',source([6]));await ready(f.owner,[frame([node('hosted')])]);const b=f.owner.image(node('hosted'));assert.notEqual(b.texture,old);assert.equal(a.texture,old);assert.deepEqual(f.images.map(i=>i.value.token),[1,6]);a.release();b.release();}finally{await f.close();}
});
test('prepared asset dimensions are independent of later mutation to caller document metadata',async()=>{
 const entry=image(),f=setup({},new Map([['p',[entry]]]));try{entry.width=999;entry.height=0;await ready(f.owner,[frame([node()])]);assert.equal(f.owner.stats.textureBytes,16);assert.equal(f.images[0].value.width,2);}finally{await f.close();}
});
test('oversized request sets are rejected before starting any decode or upload jobs',async()=>{
 const f=setup({maxEntries:1});try{assert.throws(()=>f.owner.prepare([frame([node(),node('other')])]),e=>e.code==='E_HYA_RUNTIME_LIMIT');assert.equal(f.owner.stats.pending,0);assert.equal(f.owner.stats.retainedTextures,0);assert.equal(f.images.length,0);}finally{await f.close();}
});
test('same opaque bitmap object with a new generation takes a fresh owned snapshot',async()=>{
 const f=setup();try{const value={width:2,height:2,token:1},a=bitmap(value);await ready(f.owner,[frame([glyphNode(a)])]);const old=f.owner.bitmap(a);value.token=2;const b=bitmap(value,2);await ready(f.owner,[frame([glyphNode(b)])]);const current=f.owner.bitmap(b);assert.notEqual(old.texture,current.texture);assert.deepEqual(f.images.map(i=>i.value.token),[1,2]);old.release();current.release();}finally{await f.close();}
});
test('superseded late decode is released without uploading or publishing its old generation',async()=>{
 const gate=deferred(),started=deferred();let calls=0,f;const host={async decode(bytes){const value=f.decoded(bytes[0]);if(++calls===1){started.resolve();await gate.promise;}return value;},async snapshot(){throw Error('not used')}};
 f=setup({host});try{let pending;try{f.owner.prepare([frame([node()])]);}catch(e){pending=e;}assert.ok(pending instanceof ProductionTexturePending);await started.promise;
  f.owner.replaceImage('p','image',source([8]));const rejected=assert.rejects(pending.ready,e=>e.code==='E_HYA_RUNTIME_ABORTED');await ready(f.owner,[frame([node()])]);gate.resolve();await rejected;await settle();assert.deepEqual(f.images.map(i=>i.closed),[1,0]);assert.equal(f.snapshot().calls.filter(c=>c.method==='queue.copyExternalImageToTexture').length,1);assert.equal(f.owner.stats.retainedTextures,1);
 }finally{gate.resolve();await f.close();}
});
test('decode concurrency is bounded and a disposed queue never starts or leaks late work',async()=>{
 const gate=deferred(),started=deferred();let calls=0,f;f=setup({maxConcurrent:1,host:{async decode(bytes){calls++;started.resolve();await gate.promise;return f.decoded(bytes[0]);},async snapshot(){throw Error('not used')}}});
 try{let pending;try{f.owner.prepare([frame([node(),node('other')])]);}catch(e){pending=e;}await started.promise;assert.equal(f.owner.stats.active,1);assert.equal(f.owner.stats.queued,1);f.owner.dispose();const rejected=assert.rejects(pending.ready);gate.resolve();await rejected;await settle();assert.equal(calls,1);assert.equal(f.owner.stats.retainedTextures,0);assert.equal(f.owner.stats.pending,0);assert.equal(f.images[0].closed,1);
 }finally{gate.resolve();await f.close();}
});
test('texture disposal releases its original network acquisition and settles without awaiting remote bytes',async()=>{
 const started=deferred(),wait=deferred();let resolverSignal;
 const entry={...image(),source:{kind:'referenced',uri:'/image.png',integrity:source([1]).integrity}},f=setup({},new Map([['p',[entry]]]),{policy:{mode:'same-origin',baseUrl:'https://fixture.invalid/'},resolver:{async resolve(_uri,signal){resolverSignal=signal;started.resolve();await wait.promise;return new Uint8Array([1]);}}});
 try{let pending;try{f.owner.prepare([frame([node()])]);}catch(e){pending=e;}await started.promise;const rejected=assert.rejects(pending.ready,e=>e.code==='E_LAYOUT_ASSET_ABORTED');f.owner.dispose();await rejected;await f.owner.whenIdle();assert.equal(resolverSignal.aborted,true);assert.equal(f.assets.get('p').stats.references,0);assert.equal(f.owner.stats.retainedTextures,0);assert.equal(f.images.length,0);wait.resolve();await settle();assert.equal(f.assets.get('p').stats.cacheEntries,0);}finally{wait.resolve();await f.close();}
});
test('outline font preparation forwards abort to its borrowed asset acquisition',async()=>{
 const started=deferred(),wait=deferred();let resolverSignal;
 const document={assets:[{id:'font',kind:'font',family:'Fixture',weight:400,style:'normal',metrics:{unitsPerEm:1000},source:{kind:'referenced',uri:'/font.otf',integrity:source([1]).integrity}}]};
 const assets=new LayoutAssetOwner(document,{policy:{mode:'same-origin',baseUrl:'https://fixture.invalid/'},resolver:{async resolve(_uri,signal){resolverSignal=signal;started.resolve();await wait.promise;return new Uint8Array([1]);}}});
 const controller=new AbortController(),loading=createProductionOutlineFontPort(assets).acquire(document,controller.signal);
 try{await started.promise;const rejected=assert.rejects(loading,e=>e.code==='E_HYA_RUNTIME_ABORTED');controller.abort();await rejected;assert.equal(resolverSignal.aborted,true);assert.equal(assets.stats.references,0);assert.equal(assets.stats.disposed,false);wait.resolve();await settle();assert.equal(assets.stats.cacheEntries,0);}finally{wait.resolve();assets.dispose();}
});
test('a host ignoring upload abort still releases the late real Engine handle and bitmap',async()=>{
 const f=setup(),gate=deferred(),started=deferred(),load=f.manager.loadTexture.bind(f.manager);f.manager.loadTexture=async(value,options)=>{const result=await load(value,{...options,signal:undefined});started.resolve();await gate.promise;return result;};
 try{let pending;try{f.owner.prepare([frame([node()])]);}catch(e){pending=e;}await started.promise;f.owner.dispose();const rejected=assert.rejects(pending.ready,e=>e.code==='E_HYA_RUNTIME_ABORTED');gate.resolve();await rejected;await settle();assert.equal(f.images[0].closed,1);assert.equal(f.owner.stats.textureBytes,0);assert.equal(f.manager.getDebugSnapshot().records.length,0);
 }finally{gate.resolve();await f.close();}
});
test('sticky decode failure publishes no texture and explicit retry prepares a new generation',async()=>{
 const failure=Error('decode failed');let fail=true,f;f=setup({host:{async decode(bytes){if(fail)throw failure;return f.decoded(bytes[0]);},async snapshot(){throw Error('not used')}}});
 try{await assert.rejects(ready(f.owner,[frame([node()])]),e=>e===failure);assert.throws(()=>f.owner.prepare([frame([node()])]),e=>e===failure);assert.equal(f.owner.stats.acquired,0);fail=false;f.owner.retryFailed();await ready(f.owner,[frame([node()])]);assert.equal(f.owner.stats.retainedTextures,1);}finally{await f.close();}
});
test('wrong replacement SHA fails before decode and never invalidates an already acquired old texture',async()=>{
 const f=setup();try{await ready(f.owner,[frame([node()])]);const old=f.owner.image(node()),texture=old.texture;f.owner.replaceImage('p','image',{...source([9]),data:[8]});await assert.rejects(ready(f.owner,[frame([node()])]),e=>e.code==='E_LAYOUT_ASSET_INTEGRITY');assert.equal(old.texture,texture);assert.equal(f.images.length,1);old.release();}finally{await f.close();}
});
test('mismatched decoded dimensions close the CPU source before any GPU allocation',async()=>{
 let f;f=setup({host:{async decode(){const value=f.decoded(1);value.value.width=3;return value;},async snapshot(){throw Error('not used')}}});try{await assert.rejects(ready(f.owner,[frame([node()])]),e=>e.code==='E_HYA_RUNTIME_HOST_PORT');assert.equal(f.images[0].closed,1);assert.equal(f.snapshot().resources.texture.live,0);}finally{await f.close();}
});
test('explicit ceilings include retired held generations and free capacity only after release',async()=>{
 const f=setup({maxTextureBytes:16,maxBitmapBytes:16,maxEntries:1});try{await ready(f.owner,[frame([node()])]);const old=f.owner.image(node());f.owner.replaceImage('p','image',source([9]));assert.throws(()=>f.owner.prepare([frame([node()])]),e=>e.code==='E_HYA_RUNTIME_LIMIT');assert.ok(old.texture);assert.equal(f.owner.stats.textureBytes,16);old.release();await ready(f.owner,[frame([node()])]);assert.equal(f.owner.stats.textureBytes,16);}finally{await f.close();}
});
test('disposed owner preserves acquired handles until release and rejects new acquisitions',async()=>{
 const f=setup();try{await ready(f.owner,[frame([node()])]);const lease=f.owner.image(node()),texture=lease.texture;f.owner.dispose();assert.equal(lease.texture,texture);assert.equal(f.owner.stats.retainedTextures,1);assert.throws(()=>f.owner.image(node()),e=>e.code==='E_HYA_RUNTIME_DISPOSED');lease.release();assert.throws(()=>lease.texture,e=>e.code==='E_HYA_RUNTIME_DISPOSED');assert.equal(f.owner.stats.retainedTextures,0);}finally{await f.close();}
});
test('original AssetManager recovery reuses owned bitmap copies after source disposal',async()=>{
 const f=setup();try{const value={width:2,height:2,token:1},s=bitmap(value);await ready(f.owner,[frame([glyphNode(s)])]);const lease=f.owner.bitmap(s),old=lease.texture;value.width=value.height=0;
  f.owner.suspendForDeviceLoss();f.manager.suspendForDeviceLoss();f.engine.device=createAuditGpuDevice();const signal=new AbortController().signal;assert.deepEqual(await f.manager.recoverDevice(f.engine.device,signal),[]);f.owner.recoverGpuResource(f.engine.device,signal);assert.notEqual(lease.texture,old);assert.equal(lease.texture.width,2);assert.equal(f.images[0].closed,0);lease.release();
 }finally{await f.close();}
});
test('unsupported capture, invalid sampling and missing parts fail explicitly before async work',async()=>{
 const f=setup({},new Map([['p',[{...image(),filter:'bicubic'}]]]));try{assert.throws(()=>f.owner.image(node()),e=>e.code==='E_HYA_RUNTIME_HOST_PORT');assert.throws(()=>f.owner.image({...node(),source:{kind:'node',id:'n'}}),e=>e.code==='E_HYA_RUNTIME_HOST_PORT');assert.throws(()=>f.owner.image(node('image','missing')),e=>e.code==='E_HYA_RUNTIME_HOST_PORT');assert.equal(f.owner.stats.pending,0);}finally{await f.close();}
});
test('bounded diagnostic failures cannot replay resource cleanup',async()=>{
 const f=setup({invalidate(){throw Error('application invalidation failed')}});try{for(let i=0;i<24;i++){f.owner.replaceImage('p','image',source([i]));await ready(f.owner,[frame([node()])]);}assert.equal(f.owner.stats.cleanupErrors,16);f.owner.dispose();assert.ok(f.images.every(i=>i.closed===1));assert.equal(f.owner.stats.refs,0);}finally{await f.close();}
});


test('native snapshot preserves premultiplied glyph coverage while encoded images keep the original straight decode',async()=>{
 const prior=Object.getOwnPropertyDescriptor(globalThis,'createImageBitmap'),calls=[],images=[];
 Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,writable:true,value:async(source,options)=>{const record={encoded:source instanceof Blob,options,closed:0};calls.push(record);const value={width:2,height:2,close(){record.closed++}};images.push(value);return value;}});
 const f=setup({host:undefined});
 try{
  const value={width:2,height:2},source=bitmap(value),frames=[frame([node(),glyphNode(source)])];
  await ready(f.owner,frames);assert.equal(calls.length,2);assert.equal(calls.find(c=>!c.encoded).options.premultiplyAlpha,'premultiply');assert.equal(calls.find(c=>c.encoded).options.premultiplyAlpha,'none');assert.ok(calls.every(c=>c.options.colorSpaceConversion==='none'));
  const glyph=f.owner.bitmap(source),asset=f.owner.image(node());assert.equal(glyph.alphaMode,'premultiplied');assert.equal(asset.alphaMode,'premultiplied');glyph.release();asset.release();await ready(f.owner,frames);assert.equal(calls.length,2,'static bitmap must reuse its snapshot');
 }finally{await f.close();if(prior)Object.defineProperty(globalThis,'createImageBitmap',prior);else delete globalThis.createImageBitmap;}
 assert.ok(calls.every(c=>c.closed===1));assert.equal(f.snapshot().resources.texture.live,0);
});
