import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {decodePng} from '../../scripts/visual-regression/png.mjs';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url)),dir=resolve(root,'artifacts/engine-0.2.2/g07/public-ui-'+Date.now());mkdirSync(dir,{recursive:true});const cases=[];let report;
try{report=await runChromeWebGpuFixture({root,fixture:'examples/gui-runtime/index.html',query:{'theme-skins':1},timeoutMs:60000,acceptedStatuses:['passed','failed'],interact:async cdp=>{
 const evaluate=async expression=>{const r=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
 const state=()=>evaluate("(()=>{const c=document.querySelector('canvas');return c?.dataset.ready==='true'&&c.dataset.themeSkins?JSON.parse(c.dataset.themeSkins):null;})()");
 const wait=async predicate=>{for(let i=0;i<200;i++){const result=await state();if(result&&predicate(result))return result;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Theme example readiness/state timed out');};
 const click=async(x,y)=>{for(const type of ['mousePressed','mouseReleased'])await cdp.call('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});};
 const snapshot=async name=>{await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const r=await cdp.call('Page.captureScreenshot',{format:'png'}),bytes=Buffer.from(r.result.data,'base64');writeFileSync(resolve(dir,name+'.png'),bytes);return decodePng(bytes);};
 const publish=async data=>evaluate(`(()=>{const node=document.createElement('pre');node.id='result';node.dataset.status=${JSON.stringify(data.status)};node.textContent=${JSON.stringify(JSON.stringify(data))};document.body.append(node);})()`);
 try{
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:960,height:540,deviceScaleFactor:1,mobile:false});let initial=await wait(s=>s.selected===0);assert.equal(initial.value,'Player');const before=await snapshot('theme-cyan');
  await click(269,178);let changed=await wait(s=>s.selected===1);assert.equal(changed.focus,'theme-switch');assert.equal(changed.value,initial.value);assert.deepEqual(changed.tree,initial.tree);const after=await snapshot('theme-amber');
  let different=0;for(let y=158;y<198;y++)for(let x=28;x<168;x++){const p=(y*before.width+x)*4;if(before.data.subarray(p,p+3).some((n,k)=>Math.abs(n-after.data[p+k])>8))different++;}assert.ok(different>2500,'Resource-only replacement must visibly reskin the existing button');cases.push({id:'trusted-click-resource-only-reskin-keeps-tree-value-focus',differentPixels:different});
  await click(269,178);changed=await wait(s=>s.selected===0);assert.deepEqual(changed.tree,initial.tree);cases.push({id:'switch-back-preserves-control-identities'});
  const noToast=await snapshot('theme-restored');await click(99,178);changed=await wait(s=>s.focus==='theme-save');assert.equal(changed.value,'Player');await new Promise(resolve=>setTimeout(resolve,250));const toast=await snapshot('theme-save-toast');let toastPixels=0;for(let y=322;y<366;y++)for(let x=26;x<342;x++){const p=(y*toast.width+x)*4;if(toast.data.subarray(p,p+3).some((n,k)=>Math.abs(n-noToast.data[p+k])>8))toastPixels++;}assert.ok(toastPixels>2000,'Save callback must show the real Toast');cases.push({id:'existing-save-button-still-operates-after-reskin',toastPixels});
  await evaluate("window.dispatchEvent(new Event('pagehide'))");assert.equal(await evaluate("document.querySelector('canvas').dataset.themeSkins??null"),null);cases.push({id:'example-teardown-releases-observer-and-runtime-binding'});await publish({status:'passed',caseCount:cases.length,cases});
 }catch(error){await publish({status:'failed',error:String(error.stack??error),caseCount:cases.length,cases});}
}});}catch(error){report={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
const served=report.httpProvenance?.files??[],mismatches=served.filter(f=>createHash('sha256').update(readFileSync(resolve(root,f.sourcePath))).digest('hex')!==f.sha256);if(!served.length||mismatches.length)report={...report,status:'failed',servedByteMismatch:mismatches};
writeFileSync(resolve(dir,'result.json'),JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),...report},null,2)+'\n');console.log(JSON.stringify({dir,status:report.status,cases:report.caseCount,error:report.error}));if(report.status!=='passed'||report.caseCount!==4)process.exitCode=1;
