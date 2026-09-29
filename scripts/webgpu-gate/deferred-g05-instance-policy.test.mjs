import test from 'node:test';
import assert from 'node:assert/strict';
import {parseG05InstanceOptions,createG05InstanceData,createG05InstanceView,classifyG05Instances,verifyG05InstanceIds} from './deferred-g05-instance-policy.mjs';
test('instance parser rejects omitted workload axes masquerading as accepted flags',()=>{
 assert.deepEqual(parseG05InstanceOptions(['--count=10000','--views=4','--variant=frustum-rejected','--integrated']),{count:10000,views:4,variant:'frustum-rejected',preference:'low-power',full:false,idleMs:120000});
 for(const args of [['--count=999'],['--views=2'],['--variant=no'],['--full','--full'],['--idle-ms=1']])assert.throws(()=>parseG05InstanceOptions(args));
});
test('instance workload has affine nonuniform poses, complete LOD coverage and independent rejected views',()=>{
 for(const count of [1000,10000]){
  const {matrices,colors}=createG05InstanceData(count);assert.equal(matrices.length,count*16);assert.equal(colors.length,count*4);
  for(let i=0;i<count;i++)assert.deepEqual([matrices[i*16+3],matrices[i*16+7],matrices[i*16+11],matrices[i*16+15]],[0,0,0,1]);
  const full=classifyG05Instances(matrices,createG05InstanceView(0,false,true));assert.equal(full.flat().length,count);assert.ok(full.every(ids=>ids.length>count/4));
  assert.equal(verifyG05InstanceIds(full,full,count).checkedIds,count);
  const rejected=Array.from({length:4},(_,i)=>classifyG05Instances(matrices,createG05InstanceView(i,true,false)));
  for(const ids of rejected){assert.ok(ids[0].length>0&&ids[0].length<count/4);assert.equal(ids[1].length+ids[2].length,0);}
  assert.notDeepEqual(rejected[0],rejected[1]);assert.notDeepEqual(rejected[0],rejected[2]);
  assert.throws(()=>verifyG05InstanceIds([[0,0],[],[]],[[0,1],[],[]],count),/ID/);
  assert.throws(()=>verifyG05InstanceIds([[count],[],[]],[[0],[],[]],count),/ID/);
 }
});
import {validateG05InstanceResult} from './deferred-g05-instance-policy.mjs';
function result(){
 const n=3,metrics=Object.fromEntries(['bindGroupsCreated','buffersCreated','renderPipelinesCreated','bufferUploadsPerFrame','uploadBytesPerFrame','drawsPerFrame','renderPassesPerFrame'].map(k=>[k,0]));metrics.metricClassification={measuredFrames:n,strictEquality:{passed:true}};
 return {status:'passed',schemaVersion:1,suite:'g05-instances',count:1000,views:1,variant:'lod-on',adapter:{vendor:'amd',architecture:'rdna-1',isFallbackAdapter:false},width:1280,height:720,normalFrameInstanceReadbackBytes:0,samples:n,warmup:2,
 paths:['candidate','reference'].map((path,i)=>{const passes=[{kind:'render',label:'instance render',durationMs:1},...(i?[]:[{kind:'compute',label:'GpuInstanceLod.classify',durationMs:1}])];return {path,mode:i?'all':'gpu',
 cpu:Array.from({length:n},(_,frame)=>({frame,timestampQuery:false,cpuRuntimeMs:1,cpuRecordMs:1,cpuSubmitMs:0,queueWaitMs:1,frameWallMs:2})),gpu:Array.from({length:n},(_,frame)=>({frame,gpuSpanMs:3,gpuPassSumMs:passes.length,passes})),metrics:structuredClone(metrics),gpuMetrics:structuredClone(metrics),resourcesBefore:{buffer:{created:1,estimatedBytes:64},texture:{created:1,estimatedBytes:4}},resources:{buffer:{created:1,estimatedBytes:64},texture:{created:1,estimatedBytes:4}}};}),
 pixelReference:'cpu-lod-buckets',ids:[{view:0,checkedIds:1000,counts:[334,333,333]}],pixels:[{view:0,maxDelta:0,litPixels:100}],geometryTiers:[144,64,16].map(triangles=>({triangles})),poseNormals:{count:9,mirrored:4,nonuniform:9,maxDelta:0,litPixels:100,probes:Array.from({length:9},(_,id)=>({id,mirrored:id%2===1,pixel:[.2,.3,.4,1]}))},validationErrors:[],cleanup:{ownerResidual:0,liveGpuResources:0}};
}
test('instance evidence rejects missing stages, samples, independent normals and quality metadata',()=>{
 const options=parseG05InstanceOptions([]);validateG05InstanceResult(result(),options);
 for(const mutate of [r=>r.pixelReference='unknown',r=>r.paths.pop(),r=>r.paths[0].cpu.pop(),r=>r.paths[0].cpu[0].timestampQuery=true,r=>r.paths[0].gpu[0].gpuSpanMs=NaN,r=>r.paths[0].gpu[0].passes=[],r=>r.paths[0].mode='all',r=>r.poseNormals=null,r=>r.poseNormals.probes[0].mirrored=true,r=>r.geometryTiers[1].triangles=144,r=>r.ids[0].checkedIds=10,r=>r.pixels[0].maxDelta=.1,r=>r.normalFrameInstanceReadbackBytes=4,r=>r.cleanup.liveGpuResources=1]){
  const r=result();mutate(r);assert.throws(()=>validateG05InstanceResult(r,options));
 }
});
