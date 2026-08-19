import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './chrome-runner.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const fixture='scripts/webgpu-gate/hybrid-ray-shadow-ray-reflection-ray-ao-fixture.html';
const browsers=[['chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],['edge','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']].filter(([,path])=>existsSync(path));
if(!browsers.length)throw new Error('G07 hybrid ray gate requires Chrome or Edge.');
const evidence=[];
for(const [name,path] of browsers){process.env.CHROME_PATH=path;process.env.WEBGPU_ANGLE_BACKEND='d3d11';const result=await runChromeWebGpuFixture({root,fixture,timeoutMs:90_000,acceptedStatuses:['passed']});if(result.status!=='ok'||!Object.values(result.checks).every(Boolean)||result.errors.length)throw new Error(`${name} hybrid ray verification failed: ${JSON.stringify(result)}`);evidence.push({browser:name,artifactHash:result.artifactHash,checks:result.checks,timestampQuery:result.timestampQuery,metrics:result.metrics,browserEvidence:result.browserEvidence,browserDiagnostics:result.browserDiagnostics,httpProvenance:result.httpProvenance});console.log(`[ray-hybrid:${name}] passed ${result.artifactHash.slice(0,16)}.`);}
console.log(JSON.stringify({status:'passed',effectCount:3,browsers:evidence},null,2));
