import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url)),startedAt=new Date().toISOString();
const out=resolve(root,`artifacts/engine-0.2.2/g05/controller-${Date.now()}.json`),sha=p=>createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex');
const paths=[];function scan(dir){for(const e of readdirSync(resolve(root,dir),{withFileTypes:true})){const p=`${dir}/${e.name}`;if(e.isDirectory())scan(p);else if(/\.(?:ts|js|html)$/u.test(p))paths.push(p);}}
scan('engine/src/gui');scan('engine/src/input');scan('examples/gui-runtime');paths.push('engine/src/components/KeyboardComponent.ts','engine/test/gui-controller-manual-gate.mjs','examples/shared/engine.js');
const fingerprints=Object.fromEntries(paths.map(p=>[p,sha(p)]));
mkdirSync(resolve(out,'..'),{recursive:true});writeFileSync(out,JSON.stringify({status:'waiting-for-physical-controller',startedAt,fingerprints},null,2)+'\n');
console.log(JSON.stringify({status:'opening-visible-controller-workflow',out}), '\nHold D-pad RIGHT for at least 0.5 seconds (volume 5 to 6), release → RB → A (hints on) → RB → A (open) → A (save) → A (reopen) → B (cancel). Release each button before the next press. Keep the test window focused.');
let result,last;
try{
 result=await runChromeWebGpuFixture({root,fixture:'examples/gui-runtime/index.html',query:{'input-navigation':1},timeoutMs:900000,acceptedStatuses:['passed','failed'],presentation:{mode:'visible',width:1100,height:760},interact:async cdp=>{
  const evaluate=async expression=>{const r=await cdp.call('Runtime.evaluate',{expression,returnByValue:true});if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
  const start=Date.now();let ready=false;
  // Observe the page only. No synthetic gamepads, DOM input events or CDP input commands.
  while(Date.now()-start<850000){
   last=await evaluate("(()=>{const c=document.querySelector('canvas');return c?.dataset.inputNavigation?JSON.parse(c.dataset.inputNavigation):null;})()");
   if(last&&!ready){ready=true;console.log('CONTROLLER WORKFLOW READY',out);}
   if(last?.devices?.some(d=>d.index===0)&&last.saveCount>=1&&last.cancelCount>=1&&last.hints===true&&last.volume!==5&&!last.modal&&last.focus==='review-settings')break;
   await new Promise(r=>setTimeout(r,500));
  }
  assert.ok(last?.devices.some(d=>d.index===0),'No physical browser gamepad at index 0');
  assert.ok(last.saveCount>=1&&last.cancelCount>=1&&last.hints===true&&last.volume!==5&&!last.modal&&last.focus==='review-settings','Physical settings workflow did not complete');
  assert.equal(last.sceneActions,0,'GUI input also activated a scene action');
  assert.equal(last.volume,6,'One right press must change volume from 5 to 6 only');
  assert.equal(last.saveCount,1,'Confirmation must save once, not once per held frame');
  assert.equal(last.cancelCount,1,'Cancellation must occur once');
  assert.ok(last.maxButtonHoldFrames?.[0]?.[15]>=10,'Hold D-pad RIGHT for at least 0.5 seconds so repeat suppression is exercised');
  const trace=last.trace.filter(e=>e.source==='physical-gamepad-sampler'&&e.consumed),expect=[e=>(e.action==='right'||e.action==='left')&&e.focus==='volume',e=>e.action==='next'&&e.focus==='hints',e=>e.action==='confirm'&&e.focus==='hints',e=>e.action==='next'&&e.focus==='review-settings',e=>e.action==='confirm'&&e.focus!=='review-settings',e=>e.action==='confirm'&&e.focus==='review-settings',e=>e.action==='confirm'&&e.focus!=='review-settings',e=>e.action==='cancel'&&e.focus==='review-settings'];
  let cursor=0;for(const event of trace)if(expect[cursor]?.(event))cursor++;
  assert.equal(cursor,expect.length,'Physical trace lacks the declared ordered workflow');
  assert.equal(last.trace.length,8,'Exactly eight physical press actions are required; held frames must not repeat');
  assert.equal(trace.length,8,'Every declared UI action must be consumed');
  assert.deepEqual(trace.map(e=>e.action),['right','next','confirm','next','confirm','confirm','confirm','cancel']);
  assert.ok(trace.every(e=>Number.isSafeInteger(e.tick)&&e.raw?.[0]?.buttons?.some(value=>value>=0.5)),'Each physical action must retain its raw sampled button evidence');
  await evaluate("window.dispatchEvent(new Event('pagehide'))");const cleanup=await evaluate("JSON.parse(document.querySelector('canvas').dataset.inputNavigation)");assert.equal(cleanup.disposed,true);
  const data={status:'passed',caseCount:1,startedAt,completedAt:new Date().toISOString(),workflow:'volume → hints → modal confirm → restore → modal cancel → restore',device:last.devices,state:last,cleanup,qualification:'Physical standard Gamepad API sampled by the one production host sampler. CDP observed state only; no synthetic device/input injection. Human operation confirmation recorded separately.'};
  await evaluate(`(()=>{const n=document.createElement('pre');n.id='result';n.dataset.status='passed';n.textContent=${JSON.stringify(JSON.stringify(data))};document.body.append(n);})()`);
 }});
}catch(error){result={status:'failed',startedAt,error:String(error.stack??error),browserFailure:error.browserFailure,last};}
const changed=paths.filter(p=>sha(p)!==fingerprints[p]);if(changed.length)result={...result,status:'failed',changed};
const served=result.httpProvenance?.files??[],mismatches=served.filter(f=>{try{return sha(f.sourcePath)!==f.sha256;}catch{return true;}});if(!served.length||mismatches.length)result={...result,status:'failed',servedByteMismatch:mismatches};
writeFileSync(out,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),fingerprints,...result},null,2)+'\n');console.log(JSON.stringify({out,status:result.status,error:result.error}));if(result.status!=='passed')process.exitCode=1;
