import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url)),sha=p=>createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex'),paths=[];
function scan(dir){for(const e of readdirSync(resolve(root,dir),{withFileTypes:true})){const p=`${dir}/${e.name}`;if(e.isDirectory())scan(p);else if(/\.(?:ts|wgsl|js)$/u.test(p))paths.push(p);}}
scan('engine/src');scan('engine/dist');paths.push('engine/test/gui-region-input.html','engine/test/gui-region-input-fixture.mjs','engine/test/gui-region-input-gate.mjs','config/layout-022-contract.json');
const fingerprints=Object.fromEntries(paths.map(p=>[p,sha(p)]));let report;
try{
 report=await runChromeWebGpuFixture({root,fixture:'engine/test/gui-region-input.html',timeoutMs:60000,acceptedStatuses:['passed','failed'],interact:async cdp=>{
  const evaluate=async expression=>{const r=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
  try{
   let ready=false;for(let n=0;n<200;n++){if(await evaluate("document.querySelector('canvas')?.dataset.ready==='true'")){ready=true;break;}if(await evaluate("document.querySelector('#result')?.dataset.status==='failed'"))return;await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'Region fixture readiness');
   const check=async id=>evaluate(`window.probe.check(${JSON.stringify(id)})`);
   let data=await check('static-retained-frame');assert.equal(data.actual.submitted,false);assert.equal(data.actual.stats.updates,0);
   const point={x:59,y:90.5};const mouse=async type=>cdp.call('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
   await mouse('mousePressed');await mouse('mouseReleased');data=await check('fractional-negative-origin-css-scaled-click');assert.equal(data.clicks,1);assert.equal(data.focus,'a');assert.deepEqual(data.scene,[]);assert.equal(data.actual.stats.updates,1);
   await evaluate("document.querySelector('canvas').focus()");await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',code:'Tab',key:'Tab'});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',code:'Tab',key:'Tab'});data=await check('tab-focus-cache-invalidation');assert.equal(data.focus,'b');assert.equal(data.actual.stats.updates,1);
   data=await check('unchanged-focus-stays-idle');assert.equal(data.actual.stats.updates,0);assert.equal(data.actual.submitted,false);
   await mouse('mousePressed');await evaluate("window.dispatchEvent(new Event('blur'))");await mouse('mouseReleased');data=await check('blur-cancels-owned-sequence');assert.equal(data.cancels,1);assert.equal(data.clicks,1);assert.deepEqual(data.scene,[]);
   await mouse('mousePressed');await evaluate('window.probe.disable()');await mouse('mouseReleased');data=await evaluate('window.probe.state()');assert.equal(data.cancels,2);assert.equal(data.clicks,1);assert.equal(data.pressed,false);
   await check('inactive-world-cannot-click');
   const final=await evaluate('window.probe.finish()');await evaluate(`(()=>{const n=document.querySelector('#result');n.dataset.status='passed';n.textContent=${JSON.stringify(JSON.stringify(final))};})()`);
  }catch(error){await evaluate(`(()=>{const n=document.querySelector('#result');n.dataset.status='failed';n.textContent=${JSON.stringify(JSON.stringify({status:'failed',error:String(error.stack??error)}))};})()`);}
 }});
}catch(error){report={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
const changed=paths.filter(p=>sha(p)!==fingerprints[p]);if(changed.length)report={...report,status:'failed',changed};
const served=report.httpProvenance?.files??[],mismatches=served.filter(f=>{try{return sha(f.sourcePath)!==f.sha256;}catch{return true;}});if(!served.length||mismatches.length)report={...report,status:'failed',servedByteMismatch:mismatches};
const out=resolve(root,`artifacts/engine-0.2.2/g05/native-region-input-${Date.now()}.json`);writeFileSync(out,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),fingerprints,servedByteAudit:{files:served.length,mismatches:mismatches.map(f=>f.sourcePath)},...report},null,2)+'\n');console.log(JSON.stringify({out,status:report.status,cases:report.caseCount,error:report.error}));if(report.status!=='passed'||report.caseCount!==6)process.exitCode=1;
