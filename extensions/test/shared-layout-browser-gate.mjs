import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
import {oracleCases} from './shared-layout-oracle-cases.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url)),build=resolve(root,'artifacts/engine-0.2.2/g02/pure-layout');
const dpr=Number(process.argv[2]??1);if(![1,2].includes(dpr))throw Error('Expected DPR 1 or 2');
execFileSync(process.execPath,[resolve(root,'node_modules/typescript/bin/tsc'),'-p','extensions/test/shared-layout-pure-tsconfig.json'],{cwd:root,stdio:'pipe'});
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const dirty=execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'});
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),fingerprints={};
for(const dir of ['extensions/src/layout','extensions/src/animation/layout/parameterized'])for(const e of readdirSync(resolve(root,dir),{withFileTypes:true}))if(e.isFile()&&e.name.endsWith('.ts'))fingerprints[`${dir}/${e.name}`]=hash(resolve(root,dir,e.name));
for(const p of ['extensions/src/layout.ts','extensions/test/shared-layout-oracle-cases.mjs','extensions/test/shared-layout-oracle.mjs','extensions/test/shared-layout-browser-gate.mjs','config/layout-022-contract.json'])fingerprints[p]=hash(resolve(root,p));
let result;
try{result=await runChromeWebGpuFixture({root,fixture:'extensions/test/shared-layout-oracle.html',query:{dpr},interact:async cdp=>{await cdp.call('Emulation.setDeviceMetricsOverride',{width:960,height:540,deviceScaleFactor:dpr,mobile:false});},mounts:[{prefix:'/shared-layout-build',directory:build}],timeoutMs:90000,acceptedStatuses:['passed','failed']});}
catch(error){result={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
const output=resolve(root,`artifacts/engine-0.2.2/g02/oracle-dpr${dpr}-${Date.now()}.json`);mkdirSync(resolve(output,'..'),{recursive:true});
writeFileSync(output,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),sourceRevision:revision,workingTree:dirty,purpose:'correctness geometry differential, not formal performance evidence',fingerprints,...result},null,2)+'\n');
console.log(JSON.stringify({output:relative(root,output),status:result.status,cases:result.cases,failures:result.failures}));
if(result.status!=='passed'||result.dpr!==dpr||result.cases!==oracleCases.length||result.failures?.length)throw Error('Shared layout reference differential failed; all observations retained at '+output);
