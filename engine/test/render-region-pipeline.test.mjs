import test from 'node:test';
import assert from 'node:assert/strict';
import {RenderPipeline,RenderView,RenderFrameContext,Entity,World} from '../dist/experimental.js';
import {GuiSystem,GuiRoot} from '../dist/gui.js';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';

function fixture(sampleCount=1,width=800,height=600,behaviors={}){
 const device=createAuditGpuDevice({behaviors}),audit=getAuditGpuDeviceState(device);let acquisitions=0;
 const texture=device.createTexture({label:'test-output',size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT});
 const target={key:'output',format:'rgba8unorm',width,height,displayWidth:width,displayHeight:height,getOutputView(){acquisitions++;return texture.createView()},getRenderPassDescriptor(){return{colorAttachments:[{view:this.getOutputView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}]}}};
 const engine={device,format:'rgba8unorm',width,height,displayWidth:width,displayHeight:height,msaaSamples:sampleCount,reverseZ:false,clearColor:{r:0,g:0,b:0,a:1},getDepthFormat:()=> 'depth24plus',getRenderPassDescriptor:()=>target.getRenderPassDescriptor()};
 const view=new RenderView({camera:new Entity(),target,sampleCount}),pipeline=new RenderPipeline(engine),world=new World();
 const ui=view.createRegion({id:'tools',bounds:{x:0,y:0,width:320,height},visible:true,updateMode:'demand',clearMode:'on-update'}),scene=view.createRegion({id:'scene',bounds:{x:320,y:0,width:width-320,height},visible:true,updateMode:'continuous',clearMode:'on-update'});
 const records={ui:0,scene:0},uiSystem={record(){records.ui++}},sceneSystem={record(){records.scene++}};pipeline.add(uiSystem,{region:ui});pipeline.add(sceneSystem,{region:scene});
 return{engine,device,audit,view,pipeline,world,ui,scene,uiSystem,sceneSystem,records,acquisitions:()=>acquisitions,texture,frame:()=>pipeline.execute(world,1,16,{view})};
}
const flush=async()=>{await Promise.resolve();await Promise.resolve()};

test('Windows backing-size rounding does not reject independent axis scales',async()=>{
 const f=fixture(4,1001,677);f.view.target.displayWidth=801;f.view.target.displayHeight=541;
 f.ui.setBounds({x:0,y:0,width:320,height:541});f.scene.setBounds({x:320,y:0,width:481,height:541});let captured;
 f.uiSystem.record=(_world,context)=>{captured=context.view};assert.doesNotThrow(()=>f.frame());
 assert.ok(Math.abs(captured.viewport.width-320*1001/801)<1e-9);assert.ok(Math.abs(captured.viewport.height-677)<1e-9);
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

for(const field of ['width','height','displayWidth','displayHeight'])test(`zero ${field} skips GPU work, preserves once and recomposes on restore`,async()=>{
 const f=fixture();f.ui.setMode('once');f.scene.setMode('demand');const old=f.view.target[field];f.view.target[field]=0;
 const before={encode:f.audit.getCallCount('device.createCommandEncoder'),submit:f.audit.getCallCount('queue.submit'),textures:f.audit.getCallCount('device.createTexture')};
 f.frame();assert.deepEqual(f.records,{ui:0,scene:0});assert.equal(f.acquisitions(),0);assert.equal(f.audit.getCallCount('device.createCommandEncoder'),before.encode);assert.equal(f.audit.getCallCount('queue.submit'),before.submit);assert.equal(f.audit.getCallCount('device.createTexture'),before.textures);
 f.view.target[field]=old;f.frame();assert.deepEqual(f.records,{ui:1,scene:1});f.frame();assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,0);
 f.view.target[field]=0;f.ui.requestOnce();f.frame();assert.equal(f.records.ui,1);f.view.target[field]=old;f.frame();assert.equal(f.records.ui,2);
 f.view.target[field]=0;f.frame();f.view.target[field]=old;f.frame();assert.deepEqual(f.records,{ui:2,scene:1});assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,1);
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

for(const fail of [false,true])test(`uncached clipped GUI keeps full projection and a valid shared viewport${fail?' after failure':''}`,async()=>{
 const calls=[],f=fixture(1,800,600,{'renderPass.setViewport':({args})=>calls.push(args)}),gui=new GuiSystem(f.engine),root=new GuiRoot();gui.roots.add(root);let surface;
 f.ui.setBounds({x:-20.25,y:-9.5,width:320.5,height:200.25});f.pipeline.clear();
 gui.renderer.render=(_pass,_roots,_engine,_reverse,_samples,value)=>{surface=value;if(fail)throw Error('test draw failure')};
 f.uiSystem.record=(_world,context)=>gui.render(context);
 f.pipeline.add(f.uiSystem,{region:f.ui,pass:'shared'});
 const render=()=>f.pipeline.execute(f.world,0,16,{view:f.view,regionCache:false});if(fail)assert.throws(render,/test draw failure/);else render();
 assert.deepEqual(surface,{width:800,height:600,format:'rgba16float',originX:20.25,originY:9.5});assert.deepEqual(calls.slice(0,3),[[0,0,301,191,0,1],[0,0,800,600,0,1],[0,0,301,191,0,1]]);assert.ok(calls.every(v=>v[0]>=0&&v[1]>=0));
 f.pipeline.clear();gui.destroy();root.destroy();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});
test('regional execution redraws only dirty producers and composes every complete presented frame',async()=>{
 const f=fixture();f.frame();assert.deepEqual(f.records,{ui:1,scene:1});assert.equal(f.pipeline.getDebugSnapshot().regions.updates,2);assert.equal(f.pipeline.getDebugSnapshot().regions.compositeDraws,3);
 f.frame();assert.deepEqual(f.records,{ui:1,scene:2});assert.equal(f.pipeline.getDebugSnapshot().regions.updates,1);
 f.ui.invalidate('button changed');f.frame();assert.deepEqual(f.records,{ui:2,scene:3});
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);assert.equal(f.audit.snapshot().resources.buffer.live,0);
});
test('all-static frames do not acquire output, encode or submit; invalidation wakes them without stopping world time',async()=>{
 const f=fixture();f.scene.setMode('demand');f.frame();const before={acquire:f.acquisitions(),encode:f.audit.getCallCount('device.createCommandEncoder'),submit:f.audit.getCallCount('queue.submit'),frame:f.world.frameData.frameId};
 const idle=f.frame();assert.equal(idle.submitted,false);assert.equal(f.acquisitions(),before.acquire);assert.equal(f.audit.getCallCount('device.createCommandEncoder'),before.encode);assert.equal(f.audit.getCallCount('queue.submit'),before.submit);assert.ok(f.world.frameData.frameId>before.frame);
 f.ui.invalidate('wake');f.frame();assert.equal(f.audit.getCallCount('queue.submit'),before.submit+1);assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,1);
 f.pipeline.clear();f.texture.destroy();await flush();
});
test('hidden content keeps dirty state, removal repaints the complete output, and once updates are submission-consumed',async()=>{
 const f=fixture();f.scene.setMode('demand');f.frame();f.ui.setVisible(false);f.ui.invalidate('hidden text');f.frame();assert.equal(f.records.ui,1);
 f.ui.setVisible(true);f.frame();assert.equal(f.records.ui,2);f.ui.setMode('once');f.frame();const count=f.records.ui;f.frame();assert.equal(f.records.ui,count);
 f.ui.requestOnce();f.frame();assert.equal(f.records.ui,count+1);f.ui.dispose();f.frame();assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,1);await flush();f.frame();assert.equal(f.pipeline.getDebugSnapshot().regions.cachedRegions,1);
 f.pipeline.clear();f.texture.destroy();await flush();
});
test('ordinary explicit contexts preserve eager allocation while regional idle frames remain deferred',()=>{
 const f=fixture(),before=f.audit.getCallCount('device.createCommandEncoder'),context=new RenderFrameContext(f.engine);assert.equal(f.audit.getCallCount('device.createCommandEncoder'),before+1);assert.equal(f.acquisitions(),1);context.cancel();assert.equal(f.acquisitions(),1);
 f.pipeline.clear();f.texture.destroy();
});

test('cancelled borrowed recording preserves once requests and target initialization',async()=>{
 const f=fixture();f.scene.setMode('demand');f.ui.setMode('once');
 const context=new RenderFrameContext(f.engine,{view:f.view});f.pipeline.execute(f.world,1,16,{view:f.view,context});assert.equal(context.submitted,false);context.cancel();
 assert.deepEqual(f.records,{ui:1,scene:1});f.frame();assert.deepEqual(f.records,{ui:2,scene:2});f.frame();assert.deepEqual(f.records,{ui:2,scene:2});
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('disposing a region during producer recording never fails after successful submission',async()=>{
 const f=fixture();f.uiSystem.record=()=>{f.records.ui++;f.ui.dispose()};assert.doesNotThrow(()=>f.frame());f.frame();assert.deepEqual(f.records,{ui:1,scene:2});
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('returning to a nonregional pipeline retires all region and compositor allocations',async()=>{
 const f=fixture();f.frame();f.pipeline.remove(f.uiSystem);f.pipeline.remove(f.sceneSystem);f.pipeline.add({record(){}});f.frame();await flush();
 assert.equal(f.pipeline.getDebugSnapshot().regions,undefined);assert.equal(f.audit.snapshot().resources.texture.live,1);assert.equal(f.audit.snapshot().resources.buffer.live,0);
 f.pipeline.clear();f.texture.destroy();
});

test('direct redraw of a disabled region never invokes its producers',async()=>{
 const f=fixture(4);f.ui.setMode('disabled');f.pipeline.execute(f.world,1,16,{view:f.view,regionCache:false});assert.deepEqual(f.records,{ui:0,scene:1});
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('clipped regions preserve full projection and copy only changed visible pixels',async()=>{
 const f=fixture(4);f.ui.setBounds({x:-20.25,y:-9.5,width:320.5,height:600.25});let rendered;
 f.uiSystem.record=(_world,context)=>{f.records.ui++;rendered=context.view};f.frame();
 assert.equal(rendered.target.width,322);assert.equal(rendered.target.height,601);assert.equal(rendered.displayWidth,320.5);assert.equal(rendered.displayHeight,600.25);
 assert.deepEqual(rendered.viewport,{x:.75,y:.5,width:320.5,height:600.25});
 assert.equal(f.pipeline.getDebugSnapshot().regions.cropCopies,1);const copies=f.audit.getCallCount('commandEncoder.copyTextureToTexture');assert.equal(copies,1);
 f.frame();assert.equal(f.records.ui,1);assert.equal(f.pipeline.getDebugSnapshot().regions.cropCopies,0);assert.equal(f.audit.getCallCount('commandEncoder.copyTextureToTexture'),copies);
 f.ui.invalidate('changed crop');f.frame();assert.equal(f.records.ui,2);assert.equal(f.pipeline.getDebugSnapshot().regions.cropCopies,1);
 assert.equal(f.pipeline.getDebugSnapshot().regions.cachedRegions,2);assert.ok(f.pipeline.getDebugSnapshot().regions.retainedColorBytes<=64*1024*1024);
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);assert.equal(f.audit.snapshot().resources.buffer.live,0);
});

test('moving a clipped region back inside the target retires its auxiliary visible texture',async()=>{
 const f=fixture();f.ui.setBounds({x:-10,y:0,width:320,height:600});f.frame();const clipped=f.audit.snapshot().resources.texture.live;
 f.ui.setBounds({x:0,y:0,width:320,height:600});f.frame();await flush();assert.equal(f.pipeline.getDebugSnapshot().regions.cropCopies,0);assert.equal(f.audit.snapshot().resources.texture.live,clipped-2);
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('a cancelled initial crop remains uninitialized and is copied again on the successful retry',async()=>{
 const f=fixture();f.ui.setBounds({x:-10,y:0,width:320,height:600});f.scene.setMode('demand');
 const context=new RenderFrameContext(f.engine,{view:f.view});f.pipeline.execute(f.world,1,16,{view:f.view,context});context.cancel();
 f.frame();assert.equal(f.pipeline.getDebugSnapshot().regions.cropCopies,1);assert.equal(f.records.ui,2);f.frame();assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,0);
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('resolved cache composition fits the unchanged color budget without retaining redundant MSAA samples',async()=>{
 const f=fixture(4,1280,720);f.frame();const stats=f.pipeline.getDebugSnapshot().regions;
 assert.equal(stats.compositionSamples,1);assert.equal(stats.retainedColorBytes,1280*720*8*5);assert.equal(stats.workingColorBytes,1280*720*8);assert.equal(stats.cachedRegions,2);assert.deepEqual(stats.fallbacks,[]);
 f.frame();assert.deepEqual(f.records,{ui:1,scene:2});assert.equal(f.pipeline.getDebugSnapshot().regions.retainedColorBytes,stats.retainedColorBytes);
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

for(const samples of [1,4])test(`interleaved producers retain transparent entry order in direct reconstruction (${samples} samples)`,async()=>{
 const f=fixture(samples),order=[];f.pipeline.clear();f.ui.setMode('once');f.scene.setMode('demand');
 f.pipeline.add({record(){order.push('A1')}},{region:f.ui});f.pipeline.add({record(){order.push('B')}},{region:f.scene});f.pipeline.add({record(){order.push('A2')}},{region:f.ui});
 f.frame();assert.deepEqual(order,['A1','B','A2']);assert.ok(f.pipeline.getDebugSnapshot().regions.fallbacks.some(s=>s.includes('interleaved-order')));
 order.length=0;f.frame();assert.deepEqual(order,[]);assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,0);
 f.scene.invalidate('present again');f.frame();assert.deepEqual(order,['A1','B','A2']);assert.equal(f.pipeline.getDebugSnapshot().regions.updates,2);
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('new direct storage is initialized per presentation; once remains idle and cancellation never consumes its pulse',async()=>{
 const f=fixture(4,1920,1080);f.ui.setBounds({x:0,y:0,width:1920,height:1080});f.scene.setBounds({x:0,y:0,width:1920,height:1080});f.ui.setMode('once');f.scene.setMode('demand');f.frame();
 assert.equal(f.pipeline.getDebugSnapshot().regions.cachedRegions,0);assert.equal(f.pipeline.getDebugSnapshot().regions.compositionSamples,4);assert.equal(f.pipeline.getDebugSnapshot().regions.retainedColorBytes,0);assert.equal(f.pipeline.getDebugSnapshot().regions.workingColorBytes,1920*1080*8*5);
 f.frame();assert.deepEqual(f.records,{ui:1,scene:1});assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,0);
 f.ui.requestOnce();const context=new RenderFrameContext(f.engine,{view:f.view});f.pipeline.execute(f.world,1,16,{view:f.view,context});context.cancel();f.frame();assert.deepEqual(f.records,{ui:3,scene:3});
 assert.equal(f.pipeline.getDebugSnapshot().regions.updates,2);f.frame();assert.deepEqual(f.records,{ui:3,scene:3});
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('1080p disjoint fallback keeps the static sidebar cached while the large scene records in order',async()=>{
 const f=fixture(4,1920,1080),order=[];
 f.pipeline.clear();f.pipeline.add({record(){order.push('scene');f.records.scene++}},{region:f.scene});f.pipeline.add({record(){order.push('ui');f.records.ui++}},{region:f.ui});
 f.frame();const stats=f.pipeline.getDebugSnapshot().regions;assert.deepEqual(order,['scene','ui']);assert.equal(stats.cachedRegions,1);assert.equal(stats.retainedColorBytes,320*1080*8*5);assert.equal(stats.compositionSamples,4);assert.deepEqual(stats.fallbacks,['scene:color-bytes']);
 order.length=0;f.frame();assert.deepEqual(order,['scene']);assert.deepEqual(f.records,{ui:1,scene:2});
 f.ui.invalidate('interaction');order.length=0;f.frame();assert.deepEqual(order,['scene','ui']);
 f.scene.setMode('demand');f.frame();const submits=f.audit.getCallCount('queue.submit');f.frame();assert.equal(f.audit.getCallCount('queue.submit'),submits);
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('showing a late sidebar retires the lower-priority dynamic cache and converges to static GUI reuse',async()=>{
 const f=fixture(4,1920,900);f.ui.setVisible(false);f.frame();await flush();assert.equal(f.pipeline.getDebugSnapshot().regions.retainedColorBytes,1600*900*8*5);
 f.ui.setVisible(true);f.frame();await flush();f.frame();await flush();
 const stats=f.pipeline.getDebugSnapshot().regions;assert.equal(stats.retainedColorBytes,320*900*8*5);assert.equal(stats.cachedRegions,1);assert.deepEqual(stats.fallbacks,['scene:color-bytes']);
 const records=f.records.ui;f.frame();assert.equal(f.records.ui,records);assert.equal(f.pipeline.getDebugSnapshot().regions.producerRecords,1);
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('late static admission respects other view owners and retirement while replacing only its own dynamic cache',async()=>{
 const f=fixture(4,1600,800);f.ui.setBounds({x:0,y:0,width:600,height:800});f.scene.setBounds({x:600,y:0,width:1000,height:800});f.ui.setVisible(false);
 const other=new RenderView({camera:new Entity(),target:f.view.target,sampleCount:4}),otherPipeline=new RenderPipeline(f.engine),region=other.createRegion({id:'other-owner',bounds:{x:0,y:0,width:625,height:800},updateMode:'demand',clearMode:'on-update',visible:true});
 let otherRecords=0;otherPipeline.add({record(){otherRecords++}},{region});otherPipeline.execute(f.world,0,16,{view:other});f.frame();await flush();
 assert.equal(f.pipeline.getDebugSnapshot().regions.retainedColorBytes,(625+1000)*800*8*5);
 f.ui.setVisible(true);f.frame();await flush();f.frame();await flush();
 assert.equal(f.pipeline.getDebugSnapshot().regions.retainedColorBytes,(625+600)*800*8*5);assert.deepEqual(f.pipeline.getDebugSnapshot().regions.fallbacks,['scene:color-bytes']);
 const ui=f.records.ui;f.frame();assert.equal(f.records.ui,ui);otherPipeline.execute(f.world,1,16,{view:other});assert.equal(otherRecords,1);
 otherPipeline.clear();other.destroy();f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('regional producers preserve isolated and shared pass contracts',async()=>{
 const f=fixture(),active=[];f.pipeline.clear();
 f.pipeline.add({record(_world,context){active.push(context.passActive);assert.equal(context.view.loadOp,'clear')}},{region:f.scene,pass:'isolated'});
 f.pipeline.add({record(_world,context){active.push(context.passActive)}},{region:f.ui,pass:'shared'});
 f.frame();assert.deepEqual(active,[false,true]);
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('a depthless regional producer cannot remove the next producer depth attachment',async()=>{
 const f=fixture();f.pipeline.clear();
 f.pipeline.add({record(_world,context){assert.equal(context.descriptor.depthStencilAttachment,undefined)}},{region:f.ui,pass:'shared',depth:false});
 f.pipeline.add({record(_world,context){assert.ok(context.descriptor.depthStencilAttachment);assert.equal(context.descriptor.depthStencilAttachment.depthLoadOp,'load');assert.equal(context.descriptor.depthStencilAttachment.depthStoreOp,'store')}},{region:f.ui,pass:'shared',depth:true});
 f.frame();f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('ninth-region admission plans direct redraw without allocating and retiring eight caches every frame',async()=>{
 const f=fixture();f.pipeline.clear();let records=0;
 for(let i=0;i<9;i++){const region=f.view.createRegion({id:'layer-'+i,bounds:{x:0,y:0,width:16,height:16},visible:true,updateMode:'continuous',clearMode:'on-update'});f.pipeline.add({record(){records++}},{region})}
 f.frame();assert.equal(records,9);const created=f.audit.snapshot().resources.texture.created;
 f.frame();assert.equal(records,18);assert.equal(f.audit.snapshot().resources.texture.created,created);assert.equal(f.pipeline.getDebugSnapshot().regions.cachedRegions,0);assert.ok(f.pipeline.getDebugSnapshot().regions.fallbacks.every(r=>r.endsWith('region-count')));
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('producer topology replaces the owned cache generation and reconstructs once content exactly once',async()=>{
 const f=fixture();f.ui.setMode('once');f.pipeline.add(f.sceneSystem,{region:f.scene,sort:10});f.frame();let extra=0;
 f.pipeline.add({record(){extra++}},{region:f.ui,sort:1});f.frame();assert.equal(f.records.ui,2);assert.equal(extra,1);f.frame();assert.equal(f.records.ui,2);assert.equal(extra,1);
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});


test('parent output format changes recompose display caches and replace radiance generations even when all producers are idle',async()=>{
 const f=fixture(),meanings=[];f.scene.setMode('demand');f.sceneSystem.record=(_world,context)=>{f.records.scene++;meanings.push({key:context.view.target.key,sceneColor:context.view.target.spec.sceneColor})};
 f.frame();assert.equal(meanings[0].sceneColor,'display');f.frame();assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,0);
 f.view.target.format='rgba8unorm-srgb';f.frame();assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,1);assert.deepEqual(f.records,{ui:1,scene:1});
 f.view.target.format='rgba16float';f.frame();assert.deepEqual(f.records,{ui:2,scene:2});assert.equal(meanings[1].sceneColor,'radiance');assert.notEqual(meanings[0].key,meanings[1].key);f.frame();assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,0);
 f.view.target.format='rgba32float';f.frame();assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,1);assert.deepEqual(f.records,{ui:2,scene:2});
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});


test('target attachment generations recompose cached pixels without a presentation-version feedback loop',async()=>{
 const f=fixture();f.scene.setMode('demand');let version=0;const descriptor=f.view.target.getRenderPassDescriptor.bind(f.view.target);f.view.target.getRenderPassDescriptorVersion=()=>version;f.view.target.getRenderPassDescriptor=(...args)=>{version++;return descriptor(...args)};
 f.frame();f.frame();assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,0);version++;f.frame();assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,1);assert.deepEqual(f.records,{ui:1,scene:1});f.frame();assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,0);
 const context=new RenderFrameContext(f.engine,{view:f.view,frameData:f.world.frameData});f.pipeline.execute(f.world,1,16,{view:f.view,context});version++;context.submit();f.frame();assert.equal(f.pipeline.getDebugSnapshot().regions.presentations,1,'a later attachment version must not be consumed by an older pending presentation');assert.deepEqual(f.records,{ui:1,scene:1});
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

for(const samples of [1,4])test(`pending cached readers keep their color generation when another frame clears and writes (${samples} samples)`,async()=>{
 const f=fixture(samples,512,128);f.ui.setBounds({x:0,y:0,width:64,height:128});f.scene.setBounds({x:64,y:0,width:448,height:128});let color;
 f.uiSystem.record=(_world,context)=>{f.records.ui++;color=context.view.target;};f.frame();const old=color;
 const reader=new RenderFrameContext(f.engine,{view:f.view});f.pipeline.execute(f.world,2,16,{view:f.view,context:reader});assert.equal(f.records.ui,1);
 f.ui.invalidate('new content while cached read is pending');f.frame();assert.notEqual(color,old,'new writer must not mutate the texture already selected by the old reader');assert.equal(f.records.ui,2);
 assert.ok(f.pipeline.getDebugSnapshot().regions.retainedColorBytes<=64*1024*1024);assert.equal(f.pipeline.getDebugSnapshot().regions.cachedRegions,2);
 reader.cancel();await flush();f.frame();assert.equal(f.records.ui,2,'completed readers do not force static GUI redraw');f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

for(const samples of [1,4])for(const clearMode of ['once','never-after-initialization'])test(`external ${clearMode} writers preserve their common committed seed; automatic sequential frames reuse storage (${samples} samples)`,async()=>{
 const f=fixture(samples,512,128);f.pipeline.clear();
 const region=f.view.createRegion({id:'history-writes',bounds:{x:0,y:0,width:64,height:128},updateMode:'demand',clearMode,visible:true});let target;
 f.pipeline.add({record(_world,context){target=context.view.target;}},{region});f.pipeline.add(f.sceneSystem,{region:f.scene});
 f.frame();const original=target;region.invalidate('automatic sequential');f.frame();assert.equal(target,original,'automatic submission has a known order and can reuse the committed attachment');
 region.invalidate('first external recording');const first=new RenderFrameContext(f.engine,{view:f.view});f.pipeline.execute(f.world,2,16,{view:f.view,context:first});const firstTarget=target;assert.notEqual(firstTarget,original,'even the first deferred history writer needs a separate destination');
 region.invalidate('second external recording');const second=new RenderFrameContext(f.engine,{view:f.view});f.pipeline.execute(f.world,3,16,{view:f.view,context:second});assert.notEqual(target,original);assert.notEqual(target,firstTarget);
 second.submit();first.submit();await flush();f.frame();const live=target,created=f.audit.getCallCount('device.createTexture');
 for(let n=0;n<30;n++){region.invalidate('sequential reuse');f.frame();assert.equal(target,live);}
 assert.equal(f.audit.getCallCount('device.createTexture'),created);assert.ok(f.pipeline.getDebugSnapshot().regions.retainedColorBytes<=64*1024*1024);
 f.pipeline.clear();f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});

test('recreating regional pipelines shares one bounded MSAA history runtime per device',async()=>{
 const labels=[],pipelines=[],f=fixture(4,512,128),createLayout=f.device.createBindGroupLayout.bind(f.device),createPipeline=f.device.createRenderPipeline.bind(f.device);
 f.device.createBindGroupLayout=descriptor=>{labels.push(descriptor.label);return createLayout(descriptor);};f.device.createRenderPipeline=descriptor=>{pipelines.push(descriptor.label);return createPipeline(descriptor);};
 f.pipeline.clear();const region=f.view.createRegion({id:'history-recreate',bounds:{x:0,y:0,width:64,height:128},updateMode:'demand',clearMode:'once',visible:true});
 for(let n=0;n<30;n++){
  f.pipeline.add({record(){}},{region});f.frame();region.invalidate('deferred history');const context=new RenderFrameContext(f.engine,{view:f.view});f.pipeline.execute(f.world,2,16,{view:f.view,context});context.submit();f.pipeline.clear();await flush();
 }
 assert.equal(labels.filter(label=>label?.startsWith('RegionHistory.group')).length,4);assert.equal(pipelines.filter(label=>label==='RegionHistory.perSample').length,1);
 f.texture.destroy();await flush();assert.equal(f.audit.snapshot().resources.texture.live,0);
});
