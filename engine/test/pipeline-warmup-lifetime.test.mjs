import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {importEngineSource} from './helpers/internal-source.mjs';
const {BaseRenderer}=await importEngineSource('renderer/BaseRenderer.ts');
const {BitmapTextRenderer}=await importEngineSource('renderer/BitmapTextRenderer.ts');
const {PipelineWarmupPlan}=await importEngineSource('renderer/PipelineWarmup.ts');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
class Renderer extends BaseRenderer {
 prepare(){} contributePipelineWarmup(){}
 clear(){this.clearPipelineCache();this.compute=null;}
 add(plan,device,kind){if(kind==='render')this.addPipelineWarmup(plan,'main','render',()=>({label:'render'}),device);else this.addComputePipelineWarmup(plan,'main','compute',()=>({label:'compute'}),device,()=>this.compute??null,value=>{this.compute=value;});}
 lookup(device,kind){return kind==='render'?this.getCachedPipeline('main',()=>device.createRenderPipeline({label:'new render'})):this.getCachedComputePipeline('main',()=>this.compute??null,()=>device.createComputePipeline({label:'new compute'}),value=>{this.compute=value;});}
}
function delayed(kind){const device=createAuditGpuDevice(),pending=[],name=kind==='render'?'createRenderPipelineAsync':'createComputePipelineAsync',create=device[name].bind(device);device[name]=descriptor=>new Promise((resolve,reject)=>pending.push(()=>create(descriptor).then(resolve,reject)));return{device,pending};}
for(const kind of ['render','compute']){
 test(`${kind} warmup never publishes a result from an invalidated renderer lifetime`,async()=>{
  const a=delayed(kind),b=createAuditGpuDevice(),renderer=new Renderer(),plan=new PipelineWarmupPlan(),abort=new AbortController();renderer.add(plan,a.device,kind);const run=plan.run({signal:abort.signal});await settle();assert.equal(a.pending.length,1);
  abort.abort();renderer.clear();a.pending[0]();assert.equal((await run).status,'cancelled');assert.equal(renderer.getPipelineCacheDiagnostics().size,0);
  const fresh=renderer.lookup(b,kind);assert.equal(renderer.lookup(b,kind),fresh);assert.equal(renderer.getPipelineCacheDiagnostics().pending,0);assert.equal(renderer.getPipelineCacheDiagnostics().failures,0);
 });
 test(`${kind} tasks registered before invalidation cannot start against a later lifetime`,async()=>{
  const a=delayed(kind),renderer=new Renderer(),plan=new PipelineWarmupPlan();renderer.add(plan,a.device,kind);renderer.clear();const run=plan.run();await settle();const started=a.pending.length;a.pending.forEach(complete=>complete());await run;assert.equal(started,0);assert.equal(renderer.getPipelineCacheDiagnostics().size,0);
 });
 test(`${kind} stale completion cannot replace a newer warmup for the same key`,async()=>{
  const a=delayed(kind),b=createAuditGpuDevice(),renderer=new Renderer(),oldPlan=new PipelineWarmupPlan();renderer.add(oldPlan,a.device,kind);const old=oldPlan.run();await settle();renderer.clear();const nextPlan=new PipelineWarmupPlan();renderer.add(nextPlan,b,kind);await nextPlan.run();const fresh=renderer.lookup(b,kind);a.pending[0]();await old;assert.equal(renderer.lookup(b,kind),fresh);assert.equal(renderer.getPipelineCacheDiagnostics().pending,0);assert.equal(renderer.getPipelineCacheDiagnostics().size,1);
 });
}
test('BitmapText reprepare on another device rejects the cancelled old shader pipeline',async()=>{
 const a=delayed('render'),b=createAuditGpuDevice(),engine=device=>({device,format:'rgba8unorm',getDepthFormat:()=> 'depth24plus'}),renderer=new BitmapTextRenderer();renderer.prepare(engine(a.device));const shader=renderer.shader,plan=new PipelineWarmupPlan(),abort=new AbortController();renderer.contributePipelineWarmup(plan);const run=plan.run({signal:abort.signal});await settle();abort.abort();renderer.destroy();renderer.prepare(engine(b));
 try{a.pending.forEach(complete=>complete());assert.equal((await run).status,'cancelled');const result=renderer._getPipeline();assert.notEqual(result.descriptor.vertex.module,shader);assert.equal(result.descriptor.vertex.module,renderer.shader);assert.equal(getAuditGpuDeviceState(b).snapshot().resources['render-pipeline'].created,1);assert.equal(renderer.getPipelineCacheDiagnostics().pending,0);}
 finally{renderer.destroy();}
});
