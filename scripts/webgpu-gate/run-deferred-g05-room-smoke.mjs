import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createG05RoomPlan} from './deferred-g05-cohort-policy.mjs';
import {validateG05RoomResult} from './deferred-g05-policy.mjs';
import {validateG05RoomMemory} from './deferred-g05-memory-policy.mjs';
import {deferredRuntimeFingerprint,sha256} from './deferred-fixture-policy.mjs';
if(process.argv.length!==2)throw Error('Room smoke matrix takes no flags; full qualification is separate');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=resolve(root,'artifacts/engine-0.2.1/g05');
const generatedAt=new Date().toISOString(),path=resolve(directory,`room-smoke-matrix-${generatedAt.replaceAll(':','-')}.json`),inputs=await deferredRuntimeFingerprint(root);
const jobs=createG05RoomPlan().filter(j=>j.cohort===0).map(({cohort,...job})=>({...job,full:false}));
let expectedHarness;const config=JSON.parse(await readFile(resolve(root,'config/lighting-performance-021.json'),'utf8'));
const report={schemaVersion:1,status:'running',tier:'diagnostic-room-smoke-matrix',generatedAt,inputs,scope:'All E/G room workload axes, short correctness/resource smoke only; no performance qualification',jobs,entries:[]};
await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
try{
 for(const [i,job]of jobs.entries()){
  console.log(`Room smoke ${i+1}/${jobs.length}: ${job.preference} ${job.caseId}/${job.algorithm}/moving=${job.moving}`);
  const args=['scripts/webgpu-gate/run-deferred-g05-room.mjs',`--case=${job.caseId}`];if(job.preference==='low-power')args.push('--integrated');if(job.algorithm==='reference')args.push('--reference');if(!job.moving)args.push('--static');
  const captured=await new Promise((done,reject)=>{const child=spawn(process.execPath,args,{cwd:root,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;process.stdout.write(b);});child.stderr.on('data',b=>{stderr+=b;process.stderr.write(b);});child.on('error',reject);child.on('close',code=>done({code,stdout,stderr}));});
  const entry={job,...captured};report.entries.push(entry);
  for(const line of captured.stdout.split('\n')){let value;try{value=JSON.parse(line);}catch{continue;}if(value.path)entry.artifact=value.path;}
  await writeFile(path,JSON.stringify(report,null,2)+'\n');
  if(captured.code!==0||!entry.artifact)throw Error(`Room smoke ${i+1} failed`);
  if(!entry.artifact.startsWith(directory+'/')||!entry.artifact.endsWith('.json'))throw Error('Invalid child artifact path');
  const bytes=await readFile(entry.artifact),e=JSON.parse(bytes);entry.artifactSha256=sha256(bytes);
  expectedHarness??=e.harness.sha256;if(e.harness.sha256!==expectedHarness)throw Error('Room harness changed during matrix');
  if(e.inputs.sha256!==inputs.sha256)throw Error('Room matrix runtime changed');validateG05RoomResult(e.result,job);
  if(e.result.adapter.vendor!==(job.preference==='high-performance'?'amd':'intel'))throw Error('Unexpected GPU class');
  for(const metric of [e.result.cpuMetrics,e.result.gpuMetrics])for(const key of ['bindGroupsCreated','buffersCreated','renderPipelinesCreated'])if(metric[key]!==0)throw Error(`Unstable ${job.caseId}/${key}: ${metric[key]}`);
  const memory=validateG05RoomMemory(e.result,config);if(memory.status!=='passed')throw Error('Room memory budget failed');
  entry.summary={adapter:e.result.adapter,pixels:e.result.pixels,memory,cleanup:e.result.cleanup};
 }
 if((await deferredRuntimeFingerprint(root)).sha256!==inputs.sha256)throw Error('Runtime changed during matrix');report.status='passed';
}catch(error){report.status='failed';report.error=error.stack??String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await writeFile(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({path,status:report.status,completed:report.entries.length,error:report.error}));}
