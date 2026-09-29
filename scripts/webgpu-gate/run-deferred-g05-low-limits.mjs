import {parseCompatibilityOptions} from './deferred-compatibility-policy.mjs';
import {validateG05LowLimits} from './deferred-g05-low-limits-policy.mjs';
import {runChromeWebGpuFixture} from './chrome-runner.mjs';
import {deferredRuntimeFingerprint,sha256} from './deferred-fixture-policy.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=resolve(root,'artifacts/engine-0.2.1/g05'),{preference}=parseCompatibilityOptions(process.argv.slice(2));
const inputs=await deferredRuntimeFingerprint(root),build=JSON.parse(await readFile(resolve(directory,'fixture-build.json'),'utf8'));
if(inputs.sha256!==build.inputs.sha256)throw Error('Stale G05 runtime');for(const output of build.outputs)if(sha256(await readFile(resolve(directory,output.file)))!==output.sha256)throw Error('Stale runtime chunk');
async function fingerprint(){const names=['run-deferred-g05-low-limits.mjs','deferred-g05-low-limits-policy.mjs','deferred-g05-low-limits-fixture.mjs','deferred-g05-low-limits-fixture.html','deferred-g05-forward-allocation.mjs','chrome-runner.mjs','deferred-fixture-policy.mjs','deferred-compatibility-policy.mjs'];const files=await Promise.all(names.map(async file=>({file,sha256:sha256(await readFile(resolve(root,'scripts/webgpu-gate',file)))})));return {files,sha256:sha256(JSON.stringify(files))};}
const harness=await fingerprint();let result;
try{result=await runChromeWebGpuFixture({root,fixture:'scripts/webgpu-gate/deferred-g05-low-limits-fixture.html',query:{powerPreference:preference},timeoutMs:240000,acceptedStatuses:['passed','unavailable','failed']});}catch(error){result={status:'failed',stage:'browser-infrastructure',error:error.stack??String(error)};}
const evidence={schemaVersion:1,tier:'diagnostic-g05-native-low-limits',generatedAt:new Date().toISOString(),inputs,build,harness,preference,revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0,result};
const path=resolve(directory,`low-limits-${preference}-${result.status}-${evidence.generatedAt.replaceAll(':','-')}.json`);await writeFile(path,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({path,status:result.status,error:result.error,cases:result.cases?.length}));
if(inputs.sha256!==(await deferredRuntimeFingerprint(root)).sha256||harness.sha256!==(await fingerprint()).sha256)throw Error('Inputs changed during capture');validateG05LowLimits(result);
