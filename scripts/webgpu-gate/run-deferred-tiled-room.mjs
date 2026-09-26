import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {setTimeout as idle} from 'node:timers/promises';
import {runChromeWebGpuFixture} from './chrome-runner.mjs';
import {deferredRuntimeFingerprint,sha256} from './deferred-fixture-policy.mjs';
import {parseTiledRoomOptions,tiledRoomHarnessFingerprint,validateTiledRoomResult,summarizeTiledRoomTiming} from './deferred-tiled-room-policy.mjs';
import {parseG01ThermalStatus,validateG01HostSamples} from '../benchmark/lighting-g01-host.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=resolve(root,'artifacts/engine-0.2.1/g03');
const options=parseTiledRoomOptions(process.argv.slice(2));await mkdir(directory,{recursive:true});
const inputs=await deferredRuntimeFingerprint(root),harness=await tiledRoomHarnessFingerprint(root),build=JSON.parse(await readFile(resolve(directory,'fixture-build.json'),'utf8'));
if(inputs.sha256!==build.inputs.sha256)throw Error('Stale tiled runtime; rebuild fixture with --tiled');
for(const output of build.outputs)if(sha256(await readFile(resolve(directory,output.file)))!==output.sha256)throw Error('Tiled runtime chunk changed');
const host=()=>{const output=execFileSync('pmset',['-g','therm'],{encoding:'utf8'});return {command:'pmset -g therm',observedAt:new Date().toISOString(),output,...parseG01ThermalStatus(output)};};
let interCaseIdleMs=0;
if(options.full){const started=performance.now();console.log('Full G03 capture: waiting 30 seconds before host check.');await idle(30000);interCaseIdleMs=performance.now()-started;}
const before=host();
// Retain rejected preflight values in the capture log before any early exit.
console.log(JSON.stringify({phase:'host-before',host:before}));
if(options.full&&!before.ready)throw Error(`Host not ready: ${before.reasons.join('; ')}`);
const result=await runChromeWebGpuFixture({root,fixture:'scripts/webgpu-gate/deferred-tiled-room-fixture.html',
  query:{powerPreference:options.preference,count:options.count,overlap:options.overlap?1:0,algorithm:options.algorithm,full:options.full?1:0},timeoutMs:240000,acceptedStatuses:['passed','failed']});
const evidence={schemaVersion:1,tier:options.full?'diagnostic-g03-performance-candidate':'diagnostic-g03-room-smoke',generatedAt:new Date().toISOString(),options,inputs,harness,build,
  revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0,
  interCaseIdleMs,hostSamples:[before,host()],result};
const path=resolve(directory,`room-${options.algorithm}-${options.count}-${options.overlap?'overlap':'sparse'}-${options.preference}-${evidence.generatedAt.replaceAll(':','-')}.json`);
await writeFile(path,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
if(inputs.sha256!==(await deferredRuntimeFingerprint(root)).sha256||harness.sha256!==(await tiledRoomHarnessFingerprint(root)).sha256)throw Error('Room sources changed during capture');
if(result.status!=='passed')console.error(JSON.stringify({path,error:result.error}));
validateTiledRoomResult(result,options);
if(options.full){const errors=validateG01HostSamples(evidence.hostSamples);if(errors.length)throw Error(errors.join('; '));}
console.log(JSON.stringify({path,status:result.status,adapter:result.adapter,pixels:result.pixels,p95:summarizeTiledRoomTiming(result.raw),hostReady:evidence.hostSamples.every(h=>h.ready)}));
