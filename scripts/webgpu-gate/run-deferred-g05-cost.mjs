import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {waitG05Cooldown} from './deferred-g05-cooldown.mjs';
import {runChromeWebGpuFixture} from './chrome-runner.mjs';
import {deferredRuntimeFingerprint,sha256} from './deferred-fixture-policy.mjs';
import {parseG05RoomOptions,validateG05RoomResult,summarizeG05Room} from './deferred-g05-policy.mjs';
import {parseG05CostOptions,validateG05CostResult} from './deferred-g05-cost-policy.mjs';
import {parseG01ThermalStatus,validateG01HostSamples} from '../benchmark/lighting-g01-host.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=resolve(root,'artifacts/engine-0.2.1/g05');
const options=parseG05CostOptions(process.argv.slice(2));await mkdir(directory,{recursive:true});
async function fingerprintHarness(){
 const paths=['deferred-g05-policy.mjs','deferred-g05-cost-policy.mjs','deferred-g05-cost-observer.mjs','deferred-g05-cost-fixture.html','deferred-g05-cost-fixture.mjs','deferred-g05-memory-policy.mjs','deferred-g05-room-scene.mjs','run-deferred-g05-cost.mjs','deferred-room-fixture.mjs','float-texture-readback.mjs','chrome-runner.mjs','deferred-fixture-policy.mjs','deferred-g05-cooldown.mjs'].map(f=>`scripts/webgpu-gate/${f}`);
 paths.push('scripts/benchmark/lighting-g01-host.mjs','config/lighting-performance-021.json');
 const files=await Promise.all(paths.map(async path=>({path,sha256:sha256(await readFile(resolve(root,path)))})));return {files,sha256:sha256(JSON.stringify(files))};
}
const inputs=await deferredRuntimeFingerprint(root),harness=await fingerprintHarness(),build=JSON.parse(await readFile(resolve(directory,'fixture-build.json'),'utf8'));
if(inputs.sha256!==build.inputs.sha256)throw Error('Stale G05 runtime; build-deferred-fixture.mjs --performance');
for(const output of build.outputs)if(sha256(await readFile(resolve(directory,output.file)))!==output.sha256)throw Error(`Stale chunk: ${output.file}`);
const host=()=>{const output=execFileSync('pmset',['-g','therm'],{encoding:'utf8'});return {command:'pmset -g therm',observedAt:new Date().toISOString(),output,...parseG01ThermalStatus(output)};};
const interCaseIdleMs=options.full?await waitG05Cooldown(options.idleMs,{onProgress:remaining=>console.log(`G05 cooling: ${Math.ceil(remaining/1000)}s remaining`)}):0;
const before=host();console.log(JSON.stringify({phase:'host-before',host:before}));
let result;
if(options.full&&!before.ready)result={status:'failed',stage:'host-preflight',error:`Host not ready: ${before.reasons.join('; ')}`};
else try{result=await runChromeWebGpuFixture({root,mounts:[{prefix:'/artifacts/engine-0.2.1/g03',directory}],fixture:'scripts/webgpu-gate/deferred-g05-cost-fixture.html',
 query:{...options,full:options.full?1:0,moving:options.moving?1:0,powerPreference:options.preference},timeoutMs:1200000,acceptedStatuses:['passed','failed']});}
catch(error){result={status:'failed',stage:'browser-infrastructure',error:error.stack??String(error)};}
const evidence={schemaVersion:1,tier:options.full?'diagnostic-g05-cost-candidate':'diagnostic-g05-cost-smoke',generatedAt:new Date().toISOString(),options,inputs,harness,build,
 revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0,
 interCaseIdleMs,hostSamples:[before,host()],result};
let validationError,memory;
try{
 if(inputs.sha256!==(await deferredRuntimeFingerprint(root)).sha256||harness.sha256!==(await fingerprintHarness()).sha256)throw Error('Source changed during capture');
 memory=validateG05CostResult(result,options,JSON.parse(await readFile(resolve(root,'config/lighting-performance-021.json'),'utf8')));
 if(options.full){const errors=validateG01HostSamples(evidence.hostSamples);if(errors.length)throw Error(errors.join('; '));}
 evidence.validation={status:'passed',memory};
}catch(error){validationError=error;evidence.validation={status:'failed',error:error.stack??String(error)};}
const path=resolve(directory,`cost-${options.ao}-${options.caseId}-${options.algorithm}-${options.moving?'moving':'static'}-${options.preference}-${evidence.generatedAt.replaceAll(':','-')}.json`);
await writeFile(path,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({path,status:evidence.validation.status,renderStatus:result.status,error:evidence.validation.error??result.error,adapter:result.adapter}));
if(validationError)throw validationError;
console.log(JSON.stringify({memory,pixels:result.pixels,p95:summarizeG05Room(result),hostReady:evidence.hostSamples.every(h=>h.ready)}));
