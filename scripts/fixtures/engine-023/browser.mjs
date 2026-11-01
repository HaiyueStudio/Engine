import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import {runChromeWebGpuFixture} from '../../webgpu-gate/chrome-runner.mjs';

const root=resolve(import.meta.dirname,'../../..'),mode=process.argv[2];
if(!['native-reference','icon-oracle'].includes(mode))throw Error('Expected native-reference or icon-oracle');
const hash=p=>createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex');
const dir=resolve(root,'artifacts/engine-0.2.3/g01');mkdirSync(dir,{recursive:true});
if(mode==='icon-oracle')writeFileSync(resolve(dir,'gui-content-reference.mjs'),ts.transpileModule(readFileSync(resolve(root,'engine/src/gui/GuiContent.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
const fixture=mode==='native-reference'?'scripts/fixtures/layout-contracts/region-baseline.html':'scripts/fixtures/engine-023/icon-oracle.html';
let result;
try{result=await runChromeWebGpuFixture({root,fixture,timeoutMs:90000,acceptedStatuses:['passed','failed']});}
catch(error){result={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
const inputs=[fixture,mode==='native-reference'?'scripts/fixtures/layout-contracts/region-baseline.mjs':'scripts/fixtures/engine-023/icon-oracle.mjs','engine/dist/gui.js','engine/dist/experimental.js','engine/src/gui/GuiContent.ts'];
const report={schemaVersion:1,generatedAt:new Date().toISOString(),qualification:false,
  purpose:mode==='native-reference'?'Direct redraw reference only; does not exercise retained-region optimization or grant production cadence qualification. The historical fixture note refers only to this reference path.':'Independent DOM oracle; left compared with current source, right is a frozen target reference, not an implemented claim.',
  revision:execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),'rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  inputs:inputs.map(path=>({path,sha256:hash(path)})),...result};
const output=resolve(dir,mode+(result.status==='passed'?'':'-failed-'+Date.now())+'.json');
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,output:relative(root,output),adapter:result.adapter,cases:result.cases?.length,cohorts:result.cohorts?.map(c=>({msaa:c.samples,cpuP95:c.p95CpuMs,cadenceP95:c.p95CadenceMs}))}));
if(result.status!=='passed')process.exitCode=1;
