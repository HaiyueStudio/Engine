import {checkG05PendingMemory} from './deferred-g05-memory-pending.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deferredRuntimeFingerprint,sha256} from './deferred-fixture-policy.mjs';
import {captureG05ResourceSnapshot,validateG05RoomMemory} from './deferred-g05-memory-policy.mjs';
import {createAuditGpuDevice,ensureRealRendererGpuConstants} from '../benchmark/real-renderer-audit-device.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=resolve(root,'artifacts/engine-0.2.1/g05');
const inputs=await deferredRuntimeFingerprint(root),build=JSON.parse(await readFile(resolve(directory,'fixture-build.json'),'utf8'));
if(inputs.sha256!==build.inputs.sha256)throw Error('Build current G05 private runtime before structural check');
for(const output of build.outputs)if(sha256(await readFile(resolve(directory,output.file)))!==output.sha256)throw Error('Stale G05 runtime chunk');
const runtime=await import('../../artifacts/engine-0.2.1/g05/fixture.js'),config=JSON.parse(await readFile(resolve(root,'config/lighting-performance-021.json'),'utf8'));
ensureRealRendererGpuConstants();const results=[];
for(const [width,height]of [[1280,720],[1920,1080]])for(const views of [1,4])for(const algorithm of ['reference','tiled']){
 const device=createAuditGpuDevice({limits:{maxColorAttachments:8,maxColorAttachmentBytesPerSample:32,maxStorageBuffersPerShaderStage:8,maxComputeInvocationsPerWorkgroup:256,maxComputeWorkgroupSizeX:256,maxComputeWorkgroupsPerDimension:65535,maxComputeWorkgroupStorageSize:16384}}),target=runtime.createAuditTarget(device,width,height,true);let state;
 try{
  state=await runtime.createRealRendererBenchmarkScenario({device,target,entityCount:0,viewCount:views,renderProfile:'batched'});state.render3d.passes.length=0;
  state.world.add(new runtime.Entity('memory-box').addComponent(new runtime.Transform3D()).addComponent(new runtime.Mesh3D(runtime.createBox3D(),new runtime.PbrMaterial({roughness:.5,metallic:0}))));
  for(let i=0;i<128;i++)state.world.add(new runtime.Entity(`memory-light:${i}`).addComponent(new runtime.Transform3D().setTranslation(i%8-4,2,Math.floor(i/8)-8)).addComponent(new runtime.PointLight({range:2,intensity:1})));
  state.render3d.checkEntityManager(state.world);const profile=await runtime.createDeferredReferenceProfile(state.render3d,state.engine,algorithm==='tiled'?{tiled:{forceCulling:true}}:{});
  runtime.resetRealRendererBenchmarkMetrics(state);
  const resources={},resourceAttribution={};
  for(const phase of ['warm','cpu','gpu']){
   // Structural steady-state replay only. Phase names align with the report schema;
   // these frames contain neither native GPU execution nor timing populations.
   for(let frame=0;frame<8;frame++)await runtime.runRealRendererBenchmarkFrame(state);
   resources[phase]=state.tracker.getDebugSnapshot().byType;resourceAttribution[phase]=captureG05ResourceSnapshot(state.tracker);
  }
  if(!profile.backend.diagnostics.completeCoverage)throw Error('Structural fixture unexpectedly fell back');
  const result={width,height,views,algorithm,resources,resourceAttribution},memory=validateG05RoomMemory(result,config);
  if(memory.status!=='passed')throw Error(`Structural memory budget failed: ${JSON.stringify(memory)}`);
  results.push({...result,memory});
 }finally{if(state){await runtime.destroyRealRendererBenchmarkScenario(state);const last=results.at(-1);if(last)last.cleanup={ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources};if(state.finalMetrics.ownerResidual!==0||state.finalMetrics.liveGpuResources!==0)throw Error('Structural cleanup residue');}target.destroy();}
}
const pending=await checkG05PendingMemory(config);
if(inputs.sha256!==(await deferredRuntimeFingerprint(root)).sha256)throw Error('Runtime changed during structural check');
const paths=['scripts/webgpu-gate/check-deferred-g05-memory-structure.mjs','scripts/webgpu-gate/deferred-g05-memory-policy.mjs','scripts/webgpu-gate/deferred-g05-memory-pending.mjs','engine/test/helpers/internal-source.mjs','config/lighting-performance-021.json'];
const policies=await Promise.all(paths.map(async path=>({path,sha256:sha256(await readFile(resolve(root,path)))})));
const generatedAt=new Date().toISOString(),report={schemaVersion:1,tier:'diagnostic-g05-memory-structure',status:'passed',generatedAt,inputs,build,policies,native:false,performanceQualified:false,scope:'Shared versioned audit device; actual renderer allocation descriptors/ownership only. No native timing, pixels or physical device-limit qualification.',pending,results};
await mkdir(directory,{recursive:true});const path=resolve(directory,`memory-structure-${generatedAt.replaceAll(':','-')}.json`);await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({path,status:report.status,cases:results.length,pendingBytes:pending.pending.deferredEstimateBytes,bytes:results.map(r=>({width:r.width,views:r.views,algorithm:r.algorithm,bytes:r.resourceAttribution.gpu.deferredEstimateBytes}))}));
