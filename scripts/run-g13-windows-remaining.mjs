import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync,openSync,closeSync,realpathSync,statfsSync} from 'node:fs';
import {resolve,relative,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {hostname,cpus,release} from 'node:os';
import {G13_STAGE9_REUSE} from './g13-stage9-reuse-policy.mjs';
import {G13_REUSED_KINDS,windowsRemainingPlan,validateWindowsRemainingConfig,validateWindowsRemainingReuse,windowsRemainingOutput,assertWindowsRemainingOutput} from './g13-windows-remaining-policy.mjs';
import {validateWindowsRenderReport,validateWindowsG05BudgetSummary} from './g13-windows-final-policy.mjs';
import {validateEngine021RevisionReuse} from './engine-021-evidence-policy.mjs';
import {g13WindowsCandidatePlan,auditG13ProductionGpu} from './g13-production-candidate-policy.mjs';
import {deferredRuntimeFingerprint} from './webgpu-gate/deferred-fixture-policy.mjs';
import {lightingContinuousEvidenceInputs,studyEvidenceInputs} from './webgpu-gate/framegraph-evidence-inputs.mjs';
import {auditG05ContinuousReport} from './webgpu-gate/deferred-g05-continuous-artifact.mjs';
import {auditFrameGraphStudy} from './webgpu-gate/framegraph-study-artifact.mjs';
import {buildDeferredFixture} from './webgpu-gate/deferred-fixture-builder.mjs';
import {ensureFrozenHyaFoundationLayout} from './hya-foundation-layout.mjs';
import {changedSourceInputs} from './hya-corpus/source-snapshot.mjs';
import {assessProductionCapture} from './hya-corpus/production-cohort-policy.mjs';
import {verifyServedBytes} from './hya-corpus/packed-browser.mjs';
import {validatePhysicalEvidence} from './hya-corpus/physical-policy.mjs';
import {RESULT_PATH,readCorpusManifest,syncCorpus} from './hya-corpus/corpus.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2),configFile='config/g13-windows-remaining.json';
const sha=b=>createHash('sha256').update(b).digest('hex'),json=p=>JSON.parse(readFileSync(p)),save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const git=(cwd,a)=>execFileSync('git',['-c','safe.directory='+cwd.replaceAll('\\','/'),...a],{cwd,encoding:'utf8',windowsHide:true}).trim();
const clean=(cwd,revision)=>{assert.equal(git(cwd,['rev-parse','HEAD']),revision);assert.equal(git(cwd,['status','--porcelain']),'','Frozen source must remain clean');};
const contained=(base,path)=>{const file=realpathSync(resolve(base,path)),local=relative(realpathSync(base),file);assert.ok(local&&!isAbsolute(local)&&!local.startsWith('..'),'Evidence path escapes owner');return file;};
const load=(base,b)=>{const file=contained(base,b.file??b.path),bytes=readFileSync(file);assert.equal(sha(bytes),b.sha256,'Changed evidence '+file);return JSON.parse(bytes);};
const digest=p=>({file:relative(root,p).replaceAll('\\','/'),sha256:sha(readFileSync(p))});
const free=()=>{const s=statfsSync(root);assert.ok(Number(s.bavail)*Number(s.bsize)>=8*1024**3,'At least 8 GiB free space required; no files were removed');};
const config=validateWindowsRemainingConfig(json(resolve(root,configFile))),checkout=resolve(root,config.checkout),plan=windowsRemainingPlan();
assert.equal(realpathSync(checkout),checkout,'Checkout must not be a link');
if(args.length===1&&args[0]==='--plan'){console.log(JSON.stringify({...plan,config:digest(resolve(root,configFile)),checkout},null,2));process.exit(0);}
if(args.length!==1||!['--prepare','--verify','--run','--verify-reuse-only'].includes(args[0]))throw Error('Use --plan, --prepare, --verify, --run or --verify-reuse-only');
if(process.platform!=='win32')throw Error('Registered Windows runner required');
const env={...process.env};for(const key of ['NODE_AUTH_TOKEN','NPM_TOKEN','GH_TOKEN','GITHUB_TOKEN','COSIGN_PRIVATE_KEY','SIGNING_KEY','NPM_CONFIG_TOKEN','NPM_CONFIG__AUTH','NPM_CONFIG__AUTHTOKEN'])delete env[key];
function execute(out,id,cwd,command,argv,timeout=7200000){
  free();const stdout=openSync(resolve(out,id+'.stdout.log'),'wx'),stderr=openSync(resolve(out,id+'.stderr.log'),'wx'),startedAt=new Date().toISOString();let r;
  console.log('START '+id+'; '+resolve(out,id+'.stdout.log'));
  try{r=spawnSync(command,argv,{cwd,env,stdio:['ignore',stdout,stderr],windowsHide:true,timeout});}finally{closeSync(stdout);closeSync(stderr);}
  const step={id,command,args:argv,startedAt,finishedAt:new Date().toISOString(),exitCode:r.status,error:r.error?.message};save(resolve(out,id+'.json'),step);console.log('END '+id+'; exit '+r.status);if(r.error)throw r.error;return step;
}
function required(...a){const step=execute(...a);assert.equal(step.exitCode,0,step.id+' failed; original log retained');return step;}
function revisionReuse(revision){const changes=git(root,['diff','--no-renames','--name-only',config.captureRevision,revision]).split('\n').filter(Boolean);const stage9FixFiles=Object.fromEntries(Object.keys(G13_STAGE9_REUSE.files).map(p=>[p,sha(readFileSync(resolve(root,p)))]));for(const kind of G13_REUSED_KINDS)validateEngine021RevisionReuse(config.captureRevision,{revision,targetVersion:'0.2.2',stage9FixFiles,reuseChanges:{[config.captureRevision]:changes}},kind,config.reports[kind]);return changes;}

async function verifyReuse(revision){
  console.log('Verifying original renderer/source/package hashes. No sampling has started.');
  clean(root,revision);clean(checkout,revision);free();const candidate=g13WindowsCandidatePlan(root,Date.now()+'-1234abcd');
  assert.equal((await deferredRuntimeFingerprint(root)).sha256,candidate.runtimeFingerprintSha256);assert.equal((await deferredRuntimeFingerprint(checkout)).sha256,candidate.isolatedRuntimeFingerprintSha256);
  const run=load(root,config.sourceRun);assert.equal(run.checkout,checkout);const reports=Object.fromEntries(G13_REUSED_KINDS.map(k=>[k,load(checkout,config.reports[k])])),support=Object.fromEntries(Object.entries(config.support).map(([k,b])=>[k,load(root,b)]));
  const oldHost=reports.rooms.hostBefore;assert.equal(hostname(),oldHost.hostname);assert.equal(cpus()[0].model,oldHost.cpu);assert.equal(release(),oldHost.os);
  const hardware=JSON.parse(execFileSync(resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; $env:PSModulePath=Join-Path $PSHOME 'Modules'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding; [pscustomobject]@{gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion);power=(powercfg /getactivescheme | Out-String)} | ConvertTo-Json -Depth 5 -Compress"],{encoding:'utf8',windowsHide:true}));assert.deepEqual(hardware,oldHost.hardware,'GPU/driver/power differs from reused measurements');
  const prerequisites=validateWindowsRemainingReuse(config,run,reports,support),rawBindings=[];
  const reader=kind=>name=>{const base=dirname(resolve(checkout,config.reports[kind].file)),file=contained(base,name),bytes=readFileSync(file);rawBindings.push({kind,file:relative(checkout,file).replaceAll('\\','/'),sha256:sha(bytes)});return Promise.resolve(bytes);};
  assert.deepEqual(await studyEvidenceInputs(checkout,'resources'),reports.resources.inputs);
  assert.deepEqual(await lightingContinuousEvidenceInputs(checkout,reports.rooms.config),reports.rooms.inputs);
  const resources=await auditFrameGraphStudy(reports.resources,reader('resources'));assert.equal(resources.status,'passed');
  const budget=readFileSync(resolve(checkout,reports.rooms.config.frozenBudget.path));assert.equal(sha(budget),reports.rooms.config.frozenBudget.sha256);
  const rooms=await auditG05ContinuousReport(reports.rooms,reader('rooms'),budget);assert.deepEqual(rooms,reports.rooms.assessment);validateWindowsG05BudgetSummary({id:'rooms'},{status:reports.rooms.status,assessment:rooms});
  const correctness=reports.correctness;assert.deepEqual(correctness.inputs,await deferredRuntimeFingerprint(checkout));
  const expected=git(checkout,['ls-files','--cached','--others','--exclude-standard','-z','--','scripts/webgpu-gate','scripts/benchmark','scripts/verify-framegraph-acceptance.mjs','config/release-matrix.json','config/framegraph-acceptance-021.json']).split('\0').filter(Boolean).sort();assert.deepEqual(correctness.harness.map(f=>f.path),expected);
  for(const f of [...correctness.harness,...correctness.auxiliaryDist.files])assert.equal(sha(readFileSync(contained(checkout,f.path))),f.sha256);
  for(const entry of correctness.entries){const b=entry.raw,bytes=await reader('correctness')(b.file);assert.equal(sha(bytes),b.sha256);}
  for(const [prefix,build]of [['artifacts/engine-0.2.1/g09',correctness.build],['artifacts/engine-0.2.1/g09/a0-built',correctness.baseline]])for(const f of build.outputs)assert.equal(sha(readFileSync(contained(resolve(checkout,prefix),f.file))),f.sha256);
  console.log('Verifying HYA GPU 5%, served bytes, corpus, layout and real input receipts.');
  const snapshots=[support.layout.sourceInputs,support.layout.harnessInputs,support.corpus.sourceInputs];for(const snapshot of snapshots){assert.equal(sha(JSON.stringify(snapshot.inputs)),snapshot.sha256);assert.deepEqual(changedSourceInputs(root,snapshot),[]);}
  const hya=support.hyaByteAudit,production=load(root,hya.productionReport);assert.equal(production.status,'passed');assert.equal(production.diagnostic,false);assert.deepEqual(changedSourceInputs(root,production.inputs),[]);assert.equal(production.packageReport.sha256,candidate.packageReport.sha256);
  const rawCaptures=[],productionBudget=json(resolve(root,'config/framegraph-production-021.json'));
  for(const [i,b]of hya.productionCaptures.entries()){
    const raw=load(root,b),directory=dirname(resolve(root,b.path));assert.deepEqual(raw.job,production.plan[i]);assert.equal(assessProductionCapture(raw,production.plan[i],productionBudget).failed,false);
    const served=verifyServedBytes(root,[{prefix:'/g12-packed',directory:resolve(directory,'packages')},{prefix:'/g12-case',directory},{prefix:'/g12-production',directory:dirname(resolve(root,hya.productionReport.path))},{prefix:'/g12-font',directory:resolve(root,'examples/hya-production')}],raw);assert.equal(served.status,'passed');
    for(const t of raw.tarballs)assert.equal(sha(readFileSync(t.source)),t.sha256);rawCaptures.push(raw);
  }
  const gpu=auditG13ProductionGpu(production,rawCaptures,json(resolve(root,'config/lighting-performance-021.json')).sampling);assert.equal(gpu.length,4);
  for(const b of hya.rounds){const raw=load(root,b);assert.equal(raw.status,'passed');assert.equal(raw.samples.length,23);const corpusDir=dirname(resolve(root,hya.corpusReport.path)),directory=dirname(resolve(root,b.path));assert.equal(verifyServedBytes(root,[{prefix:'/g12-packed',directory:resolve(corpusDir,'packages')},{prefix:'/g12-corpus',directory:corpusDir},{prefix:'/animation-spec/corpus/.cache',directory}],raw.browser).status,'passed');}
  load(root,hya.corpusReport);assert.equal(sha(readFileSync(RESULT_PATH)),hya.latest.sha256);assert.deepEqual(await syncCorpus(readCorpusManifest(),{offline:true}),{files:64,downloaded:0,reused:64});
  for(const assessment of [support.ime,support.gamepad]){const raw=load(root,assessment.raw);load(root,assessment.launcher);assert.deepEqual(validatePhysicalEvidence(raw,assessment.confirmation),[]);assert.equal(raw.packageReport.sha256,candidate.packageReport.sha256);for(const t of raw.tarballs)assert.equal(sha(readFileSync(t.source)),t.sha256);}
  clean(root,revision);clean(checkout,revision);
  return {status:'passed-immutable-reuse-checks',revision,captureRevision:config.captureRevision,sourceChanges:revisionReuse(revision),host:{hostname:hostname(),cpu:cpus()[0].model,os:release(),hardware},prerequisites,rendererCaptures:384,rawBindings,hyaProductionCaptures:30,hyaGpu:gpu.map(g=>({workload:g.workload,status:g.status,regression:g.regression})),layoutCohorts:27,corpusRounds:3,corpusDenominator:23,offlineAssets:64,physicalInputPackageBytesUnchanged:true,originalFilesModified:false,fullG13Complete:false};
}

if(args[0]==='--verify-reuse-only'){const verified=await verifyReuse(git(root,['rev-parse','HEAD']));console.log(JSON.stringify(verified));process.exit(0);}
const pointerPath=resolve(root,'artifacts/engine-0.2.2/g13/windows-remaining-prepared.json');
if(args[0]==='--prepare'){
  const revision=git(root,['rev-parse','HEAD']);clean(root,revision);assert.equal(git(checkout,['status','--porcelain']),'');revisionReuse(revision);free();
  const output=windowsRemainingOutput(root,Date.now()+'-'+randomBytes(4).toString('hex'));mkdirSync(output);const prep={schemaVersion:1,status:'preparing',revision,checkout,output,config:digest(resolve(root,configFile)),plan,startedAt:new Date().toISOString()};save(resolve(output,'registration.json'),prep);
  try{
    git(checkout,['fetch','--quiet',root,revision]);git(checkout,['checkout','--quiet','--detach',revision]);ensureFrozenHyaFoundationLayout(checkout);
    const verified=await verifyReuse(revision);save(resolve(output,'reuse-preflight.json'),verified);
    for(const [id,kind,entry]of [['common','rooms','deferred-reference-runtime.mjs'],['resources','resources','framegraph-resource-study-fixture.mjs']]){console.log('Rebuilding '+id+' for reuse byte check.');const built=await buildDeferredFixture({sourceRoot:checkout,outputDirectory:resolve(output,'rebuilt-'+id),entry:resolve(checkout,'scripts/webgpu-gate',entry)});assert.deepEqual(built,load(checkout,config.reports[kind]).build);}
    assert.equal(existsSync(resolve(checkout,'artifacts/engine-0.2.2/qualification.json')),false,'Existing qualification manifest must be retained; prepare a distinct run explicitly');
    clean(root,revision);clean(checkout,revision);prep.status='prepared';prep.finishedAt=new Date().toISOString();prep.reusePreflight=digest(resolve(output,'reuse-preflight.json'));save(resolve(output,'preparation.json'),prep);const pointer={output,preparationSha256:sha(readFileSync(resolve(output,'preparation.json'))),revision};save(pointerPath,pointer);
    console.log(JSON.stringify({status:'prepared',output,revision,captures:196,reusedRendererCaptures:384,formalSamplingStarted:false,entry:'scripts/start-g13-windows-remaining.cmd'}));
  }catch(error){save(resolve(output,'preparation-failure.json'),{status:'failed',error:String(error.stack??error)});throw error;}
}else{
  const pointer=json(pointerPath),output=assertWindowsRemainingOutput(root,pointer.output);assert.equal(realpathSync(output),output);const prepFile=resolve(output,'preparation.json');assert.equal(sha(readFileSync(prepFile)),pointer.preparationSha256);const prep=json(prepFile);assert.equal(prep.status,'prepared');assert.equal(prep.checkout,checkout);assert.deepEqual(prep.config,digest(resolve(root,configFile)));clean(root,prep.revision);clean(checkout,prep.revision);
  assert.equal(existsSync(resolve(output,'result.json')),false,'This run already has a result; no automatic retry');
  const verification=await verifyReuse(prep.revision);
  if(args[0]==='--verify'){console.log(JSON.stringify({status:verification.status,output,captures:196,formalSamplingStarted:false}));process.exit(0);}
  execFileSync(resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; . (Join-Path $env:G13_SOURCE_ROOT 'scripts/webgpu-gate/framegraph-background-policy.ps1'); Assert-G09GpuDiagnosticReady"],{env:{...env,G13_SOURCE_ROOT:root},stdio:'inherit',windowsHide:true});
  save(resolve(output,'reuse-at-start.json'),verification);
  const record={schemaVersion:1,status:'running',revision:prep.revision,checkout,startedAt:new Date().toISOString(),reports:{...config.reports},steps:[],reusedRendererCaptures:384,newRendererCaptures:196,macQualified:false,iPhoneQualified:false,externalPublishPerformed:false,baselinePromoted:false},resultPath=resolve(output,'result.json'),persist=()=>writeFileSync(resultPath,JSON.stringify(record,null,2)+'\n');persist();
  try{
    for(const job of plan.jobs){
      clean(root,prep.revision);clean(checkout,prep.revision);const parent=resolve(checkout,job.parent);mkdirSync(parent,{recursive:true});const before=new Set(readdirSync(parent));const step=execute(output,'capture-'+job.id,checkout,process.execPath,job.args);record.steps.push(step);
      const created=readdirSync(parent).filter(n=>!before.has(n)&&n.startsWith(job.prefix));assert.equal(created.length,1,'One fresh '+job.id+' population required');const file=resolve(parent,created[0],'report.json'),report=json(file);validateWindowsRenderReport(job,report,prep.revision);if(!['instances','forward'].includes(job.id))assert.equal(step.exitCode,0);
      record.reports[job.id]={file:relative(checkout,file).replaceAll('\\','/'),sha256:sha(readFileSync(file)),captureRevision:prep.revision};persist();if(['instances','forward'].includes(job.id))validateWindowsG05BudgetSummary(job,report);
    }
    const manifest={schemaVersion:2,contractId:'engine-021-evidence-v2',targetVersion:'0.2.2',revision:prep.revision,reports:record.reports},manifestPath=resolve(checkout,'artifacts/engine-0.2.2/qualification.json');mkdirSync(dirname(manifestPath),{recursive:true});save(manifestPath,manifest);
    record.steps.push(required(output,'seven-report-audit',checkout,process.execPath,['scripts/check-engine-021-evidence.mjs','--manifest=artifacts/engine-0.2.2/qualification.json'],1800000));persist();
    record.steps.push(required(output,'bootstrap-diagnostic',checkout,process.execPath,['scripts/verify-webgpu-lighting-scaling-fixture.mjs','--evidence=diagnostic','--lights=128','--overlap=high','--dynamic=1','--views=4','--resolution=720p','--warmup=4','--samples=8','--gpu-samples=2'],600000));persist();
    record.steps.push(required(output,'global-gate',checkout,process.execPath,['scripts/release-gate.mjs','--global'],14400000));persist();
    record.steps.push(required(output,'rehearsal',checkout,process.execPath,['scripts/release-rehearsal.mjs','--worker']));persist();
    record.steps.push(required(output,'rehearsal-audit',checkout,process.execPath,['scripts/release-rehearsal-policy.mjs','--bundle','artifacts/release/rehearsal'],300000));persist();
    const candidate=g13WindowsCandidatePlan(root,Date.now()+'-1234abcd'),packed=json(resolve(checkout,'artifacts/release/public-packages.json')),pinned=load(root,candidate.packageReport);assert.equal(packed.gate.status,'passed');const hashes=r=>r.packages.map(({name,sha256})=>({name,sha256})).sort((a,b)=>a.name.localeCompare(b.name));assert.deepEqual(hashes(packed),hashes(pinned));for(const p of packed.packages)assert.equal(sha(readFileSync(resolve(checkout,p.artifact))),p.sha256);
    clean(root,prep.revision);clean(checkout,prep.revision);await verifyReuse(prep.revision);record.status='passed-windows-global-and-rehearsal';
  }catch(error){record.status='failed';record.error=String(error.stack??error);process.exitCode=1;}
  finally{record.finishedAt=new Date().toISOString();persist();console.log('FINAL STATUS: '+record.status);if(record.error)console.error(record.error);console.log('EVIDENCE: '+output);console.log('Original failures retained. Apple qualification pending. No version published or baseline promoted.');}
}
