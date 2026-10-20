import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {runChromeWebGpuFixture} from './chrome-runner.mjs';
import {deferredRuntimeFingerprint,sha256} from './deferred-fixture-policy.mjs';
import {parseG05AllocationOptions,validateG05Allocation} from './deferred-g05-allocation-policy.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=resolve(root,'artifacts/engine-0.2.1/g05'),options=parseG05AllocationOptions(process.argv.slice(2));
const inputs=await deferredRuntimeFingerprint(root),build=JSON.parse(await readFile(resolve(directory,'fixture-build.json'),'utf8'));
if(inputs.sha256!==build.inputs.sha256)throw Error('Stale G05 runtime');for(const output of build.outputs)if(sha256(await readFile(resolve(directory,output.file)))!==output.sha256)throw Error('Stale runtime chunk');
async function fingerprint(){const names=['run-deferred-g05-allocation.mjs','deferred-g05-allocation-policy.mjs','deferred-g05-allocation-fixture.mjs','deferred-g05-allocation-fixture.html','deferred-g05-room-scene.mjs','deferred-g05-policy.mjs','deferred-room-fixture.mjs','float-texture-readback.mjs','chrome-runner.mjs','allocation-sampling-phase.mjs','deferred-fixture-policy.mjs'];const files=await Promise.all(names.map(async file=>({file,sha256:sha256(await readFile(resolve(root,'scripts/webgpu-gate',file)))})));return {files,sha256:sha256(JSON.stringify(files))};}
const harness=await fingerprint();let result;
try{result=await runChromeWebGpuFixture({root,mounts:[{prefix:'/artifacts/engine-0.2.1/g03',directory}],fixture:'scripts/webgpu-gate/deferred-g05-allocation-fixture.html',query:{...options,moving:options.moving?1:0},timeoutMs:600000,allocationSampling:{phase:'fixture-steady-state-v1',samplingInterval:4096},acceptedStatuses:['passed','failed']});}
catch(error){result={status:'failed',stage:'browser-infrastructure',error:error.stack??String(error)};}
let validation;try{validation=validateG05Allocation(result,options);}catch(error){validation={status:'failed',error:String(error)};}
const evidence={schemaVersion:1,tier:'diagnostic-g05-cpu-allocation',generatedAt:new Date().toISOString(),options,inputs,harness,build,revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0,result,validation};
const path=resolve(directory,`cpu-allocation-${options.caseId}-${options.algorithm}-${options.moving?'moving':'static'}-${options.preference}-${evidence.generatedAt.replaceAll(':','-')}.json`);
await writeFile(path,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({path,status:result.status,validation,error:result.error,top:result.allocationSampling?.top?.slice(0,5)}));
if(inputs.sha256!==(await deferredRuntimeFingerprint(root)).sha256||harness.sha256!==(await fingerprint()).sha256)throw Error('Source changed during capture');if(validation.status!=='passed')throw Error(validation.error);
