export const G05_INSTANCE_VARIANTS=Object.freeze(['lod-on','lod-off','frustum-visible','frustum-rejected']);
export function parseG05InstanceOptions(args){
 const result={count:1000,views:1,variant:'lod-on',preference:'high-performance',full:false,idleMs:120000};const seen=new Set();
 for(const arg of args){const key=arg.split('=')[0];if(seen.has(key))throw Error(`Duplicate ${key}`);seen.add(key);
  if(/^--count=(1000|10000)$/.test(arg))result.count=Number(arg.slice(8));
  else if(/^--views=(1|4)$/.test(arg))result.views=Number(arg.slice(8));
  else if(arg.startsWith('--variant=')&&G05_INSTANCE_VARIANTS.includes(arg.slice(10)))result.variant=arg.slice(10);
  else if(arg==='--integrated')result.preference='low-power';else if(arg==='--full')result.full=true;else throw Error(`Unknown G05 instance option ${arg}`);
 }return result;
}
// Same deterministic transforms and camera/quality settings for CPU oracle and GPU paths.
export function createG05InstanceData(count){
 if(![1000,10000].includes(count))throw Error('Invalid instance population');
 const matrices=new Float32Array(count*16),colors=new Float32Array(count*4),columns=Math.ceil(Math.sqrt(count));
 for(let id=0;id<count;id++){
  const offset=id*16,scale=[.009,.004,.001][id%3],angle=(id%7)*.17,c=Math.cos(angle),s=Math.sin(angle);
  matrices.set([c*scale,0,-s*scale,0,0,scale*.7,0,0,scale*.4*s,0,scale*.4*c,0,-.92+(id%columns)*1.84/columns,-.92+Math.floor(id/columns)*1.84/columns,.5,1],offset);
  colors.set([.2+(id%5)*.15,.2+(id%7)*.1,.25+(id%3)*.25,1],id*4);
 }return {matrices,colors};
}
export function createG05InstanceView(index,rejected=false,lod=true){
 if(!Number.isInteger(index)||index<0||index>3)throw Error('Invalid view index');
 const zoom=rejected?4:1,centerX=rejected?(index%2? .48:-.48):0,centerY=rejected?(index<2?-.48:.48):0;
 const view=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,-centerX,-centerY,0,1]);
 const projection=new Float32Array([zoom,0,0,0,0,zoom,0,0,0,0,1,0,0,0,0,1]),viewProjection=projection.slice();viewProjection[12]=-centerX*zoom;viewProjection[13]=-centerY*zoom;
 return {planes:new Float32Array([1,0,0,1/zoom-centerX,-1,0,0,1/zoom+centerX,0,1,0,1/zoom-centerY,0,-1,0,1/zoom+centerY,0,0,1,0,0,0,-1,1]),viewMatrix:view,projection,viewProjection,projectionPixelScale:360*zoom,perspective:false,nearPixels:lod?3:1e-5,middlePixels:lod?1:1e-6,hysteresis:0,localSphere:[0,0,0,.5]};
}
export function classifyG05Instances(matrices,view){
 const buckets=[[],[],[]];
 for(let id=0;id<matrices.length/16;id++){
  const o=id*16,r=.5*Math.hypot(...[0,1,2,4,5,6,8,9,10].map(k=>matrices[o+k])),p=[matrices[o+12],matrices[o+13],matrices[o+14]];
  let visible=true;
  for(let j=0;j<24;j+=4){const a=view.planes; if(a[j]*p[0]+a[j+1]*p[1]+a[j+2]*p[2]+a[j+3]<-r*Math.hypot(a[j],a[j+1],a[j+2]))visible=false;}
  if(visible){const height=2*r*view.projectionPixelScale;const level=height>=view.nearPixels?0:height>=view.middlePixels?1:2;buckets[level].push(id);}
 }return buckets;
}
export function verifyG05InstanceIds(actual,expected,count){
 if(actual.length!==3||expected.length!==3)throw Error('Missing LOD bucket');const seen=new Set();
 for(let level=0;level<3;level++){
  if(actual[level].length!==expected[level].length)throw Error(`LOD ${level} count mismatch`);const wanted=new Set(expected[level]);
  for(const id of actual[level]){if(!Number.isInteger(id)||id<0||id>=count||seen.has(id)||!wanted.has(id))throw Error('Wrong, duplicate or missing instance ID');seen.add(id);}
 }return {checkedIds:seen.size,counts:actual.map(ids=>ids.length)};
}
export function validateG05InstanceResult(r,o){
 if(r.status!=='passed'||r.schemaVersion!==1||r.suite!=='g05-instances')throw Error('G05 instances failed');
 for(const key of ['count','views','variant'])if(r[key]!==o[key])throw Error(`Instance ${key} mismatch`);
 if(r.adapter?.isFallbackAdapter!==false||!r.adapter.vendor||!r.adapter.architecture)throw Error('Native GPU required');
 if(r.width!==1280||r.height!==720||r.normalFrameInstanceReadbackBytes!==0)throw Error('Wrong resolution or normal-frame readback');
 const n=o.full?300:3;if(r.samples!==n||r.warmup!==(o.full?120:2)||r.paths?.length!==2)throw Error('Incomplete paired samples');
 for(const [i,p]of r.paths.entries()){
  if(p.path!==(i===0?'candidate':'reference')||p.cpu?.length!==n||p.gpu?.length!==n)throw Error('Missing instance path');
  for(const [frame,s]of p.cpu.entries()){if(s.frame!==frame||s.timestampQuery!==false)throw Error('Contaminated CPU instance samples');for(const k of ['cpuRuntimeMs','cpuRecordMs','cpuSubmitMs','queueWaitMs','frameWallMs'])if(!Number.isFinite(s[k])||s[k]<0)throw Error('Invalid CPU sample');}
  const candidate=o.variant==='lod-off'?'all':'gpu',reference=o.variant==='lod-off'?'gpu':'all';
  if(p.mode!==(i===0?candidate:reference))throw Error('Wrong paired instance path');
  for(const [frame,s]of p.gpu.entries()){
   if(s.frame!==frame||!Number.isFinite(s.gpuSpanMs)||s.gpuSpanMs<=0||!Number.isFinite(s.gpuPassSumMs)||s.gpuSpanMs+1e-6<s.gpuPassSumMs||s.passes?.filter(p=>p.kind==='render').length!==o.views)throw Error('Invalid whole-frame instance GPU sample');
   if(s.passes.filter(p=>p.kind==='compute'&&p.label==='GpuInstanceLod.classify').length!==(p.mode==='gpu'?o.views:0))throw Error('Missing instance compute population');
   for(const pass of s.passes)if(!Number.isFinite(pass.durationMs)||pass.durationMs<0||!['render','compute'].includes(pass.kind))throw Error('Invalid instance pass');
   if(Math.abs(s.gpuPassSumMs-s.passes.reduce((n,p)=>n+p.durationMs,0))>1e-6)throw Error('Instance pass sum mismatch');
  }
  for(const metric of [p.metrics,p.gpuMetrics]){
   for(const key of ['bindGroupsCreated','buffersCreated','renderPipelinesCreated','bufferUploadsPerFrame','uploadBytesPerFrame','drawsPerFrame','renderPassesPerFrame'])if(!Number.isFinite(metric?.[key])||metric[key]<0)throw Error('Missing instance resource metrics');
   if(metric.metricClassification?.measuredFrames!==n||metric.metricClassification?.strictEquality?.passed!==true)throw Error('Instance counter population mismatch');
  }
  for(const resources of [p.resourcesBefore,p.resources])for(const type of ['buffer','texture'])if(!Number.isFinite(resources?.[type]?.created)||!Number.isFinite(resources[type].estimatedBytes))throw Error('Missing instance resource snapshots');
 }
 if(r.pixelReference!==(o.variant.startsWith('frustum-')?'unculled-all-high':'cpu-lod-buckets'))throw Error('Wrong instance pixel reference');
 if(r.ids?.length!==o.views||r.pixels?.length!==o.views)throw Error('Missing per-view instance oracle');
 for(const [i,p]of r.pixels.entries())if(p.view!==i||!Number.isFinite(p.maxDelta)||p.maxDelta>1/255+1e-6||!Number.isSafeInteger(p.litPixels)||p.litPixels<1)throw Error('Instance pixel parity failed');
 for(const [view,id]of r.ids.entries()){
  if(id.view!==view||!Number.isSafeInteger(id.checkedIds)||id.checkedIds<1||id.checkedIds>o.count||id.counts?.length!==3||id.counts.some(n=>!Number.isSafeInteger(n)||n<0)||id.counts.reduce((a,b)=>a+b,0)!==id.checkedIds)throw Error('Instance ID population failed');
  if(o.variant==='frustum-rejected'?id.checkedIds>=o.count/4:id.checkedIds!==o.count)throw Error('Wrong visible instance workload');
 }
 if(JSON.stringify(r.geometryTiers?.map(g=>g.triangles))!=='[144,64,16]')throw Error('Missing LOD quality attribution');
 if(r.poseNormals?.count!==9||r.poseNormals.mirrored!==4||r.poseNormals.nonuniform!==9||r.poseNormals.probes?.length!==9||!Number.isFinite(r.poseNormals.maxDelta)||r.poseNormals.maxDelta>1/255+1e-6||r.poseNormals.litPixels<9)throw Error('Missing independent pose/normal oracle');
 for(const [id,p]of r.poseNormals.probes.entries())if(p.id!==id||p.mirrored!==(id%2===1)||p.pixel?.length!==4||p.pixel.some(v=>!Number.isFinite(v)))throw Error('Missing pose/normal probes');
 if(r.validationErrors?.length!==0||r.cleanup?.ownerResidual!==0||r.cleanup?.liveGpuResources!==0)throw Error('Instance validation or residue failure');
}
