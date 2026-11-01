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
 const draw=()=>{pass.configure('rgba8unorm',1,'none');pass.setFrameIdentity(1,'main');pass.apply(device.createCommandEncoder(),source,{},device);};
 const pipelines=()=>tracker.getResources().filter(p=>p.type==='render-pipeline'&&p.label==='SceneOutput.pipeline');
 const close=()=>{pass.destroy();source.destroy();tracker.releaseAll();};
 return{pass,device,tracker,source,complete,draw,pipelines,close,SceneOutputPass};
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
