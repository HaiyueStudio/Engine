import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
const root=resolve(import.meta.dirname,'..');
const result=await runChromeWebGpuFixture({root,fixture:'scripts/webgpu-gate/gui-cache-fixture.html',timeoutMs:90000});
if(result.status!=='passed'||result.frames!==16||result.validationErrors.length)throw Error(JSON.stringify(result));
mkdirSync(resolve(root,'artifacts/gui-cache'),{recursive:true});writeFileSync(resolve(root,'artifacts/gui-cache/webgpu.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
