import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,existsSync,realpathSync,statfsSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {G13_STAGE9_REUSE,validateG13GateSource,validateG13Stage9Files} from './g13-stage9-reuse-policy.mjs';
import {g13WindowsCandidatePlan} from './g13-production-candidate-policy.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2);
const sha=b=>createHash('sha256').update(b).digest('hex'),json=p=>JSON.parse(readFileSync(p));
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const git=(cwd,a)=>execFileSync('git',['-c','safe.directory='+cwd.replaceAll('\\','/'),...a],{cwd,encoding:'utf8',windowsHide:true}).trim();
const clean=(cwd,revision)=>{assert.equal(git(cwd,['rev-parse','HEAD']),revision);assert.equal(git(cwd,['status','--porcelain']),'','Candidate must remain clean');};
const plan={targetVersion:'0.2.2',decision:G13_STAGE9_REUSE.decision,reusedRendererCaptures:580,newRendererCaptures:0,following:['all original HYA/layout/corpus/physical/package hash checks','seven-report raw audit and four fresh runtime builds','complete global gate','no-publication rehearsal','independent rehearsal and four-tarball audit'],automaticRetry:false,externalPublishPerformed:false,baselinePromoted:false,macQualified:false,iPhoneQualified:false};
if(args.length===1&&args[0]==='--plan'){console.log(JSON.stringify(plan,null,2));process.exit(0);}
if(args.length!==1||!['--prepare','--verify','--run'].includes(args[0]))throw Error('Use --plan, --prepare, --verify or --run');
assert.equal(process.platform,'win32');
const env={...process.env};for(const key of ['NODE_AUTH_TOKEN','NPM_TOKEN','GH_TOKEN','GITHUB_TOKEN','COSIGN_PRIVATE_KEY','SIGNING_KEY','NPM_CONFIG_TOKEN','NPM_CONFIG__AUTH','NPM_CONFIG__AUTHTOKEN'])delete env[key];
const free=()=>{const s=statfsSync(root);assert.ok(Number(s.bavail)*Number(s.bsize)>=8*1024**3,'At least 8 GiB free required; no files were removed');};
const failedFile=resolve(root,G13_STAGE9_REUSE.sourceRun,'result.json');
const originalBytes=readFileSync(failedFile);assert.equal(sha(originalBytes),G13_STAGE9_REUSE.sourceRunSha256);const failed=json(failedFile);validateG13GateSource(failed);
const checkout=resolve(root,JSON.parse(readFileSync(resolve(root,'config/g13-windows-remaining.json'))).checkout);assert.equal(realpathSync(checkout),checkout);assert.equal(failed.checkout,checkout);
function checkPins(revision){
  clean(root,revision);clean(checkout,revision);free();assert.equal(sha(readFileSync(failedFile)),G13_STAGE9_REUSE.sourceRunSha256);
  for(const base of [root,checkout])validateG13Stage9Files(Object.fromEntries(Object.keys(G13_STAGE9_REUSE.files).map(p=>[p,sha(readFileSync(resolve(base,p)))])));
  for(const b of Object.values(G13_STAGE9_REUSE.reports))assert.equal(sha(readFileSync(resolve(checkout,b.file))),b.sha256);
}
function execute(out,id,cwd,argv,timeout=1800000){
  free();const stdout=openSync(resolve(out,id+'.stdout.log'),'wx'),stderr=openSync(resolve(out,id+'.stderr.log'),'wx');let r;
  const startedAt=new Date().toISOString();console.log('START '+id+'; '+resolve(out,id+'.stdout.log'));
  try{r=spawnSync(process.execPath,argv,{cwd,env,stdio:['ignore',stdout,stderr],windowsHide:true,timeout});}finally{closeSync(stdout);closeSync(stderr);}
  const step={id,args:argv,startedAt,finishedAt:new Date().toISOString(),exitCode:r.status,error:r.error?.message};save(resolve(out,id+'.json'),step);console.log('END '+id+'; exit '+r.status);assert.equal(r.status,0,id+' failed; original logs retained');if(r.error)throw r.error;return step;
}
const manifestPath=resolve(checkout,'artifacts/engine-0.2.2/qualification.json');
function manifestFor(revision){return {schemaVersion:2,contractId:'engine-021-evidence-v2',targetVersion:'0.2.2',revision,reports:G13_STAGE9_REUSE.reports};}
const pointerPath=resolve(root,'artifacts/engine-0.2.2/g13/windows-gates-prepared.json');
if(args[0]==='--prepare'){
  const revision=git(root,['rev-parse','HEAD']);clean(root,revision);assert.equal(git(checkout,['status','--porcelain']),'');free();
  assert.equal(existsSync(pointerPath),false,'Prepared gate run exists; no implicit replacement');
  const output=resolve(root,'artifacts/engine-0.2.2/g13/windows-gates-'+Date.now()+'-'+randomBytes(4).toString('hex'));mkdirSync(output);
  const record={schemaVersion:1,status:'preparing',revision,checkout,output,plan,startedAt:new Date().toISOString(),originalRun:{file:G13_STAGE9_REUSE.sourceRun+'/result.json',sha256:G13_STAGE9_REUSE.sourceRunSha256}};save(resolve(output,'registration.json'),record);
  try{
    git(checkout,['fetch','--quiet',root,revision]);git(checkout,['checkout','--quiet','--detach',revision]);checkPins(revision);
    const oldManifest=readFileSync(manifestPath);save(resolve(output,'original-manifest.json'),JSON.parse(oldManifest));writeFileSync(resolve(output,'original-manifest.bytes.json'),oldManifest,{flag:'wx'});
    assert.deepEqual(Object.keys(json(manifestPath).reports).sort(),Object.keys(G13_STAGE9_REUSE.reports).sort());
    for(const [kind,b]of Object.entries(G13_STAGE9_REUSE.reports))for(const field of ['file','sha256','captureRevision'])assert.equal(json(manifestPath).reports[kind][field],b[field]);
    writeFileSync(manifestPath,JSON.stringify(manifestFor(revision),null,2)+'\n');
    execute(output,'reuse-preflight',root,['scripts/run-g13-windows-remaining.mjs','--verify-reuse-only']);
    execute(output,'seven-report-preflight',checkout,['scripts/check-engine-021-evidence.mjs','--manifest=artifacts/engine-0.2.2/qualification.json']);
    execute(output,'bundle-preflight',checkout,['shader-language/scripts/check-stage9-bundle.mjs']);
    checkPins(revision);record.status='prepared';record.finishedAt=new Date().toISOString();record.manifestSha256=sha(readFileSync(manifestPath));save(resolve(output,'preparation.json'),record);
    save(pointerPath,{output,revision,preparationSha256:sha(readFileSync(resolve(output,'preparation.json')))});
    console.log(JSON.stringify({status:'prepared-gates-only',output,revision,newRendererCaptures:0,reusedRendererCaptures:580,formalSamplingStarted:false,entry:'scripts/start-g13-windows-gates.cmd'}));
  }catch(error){save(resolve(output,'preparation-failure.json'),{status:'failed',error:String(error.stack??error)});throw error;}
}else{
  const pointer=json(pointerPath),output=realpathSync(pointer.output),local=relative(resolve(root,'artifacts/engine-0.2.2/g13'),output);
  assert.ok(!isAbsolute(local)&&/^windows-gates-\d{13}-[a-f0-9]{8}$/.test(local),'Output must be the prepared G13 child');
  const bytes=readFileSync(resolve(output,'preparation.json'));assert.equal(sha(bytes),pointer.preparationSha256);const prep=JSON.parse(bytes);assert.equal(prep.status,'prepared');assert.equal(prep.checkout,checkout);assert.equal(prep.output,output);assert.equal(prep.revision,pointer.revision);checkPins(prep.revision);assert.equal(sha(readFileSync(manifestPath)),prep.manifestSha256);
  if(args[0]==='--verify'){console.log(JSON.stringify({status:'passed-prepared-gate-pins',output,...plan}));process.exit(0);}
  assert.equal(existsSync(resolve(output,'result.json')),false,'Run already has a result; no automatic retry');
  execFileSync(resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; . (Join-Path $env:G13_SOURCE_ROOT 'scripts/webgpu-gate/framegraph-background-policy.ps1'); Assert-G09GpuDiagnosticReady"],{env:{...env,G13_SOURCE_ROOT:root},stdio:'inherit',windowsHide:true});
  const record={schemaVersion:1,status:'running',revision:prep.revision,checkout,startedAt:new Date().toISOString(),...plan,steps:[]},resultPath=resolve(output,'result.json'),persist=()=>writeFileSync(resultPath,JSON.stringify(record,null,2)+'\n');persist();
  try{
    for(const [id,cwd,argv,timeout]of [
      ['reuse-at-start',root,['scripts/run-g13-windows-remaining.mjs','--verify-reuse-only'],1800000],
      ['seven-report-audit',checkout,['scripts/check-engine-021-evidence.mjs','--manifest=artifacts/engine-0.2.2/qualification.json'],1800000],
      ['global-gate',checkout,['scripts/release-gate.mjs','--global'],14400000],
      ['rehearsal',checkout,['scripts/release-rehearsal.mjs','--worker'],10800000],
      ['rehearsal-audit',checkout,['scripts/release-rehearsal-policy.mjs','--bundle','artifacts/release/rehearsal'],300000],
    ]){checkPins(prep.revision);record.steps.push(execute(output,id,cwd,argv,timeout));persist();}
    const candidate=g13WindowsCandidatePlan(root,Date.now()+'-1234abcd'),pinned=json(resolve(root,candidate.packageReport.file??candidate.packageReport.path)),packed=json(resolve(checkout,'artifacts/release/public-packages.json'));
    assert.equal(packed.gate.status,'passed');const hashes=r=>r.packages.map(({name,sha256})=>({name,sha256})).sort((a,b)=>a.name.localeCompare(b.name));assert.deepEqual(hashes(packed),hashes(pinned));for(const p of packed.packages)assert.equal(sha(readFileSync(resolve(checkout,p.artifact))),p.sha256);
    record.steps.push(execute(output,'reuse-at-finish',root,['scripts/run-g13-windows-remaining.mjs','--verify-reuse-only']));checkPins(prep.revision);record.status='passed-windows-global-and-rehearsal';
  }catch(error){record.status='failed';record.error=String(error.stack??error);process.exitCode=1;}
  finally{record.finishedAt=new Date().toISOString();persist();console.log('FINAL STATUS: '+record.status);if(record.error)console.error(record.error);console.log('EVIDENCE: '+output);console.log('Original failure retained. Apple pending. No version published or baseline promoted.');}
}
