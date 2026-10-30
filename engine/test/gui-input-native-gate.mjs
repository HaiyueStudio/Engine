import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url)),sha=p=>createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex');
const paths=[];
function scan(dir){for(const e of readdirSync(resolve(root,dir),{withFileTypes:true})){const p=`${dir}/${e.name}`;if(e.isDirectory())scan(p);else if(/\.(?:ts|mjs|html|js)$/u.test(p))paths.push(p);}}
scan('engine/src/gui');scan('engine/src/input');scan('examples/gui-runtime');paths.push('engine/src/components/KeyboardComponent.ts','engine/test/gui-input-native-gate.mjs','examples/shared/engine.js','config/layout-022-contract.json');
const fingerprints=Object.fromEntries(paths.map(p=>[p,sha(p)])),cases=[];
let report;
try{
 report=await runChromeWebGpuFixture({root,fixture:'examples/gui-runtime/index.html',query:{'input-navigation':1},timeoutMs:60000,acceptedStatuses:['passed','failed'],interact:async cdp=>{
  const evaluate=async expression=>{const r=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
  const wait=async(predicate,label)=>{const start=Date.now();while(Date.now()-start<20000){const value=await evaluate(`(()=>{const c=document.querySelector('canvas');return c?.dataset.ready==='true'&&c?.dataset.inputNavigation?JSON.parse(c.dataset.inputNavigation):null;})()`);if(value&&predicate(value))return value;await new Promise(r=>setTimeout(r,100));}throw Error(`Timed out: ${label}`);};
  const key=async(code,key=code,extra={})=>{await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',code,key,...extra});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',code,key,...extra});};
  const record=(id,data)=>cases.push({id,data});
  try{
   await wait(s=>s.focus==='volume','initial focus');await evaluate("document.querySelector('canvas').focus()");
   await key('ArrowRight');let s=await wait(s=>s.volume===6,'slider right');assert.equal(s.focus,'volume');record('slider-key-priority',s);
   await key('Tab','Tab');await wait(s=>s.focus==='hints','Tab to checkbox');await key('Space',' ');s=await wait(s=>s.hints===true,'checkbox confirm');assert.equal(s.sceneActions,0);record('confirm-consumed-before-scene',s);
   await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',code:'Space',key:' ',autoRepeat:true});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',code:'Space',key:' '});
   await key('Tab','Tab');s=await wait(s=>s.focus==='review-settings','repeat did not toggle checkbox');assert.equal(s.hints,true);record('repeat-confirm-once',s);
   await key('Enter');await wait(s=>s.modal===true,'open modal');await key('Escape');s=await wait(s=>s.cancelCount===1&&!s.modal&&s.focus==='review-settings','modal cancel and focus restoration');assert.equal(s.sceneActions,0);record('modal-cancel-restores-focus',s);
   await key('Enter');await wait(s=>s.modal,'reopen modal');await key('Enter');s=await wait(s=>s.saveCount===1&&!s.modal&&s.focus==='review-settings','confirm save and focus restoration');assert.equal(s.sceneActions,0);record('keyboard-production-workflow',s);
   const point=await evaluate("(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.left+45,y:r.top+245};})()");
   await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});s=await wait(s=>s.hints===false,'native mouse checkbox');record('native-mouse-single-activation',s);
   await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:9}]});await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});s=await wait(s=>s.hints===true,'native touch checkbox');assert.equal(s.sceneActions,0);record('native-touch-single-activation',s);
   await evaluate("window.dispatchEvent(new Event('pagehide'))");s=await evaluate("JSON.parse(document.querySelector('canvas').dataset.inputNavigation)");assert.equal(s.disposed,true);record('host-sampler-teardown',s);
   await evaluate(`(()=>{const node=document.createElement('pre');node.id='result';node.dataset.status='passed';node.textContent=${JSON.stringify(JSON.stringify({status:'passed',caseCount:cases.length,cases,qualification:'Current public-import WebGPU GUI example; CDP trusted keyboard/mouse/touch, not physical controller evidence.'}))};document.body.append(node);})()`);
  }catch(error){await evaluate(`(()=>{const n=document.createElement('pre');n.id='result';n.dataset.status='failed';n.textContent=${JSON.stringify(JSON.stringify({status:'failed',error:String(error.stack??error),caseCount:cases.length,cases}))};document.body.append(n);})()`);}
 }});
}catch(error){report={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure,cases};}
const changed=paths.filter(p=>sha(p)!==fingerprints[p]);if(changed.length)report={...report,status:'failed',changed};
const served=report.httpProvenance?.files??[],mismatches=served.filter(f=>{try{return sha(f.sourcePath)!==f.sha256||readFileSync(resolve(root,f.sourcePath)).byteLength!==f.byteLength;}catch{return true;}});
if(!served.length||mismatches.length)report={...report,status:'failed',servedByteMismatch:mismatches};
const out=resolve(root,`artifacts/engine-0.2.2/g05/native-input-${Date.now()}.json`);mkdirSync(resolve(out,'..'),{recursive:true});
writeFileSync(out,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),sourceSnapshot:'Working-tree fingerprints; no release qualification or baseline promotion',fingerprints,servedByteAudit:{files:served.length,mismatches:mismatches.map(f=>f.sourcePath)},...report},null,2)+'\n');
console.log(JSON.stringify({out,status:report.status,cases:report.caseCount,error:report.error}));if(report.status!=='passed'||report.caseCount!==8)process.exitCode=1;
