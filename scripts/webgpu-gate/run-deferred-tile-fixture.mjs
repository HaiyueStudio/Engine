import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {runChromeWebGpuFixture} from './chrome-runner.mjs';
import {generateDeferredTiledProduction} from '../../shader-language/scripts/generate-deferred-tiled-production.mjs';
import {deferredRuntimeFingerprint,sha256} from './deferred-fixture-policy.mjs';
import {parseTiledFixtureOptions,tiledHarnessFingerprint,validateTiledFixtureResult} from './deferred-tiled-policy.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=resolve(root,'artifacts/engine-0.2.1/g03');
const options=parseTiledFixtureOptions(process.argv.slice(2));
await mkdir(directory,{recursive:true});
const {artifact}=await generateDeferredTiledProduction();
await writeFile(resolve(directory,'tiled-artifact.json'),JSON.stringify(artifact));
const inputs=await deferredRuntimeFingerprint(root),harness=await tiledHarnessFingerprint(root);
let build;
if(options.mode==='render'){
  build=JSON.parse(await readFile(resolve(directory,'fixture-build.json'),'utf8'));
  if(build.inputs.sha256!==inputs.sha256)throw Error('Stale tiled runtime; rebuild with --tiled');
  for(const output of build.outputs)if(sha256(await readFile(resolve(directory,output.file)))!==output.sha256)throw Error('Tiled runtime chunk changed');
}
const result=await runChromeWebGpuFixture({root,fixture:`scripts/webgpu-gate/${options.mode==='render'?'deferred-tiled-render':'deferred-tile'}-fixture.html`,
  query:{powerPreference:options.preference},timeoutMs:180000,acceptedStatuses:['passed','failed']});
const evidence={schemaVersion:1,tier:`diagnostic-g03-${options.mode}`,generatedAt:new Date().toISOString(),inputs,harness,build,
  revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0,result};
const path=resolve(directory,`tile-${options.mode}-${options.preference}-${evidence.generatedAt.replaceAll(':','-')}.json`);
await writeFile(path,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
if(inputs.sha256!==(await deferredRuntimeFingerprint(root)).sha256||harness.sha256!==(await tiledHarnessFingerprint(root)).sha256)throw Error('Tiled inputs changed during capture');
if(result.status!=='passed')console.error(JSON.stringify({path,error:result.error}));
validateTiledFixtureResult(result,options.mode);
console.log(JSON.stringify({path,status:result.status,adapter:result.adapter,cases:result.cases?.length??1}));
