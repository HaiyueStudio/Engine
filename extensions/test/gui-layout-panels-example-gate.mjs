import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url)),out=resolve(root,'artifacts/engine-0.2.2/g08/example-'+Date.now());mkdirSync(out,{recursive:true});
const cases=[];let report;
try {report=await runChromeWebGpuFixture({root,fixture:'examples/gui-runtime/index.html',query:{'panels-tabs':1},timeoutMs:90000,acceptedStatuses:['passed','failed'],interact:async cdp=>{
 const evaluate=async expression=>{const r=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
 const state=()=>evaluate("(()=>{const c=document.querySelector('canvas');return c?.dataset.ready==='true'&&c.dataset.panelState?JSON.parse(c.dataset.panelState):null})()");
 const wait=async predicate=>{for(let i=0;i<300;i++){const data=await state();if(data&&predicate(data))return data;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Panel example not ready: '+await evaluate("document.querySelector('#status').textContent"));};
 const point=async id=>{const data=await state();const r=data.targets[id];assert.ok(r?.width>0&&r?.height>0,'Missing target '+id);return evaluate(`(()=>{const b=document.querySelector('canvas').getBoundingClientRect();return{x:b.x+${r.x+r.width/2}*b.width/${data.width},y:b.y+${r.y+r.height/2}*b.height/${data.height}}})()`);};
 const mouse=async(type,p)=>cdp.call('Input.dispatchMouseEvent',{type,...p,button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:1});
 const click=async id=>{const p=await point(id);await mouse('mousePressed',p);await mouse('mouseReleased',p);};
 const screenshot=async id=>{await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const r=await cdp.call('Page.captureScreenshot',{format:'png'});const bytes=Buffer.from(r.result.data,'base64');writeFileSync(resolve(out,id+'.png'),bytes);return createHash('sha256').update(bytes).digest('hex');};
 const publish=async value=>evaluate(`(()=>{const n=document.createElement('pre');n.id='result';n.dataset.status=${JSON.stringify(value.status)};n.textContent=${JSON.stringify(JSON.stringify(value))};document.body.append(n)})()`);
 try {
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:960,height:640,deviceScaleFactor:1,mobile:false});const initial=await wait(s=>s.activeId==='settings'&&s.targets['workspace-horizontal:divider']?.height>0);
  const before=await screenshot('settings');assert.equal(initial.value,'Retained page state');
  await click('update-hidden-preview');let current=await wait(s=>s.revision===1);assert.equal(current.activeId,'settings');
  await click('workspace-tabs:tab:preview:select');current=await wait(s=>s.activeId==='preview');assert.equal(current.previewText,'Preview revision 1');const preview=await screenshot('preview');assert.notEqual(preview,before);cases.push({id:'public-example-shows-pending-hidden-page-content',before,preview});
  await click('workspace-tabs:tab:settings:select');current=await wait(s=>s.activeId==='settings');assert.equal(current.value,initial.value);assert.equal(current.gain,5);cases.push({id:'switch-back-retains-business-values'});
  let p=await point('workspace-horizontal:divider');await mouse('mousePressed',p);await mouse('mouseMoved',{x:p.x+60,y:p.y});await mouse('mouseReleased',{x:p.x+60,y:p.y});current=await wait(s=>s.ratio>initial.ratio+.04);const resized=await screenshot('divider-drag');cases.push({id:'trusted-divider-resizes-composed-ui',ratio:current.ratio,sha256:resized});
  await click('workspace-tabs:tab:preview:select');await wait(s=>s.activeId==='preview');await click('workspace-tabs:tab:preview:close');current=await wait(s=>s.activeId==='help');assert.deepEqual(current.pages,['settings','help']);cases.push({id:'trusted-close-chooses-next-stable-page'});
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:700,height:480,deviceScaleFactor:2,mobile:false});await wait(s=>s.width===700);await screenshot('narrow-dpr2');cases.push({id:'production-window-resize-dpr2'});
  await evaluate("window.dispatchEvent(new Event('pagehide'))");assert.equal(await evaluate("document.querySelector('canvas').dataset.panelState??null"),null);cases.push({id:'teardown-detaches-controls-and-observer'});await publish({status:'passed',caseCount:cases.length,cases});
 } catch(error) {await publish({status:'failed',error:String(error.stack??error),cases});}
}});}catch(error){report={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
const served=report.httpProvenance?.files??[],mismatch=served.filter(f=>createHash('sha256').update(readFileSync(resolve(root,f.sourcePath))).digest('hex')!==f.sha256);if(!served.length||mismatch.length)report={...report,status:'failed',mismatch};
writeFileSync(resolve(out,'result.json'),JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),...report},null,2)+'\n');console.log(JSON.stringify({out,status:report.status,cases:report.caseCount,error:report.error}));if(report.status!=='passed')process.exitCode=1;
