import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createG05GpuFocusPlan,validateG05GpuFocusCandidate,evaluateG05GpuFocus} from './deferred-g05-gpu-focus-policy.mjs';
import {sha256} from './deferred-fixture-policy.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=resolve(root,'artifacts/engine-0.2.1/g05');
const args=process.argv.slice(2);if(args.length!==1||!['--plan','--full'].includes(args[0]))throw Error('Use --plan or --full');
const plan=createG05GpuFocusPlan();
if(args[0]==='--plan')console.log(JSON.stringify({captures:plan.length,minimumIdleMinutes:plan.length*2,plan},null,2));
else{
 await mkdir(directory,{recursive:true});
 const generatedAt=new Date().toISOString(),path=resolve(directory,`gpu-focus-cohorts-${generatedAt.replaceAll(':','-')}.json`);
 const policyPaths=['scripts/webgpu-gate/deferred-g05-gpu-focus-policy.mjs','scripts/webgpu-gate/run-deferred-g05-gpu-focus.mjs','scripts/webgpu-gate/deferred-g05-cohort-policy.mjs','scripts/webgpu-gate/deferred-g05-cost-policy.mjs','scripts/benchmark/lighting-g01-policy.mjs','scripts/benchmark/timing-cohorts.mjs','config/lighting-performance-021.json'];
 const policyFiles=await Promise.all(policyPaths.map(async path=>({path,sha256:sha256(await readFile(resolve(root,path)))})));
 const config=JSON.parse(await readFile(resolve(root,'config/lighting-performance-021.json')));
 const report={schemaVersion:1,tier:'diagnostic-g05-gpu-focus-cohorts',generatedAt,status:'running',policyFiles,plan,entries:[]};
 await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 try{
  for(const [i,job]of plan.entries()){
   console.log(`GPU focus ${i+1}/${plan.length}: cohort ${job.cohort+1}, ${job.preference}, ${job.caseId}/${job.ao}/${job.algorithm}`);
   const flags=[`scripts/webgpu-gate/run-deferred-g05-${job.runner}.mjs`,`--case=${job.caseId}`,'--full'];
   if(job.runner==='cost')flags.push(`--ao=${job.ao}`);if(job.preference==='low-power')flags.push('--integrated');if(job.algorithm==='reference')flags.push('--reference');
   const capture=await run(flags),entry={job,...capture};report.entries.push(entry);
   for(const line of capture.stdout.split('\n')){
    let v;try{v=JSON.parse(line);}catch{continue;}
    if(v.path){const artifact=resolve(v.path);if(!artifact.startsWith(directory+sep)||!artifact.endsWith('.json'))throw Error('Unexpected artifact');const raw=await readFile(artifact);entry.artifact=artifact;entry.sha256=sha256(raw);entry.evidence=JSON.parse(raw);}
   }
   await writeFile(path,JSON.stringify(report,null,2)+'\n');
   if(capture.exitCode!==0||!entry.evidence)throw Error(`Capture ${i+1} failed; complete failure retained`);
   entry.summary=validateG05GpuFocusCandidate(entry.evidence,job,config);
  }
  for(const f of policyFiles)if(f.sha256!==sha256(await readFile(resolve(root,f.path))))throw Error('Focus policy changed during capture');
  for(const e of report.entries)if(e.sha256!==sha256(await readFile(e.artifact)))throw Error('Raw capture changed');
  report.audit=evaluateG05GpuFocus(report.entries,config);report.status=report.audit.status;
 }catch(error){report.status='failed';report.error=error.stack??String(error);}
 finally{report.finishedAt=new Date().toISOString();await writeFile(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({path,status:report.status,captures:report.entries.length,error:report.error}));}
 if(report.status!=='passed')process.exitCode=1;
}
function run(args){return new Promise((resolveRun,reject)=>{const child=spawn(process.execPath,args,{cwd:root,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>{stdout+=d;process.stdout.write(d);});child.stderr.on('data',d=>{stderr+=d;process.stderr.write(d);});child.on('error',reject);child.on('close',exitCode=>resolveRun({exitCode,stdout,stderr}));});}
