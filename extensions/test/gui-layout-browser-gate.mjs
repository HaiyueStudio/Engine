import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url)),build=resolve(root,'artifacts/engine-0.2.2/g03/compiled'),dpr=Number(process.argv[2]??1);
if(![1,2].includes(dpr))throw Error('Expected DPR 1 or 2');
execFileSync(process.execPath,[resolve(root,'node_modules/typescript/bin/tsc'),'--target','ESNext','--module','ESNext','--moduleResolution','bundler','--strict','--noUncheckedIndexedAccess','--exactOptionalPropertyTypes','--skipLibCheck','--types','@webgpu/types','--rootDir','extensions/src','--outDir',build,'extensions/src/gui-layout.ts'],{cwd:root,stdio:'pipe'});
const fingerprints={},hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const visit=dir=>{for(const e of readdirSync(resolve(root,dir),{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())visit(p);else if(e.name.endsWith('.ts'))fingerprints[p]=hash(resolve(root,p));}};
for(const dir of ['engine/src/gui','extensions/src/gui-layout','extensions/src/layout'])visit(dir);
for(const p of ['extensions/src/gui-layout.ts','extensions/test/gui-layout-browser.html','extensions/test/gui-layout-browser.mjs','extensions/test/gui-layout-browser-gate.mjs','config/layout-022-contract.json'])fingerprints[p]=hash(resolve(root,p));
let result;try{result=await runChromeWebGpuFixture({root,fixture:'extensions/test/gui-layout-browser.html',query:{dpr},mounts:[{prefix:'/g03-layout-build',directory:build}],interact:cdp=>cdp.call('Emulation.setDeviceMetricsOverride',{width:1000,height:800,deviceScaleFactor:dpr,mobile:false}),timeoutMs:90000,acceptedStatuses:['passed','failed']});}catch(error){result={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
const output=resolve(root,`artifacts/engine-0.2.2/g03/native-dpr${dpr}-${Date.now()}.json`);mkdirSync(resolve(output,'..'),{recursive:true});
writeFileSync(output,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),workingTree:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}),fingerprints,...result},null,2)+'\n');
console.log(JSON.stringify({output:relative(root,output),status:result.status,cases:result.caseCount,error:result.error}));
if(result.status!=='passed'||result.caseCount!==16||result.dpr!==dpr)throw Error('G03 native render verification failed: '+output);
