import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync,openSync,closeSync,realpathSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {resolve,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {npmCommand,npmArgs} from './npm-process.mjs';
import {WINDOWS_RENDER_JOBS,windowsFinalPaths,assertWindowsFinalLocation,validateWindowsRenderReport,windowsFinalPlan} from './g13-windows-final-policy.mjs';
import {g13ProductionPlan} from './g13-production-candidate-policy.mjs';
import {ensureFrozenHyaFoundationLayout} from './hya-foundation-layout.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),argv=process.argv.slice(2);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),json=path=>JSON.parse(readFileSync(path)),save=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true}).trim();
const environment={...process.env};for(const name of ['NODE_AUTH_TOKEN','NPM_TOKEN','GH_TOKEN','COSIGN_PRIVATE_KEY','SIGNING_KEY'])delete environment[name];
function clean(cwd,revision){assert.equal(git(cwd,['rev-parse','HEAD']),revision,'Frozen source revision changed');assert.equal(git(cwd,['status','--porcelain']),'','Source must stay clean');}
function execute(cwd,out,id,command,args,timeout=3600000){
  const stdout=openSync(resolve(out,id+'.stdout.log'),'wx'),stderr=openSync(resolve(out,id+'.stderr.log'),'wx');console.log('START '+id+'; log: '+resolve(out,id+'.stdout.log'));
  const startedAt=new Date().toISOString();let result;
  try{result=spawnSync(command,args,{cwd,env:environment,stdio:['ignore',stdout,stderr],windowsHide:true,timeout});}
  finally{closeSync(stdout);closeSync(stderr);}
  const record={id,command,args,startedAt,finishedAt:new Date().toISOString(),exitCode:result.status,error:result.error?.message};save(resolve(out,id+'.json'),record);console.log('END '+id+'; exit: '+result.status);
  if(result.error)throw result.error;return record;
}
function required(...args){const r=execute(...args);if(r.exitCode!==0)throw Error(r.id+' failed; its original logs are retained');return r;}
function npmStep(cwd,out,id,args,timeout){return required(cwd,out,id,npmCommand(),npmArgs(args),timeout);}
if(argv.length===1&&argv[0]==='--plan'){console.log(JSON.stringify(windowsFinalPlan(),null,2));process.exit(0);}
if(process.platform!=='win32')throw Error('This entry requires the registered Windows runner');
if(argv.length===1&&argv[0]==='--prepare'){
  const revision=git(root,['rev-parse','HEAD']);clean(root,revision);const id=Date.now()+'-'+randomBytes(4).toString('hex'),paths=windowsFinalPaths(root,id);
  g13ProductionPlan(root,id);mkdirSync(paths.output);const record={schemaVersion:1,status:'preparing',revision,root,paths,startedAt:new Date().toISOString(),plan:windowsFinalPlan()};save(paths.preparation,record);
  try{
    required(root,paths.output,'clone','git',['clone','--quiet','--local','--no-hardlinks','--no-checkout',root,paths.checkout],300000);
    required(root,paths.output,'long-paths','git',['-C',paths.checkout,'config','core.longpaths','true']);
    required(root,paths.output,'filemode','git',['-C',paths.checkout,'config','core.filemode','false']);
    required(root,paths.output,'detach','git',['-C',paths.checkout,'checkout','--quiet','--detach',revision],300000);
    ensureFrozenHyaFoundationLayout(paths.checkout);
    npmStep(paths.checkout,paths.output,'locked-install',['ci','--cache','D:/npm-cache'],1200000);
    clean(paths.checkout,revision);
    for(const workspace of ['shader-language','engine','animation-spec','extensions'])npmStep(paths.checkout,paths.output,'build-'+workspace,['run','build','-w','./'+workspace],1200000);
    required(paths.checkout,paths.output,'build-a0',process.execPath,['scripts/webgpu-gate/build-framegraph-baseline.mjs'],600000);
    required(paths.checkout,paths.output,'build-current',process.execPath,['scripts/webgpu-gate/build-deferred-fixture.mjs','--framegraph'],600000);
    clean(root,revision);clean(paths.checkout,revision);record.status='prepared';record.finishedAt=new Date().toISOString();save(paths.preparation,record);
    save(resolve(root,'artifacts/engine-0.2.2/g13/windows-final-prepared.json'),{output:paths.output,preparationSha256:sha(readFileSync(paths.preparation)),revision});
    console.log('PREPARED: '+paths.output);
  }catch(error){record.status='failed';record.error=String(error.stack??error);save(paths.preparation,record);throw error;}
}else if(argv.length===1&&argv[0]==='--run'){
  const pointer=json(resolve(root,'artifacts/engine-0.2.2/g13/windows-final-prepared.json')),output=assertWindowsFinalLocation(root,pointer.output),preparation=resolve(output,'preparation.json');
  assert.equal(realpathSync(output),output);assert.equal(sha(readFileSync(preparation)),pointer.preparationSha256);
  const prep=json(preparation),checkout=resolve(output,'checkout');assert.equal(prep.status,'prepared');assert.equal(prep.paths.checkout,checkout);clean(root,prep.revision);clean(checkout,prep.revision);
  if(existsSync(resolve(output,'result.json')))throw Error('This prepared run already has a result; no automatic retry');
  execFileSync(resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; . (Join-Path $env:G13_SOURCE_ROOT 'scripts/webgpu-gate/framegraph-background-policy.ps1'); Assert-G09GpuDiagnosticReady"],{env:{...environment,G13_SOURCE_ROOT:root},stdio:'inherit',windowsHide:true});
  const record={schemaVersion:1,status:'running',revision:prep.revision,dirty:false,startedAt:new Date().toISOString(),checkout,reports:{},steps:[],macQualified:false,iPhoneQualified:false,externalPublishPerformed:false,formalBaselineUpdated:false};save(resolve(output,'result.json'),record);
  try{
    const manifest={schemaVersion:2,contractId:'engine-021-evidence-v2',targetVersion:'0.2.2',revision:prep.revision,reports:{}};
    for(const job of WINDOWS_RENDER_JOBS){
      clean(checkout,prep.revision);const parent=resolve(checkout,job.parent);mkdirSync(parent,{recursive:true});const before=new Set(readdirSync(parent));
      const step=execute(checkout,output,'capture-'+job.id,process.execPath,job.args,job.id==='rooms'?14400000:7200000);record.steps.push(step);
      const created=readdirSync(parent).filter(name=>!before.has(name)&&name.startsWith(job.prefix));assert.equal(created.length,1,job.id+': exactly one fresh capture directory required');
      const reportPath=resolve(parent,created[0],'report.json'),report=json(reportPath);validateWindowsRenderReport(job,report,prep.revision);
      if(step.exitCode!==0&&!['rooms','instances','forward'].includes(job.id))throw Error(job.id+': sampling failed');
      const binding={file:relative(checkout,reportPath).replaceAll('\\','/'),sha256:sha(readFileSync(reportPath)),captureRevision:prep.revision};manifest.reports[job.id]=binding;record.reports[job.id]={...binding,originalStatus:report.status};save(resolve(output,'result.json'),record);
    }
    const qualification=resolve(checkout,'artifacts/engine-0.2.2/qualification.json');mkdirSync(dirname(qualification),{recursive:true});save(qualification,manifest);
    record.steps.push(required(checkout,output,'seven-report-audit',process.execPath,['scripts/check-engine-021-evidence.mjs','--manifest=artifacts/engine-0.2.2/qualification.json'],1800000));
    record.steps.push(required(checkout,output,'bootstrap-diagnostic',process.execPath,['scripts/verify-webgpu-lighting-scaling-fixture.mjs','--evidence=diagnostic','--lights=128','--overlap=high','--dynamic=1','--views=4','--resolution=720p','--warmup=4','--samples=8','--gpu-samples=2'],600000));
    record.steps.push(required(checkout,output,'global-gate',process.execPath,['scripts/release-gate.mjs','--global'],14400000));
    record.steps.push(required(checkout,output,'rehearsal',process.execPath,['scripts/release-rehearsal.mjs','--worker'],7200000));
    record.steps.push(required(checkout,output,'rehearsal-audit',process.execPath,['scripts/release-rehearsal-policy.mjs','--bundle','artifacts/release/rehearsal'],300000));
    const rebuilt=json(resolve(checkout,'artifacts/release/public-packages.json')),pinned=json(resolve(root,'artifacts/engine-0.2.2/g13/packages-handoff-compact/public-packages.json'));
    assert.equal(rebuilt.gate.status,'passed');assert.deepEqual(rebuilt.packages.map(p=>({name:p.name,sha256:p.sha256})).sort((a,b)=>a.name.localeCompare(b.name)),pinned.packages.map(p=>({name:p.name,sha256:p.sha256})).sort((a,b)=>a.name.localeCompare(b.name)));
    clean(root,prep.revision);clean(checkout,prep.revision);record.status='passed-windows-global-and-rehearsal';
  }catch(error){record.status='failed';record.error=String(error.stack??error);process.exitCode=1;}
  finally{record.finishedAt=new Date().toISOString();save(resolve(output,'result.json'),record);console.log('FINAL STATUS: '+record.status);if(record.error)console.error(record.error);console.log('EVIDENCE: '+output);console.log('Apple qualification remains pending. No version was published and no baseline was promoted.');}
}else throw Error('Use --plan, --prepare or --run');
