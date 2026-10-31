import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {releaseWorkflowSteps,workflowId,validateWorkflowManifest,assessWorkflowPreflight,runReleaseWorkflow,workflowLauncher} from './release-workflow-run-policy.mjs';
import {independentWorkflowArguments,windowsLaunchCommand,workflowLaunchEnvironment,confirmIndependentStartup} from './release-workflow-launch.mjs';
import {setTimeout as delay} from 'node:timers/promises';
const root=resolve(import.meta.dirname,'..');
const manifest={schemaVersion:1,profile:'diagnostic',root,node:process.execPath,host:{platform:process.platform,architecture:process.arch,nodeVersion:process.version},noPublication:true,source:{revision:'a'.repeat(40),dirty:true,files:{'scripts/release-workflow.mjs':'b'.repeat(64)}},steps:releaseWorkflowSteps('diagnostic')};
function harness(){const h={saved:[],executed:[],checked:[],host:{platform:'win32',administrator:true,blockers:[]},changed:false};h.io={now:()=>new Date(0).toISOString(),save:async s=>h.saved.push(structuredClone(s)),host:async()=>h.host,verifyInputs:async()=>{if(h.changed)throw Error('inputs changed');},verifyCompleted:async s=>h.checked.push(s.id),execute:async s=>{h.executed.push(s.id);return {exitCode:0};}};return h;}
test('profiles preserve fixed non-publication commands and reject inserted execution',()=>{
 validateWorkflowManifest(manifest);for(const profile of ['ci','global']){const m={...manifest,profile,source:{...manifest.source,dirty:false},steps:releaseWorkflowSteps(profile)};validateWorkflowManifest(m);assert.ok(m.steps.some(s=>s.id==='rehearsal'));assert.ok(m.steps.some(s=>s.id==='rehearsal-audit'));}
 assert.throws(()=>validateWorkflowManifest({...manifest,noPublication:false}));assert.throws(()=>validateWorkflowManifest({...manifest,host:{...manifest.host,nodeVersion:'v20.0.0'}}));
 assert.throws(()=>validateWorkflowManifest({...manifest,steps:[{id:'publish',kind:'npm',args:['publish']}]}));
 assert.throws(()=>validateWorkflowManifest({...manifest,profile:'global',steps:releaseWorkflowSteps('global')}),/clean/);
});
test('administrator and background-app checks are independent and have explicit not-started states',()=>{
 const m={...manifest,profile:'global'};
 assert.equal(assessWorkflowPreflight(m,{platform:'win32',administrator:false,blockers:[{Name:'ChatGPT',Pid:1}]}).status,'permission-required');
 const apps=assessWorkflowPreflight(m,{platform:'win32',administrator:true,blockers:[{Name:'ChatGPT',Pid:1}]});assert.equal(apps.status,'background-apps');assert.match(apps.message,/Permission passed/);
 assert.equal(assessWorkflowPreflight(m,{platform:'win32',administrator:true}).status,'preflight-failed');
});
test('successful steps resume only after verifying their original logs and frozen inputs',async()=>{
 const h=harness(),first=await runReleaseWorkflow(manifest,null,h.io);assert.equal(first.status,'passed');assert.deepEqual(h.executed,manifest.steps.map(s=>s.id));
 await runReleaseWorkflow(manifest,first,h.io);assert.equal(h.executed.length,2);assert.equal(h.checked.length,2);
 h.changed=true;await assert.rejects(runReleaseWorkflow(manifest,first,h.io),/changed/);
 const another={...first,manifestId:'other'};await assert.rejects(runReleaseWorkflow(manifest,another,h.io),/another/);
});
test('failed or interrupted stages preserve history and require explicit named retry',async()=>{
 const h=harness();let calls=0;h.io.execute=async()=>({exitCode:++calls===1?1:0});
 const first=await runReleaseWorkflow(manifest,null,h.io);assert.equal(first.status,'failed');
 assert.equal((await runReleaseWorkflow(manifest,first,h.io)).status,'needs-explicit-retry');assert.equal(calls,1);
 const done=await runReleaseWorkflow(manifest,first,h.io,{retryStage:manifest.steps[0].id});assert.equal(done.status,'passed');assert.equal(done.stages[manifest.steps[0].id].history[0].exitCode,1);
});
test('formal preflight never starts a stage when permissions or applications block it',async()=>{
 const m={...manifest,profile:'global',source:{...manifest.source,dirty:false},steps:releaseWorkflowSteps('global')};
 for(const host of [{platform:'win32',administrator:false,blockers:[]},{platform:'win32',administrator:true,blockers:[{Name:'Taskmgr',Pid:10}]}]){
  const h=harness();h.host=host;assert.notEqual((await runReleaseWorkflow(m,null,h.io)).status,'passed');assert.equal(h.executed.length,0);
 }
});
test('independent Explorer launcher preserves terminal exit/output and has no app termination command',()=>{
 const cmd=workflowLauncher({...manifest,root:'D:\\Project %name% & safe',node:'C:\\Program Files\\nodejs\\node.exe'},'D:\\Evidence %test%\\run.json','win32');
 assert.match(cmd,/DisableDelayedExpansion/);assert.match(cmd,/%%name%%/);assert.match(cmd,/pause/);assert.match(cmd,/launch --run/);assert.match(cmd,/--no-publish/);assert.doesNotMatch(cmd,/taskkill|Stop-Process|ChatGPT/i);
 const sh=workflowLauncher(manifest,"/tmp/one'two/run.json",'linux');assert.match(sh,/'\\''/);assert.match(sh,/code=\$\?/);
});
test('broker arguments preserve literal paths and the independent terminal, excluding credentials',()=>{
 const options={root:"D:\\Project %name% & 'safe'",node:'C:\\Program Files\\nodejs\\node.exe',runPath:'D:\\Evidence & one\\run.json',nonce:'a'.repeat(24)};
 const args=independentWorkflowArguments(options,'win32');assert.ok(args.includes('--keep-terminal'));assert.equal(args[args.indexOf('--run')+1],options.runPath);
 const command=windowsLaunchCommand(options);assert.ok(command.startsWith('"'+options.node+'" '));assert.ok(command.includes('"'+options.runPath+'"'));assert.doesNotMatch(command,/-EncodedCommand|cmd\.exe|powershell\.exe/i);
 assert.ok(!independentWorkflowArguments({...options,closeOnComplete:true},'win32').includes('--keep-terminal'));
 assert.ok(!independentWorkflowArguments(options,'linux').includes('--keep-terminal'));
 assert.throws(()=>independentWorkflowArguments({...options,nonce:'../escape'},'win32'));
 assert.throws(()=>independentWorkflowArguments({...options,retryStage:'x & publish'},'win32'));
 assert.throws(()=>independentWorkflowArguments({...options,runPath:'one\ntwo'},'win32'));
 assert.deepEqual(workflowLaunchEnvironment({Path:'runtime',SystemRoot:'windows',NPM_TOKEN:'private',GH_TOKEN:'private',NODE_OPTIONS:'untrusted',npm_config_cache:'cache'}),['Path=runtime','SystemRoot=windows','npm_config_cache=cache']);
});
test('OS launch acceptance requires the owning controller acknowledgement',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'g02-ack-')),file=resolve(dir,'run.json'),nonce='a'.repeat(24);
 try{
  writeFileSync(file,JSON.stringify({launch:{nonce},controller:{pid:12,status:'starting'}}));
  assert.equal((await confirmIndependentStartup(file,12,nonce)).status,'starting');
  await assert.rejects(confirmIndependentStartup(file,12,'b'.repeat(24)),/ownership/);
  await assert.rejects(confirmIndependentStartup(file,13,nonce,{timeoutMs:1}),/acknowledge/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('actual independent controller completes after its launching CLI has exited',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'g02-independent-'));
 const run=args=>spawnSync(process.execPath,['scripts/release-workflow.mjs',...args],{cwd:root,encoding:'utf8',timeout:60000});
 try{
  let result=run(['plan','--profile','diagnostic','--output',dir]);assert.equal(result.status,0,result.stderr);
  const file=resolve(dir,'run.json');
  result=run(['launch','--run',file,'--no-publish','--hidden','--close-on-complete']);assert.equal(result.status,0,result.stderr+result.stdout);
  const launch=JSON.parse(result.stdout);assert.equal(launch.status,'launched-independent');assert.ok(launch.pid>0);
  let saved;const until=Date.now()+60000;
  do{saved=JSON.parse(readFileSync(file));if(saved.controller?.finishedAt)break;await delay(50);}while(Date.now()<until);
  assert.equal(saved.controller.pid,launch.pid);assert.equal(saved.controller.status,'passed',JSON.stringify(saved));
  assert.notEqual(saved.controller.pid,saved.launch.requestedByPid);
  if(process.platform==='win32')assert.notEqual(saved.controller.parentPid,saved.launch.requestedByPid,'Windows broker must be outside the launching CLI process tree');
  assert.equal(saved.state.status,'passed');assert.equal(saved.state.published,false);assert.equal(saved.state.releaseQualificationGranted,false);
  assert.ok(Object.values(saved.state.stages).every(s=>s.attempt===1&&s.status==='passed'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('actual platform CLI prepares, runs and resumes diagnostic workflow without installing copies or publishing',()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'g02-workflow-'));
 const run=args=>spawnSync(process.execPath,['scripts/release-workflow.mjs',...args],{cwd:root,encoding:'utf8',timeout:60000});
 try{
  let result=run(['plan','--profile','diagnostic','--output',dir]);assert.equal(result.status,0,result.stderr);
  const file=resolve(dir,'run.json');const original=JSON.parse(readFileSync(file));assert.equal(original.manifestId,workflowId(original.manifest));
  result=run(['run','--run',file,'--no-publish']);assert.equal(result.status,0,result.stderr+result.stdout);
  const first=JSON.parse(readFileSync(file));assert.equal(first.state.status,'passed');assert.equal(first.state.published,false);
  result=run(['run','--run',file,'--no-publish']);assert.equal(result.status,0,result.stderr);assert.ok(!result.stdout.includes('START '));
  writeFileSync(resolve(dir,first.state.stages['planar-protocol'].stdout.file),'tampered');
  result=run(['run','--run',file,'--no-publish']);assert.notEqual(result.status,0);assert.match(result.stderr,/log changed/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
