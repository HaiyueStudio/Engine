import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createG05InstancePlan} from './deferred-g05-instance-cohort-policy.mjs';
import {validateG05InstanceResult} from './deferred-g05-instance-policy.mjs';
import {deferredRuntimeFingerprint,sha256} from './deferred-fixture-policy.mjs';
if(process.argv.length!==2)throw Error('Instance smoke matrix takes no flags; full qualification is separate');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=resolve(root,'artifacts/engine-0.2.1/g05');
const generatedAt=new Date().toISOString(),path=resolve(directory,`instance-smoke-matrix-${generatedAt.replaceAll(':','-')}.json`),inputs=await deferredRuntimeFingerprint(root);
const jobs=createG05InstancePlan().filter(j=>j.cohort===0).map(({cohort,...job})=>({...job,full:false}));
let expectedHarness;
const report={schemaVersion:1,status:'running',tier:'diagnostic-instance-smoke-matrix',generatedAt,inputs,scope:'All F workload axes, short correctness/structural smoke only; no performance qualification',jobs,entries:[]};
await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
try{
 for(const [i,job]of jobs.entries()){
  console.log(`Instance smoke ${i+1}/${jobs.length}: ${job.preference} ${job.count}/${job.views}/${job.variant}`);
  const args=['scripts/webgpu-gate/run-deferred-g05-instances.mjs',`--count=${job.count}`,`--views=${job.views}`,`--variant=${job.variant}`];if(job.preference==='low-power')args.push('--integrated');
  const captured=await new Promise((done,reject)=>{const child=spawn(process.execPath,args,{cwd:root,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;process.stdout.write(b);});child.stderr.on('data',b=>{stderr+=b;process.stderr.write(b);});child.on('error',reject);child.on('close',code=>done({code,stdout,stderr}));});
  const entry={job,...captured};report.entries.push(entry);
  for(const line of captured.stdout.split('\n')){let value;try{value=JSON.parse(line);}catch{continue;}if(value.path)entry.artifact=value.path;}
  await writeFile(path,JSON.stringify(report,null,2)+'\n');
  if(captured.code!==0||!entry.artifact)throw Error(`Instance smoke ${i+1} failed`);
  if(!entry.artifact.startsWith(directory+'/')||!entry.artifact.endsWith('.json'))throw Error('Invalid child artifact path');
  const bytes=await readFile(entry.artifact),e=JSON.parse(bytes);entry.artifactSha256=sha256(bytes);
  expectedHarness??=e.harness.sha256;if(e.harness.sha256!==expectedHarness)throw Error('Instance harness changed during matrix');
  if(e.inputs.sha256!==inputs.sha256)throw Error('Instance matrix runtime changed');validateG05InstanceResult(e.result,job);
  if(e.result.adapter.vendor!==(job.preference==='high-performance'?'amd':'intel'))throw Error('Unexpected GPU class');
  for(const p of e.result.paths)for(const metric of [p.metrics,p.gpuMetrics])for(const key of ['bindGroupsCreated','buffersCreated','renderPipelinesCreated'])if(metric[key]!==0)throw Error(`Unstable ${job.variant}/${p.path}/${key}: ${metric[key]}`);
  entry.summary={adapter:e.result.adapter,ids:e.result.ids,pixels:e.result.pixels,poseNormalDelta:e.result.poseNormals.maxDelta,cleanup:e.result.cleanup};
 }
 if((await deferredRuntimeFingerprint(root)).sha256!==inputs.sha256)throw Error('Runtime changed during matrix');report.status='passed';
}catch(error){report.status='failed';report.error=error.stack??String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await writeFile(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({path,status:report.status,completed:report.entries.length,error:report.error}));}
