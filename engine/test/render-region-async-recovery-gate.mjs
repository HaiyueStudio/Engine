import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateWorkingSetContract} from '../../scripts/fixtures/layout-contracts/working-set-policy.mjs';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
import {validateAsyncRecoveryReport} from './render-region-async-recovery-policy.mjs';
if(process.argv.length>2)throw Error('Async GUI recovery probe accepts no arguments.');
const root=fileURLToPath(new URL('../..',import.meta.url)),paths=[],spec={id:'async-recovery',fixture:'async-recovery',count:72,workload:{canvasCss:[192,128],msaa:[1,4],pixelTolerance:2,scenarios:['during','after'],recoveriesPerCandidate:2,reference:'independent never-lost native Engine, explicit same-generation disabled control storage reset',qualification:'Native asynchronous GUI/device correctness only'}};
function sources(dir){for(const e of readdirSync(resolve(root,dir),{withFileTypes:true})){const path=`${dir}/${e.name}`;if(e.isDirectory())sources(path);else if(path.endsWith('.ts'))paths.push(path)}}
for(const dir of ['engine/src/gui','engine/src/renderer/regions','engine/src/core','engine/src/rtt','engine/src/postprocess','engine/src/systems','engine/src/frame','engine/src/renderer','engine/src/material','engine/src/geometry','engine/src/components','engine/src/assets','engine/src/scene','engine/src/ecs','engine/src/shaders/generated','engine/src/shader'])sources(dir);
paths.push('engine/src/index.ts','engine/src/experimental.ts','engine/src/gui.ts','engine/src/material.ts','engine/test/render-region-async-recovery-gate.mjs');
paths.push('engine/test/render-region-async-recovery-policy.mjs');
paths.push('config/layout-022-contract.json','config/region-working-set-022-contract.json','scripts/fixtures/layout-contracts/working-set-policy.mjs');
paths.push('engine/src/shaders/generated/2d-ui-region-history.generated.wgsl','shader-language/scripts/generate-gui-region-history-production.mjs','shader-language/src/render-family/stdlib/2d-ui/gui-region-history.wgsl');
paths.push(`engine/test/fixtures/render-region-${spec.fixture}.html`,`engine/test/fixtures/render-region-${spec.fixture}.mjs`);
const sha=p=>createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex'),fingerprints=Object.fromEntries(paths.map(p=>[p,sha(p)]));
validateWorkingSetContract(JSON.parse(readFileSync(resolve(root,'config/region-working-set-022-contract.json'),'utf8')));
let result;try{result=await runChromeWebGpuFixture({root,fixture:`engine/test/fixtures/render-region-${spec.fixture}.html`,acceptedStatuses:['passed','failed'],timeoutMs:120000})}catch(error){result={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure}}
if(result.status==='passed')try{result.reportAudit={status:'passed',...validateAsyncRecoveryReport(result)}}catch(error){result={...result,status:'failed',reportAudit:{status:'failed',error:String(error.stack??error)}}}
const changed=paths.filter(p=>sha(p)!==fingerprints[p]);if(changed.length)result={...result,status:'failed',sourceChangedDuringRun:changed};
const served=result.httpProvenance?.files??[],mismatches=served.filter(row=>{
  const path=resolve(root,row.sourcePath);
  try{return sha(path)!==row.sha256||readFileSync(path).byteLength!==row.byteLength}catch{return true}
}).map(row=>row.sourcePath);
result={...result,servedByteAudit:{status:served.length&&!mismatches.length?'passed':'failed',files:served.length,mismatches}};
if(!served.length||mismatches.length)result.status='failed';
const dirty=execFileSync('git',['status','--porcelain=v1','--untracked-files=all','--','engine/src','engine/test','scripts/engine-module-contracts.mjs','scripts/check-engine-module-boundaries.mjs','shader-language/src/render-family/stdlib/2d-ui'],{cwd:root,encoding:'utf8'}).trim().length>0;
const out=resolve(root,`artifacts/engine-0.2.2/g04/native-${spec.id}-${Date.now()}.json`);mkdirSync(resolve(out,'..'),{recursive:true});const temporary=out+'.tmp';writeFileSync(temporary,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty,sourceSnapshot:'Working-tree fingerprints; not a release candidate',acceptance:'diagnostic-correctness-only',memoryContract:'engine-022-g04-working-set-v1',workload:spec.workload,fingerprints,...result},null,2)+'\n');renameSync(temporary,out);console.log(JSON.stringify({out,status:result.status,cases:result.caseCount,error:result.error}));if(result.status!=='passed'||result.caseCount!==spec.count)process.exitCode=1;
