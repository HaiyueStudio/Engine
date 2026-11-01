import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cpus,hostname,release} from 'node:os';
import {runChromeWebGpuFixture} from './webgpu-gate/chrome-runner.mjs';
import {frameGraphBrowserPath} from './webgpu-gate/framegraph-qualification.mjs';
import {requireFrameGraphPresentation,readFrameGraphPresentation} from './webgpu-gate/framegraph-presentation.mjs';
import {verifyServedBytes} from './hya-corpus/packed-browser.mjs';
import {windowsWorkflowHost} from './release-workflow.mjs';
import {GAMEPLAY_PRODUCTION_PROTOCOL as protocolId,GAMEPLAY_PRODUCTION_PROFILE as profile,GAMEPLAY_PRODUCTION_INPUTS,gameplayProductionPlan,assertGameplayProductionContract,validateGameplayProductionCapture,validateGameplayPresentationImage,validateGameplayProductionMatrix} from './gameplay-023-production-policy.mjs';

const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2),mode=args.shift(),sha=b=>createHash('sha256').update(b).digest('hex'),json=p=>JSON.parse(readFileSync(p));
const contractPath='config/gameplay-023-contract.json',contract=json(resolve(root,contractPath));assertGameplayProductionContract(contract);
const take=key=>{const at=args.indexOf(key);if(at<0)return;assert(args[at+1]&&!args[at+1].startsWith('--'));return args.splice(at,2)[1];};
const candidatePath=take('--candidate'),output=take('--output'),jobValue=take('--job'),reportPath=take('--report');assert(!args.length&&['--plan','--smoke','--run','--audit'].includes(mode),'Use --plan | --smoke --candidate FILE --output NEW_CHILD [--job 0..23] | --run --candidate FILE --output NEW_CHILD | --audit --report FILE');
const plan=gameplayProductionPlan();if(mode==='--plan'){assert(!candidatePath&&!output&&!jobValue&&!reportPath);console.log(JSON.stringify({protocolId,profile,captures:plan.length,plan,hardBudgetsUnchanged:true,formalBaselineUpdated:false},null,2));process.exit(0);}
if(mode==='--audit'){
 assert(reportPath&&!candidatePath&&!output&&!jobValue);const {dirname}=await import('node:path'),{loadCandidateInputs}=await import('../artifacts/engine-0.2.3/g11/candidate-inputs.mjs'),report=json(resolve(root,reportPath)),base=dirname(resolve(root,reportPath)),loaded=loadCandidateInputs(root,resolve(root,report.candidate.path));assert.equal(loaded.candidateSha256,report.candidate.sha256);assert.equal(loaded.contentManifest.sha256,report.candidate.contentManifest.sha256);
 assert.deepEqual(Object.keys(report.inputs).sort(),[...GAMEPLAY_PRODUCTION_INPUTS].sort());for(const[p,h]of Object.entries(report.inputs))assert.equal(sha(readFileSync(resolve(root,p))),h,'Frozen collector changed: '+p);
 const raws=report.entries.map((e,i)=>{const prefix=String(i).padStart(2,'0');for(const[key,name]of [['raw','raw.json'],['live','frames.jsonl'],['screenshot','frame.png']]){assert.equal(e[key]?.file??e[key]?.path,prefix+'/'+name);assert.equal(sha(readFileSync(resolve(base,prefix,name))),e[key].sha256,key+' bytes changed');}
  const raw=json(resolve(base,prefix,'raw.json'));assert.deepEqual(verifyServedBytes(root,loaded.candidate.mounts,raw,{requiredPackages:[]}),e.servedBytes);assert.equal(e.servedBytes.status,'passed');assert.deepEqual(validateGameplayPresentationImage(readFileSync(resolve(base,prefix,'frame.png'))),e.screenshotPresence);assert.equal(e.screenshotPresence.status,'passed');
  const retained={startup:[],warmup:[],samples:[]};for(const line of readFileSync(resolve(base,prefix,'frames.jsonl'),'utf8').trim().split('\n').filter(Boolean)){const delta=JSON.parse(line);for(const key of Object.keys(retained)){retained[key].push(...delta[key]);assert.equal(delta.counts[key],retained[key].length);}}for(const[key,frames]of Object.entries(retained))assert.deepEqual(frames,raw[key].slice(0,frames.length),'Incremental crash evidence differs from complete raw frames');return raw;
 });const result=validateGameplayProductionMatrix(report,raws);console.log(JSON.stringify(result,null,2));if(result.errors.length)process.exitCode=1;process.exit(process.exitCode??0);
}
assert(!reportPath);
assert(process.platform==='win32','This frozen production matrix selects the registered Windows route');assert(candidatePath&&output);const smoke=mode==='--smoke',index=jobValue===undefined?0:Number(jobValue);assert(Number.isInteger(index)&&index>=0&&index<plan.length);assert(smoke||jobValue===undefined);
const out=resolve(root,output),local=relative(resolve(root,'artifacts/engine-0.2.3/g11'),out);assert(local&&!isAbsolute(local)&&/^[a-z0-9-]+$/.test(local),'Use a fresh G11 child directory');mkdirSync(out);
const git=argv=>execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),...argv],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),source={revision:git(['rev-parse','HEAD']),dirty:!!git(['status','--porcelain'])};
const record={schemaVersion:1,protocolId,status:'preflight',tier:smoke?'smoke':'formal-production',source,profile,plan:smoke?[plan[index]]:plan,entries:[],startedAt:new Date().toISOString(),releaseQualified:false,published:false,formalBaselineUpdated:false};
const save=()=>writeFileSync(out+'/report.json',JSON.stringify(record,null,2)+'\n');save();
const clean=()=>{assert.equal(git(['rev-parse','HEAD']),source.revision);if(!smoke)assert.equal(git(['status','--porcelain']),'','Formal source changed');};
try{
 const {loadCandidateInputs}=await import('../artifacts/engine-0.2.3/g11/candidate-inputs.mjs');
 if(!smoke){assert.equal(source.dirty,false,'Prepare a clean isolated candidate before formal capture');const host=windowsWorkflowHost(root);assert(host.administrator,'Administrator was not confirmed; no capture started');assert.equal(host.blockers.length,0,'Background applications remain; no capture started');}
 const loaded=loadCandidateInputs(root,resolve(root,candidatePath));record.candidate={path:candidatePath,sha256:loaded.candidateSha256,contentManifest:loaded.contentManifest};
 record.inputs=Object.fromEntries(GAMEPLAY_PRODUCTION_INPUTS.map(p=>[p,sha(readFileSync(resolve(root,p)))]));
 const host=()=>{const shell=resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),script="$ErrorActionPreference='Stop'; $env:PSModulePath=Join-Path $PSHOME 'Modules'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding; [pscustomobject]@{gpu=@(Get-CimInstance Win32_VideoController|Select-Object Name,DriverVersion,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate);power=(powercfg /getactivescheme|Out-String)}|ConvertTo-Json -Depth 5 -Compress";return{hostname:hostname(),cpu:cpus()[0].model,os:release(),node:process.version,hardware:JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}))};};
 record.hostBefore=host();const expected=json(resolve(root,'config/framegraph-production-021.json')).device;if(!smoke){assert(record.hostBefore.cpu.includes(expected.cpu.split(' ').at(-1)));assert(record.hostBefore.hardware.gpu.some(g=>g.Name===expected.gpu&&g.CurrentRefreshRate===expected.refreshHz),'Registered GPU/display profile required');}
 record.status='running';save();process.env.WEBGPU_REQUIRE_NATIVE='1';
 for(const [n,spec]of record.plan.entries()){
  clean();for(const[p,h]of Object.entries(record.inputs))assert.equal(sha(readFileSync(resolve(root,p))),h,p);const check=loadCandidateInputs(root,resolve(root,candidatePath));assert.equal(check.contentManifest.sha256,loaded.contentManifest.sha256);assert.equal(check.candidateSha256,loaded.candidateSha256);
  const directory=out+'/'+String(n).padStart(2,'0');mkdirSync(directory);const entry={spec,status:'running',startedAt:new Date().toISOString()};record.entries.push(entry);save();const fixture=directory+'/fixture.html';
  writeFileSync(fixture,'<!doctype html><meta charset="utf-8"><style>body{margin:0}canvas{width:1280px;height:720px;display:block}#progress{height:28px}#result{display:none}</style><p id="progress">Preparing G11 production</p><canvas width="1280" height="720" tabindex="0"></canvas><pre id="result"></pre><script type="importmap">'+JSON.stringify({imports:loaded.candidate.imports})+'</script><script type="module" src="/scripts/webgpu-gate/gameplay-023-production-fixture.mjs"></script>',{flag:'wx'});
  let raw,screenshot,screenshotPresence;const live=directory+'/frames.jsonl';writeFileSync(live,'',{flag:'wx'});
  try{raw=await runChromeWebGpuFixture({root,fixture:relative(root,fixture).replaceAll('\\','/'),browserPath:frameGraphBrowserPath(spec.browserId),mounts:loaded.candidate.mounts,timeoutMs:180000,presentation:smoke?null:{mode:'visible',width:1320,height:960},chunkedResult:true,acceptedStatuses:['captured','failed'],interact:async cdp=>{
   const evaluate=async expression=>{const response=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(response.result?.exceptionDetails)throw Error(JSON.stringify(response.result.exceptionDetails));return response.result?.result?.value;};
   await cdp.call('Emulation.setDeviceMetricsOverride',{width:1320,height:900,deviceScaleFactor:1,mobile:false});const initializationDeadline=Date.now()+15000;
   while(!await evaluate('window.__g11Production?.ready===true')){assert(Date.now()<initializationDeadline,'Production module did not initialize within 15 seconds');await new Promise(r=>setTimeout(r,100));}
   const deadline=Date.now()+150000;
   if(!smoke)await requireFrameGraphPresentation(cdp);await evaluate('void window.__g11Production.start('+JSON.stringify(spec)+','+smoke+','+JSON.stringify({profile,protocolId})+')');const cursor={startup:0,warmup:0,samples:0};let invisible=0;
   while(!await evaluate('window.__g11Production.done')){
    if(await evaluate('window.__g11Production.readyToFinalize')){
     try{const rect=await evaluate('document.querySelector("canvas").getBoundingClientRect().toJSON()'),png=await cdp.call('Page.captureScreenshot',{format:'png',clip:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,scale:1}});const bytes=Buffer.from(png.result.data,'base64');writeFileSync(directory+'/frame.png',bytes,{flag:'wx'});screenshot={file:String(n).padStart(2,'0')+'/frame.png',sha256:sha(bytes)};screenshotPresence=validateGameplayPresentationImage(bytes);}finally{await evaluate('window.__g11Production.finalize()');}continue;
    }
    const delta=await evaluate('window.__g11Production.delta('+JSON.stringify(cursor)+')');if(delta){appendFileSync(live,JSON.stringify(delta)+'\n');Object.assign(cursor,delta.counts);}
    if(!smoke){const state=await readFrameGraphPresentation(cdp);invisible=state?.visible==='visible'&&state.focused===true?0:invisible+1;if(invisible>=3)await evaluate('window.__g11Production.abort("Presentation eligibility lost; all frames retained.")');}
    if(Date.now()>deadline)await evaluate('window.__g11Production.abort("Capture deadline exceeded; original population retained.")');await new Promise(r=>setTimeout(r,500));
   }
  }});}catch(error){raw={schemaVersion:1,status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
  const rawBytes=Buffer.from(JSON.stringify(raw,null,2)+'\n');writeFileSync(directory+'/raw.json',rawBytes,{flag:'wx'});const assessment=validateGameplayProductionCapture(raw,spec,{smoke}),servedBytes=verifyServedBytes(root,loaded.candidate.mounts,raw,{requiredPackages:[]});
  Object.assign(entry,{status:assessment.status==='failed'||servedBytes.status!=='passed'||screenshotPresence?.status!=='passed'?'failed':smoke?'smoke-complete':'passed',finishedAt:new Date().toISOString(),raw:{file:String(n).padStart(2,'0')+'/raw.json',sha256:sha(rawBytes)},live:{file:String(n).padStart(2,'0')+'/frames.jsonl',sha256:sha(readFileSync(live))},assessment,servedBytes,screenshot,screenshotPresence});save();console.log(JSON.stringify({capture:n+1,total:record.plan.length,spec,status:entry.status,errors:assessment.errors}));if(entry.status==='failed')throw Error('Original capture failed; no retry or budget change.');
 }
 record.hostAfter=host();assert.deepEqual(record.hostAfter,record.hostBefore,'Host/power state changed');clean();const after=loadCandidateInputs(root,resolve(root,candidatePath));assert.equal(after.candidateSha256,loaded.candidateSha256);assert.equal(after.contentManifest.sha256,loaded.contentManifest.sha256);for(const[p,h]of Object.entries(record.inputs))assert.equal(sha(readFileSync(resolve(root,p))),h,p);
 record.status=smoke?'smoke-complete':'passed-production-prerequisite';
}catch(error){record.status=record.entries.length?'failed':'not-started';record.error=String(error.stack??error);process.exitCode=1;}
finally{record.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:record.status,output:out,published:false,formalBaselineUpdated:false}));}
