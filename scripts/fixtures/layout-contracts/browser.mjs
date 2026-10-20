import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {runChromeWebGpuFixture} from '../../webgpu-gate/chrome-runner.mjs';
const root=resolve(import.meta.dirname,'../../..'),mode=process.argv[2];
if(!['oracle','region-baseline'].includes(mode))throw Error('Expected oracle or region-baseline');
let result;
try{result=await runChromeWebGpuFixture({root,fixture:`scripts/fixtures/layout-contracts/${mode}.html`,timeoutMs:90000,acceptedStatuses:['passed','failed']});}
catch(error){result={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
const suffix=result.status==='passed'?'':`-failed-${Date.now()}`;
const output=resolve(root,`artifacts/engine-0.2.2/g01/${mode}${suffix}.json`);mkdirSync(resolve(output,'..'),{recursive:true});
writeFileSync(output,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),contractSnapshot:JSON.parse(readFileSync(resolve(root,'config/layout-022-contract.json'),'utf8')),configSha256:createHash('sha256').update(readFileSync(resolve(root,'config/layout-022-contract.json'))).digest('hex'),...result},null,2)+'\n');
if(result.status!=='passed')throw Error(JSON.stringify(result));
console.log(JSON.stringify({output,status:result.status,adapter:result.adapter,cohorts:result.cohorts?.map(x=>({samples:x.samples,p95CpuMs:x.p95CpuMs,p95CadenceMs:x.p95CadenceMs})),referenceCases:result.results?.length}));
