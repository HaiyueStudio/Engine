import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateWorkingSetContract} from '../../scripts/fixtures/layout-contracts/working-set-policy.mjs';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
import {pendingGuiFixtureSpec,validatePendingGuiResult} from './render-region-pending-gui-policy.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url)),paths=[],spec=pendingGuiFixtureSpec(process.argv.slice(2));
const mounted=spec.mounted;
if(mounted)execFileSync(process.execPath,[resolve(root,'scripts/build-rollup-once.mjs'),'rollup.region-tests.config.js','--expect','../artifacts/engine-0.2.2/g04/target-bundle'],{cwd:resolve(root,'engine'),stdio:'pipe'});
function sources(dir){for(const e of readdirSync(resolve(root,dir),{withFileTypes:true})){const path=`${dir}/${e.name}`;if(e.isDirectory())sources(path);else if(path.endsWith('.ts'))paths.push(path)}}
for(const dir of ['engine/src/gui','engine/src/renderer/regions','engine/src/core','engine/src/rtt','engine/src/postprocess','engine/src/systems','engine/src/frame','engine/src/renderer','engine/src/material','engine/src/geometry','engine/src/components'])sources(dir);
paths.push('engine/src/renderer/RenderPipeline.ts','engine/test/fixtures/render-region-pipeline.html','engine/test/fixtures/render-region-pipeline.mjs','engine/test/render-region-pending-gui-gate.mjs');
paths.push('config/layout-022-contract.json','config/region-working-set-022-contract.json','scripts/fixtures/layout-contracts/working-set-policy.mjs');
if(mounted)paths.push('engine/rollup.region-tests.config.js');
paths.push('engine/test/render-region-pending-gui-policy.mjs','engine/test/render-region-pending-gui-policy.test.mjs',`engine/test/fixtures/render-region-${spec.fixture}.html`,`engine/test/fixtures/render-region-${spec.fixture}.mjs`);
if(spec.fixture==='scene-effects')paths.push('engine/test/fixtures/render-region-motion-probe.mjs');
if(spec.preview)paths.push('examples/manifest.json','examples/region-rendering/main.ts','examples/region-rendering/index.html');
const sha=p=>createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex'),fingerprints=Object.fromEntries(paths.map(p=>[p,sha(p)]));
validateWorkingSetContract(JSON.parse(readFileSync(resolve(root,'config/region-working-set-022-contract.json'),'utf8')));
let result;try{result=await runChromeWebGpuFixture({root,fixture:`engine/test/fixtures/render-region-${spec.fixture}.html`,query:spec.query,mounts:mounted?[{prefix:'/region-target-build',directory:resolve(root,'artifacts/engine-0.2.2/g04/target-bundle')}]:[],acceptedStatuses:['passed','failed'],timeoutMs:60000})}catch(error){result={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure}}
if(result.status==='passed')try{validatePendingGuiResult(result)}catch(error){result={...result,status:'failed',acceptanceError:String(error.stack??error)}}
const changed=paths.filter(p=>sha(p)!==fingerprints[p]);if(changed.length)result={...result,status:'failed',sourceChangedDuringRun:changed};
const served=result.httpProvenance?.files??[],mismatches=served.filter(row=>{
  const path=mounted&&row.sourcePath.startsWith('region-target-build/')?resolve(root,'artifacts/engine-0.2.2/g04/target-bundle',row.sourcePath.slice('region-target-build/'.length)):resolve(root,row.sourcePath);
  try{return sha(path)!==row.sha256||readFileSync(path).byteLength!==row.byteLength}catch{return true}
}).map(row=>row.sourcePath);
result={...result,servedByteAudit:{status:served.length&&!mismatches.length?'passed':'failed',files:served.length,mismatches}};
if(!served.length||mismatches.length)result.status='failed';
if(spec.preview&&result.previewPngDataUrl){const previewPath=`artifacts/engine-0.2.2/g04/example-preview-${Date.now()}.png`,bytes=Buffer.from(result.previewPngDataUrl.split(',')[1],'base64');writeFileSync(resolve(root,previewPath),bytes);delete result.previewPngDataUrl;result.preview={path:previewPath,byteLength:bytes.byteLength,sha256:sha(previewPath)};}
const dirty=execFileSync('git',['status','--porcelain=v1','--untracked-files=all','--','engine/src','engine/test','scripts/engine-module-contracts.mjs','scripts/check-engine-module-boundaries.mjs','shader-language/src/render-family/stdlib/2d-ui'],{cwd:root,encoding:'utf8'}).trim().length>0;
const out=resolve(root,`artifacts/engine-0.2.2/g04/native-${spec.id}-${Date.now()}.json`);mkdirSync(resolve(out,'..'),{recursive:true});writeFileSync(out,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty,sourceSnapshot:'Working-tree fingerprints; not a release candidate',acceptance:'diagnostic-correctness-only',memoryContract:'engine-022-g04-working-set-v1',workload:spec.workload,fingerprints,...result},null,2)+'\n');console.log(JSON.stringify({out,status:result.status,cases:result.caseCount,error:result.error}));if(result.status!=='passed'||result.caseCount!==spec.count)process.exitCode=1;
