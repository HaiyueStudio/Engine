import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createG05RoomPlan,validateG05RoomCandidate,evaluateG05RoomBudgets} from './deferred-g05-cohort-policy.mjs';
import {sha256} from './deferred-fixture-policy.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=resolve(root,'artifacts/engine-0.2.1/g05');
const args=process.argv.slice(2);if(args.length!==1||!['--plan','--full'].includes(args[0]))throw Error('Use --plan or --full; partial cohorts cannot qualify');
const plan=createG05RoomPlan();
if(args[0]==='--plan')console.log(JSON.stringify({scope:'room E/G only; F and Forward/default path remain separate',captures:plan.length,minimumIdleMinutes:plan.length*2,jobs:plan},null,2));
else{
 await mkdir(directory,{recursive:true});
 const generatedAt=new Date().toISOString(),path=resolve(directory,`room-cohorts-${generatedAt.replaceAll(':','-')}.json`);
 const policyPaths=['scripts/webgpu-gate/deferred-g05-cohort-policy.mjs','scripts/webgpu-gate/deferred-g05-memory-policy.mjs','scripts/webgpu-gate/run-deferred-g05-cohorts.mjs','config/lighting-performance-021.json'];
 const policyFiles=await Promise.all(policyPaths.map(async path=>({path,sha256:sha256(await readFile(resolve(root,path)))})));
 const report={schemaVersion:1,tier:'diagnostic-g05-room-cohorts',generatedAt,status:'running',policyFiles,plan,entries:[]};
 await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 try{
  for(const [index,job]of plan.entries()){
   console.log(`G05 room capture ${index+1}/${plan.length}: cohort ${job.cohort+1}, ${job.preference}, ${job.caseId}, ${job.algorithm}, moving=${job.moving}`);
   const flags=['scripts/webgpu-gate/run-deferred-g05-room.mjs',`--case=${job.caseId}`,'--full',`--idle-ms=${job.idleMs}`];
   if(job.preference==='low-power')flags.push('--integrated');if(job.algorithm==='reference')flags.push('--reference');if(!job.moving)flags.push('--static');
   const capture=await run(flags),entry={job,exitCode:capture.code,stdout:capture.stdout,stderr:capture.stderr};report.entries.push(entry);
   for(const line of capture.stdout.split('\n')){
    let value;try{value=JSON.parse(line);}catch{continue;}
    if(value.path){const artifact=resolve(value.path);if(!artifact.startsWith(directory+sep)||!artifact.endsWith('.json'))throw Error('Unexpected child artifact path');entry.artifact=artifact;entry.evidence=JSON.parse(await readFile(artifact,'utf8'));}
   }
   await writeFile(path,JSON.stringify(report,null,2)+'\n');
   if(capture.code!==0||!entry.evidence)throw Error(`Capture ${index+1} failed; all logs retained in ${path}`);
   entry.summary=validateG05RoomCandidate(entry.evidence,job);
  }
  for(const file of policyFiles)if(sha256(await readFile(resolve(root,file.path)))!==file.sha256)throw Error('Cohort policy changed during capture');
  report.budgets=evaluateG05RoomBudgets(report.entries,JSON.parse(await readFile(resolve(root,'config/lighting-performance-021.json'),'utf8')));
  report.status=report.budgets.status;
 }catch(error){report.status='failed';report.error=error.stack??String(error);process.exitCode=1;}
 finally{report.finishedAt=new Date().toISOString();await writeFile(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({path,status:report.status,captures:report.entries.length,error:report.error}));}
 if(report.status!=='passed')process.exitCode=1;
}
function run(args){return new Promise((resolveRun,reject)=>{
 const child=spawn(process.execPath,args,{cwd:root,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',data=>{stdout+=data;process.stdout.write(data);});child.stderr.on('data',data=>{stderr+=data;process.stderr.write(data);});
 child.on('error',reject);child.on('close',code=>resolveRun({code,stdout,stderr}));
});}
