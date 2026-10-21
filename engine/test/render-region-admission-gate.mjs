import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateWorkingSetContract} from '../../scripts/fixtures/layout-contracts/working-set-policy.mjs';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
import {validateCompleteAdmissionReport} from './render-region-admission-policy.mjs';
if(process.argv.length>2)throw Error('Cache admission probe accepts no arguments.');
const root=fileURLToPath(new URL('../..',import.meta.url)),paths=[],spec={id:'admission',fixture:'admission',mounted:true,count:90,query:{},workload:{sizes:[[384,216],[1024,720]],sidebar:96,msaa:[1,4],clearModes:['on-update','once','never-after-initialization'],pixelTolerance:2,externalPressureBytes:62914560,cacheLimitBytes:67108864,cacheLimitRegions:8,reference:'independent immediately submitted whole-output actual Render3D and GUI',layerContract:'complete GUI layer; per-sample display-linear3D history while cached, reinitialized for new/direct storage',referenceAdditionalWork:'full-window history plus final presentation are oracle overhead, not a production performance baseline',qualification:'Correctness/admission diagnostic only'}};
const mounted=spec.mounted;
if(mounted)execFileSync(process.execPath,[resolve(root,'scripts/build-rollup-once.mjs'),'rollup.region-tests.config.js','--expect','../artifacts/engine-0.2.2/g04/target-bundle'],{cwd:resolve(root,'engine'),stdio:'pipe'});
function sources(dir){for(const e of readdirSync(resolve(root,dir),{withFileTypes:true})){const path=`${dir}/${e.name}`;if(e.isDirectory())sources(path);else if(path.endsWith('.ts'))paths.push(path)}}
for(const dir of ['engine/src/gui','engine/src/renderer/regions','engine/src/core','engine/src/rtt','engine/src/postprocess','engine/src/systems','engine/src/frame','engine/src/renderer','engine/src/material','engine/src/geometry','engine/src/components','engine/src/assets','engine/src/shaders/generated','engine/src/shader'])sources(dir);
paths.push('engine/src/renderer/RenderPipeline.ts','engine/test/fixtures/render-region-pipeline.html','engine/test/fixtures/render-region-pipeline.mjs','engine/test/render-region-admission-gate.mjs');
paths.push('config/layout-022-contract.json','config/region-working-set-022-contract.json','scripts/fixtures/layout-contracts/working-set-policy.mjs');
paths.push('engine/src/shaders/generated/2d-ui-region-history.generated.wgsl','shader-language/scripts/generate-gui-region-history-production.mjs','shader-language/src/render-family/stdlib/2d-ui/gui-region-history.wgsl');
if(mounted)paths.push('engine/rollup.region-tests.config.js');
paths.push(`engine/test/fixtures/render-region-${spec.fixture}.html`,`engine/test/fixtures/render-region-${spec.fixture}.mjs`);
paths.push('engine/test/render-region-admission-policy.mjs','engine/test/render-region-admission-policy.test.mjs');
if(spec.fixture==='scene-effects')paths.push('engine/test/fixtures/render-region-motion-probe.mjs');
if(spec.preview)paths.push('examples/manifest.json','examples/region-rendering/main.ts','examples/region-rendering/index.html');
const sha=p=>createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex'),fingerprints=Object.fromEntries(paths.map(p=>[p,sha(p)]));
validateWorkingSetContract(JSON.parse(readFileSync(resolve(root,'config/region-working-set-022-contract.json'),'utf8')));
let result;try{result=await runChromeWebGpuFixture({root,fixture:`engine/test/fixtures/render-region-${spec.fixture}.html`,query:spec.query,mounts:mounted?[{prefix:'/region-target-build',directory:resolve(root,'artifacts/engine-0.2.2/g04/target-bundle')}]:[],acceptedStatuses:['passed','failed'],timeoutMs:60000})}catch(error){result={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure}}
if(result.status==='passed')try{result.reportAudit={status:'passed',...validateCompleteAdmissionReport(result)}}catch(error){result={...result,status:'failed',reportAudit:{status:'failed',error:String(error)}}}
const changed=paths.filter(p=>sha(p)!==fingerprints[p]);if(changed.length)result={...result,status:'failed',sourceChangedDuringRun:changed};
const served=result.httpProvenance?.files??[],mismatches=served.filter(row=>{
  const path=mounted&&row.sourcePath.startsWith('region-target-build/')?resolve(root,'artifacts/engine-0.2.2/g04/target-bundle',row.sourcePath.slice('region-target-build/'.length)):resolve(root,row.sourcePath);
  try{return sha(path)!==row.sha256||readFileSync(path).byteLength!==row.byteLength}catch{return true}
}).map(row=>row.sourcePath);
result={...result,servedByteAudit:{status:served.length&&!mismatches.length?'passed':'failed',files:served.length,mismatches}};
if(!served.length||mismatches.length)result.status='failed';
if(spec.preview&&result.previewPngDataUrl){const previewPath=`artifacts/engine-0.2.2/g04/example-preview-${Date.now()}.png`,bytes=Buffer.from(result.previewPngDataUrl.split(',')[1],'base64');writeFileSync(resolve(root,previewPath),bytes);delete result.previewPngDataUrl;result.preview={path:previewPath,byteLength:bytes.byteLength,sha256:sha(previewPath)};}
const dirty=execFileSync('git',['status','--porcelain=v1','--untracked-files=all','--','engine/src','engine/test','scripts/engine-module-contracts.mjs','scripts/check-engine-module-boundaries.mjs','shader-language/src/render-family/stdlib/2d-ui'],{cwd:root,encoding:'utf8'}).trim().length>0;
const out=resolve(root,`artifacts/engine-0.2.2/g04/native-${spec.id}-${Date.now()}.json`);mkdirSync(resolve(out,'..'),{recursive:true});const temporary=out+'.tmp';writeFileSync(temporary,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty,sourceSnapshot:'Working-tree fingerprints; not a release candidate',acceptance:'diagnostic-correctness-only',memoryContract:'engine-022-g04-working-set-v1',workload:spec.workload,fingerprints,...result},null,2)+'\n');renameSync(temporary,out);console.log(JSON.stringify({out,status:result.status,cases:result.caseCount,error:result.error}));if(result.status!=='passed'||result.caseCount!==spec.count)process.exitCode=1;
