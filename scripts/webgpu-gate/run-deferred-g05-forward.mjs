import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {waitG05Cooldown} from './deferred-g05-cooldown.mjs';
import {runChromeWebGpuFixture} from './chrome-runner.mjs';
import {deferredRuntimeFingerprint,sha256} from './deferred-fixture-policy.mjs';
import {parseG01ThermalStatus} from '../benchmark/lighting-g01-host.mjs';
import {parseG05ForwardOptions,createG05ForwardPlan,G05_FORWARD_CASES,validateG05ForwardCapture,evaluateG05ForwardBudgets} from './deferred-g05-forward-policy.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=resolve(root,'artifacts/engine-0.2.1/g05'),o=parseG05ForwardOptions(process.argv.slice(2)),plan=createG05ForwardPlan(o.full||o.plan);
if(o.plan){console.log(JSON.stringify({captures:plan.length,minimumIdleMinutes:plan.length*2,scope:'G01 same-workload default Forward regression; no multi-light equivalence claim',jobs:plan},null,2));}
else{
 await mkdir(directory,{recursive:true});const generatedAt=new Date().toISOString(),path=resolve(directory,`forward-cohorts-${generatedAt.replaceAll(':','-')}.json`);
 const report={schemaVersion:1,tier:o.full?'diagnostic-g05-forward-cohorts':'diagnostic-g05-forward-smoke-matrix',generatedAt,status:'running',plan,entries:[]};
 await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 try{
  const runtime=await deferredRuntimeFingerprint(root);
  // This independent consumer uses Engine dist. Rebuild once before all cooling/captures,
  // rather than trusting a dist directory potentially left by another task.
  report.build=await promisify(execFile)('npm',['run','build','-w','./engine'],{cwd:root,maxBuffer:16*1024*1024,timeout:300000});
  if(runtime.sha256!==(await deferredRuntimeFingerprint(root)).sha256)throw Error('Source changed during Forward build');
  const inputs=await fingerprintInputs(),harness=await fingerprintHarness();report.inputs=inputs;report.harness=harness;
  const config=JSON.parse(await readFile(resolve(root,'config/lighting-performance-021.json'),'utf8'));
  const baseline=await loadBaseline(config);report.baseline=baseline.files;
  for(const [index,job]of plan.entries()){
   console.log(`G05 Forward ${index+1}/${plan.length}: ${job.preference} ${job.caseId}, cohort ${job.cohort+1}`);
   const interCaseIdleMs=await waitG05Cooldown(job.idleMs,{onProgress:remaining=>console.log(`G05 Forward cooling: ${Math.ceil(remaining/1000)}s`)});
   const before=host(),c=G05_FORWARD_CASES.find(c=>c.id===job.caseId);let result;
   if(job.full&&!before.ready)result={status:'failed',stage:'host-preflight',error:before.reasons.join('; ')};
   else try{result=await runChromeWebGpuFixture({root,fixture:'scripts/webgpu-gate/deferred-g05-forward-fixture.html',query:{...c,powerPreference:job.preference,warmup:job.full?120:2,samples:job.full?300:3,gpuSamples:job.full?300:3,resolution:'720p'},timeoutMs:240000,mounts:[{prefix:'/games',directory:resolve(root,'scripts/fixtures/lighting-content')}]});}
   catch(error){result={status:'failed',stage:'browser',error:error.stack??String(error)};}
   const evidence={schemaVersion:1,tier:job.full?'diagnostic-g05-forward-candidate':'diagnostic-g05-forward-smoke',generatedAt:new Date().toISOString(),job,inputs,harness,revision:git(['rev-parse','HEAD']),dirty:git(['status','--porcelain']).length>0,interCaseIdleMs,hostSamples:[before,host()],result};
   const artifact=resolve(directory,`forward-${job.caseId}-${job.preference}-${evidence.generatedAt.replaceAll(':','-')}.json`),bytes=JSON.stringify(evidence,null,2)+'\n';await writeFile(artifact,bytes,{flag:'wx'});
   report.entries.push({job,artifact,sha256:sha256(bytes),evidence});await writeFile(path,JSON.stringify(report,null,2)+'\n');
   console.log(JSON.stringify({artifact,status:result.execution?.status??result.status,hostReady:evidence.hostSamples.every(h=>h.ready)}));
   if(inputs.sha256!==(await fingerprintInputs()).sha256||harness.sha256!==(await fingerprintHarness()).sha256)throw Error('Forward inputs changed during capture');
   validateG05ForwardCapture(evidence,job);
  }
  if(o.full){report.budgets=evaluateG05ForwardBudgets(report.entries,baseline.evidence,config);report.status=report.budgets.status;}
  else report.status='passed';
 }catch(error){report.status='failed';report.error=error.stack??String(error);process.exitCode=1;}
 finally{report.finishedAt=new Date().toISOString();await writeFile(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({path,status:report.status,captures:report.entries.length,error:report.error}));}
 if(report.status!=='passed')process.exitCode=1;
}
function git(args){return execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();}
function host(){const output=execFileSync('pmset',['-g','therm'],{encoding:'utf8'});return {command:'pmset -g therm',observedAt:new Date().toISOString(),output,...parseG01ThermalStatus(output)};}
async function fingerprintInputs(){
 const runtime=await deferredRuntimeFingerprint(root),files=(await readdir(resolve(root,'engine/dist'),{recursive:true})).filter(f=>f.endsWith('.js')).sort();
 const outputs=await Promise.all(files.map(async f=>({path:`engine/dist/${f}`,sha256:sha256(await readFile(resolve(root,'engine/dist',f)))})));
 return {runtime,outputs,sha256:sha256(JSON.stringify({runtime,outputs}))};
}
async function fingerprintHarness(){
 const paths=['deferred-g05-forward-policy.mjs','deferred-g05-forward-allocation.mjs','float-texture-readback.mjs','framegraph-pixel-oracle.mjs','deferred-g05-forward-fixture.mjs','deferred-g05-forward-fixture.html','run-deferred-g05-forward.mjs','lighting-scaling-contract.mjs','lighting-scaling-report.mjs','chrome-runner.mjs','deferred-fixture-policy.mjs','deferred-g05-cooldown.mjs'].map(f=>`scripts/webgpu-gate/${f}`);
 paths.push('config/lighting-performance-021.json','engine/package.json','engine/rollup.config.js','review/engine-0.2.1/g01-baseline-summary.json');
 const files=await Promise.all(paths.map(async path=>({path,sha256:sha256(await readFile(resolve(root,path)))})));return {files,sha256:sha256(JSON.stringify(files))};
}
async function loadBaseline(config){
 const summary=JSON.parse(await readFile(resolve(root,config.baselineEvidence.summaryPath),'utf8')),files=[],evidence=[];
 if(summary.revision!==config.baselineEvidence.revision||summary.sourceHash!==config.baselineEvidence.sourceHash)throw Error('Frozen G01 baseline identity changed');
 for(const preference of ['high-performance','low-power'])for(const c of G05_FORWARD_CASES)for(let cohort=0;cohort<3;cohort++){
  const name=`${preference}-${c.id}-${cohort+1}.json`,path=resolve(root,config.baselineEvidence.rawDirectory,name),bytes=await readFile(path),hash=sha256(bytes);
  if(summary.captureFiles.find(f=>f.file===name)?.sha256!==hash)throw Error(`Frozen baseline changed: ${name}`);
  files.push({path,sha256:hash});evidence.push(JSON.parse(bytes));
 }return {files,evidence};
}
