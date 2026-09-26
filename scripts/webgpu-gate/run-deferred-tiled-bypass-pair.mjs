import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as idle} from 'node:timers/promises';
import {runChromeWebGpuFixture} from './chrome-runner.mjs';
import {deferredRuntimeFingerprint,sha256} from './deferred-fixture-policy.mjs';
import {tiledRoomHarnessFingerprint} from './deferred-tiled-room-policy.mjs';
import {summarizeBypassPairs} from './deferred-tiled-bypass-policy.mjs';
import {parseG01ThermalStatus,validateG01HostSamples} from '../benchmark/lighting-g01-host.mjs';
if(process.argv.length!==2)throw Error('This diagnostic has a fixed AMD 128-light overlap workload.');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=resolve(root,'artifacts/engine-0.2.1/g03');
const fingerprint=async()=>{
  const base=await tiledRoomHarnessFingerprint(root),files=[...base.files];
  for(const name of ['deferred-tiled-bypass-pair.html','deferred-tiled-bypass-pair.mjs','deferred-tiled-bypass-policy.mjs','run-deferred-tiled-bypass-pair.mjs']){const path=`scripts/webgpu-gate/${name}`;files.push({path,sha256:sha256(await readFile(resolve(root,path)))});}
  return {sha256:sha256(JSON.stringify(files)),files};
};
const inputs=await deferredRuntimeFingerprint(root),harness=await fingerprint(),build=JSON.parse(await readFile(resolve(directory,'fixture-build.json'),'utf8'));
if(inputs.sha256!==build.inputs.sha256)throw Error('Stale G03 runtime');
for(const output of build.outputs)if(sha256(await readFile(resolve(directory,output.file)))!==output.sha256)throw Error('Runtime chunk changed');
const host=()=>{const output=execFileSync('pmset',['-g','therm'],{encoding:'utf8'});return {command:'pmset -g therm',observedAt:new Date().toISOString(),output,...parseG01ThermalStatus(output)};};
console.log('Same-pipeline diagnostic: waiting 30 seconds before capture.');const start=performance.now();await idle(30000);const interCaseIdleMs=performance.now()-start;
const before=host();if(!before.ready)throw Error('Host is not ready');
const result=await runChromeWebGpuFixture({root,fixture:'scripts/webgpu-gate/deferred-tiled-bypass-pair.html',timeoutMs:180000,acceptedStatuses:['passed','failed']});
const evidence={schemaVersion:1,tier:'diagnostic-g03-same-pipeline-pairs',productQualification:false,generatedAt:new Date().toISOString(),inputs,harness,build,interCaseIdleMs,hostSamples:[before,host()],
  revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0,result};
const path=resolve(directory,`bypass-pairs-${evidence.generatedAt.replaceAll(':','-')}.json`);await writeFile(path,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
if(inputs.sha256!==(await deferredRuntimeFingerprint(root)).sha256||harness.sha256!==(await fingerprint()).sha256)throw Error('Pair source changed during capture');
if(result.status!=='passed')console.error(JSON.stringify({path,error:result.error}));
const hostErrors=validateG01HostSamples(evidence.hostSamples);if(hostErrors.length)throw Error(hostErrors.join('; '));
console.log(JSON.stringify({path,summary:summarizeBypassPairs(result)}));
