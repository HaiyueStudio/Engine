import assert from 'node:assert/strict';
import test from 'node:test';
import {createAuditGpuDevice} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {importEngineSource} from './helpers/internal-source.mjs';

async function fixture(delayed=false){
 const {SceneOutputPass}=await importEngineSource('postprocess/SceneOutputPass.ts');
 const {GPUResourceTracker,createGPUResourceOwner}=await importEngineSource('core/GPUResourceTracker.ts');
 const raw=createAuditGpuDevice(),complete=[];
 if(delayed){const make=raw.createRenderPipelineAsync.bind(raw);raw.createRenderPipelineAsync=d=>new Promise((resolve,reject)=>complete.push(()=>make(d).then(resolve,reject)));}
 const tracker=new GPUResourceTracker({debug:true}),device=tracker.instrumentDevice(raw,createGPUResourceOwner('engine','output-lifetime-test'));
 const source=device.createTexture({size:[16,16],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING}),pass=new SceneOutputPass();pass.prepare(device);
 const drawTo=(format,sampleCount,blend=false)=>{
  const target={width:16,height:16,getRenderPassDescriptor:()=>({colorAttachments:[{view:{}}]})};
  pass.configure(format,1,'none',{target,sampleCount,loadOp:blend?'load':'clear',viewport:null,scissor:null});
  pass.setFrameIdentity(1,'main');pass.apply(device.createCommandEncoder(),source,{},device);
 };
 const draw=()=>drawTo('rgba8unorm',1);
 const pipelines=()=>tracker.getResources().filter(p=>p.type==='render-pipeline'&&p.label==='SceneOutput.pipeline');
 const close=()=>{pass.destroy();source.destroy();tracker.releaseAll();};
 return{pass,device,tracker,source,complete,draw,drawTo,pipelines,close,SceneOutputPass};
}

test('300 output-pass owners release their pipeline records without releasing shared device shader state',async t=>{
 const f=await fixture();t.after(f.close);
 for(let i=0;i<300;i++){
  f.pass.prepare(f.device);f.draw();assert.equal(f.pipelines().length,1);
  f.pass.destroy();assert.equal(f.pipelines().length,0,'retired output pass '+i+' must not remain in the device owner');
 }
});

test('late output warmup cannot attach a pipeline after same-device teardown and reprepare',async t=>{
 const f=await fixture(true);t.after(f.close);const jobs=[];f.pass.contributePipelineWarmup({add:job=>jobs.push(job)},f.device);
 const pending=jobs[0].compile();await new Promise(setImmediate);assert.equal(f.complete.length,1);f.pass.destroy();f.pass.prepare(f.device);f.complete.shift()();await pending;
 assert.equal(f.pipelines().length,0,'late generation releases its instrumented pipeline record');
 f.draw();assert.equal(f.pipelines().length,1,'current generation remains usable');f.pass.destroy();assert.equal(f.pipelines().length,0);
});

test('a synchronous output pipeline winning an asynchronous warmup race keeps one live record',async t=>{
 const f=await fixture(true);t.after(f.close);const jobs=[];f.pass.contributePipelineWarmup({add:job=>jobs.push(job)},f.device);
 const pending=jobs[0].compile();await new Promise(setImmediate);f.draw();assert.equal(f.pipelines().length,1);f.complete.shift()();await pending;
 assert.equal(f.pipelines().length,1,'discard only the duplicate completion');f.draw();assert.equal(f.pipelines().length,1);
});

test('regional MSAA fallback variants retire when the compositor changes topology',async t=>{
 const f=await fixture();t.after(f.close);
 const retain=samples=>f.pass.retainPipelineVariants([{format:'rgba16float',sampleCount:samples},{format:'rgba16float',sampleCount:4,blend:false}]);
 // Same format for both routes: preserve the 4× presentation even when dropping 4× blending.
 f.drawTo('rgba16float',4,true);f.drawTo('rgba16float',4);
 const [fallback,present]=f.pipelines().map(p=>p.id);
 f.drawTo('rgba16float',1,true);const resolved=f.pipelines().at(-1).id;
 retain(1);assert.deepEqual(f.pipelines().map(p=>p.id),[present,resolved]);
 f.drawTo('rgba16float',1,true);f.drawTo('rgba16float',4);
 assert.deepEqual(f.pipelines().map(p=>p.id),[present,resolved],'steady state reuses both active variants');
 f.drawTo('rgba16float',4,true);retain(4);
 const ids=f.pipelines().map(p=>p.id);assert.equal(ids.length,2);assert.equal(ids[0],present);
 assert(!ids.includes(fallback)&&!ids.includes(resolved));
 f.pass.destroy();assert.equal(f.pipelines().length,0);
});
