import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url)),dpr=Number(process.argv[2]??1),build=resolve(root,'artifacts/engine-0.2.2/g08/compiled'),out=resolve(root,'artifacts/engine-0.2.2/g08/native-dpr'+dpr+'-'+Date.now());mkdirSync(out,{recursive:true});
execFileSync(process.execPath,[resolve(root,'node_modules/typescript/bin/tsc'),'--target','ESNext','--module','ESNext','--moduleResolution','bundler','--strict','--noUncheckedIndexedAccess','--exactOptionalPropertyTypes','--skipLibCheck','--types','@webgpu/types','--rootDir','extensions/src','--outDir',build,'extensions/src/gui-layout.ts'],{cwd:root,stdio:'pipe'});
const sha=p=>createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex'),paths=[];
function scan(dir){for(const item of readdirSync(resolve(root,dir),{withFileTypes:true})){const p=dir+'/'+item.name;if(item.isDirectory())scan(p);else if(/\.(ts|js|mjs|html|wgsl)$/u.test(p))paths.push(p);}}
for(const dir of ['engine/src/gui','engine/dist','extensions/src/gui-layout','extensions/src/layout'])scan(dir);
paths.push('extensions/src/gui-layout.ts','extensions/test/gui-layout-panels-browser.html','extensions/test/gui-layout-panels-browser.mjs','extensions/test/gui-layout-panels-browser-gate.mjs');
const fingerprints=Object.fromEntries(paths.map(p=>[p,sha(p)]));let report;
try {report=await runChromeWebGpuFixture({root,fixture:'extensions/test/gui-layout-panels-browser.html',query:{dpr},mounts:[{prefix:'/g08-layout-build',directory:build}],timeoutMs:90000,acceptedStatuses:['passed','failed'],interact:async cdp=>{
 const evaluate=async expression=>{const r=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
 const publish=async data=>evaluate(`(()=>{const n=document.querySelector('#result');n.dataset.status=${JSON.stringify(data.status)};n.textContent=${JSON.stringify(JSON.stringify(data))};})()`);
 try {
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:900,height:640,deviceScaleFactor:dpr,mobile:false});
  let ready=false;for(let i=0;i<200;i++){if(await evaluate("document.querySelector('canvas').dataset.ready==='true'")){ready=true;break;}if(await evaluate("document.querySelector('#result').dataset.status==='failed'"))return;await new Promise(r=>setTimeout(r,50));}assert.ok(ready,'G08 fixture readiness');
  const check=async id=>{await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');return evaluate(`window.probe.check(${JSON.stringify(id)})`);},point=async id=>evaluate(`window.probe.point(${JSON.stringify(id)})`);
  const mouse=async(type,p)=>cdp.call('Input.dispatchMouseEvent',{type,...p,button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:1});
  const click=async id=>{const p=await point(id);await mouse('mousePressed',p);await mouse('mouseReleased',p);};
  const key=async(key,code=key)=>{await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key,code});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key,code});};
  let data=await check('static-region');assert.equal(data.actual.submitted,false);assert.equal(data.actual.regions.updates,0);
  assert.equal(data.actual.metrics.bufferUploads,0);const initialCounters=data.actual.counters;
  let p=await point('horizontal:divider');await mouse('mousePressed',p);await mouse('mouseMoved',{x:p.x+100,y:p.y});await mouse('mouseReleased',{x:p.x+100,y:p.y});data=await check('trusted-mouse-divider');assert.ok(data.state.ratio>.39);assert.equal(data.state.pressed,false);
  const before=data.state.ratio;await key('ArrowRight');data=await check('trusted-keyboard-divider');assert.ok(Math.abs(data.state.ratio-before-.02)<1e-6);
  p=await point('vertical:divider');await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await cdp.call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x,y:p.y-35,id:1}]});await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});data=await check('trusted-touch-vertical-divider');assert.ok(data.state.verticalRatio<.7);
  p=await point('count');await mouse('mousePressed',p);data=await check('pending-page-control-press');assert.equal(data.state.counterPressed,true);
  await evaluate("window.probe.activate('b')");data=await check('page-switch-cancels-owned-pointer');assert.equal(data.state.cancels,1);assert.equal(data.state.counterPressed,false);
  await mouse('mouseReleased',p);data=await check('hidden-page-release-cannot-click');assert.equal(data.state.clicks,0);await click('tabs:tab:a:select');await check('return-after-cancel');
  await click('count');data=await check('business-counter');assert.equal(data.state.clicks,1);
  await click('tabs:tab:b:select');data=await check('trusted-page-switch');assert.equal(data.state.activeId,'b');assert.equal(data.state.clicks,1);
  data=await check('settled-page-static');assert.equal(data.actual.regions.updates,0);const dormant=data.actual.counters;
  await evaluate('window.probe.mutateInactive()');data=await check('inactive-update-keeps-region-asleep');assert.equal(data.actual.submitted,false);assert.equal(data.actual.regions.updates,0);assert.deepEqual(data.actual.counters,dormant);
  await key('ArrowLeft');data=await check('keyboard-activation-replays-pending-content');assert.equal(data.state.activeId,'a');assert.equal(data.state.text,'Changed while hidden');assert.equal(data.state.clicks,1);
  await click('tabs:tab:b:select');await check('second-page-before-close');await click('tabs:tab:b:close');data=await check('trusted-close-active-page');assert.equal(data.state.activeId,'c');assert.deepEqual(data.state.pages,['a','c']);
  await evaluate("window.probe.hide('c',false)");data=await check('hide-active-falls-back');assert.equal(data.state.activeId,'a');
  const saved=await evaluate('window.probe.save()');await evaluate("window.probe.move('c',0);window.probe.hide('c',true)");await check('stable-id-reorder-and-reveal');await evaluate(`window.probe.restore(${JSON.stringify(saved)})`);data=await check('serialized-layout-restoration');assert.equal(data.state.activeId,'a');assert.deepEqual(data.state.pages,['a','c']);
  await evaluate('window.probe.theme()');await check('theme-metrics-and-color-change');
  p=await point('horizontal:divider');const beforeCancel=(await evaluate('window.probe.state()')).ratio;await mouse('mousePressed',p);await mouse('mouseMoved',{x:p.x+30,y:p.y});await check('pending-drag-before-blur');await evaluate("window.dispatchEvent(new Event('blur'))");await mouse('mouseReleased',{x:p.x+30,y:p.y});data=await check('blur-cancels-owned-drag');assert.ok(Math.abs(data.state.ratio-beforeCancel)<1e-6);assert.equal(data.state.pressed,false);
  await evaluate('window.probe.resize(240,160)');await check('tiny-window-content-overflow');await evaluate('window.probe.resize(640,400)');await check('resize-restores-preferred-ratio');
  const final=await evaluate('window.probe.finish()');await publish({...final,initialCounters});
 } catch(error) {await publish({status:'failed',error:String(error.stack??error),lastState:await evaluate('window.probe?.state()')});}
}});}catch(error){report={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
const served=report.httpProvenance?.files??[],mismatch=served.filter(f=>{const path=f.sourcePath.startsWith('g08-layout-build/')?'artifacts/engine-0.2.2/g08/compiled/'+f.sourcePath.slice('g08-layout-build/'.length):f.sourcePath;return sha(path)!==f.sha256;});
const changed=paths.filter(p=>sha(p)!==fingerprints[p]);if(!served.length||mismatch.length||changed.length)report={...report,status:'failed',mismatch,changed};
writeFileSync(resolve(out,'result.json'),JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),fingerprints,...report},null,2)+'\n');console.log(JSON.stringify({out,status:report.status,cases:report.caseCount,error:report.error,browserFailure:report.browserFailure}));if(report.status!=='passed')process.exitCode=1;
