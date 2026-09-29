import {parseCompatibilityOptions} from './deferred-compatibility-policy.mjs';
import {validateG04Lifecycle} from './deferred-g04-lifecycle-policy.mjs';
import {runChromeWebGpuFixture} from './chrome-runner.mjs';
import {deferredRuntimeFingerprint,sha256} from './deferred-fixture-policy.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {preference}=parseCompatibilityOptions(process.argv.slice(2)),directory=resolve(root,'artifacts/engine-0.2.1/g04');
const inputs=await deferredRuntimeFingerprint(root),build=JSON.parse(await readFile(resolve(directory,'fixture-build.json'),'utf8'));
if(build.inputs.sha256!==inputs.sha256)throw Error('Stale G04 runtime; rebuild --compatibility');
for(const output of build.outputs)if(sha256(await readFile(resolve(directory,output.file)))!==output.sha256)throw Error(`Stale chunk ${output.file}`);
async function fingerprintHarness(){
  const files=['deferred-compatibility-policy.mjs','deferred-g04-lifecycle-policy.mjs','deferred-g04-lifecycle-fixture.html','deferred-g04-lifecycle-fixture.mjs','deferred-g04-lifecycle.mjs','run-deferred-g04-lifecycle.mjs','float-texture-readback.mjs','chrome-runner.mjs'];
  return sha256(JSON.stringify(await Promise.all(files.map(async file=>({file,sha256:sha256(await readFile(resolve(root,'scripts/webgpu-gate',file)))})))));
}
const harness=await fingerprintHarness();
let result;
try{result=await runChromeWebGpuFixture({root,fixture:'scripts/webgpu-gate/deferred-g04-lifecycle-fixture.html',query:{powerPreference:preference},timeoutMs:360000,acceptedStatuses:['passed','failed']});}
catch(error){result={schemaVersion:1,status:'failed',stage:'browser-infrastructure',error:error.stack??String(error)};}
if(inputs.sha256!==(await deferredRuntimeFingerprint(root)).sha256||harness!==await fingerprintHarness())throw Error('Source changed during G04 capture');
const evidence={schemaVersion:1,tier:'diagnostic-g04-lifecycle',generatedAt:new Date().toISOString(),inputs,harness,build,
  revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0,result};
const path=resolve(directory,`lifecycle-${preference}-${result.status}-${evidence.generatedAt.replaceAll(':','-')}.json`);
await writeFile(path,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({path,status:result.status,error:result.error,adapter:result.adapter,cases:result.cases?.length,maxDelta:result.cases&&Math.max(...result.cases.map(c=>c.maxDelta)),cleanup:result.cleanup}));
validateG04Lifecycle(result);
