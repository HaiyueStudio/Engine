import {writeAtomicState,acquireStateLock,inspectStateLock,removeStaleStateLock} from './release-workflow-state.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,existsSync,openSync,closeSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {npmCommand,npmArgs} from './npm-process.mjs';
import {releaseWorkflowSteps,workflowId,runReleaseWorkflow,workflowLauncher} from './release-workflow-run-policy.mjs';
import {storedPublicationLog} from './publication-policy.mjs';
import {launchIndependentWorkflow,confirmIndependentStartup} from './release-workflow-launch.mjs';
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
const root=resolve(import.meta.dirname,'..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const git=args=>execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),...args],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
function snapshot(){return {revision:git(['rev-parse','HEAD']),dirty:git(['status','--porcelain']).length>0,
  files:Object.fromEntries([...readdirSync(resolve(root,'scripts')).filter(n=>/publication|release-workflow|^npm-process\.mjs$/.test(n)).map(n=>'scripts/'+n),
    'scripts/webgpu-gate/planar-reflection-fixture.mjs','scripts/verify-webgpu-planar-reflection.mjs','scripts/webgpu-gate/framegraph-background-policy.ps1'].sort().map(p=>[p,sha(readFileSync(resolve(root,p)))]))};}
const save=writeAtomicState;
export function windowsWorkflowHost(sourceRoot=root){
  const shell=resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const script="$ErrorActionPreference='Stop'; $env:PSModulePath=Join-Path $PSHOME 'Modules'; $p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); . (Join-Path $env:G02_SOURCE_ROOT 'scripts/webgpu-gate/framegraph-background-policy.ps1'); [pscustomobject]@{platform='win32';administrator=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);blockers=@(Get-G09GpuStartBlockers)}|ConvertTo-Json -Compress -Depth 5";
  return JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,G02_SOURCE_ROOT:sourceRoot},encoding:'utf8',windowsHide:true,timeout:30000}));
}
async function main(){
  const args=process.argv.slice(2);if(args[0]==='workflow')args.shift();const mode=args.shift();
  const take=flag=>{const i=args.indexOf(flag);if(i<0)return;const v=args[i+1];if(!v||v.startsWith('--'))throw Error('Missing '+flag);args.splice(i,2);return v;};
  const profile=take('--profile')??'diagnostic',output=take('--output'),runPath=take('--run'),retryStage=take('--retry-stage'),confirm=take('--confirm-run-id');
  const noPublish=args.includes('--no-publish');if(noPublish)args.splice(args.indexOf('--no-publish'),1);
  const hidden=args.includes('--hidden');if(hidden)args.splice(args.indexOf('--hidden'),1);
  const closeOnComplete=args.includes('--close-on-complete');if(closeOnComplete)args.splice(args.indexOf('--close-on-complete'),1);
  const keepTerminal=args.includes('--keep-terminal');if(keepTerminal)args.splice(args.indexOf('--keep-terminal'),1);
  if(args.length||!['plan','run','launch','status','unlock-stale'].includes(mode))throw Error('Usage: release-workflow.mjs plan --profile diagnostic|ci|global --output DIR | run|launch|status|unlock-stale --run FILE [--no-publish] [--retry-stage ID] [--confirm-run-id SHA256]');
  if((hidden||closeOnComplete)&&mode!=='launch')throw Error('Window options apply only to explicit independent launch');
  if(keepTerminal&&mode!=='run')throw Error('Terminal retention applies only to a running controller');
  if(Number(process.versions.node.split('.')[0])<22)throw Error('Node.js 22 or newer required');
  if(mode==='plan'){
    if(!output||runPath||retryStage||confirm)throw Error('Plan requires a new output directory');
    const dir=resolve(root,output);mkdirSync(dir,{recursive:true});const path=resolve(dir,'run.json');
    const manifest={schemaVersion:1,profile,root,node:process.execPath,host:{platform:process.platform,architecture:process.arch,nodeVersion:process.version},noPublication:true,source:snapshot(),steps:releaseWorkflowSteps(profile)};
    const id=workflowId(manifest);writeFileSync(path,JSON.stringify({schemaVersion:1,manifestId:id,manifest,state:null},null,2)+'\n',{flag:'wx'});
    const launcher=resolve(dir,process.platform==='win32'?'start.cmd':'start.sh');writeFileSync(launcher,workflowLauncher(manifest,path,process.platform),{flag:'wx',mode:0o700});
    console.log(JSON.stringify({status:'prepared',profile,manifestId:id,run:path,launcher,noPublication:true}));return;
  }
  if(!runPath||output)throw Error('Existing run manifest required');
  const path=resolve(root,runPath),run=json(path),manifest=run.manifest,id=workflowId(manifest);
  if(run.manifestId!==id||manifest.root!==root)throw Error('Run manifest identity/root changed');
  if(manifest.host.nodeVersion!==process.version||manifest.node!==process.execPath||manifest.host.platform!==process.platform)throw Error('Prepared Node/host identity changed; prepare a new run');
  const lock=path+'.lock';
  if(mode==='launch'){
    if(!noPublish)throw Error('Independent launch requires --no-publish');
    const existing=inspectStateLock(lock,id);if(existing)throw Error(existing.alive?'Controller is already alive; no second launch':'Inspect and unlock the crash lock before launch');
    const nonce=randomBytes(12).toString('hex');
    run.launch={nonce,requestedAt:new Date().toISOString(),independent:true,requestedByPid:process.pid};save(path,run);
    try{
      const result=await launchIndependentWorkflow({root,node:manifest.node,runPath:path,nonce,hidden,closeOnComplete,retryStage});
      const controller=await confirmIndependentStartup(path,result.pid,nonce);
      console.log(JSON.stringify({status:'launched-independent',manifestId:id,run:path,...result,controller,published:false}));
    }catch(error){
      const evidence=resolve(dirname(path),`launch.${nonce}.failure.json`);
      save(evidence,{schemaVersion:1,manifestId:id,nonce,status:'startup-failed',error:storedPublicationLog(error.message),finishedAt:new Date().toISOString(),published:false});
      throw Error('Independent startup failed; evidence: '+evidence+'; '+error.message);
    }
    return;
  }
  if(mode==='status'){
    const owner=inspectStateLock(lock,id);
    console.log(JSON.stringify({manifestId:id,profile:manifest.profile,state:run.state,lock:owner},null,2));return;
  }
  if(mode==='unlock-stale'){
    removeStaleStateLock(lock,id,confirm);console.log(JSON.stringify({status:'stale-lock-removed',manifestId:id,stagesRetained:true}));return;
  }
  if(!noPublish)throw Error('Run requires explicit --no-publish');
  let lease;
  try{
    lease=acquireStateLock(lock,{manifestId:id});
    run.controller={pid:process.pid,parentPid:process.ppid,terminal:{stdin:!!process.stdin.isTTY,stdout:!!process.stdout.isTTY,stderr:!!process.stderr.isTTY},status:'starting',startedAt:new Date().toISOString()};save(path,run);
    const result=await runReleaseWorkflow(manifest,run.state,{
      now:()=>new Date().toISOString(),save:async state=>{run.state=state;save(path,run);},
      verifyInputs:async()=>{if(git(['rev-parse','HEAD'])!==manifest.source.revision)throw Error('Frozen source revision changed');if(manifest.profile!=='diagnostic'&&git(['status','--porcelain']))throw Error('Formal source became dirty');for(const [p,h] of Object.entries(manifest.source.files))if(sha(readFileSync(resolve(root,p)))!==h)throw Error('Frozen workflow input changed: '+p);},
      host:async()=>manifest.profile==='diagnostic'?{platform:process.platform}:process.platform==='win32'?windowsWorkflowHost():{platform:process.platform,blockers:[]},
      verifyCompleted:async(step,old)=>{
        for(const key of ['stdout','stderr']){if(!Number.isSafeInteger(old.attempt)||old[key]?.file!==`${step.id}.${old.attempt}.${key}.log`)throw Error('Invalid completed stage log path');if(sha(readFileSync(resolve(dirname(path),old[key].file)))!==old[key].sha256)throw Error('Completed stage log changed: '+step.id);}
        if(step.id==='rehearsal'||step.id==='rehearsal-audit'){
          // Recheck the actual archived reports, package bytes and checksums, not just an old green log.
          const audit=execFileSync(process.execPath,['scripts/release-rehearsal-policy.mjs','--bundle','artifacts/release/rehearsal'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:1048576});
          run.bundleRevalidation={status:'passed',verifiedAt:new Date().toISOString(),validatorOutputSha256:sha(Buffer.from(audit))};save(path,run);
        }
      },
      execute:async(step,attempt)=>{
        const stdout=resolve(dirname(path),`${step.id}.${attempt}.stdout.log`),stderr=resolve(dirname(path),`${step.id}.${attempt}.stderr.log`);
        const out=openSync(stdout,'wx'),err=openSync(stderr,'wx'),env={...process.env};
        for(const key of ['NODE_AUTH_TOKEN','NPM_TOKEN','GH_TOKEN','GITHUB_TOKEN','COSIGN_PRIVATE_KEY','SIGNING_KEY'])delete env[key];
        console.log('START '+step.id+'; logs: '+stdout);
        let outcome;
        try{outcome=await new Promise((ok,fail)=>{const child=spawn(step.kind==='npm'?npmCommand():process.execPath,step.kind==='npm'?npmArgs(step.args):step.args,{cwd:root,env,windowsHide:true,stdio:['ignore',out,err]});child.once('error',fail);child.once('close',(code,signal)=>ok({exitCode:code??1,signal}));});}
        finally{closeSync(out);closeSync(err);}
        console.log('END '+step.id+'; exit: '+outcome.exitCode);
        return {...outcome,stdout:{file:stdout.split(/[/\\]/).at(-1),sha256:sha(readFileSync(stdout))},stderr:{file:stderr.split(/[/\\]/).at(-1),sha256:sha(readFileSync(stderr))}};
      },
    },{retryStage});
    run.controller={...run.controller,status:result.status,exitCode:result.status==='passed'?0:2,finishedAt:new Date().toISOString()};save(path,run);
    console.log(JSON.stringify({status:result.status,currentStage:result.currentStage,preflight:result.preflight,run:path,published:false,baselinePromoted:false}));if(result.status!=='passed')process.exitCode=2;
  }catch(error){if(lease){run.controller={...run.controller,status:'failed',exitCode:1,error:storedPublicationLog(error.message),finishedAt:new Date().toISOString()};save(path,run);}throw error;}finally{lease?.release();}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))main().catch(error=>{console.error(storedPublicationLog(error.stack??error.message));process.exitCode=1;}).finally(async()=>{
  if(process.argv.includes('--keep-terminal')){
    console.log('No-publication controller exit code: '+(process.exitCode??0));
    const terminal=createInterface({input:process.stdin,output:process.stdout});
    try{await terminal.question('Press Enter to close this independent terminal. State and logs are retained. ');}finally{terminal.close();}
  }
});
