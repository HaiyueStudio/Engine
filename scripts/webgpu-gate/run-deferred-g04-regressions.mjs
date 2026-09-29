import {parseCompatibilityOptions} from './deferred-compatibility-policy.mjs';
import {runChromeWebGpuFixture} from './chrome-runner.mjs';
import {deferredRuntimeFingerprint,deferredHarnessFingerprint,validateDeferredFixtureEvidence,sha256} from './deferred-fixture-policy.mjs';
import {tiledHarnessFingerprint,validateTiledFixtureResult} from './deferred-tiled-policy.mjs';
import {readFile,writeFile} from 'node:fs/promises';import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),{preference}=parseCompatibilityOptions(process.argv.slice(2)),directory=resolve(root,'artifacts/engine-0.2.1/g04');
const inputs=await deferredRuntimeFingerprint(root),build=JSON.parse(await readFile(resolve(directory,'fixture-build.json'),'utf8'));
if(build.inputs.sha256!==inputs.sha256)throw Error('Stale G04 runtime');for(const output of build.outputs)if(sha256(await readFile(resolve(directory,output.file)))!==output.sha256)throw Error('Stale chunk');
const runnerSha256=sha256(await readFile(fileURLToPath(import.meta.url)));
const mounts=['g02','g03'].map(goal=>({prefix:`/artifacts/engine-0.2.1/${goal}`,directory}));
// Reuse the unchanged A/B oracles against the current runtime without overwriting frozen G02/G03 evidence.
for(const mode of ['reference','tiled']){
 const harness=await (mode==='reference'?deferredHarnessFingerprint(root):tiledHarnessFingerprint(root));let result;
 try{result=await runChromeWebGpuFixture({root,mounts,fixture:`scripts/webgpu-gate/${mode==='reference'?'deferred-reference':'deferred-tiled-render'}-fixture.html`,query:{powerPreference:preference,full:1},timeoutMs:300000,acceptedStatuses:['passed','failed']});}catch(error){result={schemaVersion:1,status:'failed',stage:'browser-infrastructure',error:error.stack??String(error)};}
 if(inputs.sha256!==(await deferredRuntimeFingerprint(root)).sha256||harness.sha256!==(await (mode==='reference'?deferredHarnessFingerprint(root):tiledHarnessFingerprint(root))).sha256)throw Error('Inputs changed during capture');
 const evidence={schemaVersion:1,tier:`diagnostic-g04-regression-${mode}`,generatedAt:new Date().toISOString(),inputs,harness,runnerSha256,build,mounts,revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0,result};
 const path=resolve(directory,`regression-${mode}-${preference}-${result.status}-${evidence.generatedAt.replaceAll(':','-')}.json`);await writeFile(path,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({path,status:result.status,error:result.error,adapter:result.adapter,cases:result.cases?.length}));
 if(mode==='reference')validateDeferredFixtureEvidence(result,{mode:'reference'});else validateTiledFixtureResult(result,'render');
}
