import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url));let report;
try{report=await runChromeWebGpuFixture({root,fixture:'engine/test/gui-grapheme-color.html',timeoutMs:60000,acceptedStatuses:['passed','failed']});}catch(error){report={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
const served=report.httpProvenance?.files??[],mismatches=served.filter(f=>createHash('sha256').update(readFileSync(resolve(root,f.sourcePath))).digest('hex')!==f.sha256);
if(!served.length||mismatches.length)report={...report,status:'failed',servedByteMismatch:mismatches};
const dir=resolve(root,'artifacts/engine-0.2.2/g06');mkdirSync(dir,{recursive:true});const out=resolve(dir,`grapheme-color-${Date.now()}.json`);writeFileSync(out,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),...report},null,2)+'\n');console.log(JSON.stringify({out,status:report.status,cases:report.caseCount,error:report.error}));if(report.status!=='passed'||report.caseCount!==6)process.exitCode=1;
