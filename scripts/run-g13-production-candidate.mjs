import {spawnSync,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,relative,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {g13ProductionPlan} from './g13-production-candidate-policy.mjs';
import {productionCapturePlan,assessProductionCapture} from './hya-corpus/production-cohort-policy.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),args=process.argv.slice(2);
if(args.length!==1||!['--plan','--run'].includes(args[0]))throw Error('Use --plan or --run');
const id=Date.now()+'-'+randomBytes(4).toString('hex'),plan=g13ProductionPlan(root,id);
if(args[0]==='--plan'){console.log(JSON.stringify(plan,null,2));process.exit(0);}
const git=values=>execFileSync('git',values,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
if(process.platform!=='win32')throw Error('Registered native Windows runner required');
if(git(['status','--porcelain']))throw Error('A clean source revision is required');
if(/^RDP/i.test(process.env.SESSIONNAME??''))throw Error('A local console session is required');
execFileSync(resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; . (Join-Path $env:G13_REPOSITORY 'scripts/webgpu-gate/framegraph-background-policy.ps1'); Assert-G09GpuDiagnosticReady"],
  {cwd:root,env:{...process.env,G13_REPOSITORY:root},windowsHide:true,stdio:'inherit'});
if(existsSync(resolve(root,plan.output)))throw Error('Fresh measurement output required');
const revision=git(['rev-parse','HEAD']),out=resolve(root,plan.wrapperOutput);mkdirSync(out);
const result={schemaVersion:1,status:'running',startedAt:new Date().toISOString(),revision,dirty:false,...plan};
const save=()=>writeFileSync(resolve(out,'launcher.json'),JSON.stringify(result,null,2)+'\n');save();
console.log('HYA production sampling: '+plan.captures+' captures; original GPU budget 5%.');
console.log('Evidence: '+plan.output+'; progress: '+plan.wrapperOutput+'/stdout.log');
console.log('Keep this independent terminal open and leave the computer idle.');
const stdout=openSync(resolve(out,'stdout.log'),'wx'),stderr=openSync(resolve(out,'stderr.log'),'wx');
try{
  const child=spawnSync(process.execPath,plan.args,{cwd:root,stdio:['ignore',stdout,stderr],windowsHide:true,timeout:2*60*60*1000});
  if(child.error)throw child.error;
  result.exitCode=child.status;
  if(git(['rev-parse','HEAD'])!==revision||git(['status','--porcelain']))throw Error('Source changed during sampling');
  g13ProductionPlan(root,id);
  const raw=JSON.parse(readFileSync(resolve(root,plan.output,'result.json')));
  result.measurementStatus=raw.status;
  if(child.status!==0||raw.status!=='passed'||raw.diagnostic!==false||raw.captures?.length!==30)throw Error('Sampling or acceptance failed; raw evidence retained');
  assert.deepEqual(raw.plan,productionCapturePlan());
  assert.equal(raw.packageReport.sha256,plan.packageReport.sha256);
  assert.equal(resolve(raw.packageReport.path),resolve(root,plan.packageReport.path));
  assert.equal(raw.gpuLimit,.05);assert.equal(raw.gpu.length,4);
  const budget=JSON.parse(readFileSync(resolve(root,'config/framegraph-production-021.json')));
  for(const [index,capture]of raw.captures.entries()){
    const directory=resolve(capture.directory),local=relative(resolve(root,plan.output),directory);
    if(!local||isAbsolute(local)||local==='..'||local.startsWith('../')||local.startsWith('..\\'))throw Error('Capture path escapes the current attempt');
    assert.deepEqual(capture.job,raw.plan[index]);
    const original=JSON.parse(readFileSync(resolve(directory,'result.json')));
    if(assessProductionCapture(original,raw.plan[index],budget).failed)throw Error('Independent capture audit failed: '+index);
  }
  result.independentlyAuditedCaptures=30;
  result.status='passed-local-hya-production';
}catch(error){result.status='failed';result.error=String(error.stack??error);process.exitCode=1;}
finally{closeSync(stdout);closeSync(stderr);result.finishedAt=new Date().toISOString();save();console.log('FINAL STATUS: '+result.status);if(result.error)console.error(result.error);console.log('Evidence: '+plan.output);console.log('Launcher evidence: '+plan.wrapperOutput);console.log('No baseline was promoted and no version was published.');}
