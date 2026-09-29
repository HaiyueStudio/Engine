import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { decodePng } from './visual-regression/png.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),out=resolve(root,'artifacts/engine-0.2.1/g06');
mkdirSync(out,{recursive:true});
const inputs=['examples/deferred-lighting/main.ts','examples/deferred-lighting/model.ts','examples/deferred-lighting/index.html','examples/deferred-lighting/bundle.js','examples/shared/engine.js','engine/src/experimental/DeferredLightingProfile.ts','scripts/verify-deferred-lighting-example.mjs','scripts/webgpu-gate/chrome-runner.mjs'];
const evidence={schemaVersion:1,status:'running',scope:'interactive-example-correctness-not-performance-qualification',revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0,inputs:inputs.map(path=>({path,sha256:createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex')})),cases:[],startedAt:new Date().toISOString()};
try {
 const browser=await runChromeWebGpuFixture({root,fixture:'examples/deferred-lighting/index.html',query:{regression:1},timeoutMs:60000,visualCapture:{viewportWidth:1280,viewportHeight:800},navigateAwayAfterResult:true,interact:async cdp=>{
 const evaluate=async expression => { const result=(await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result; if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text); return result.result?.value; };
 const ready=async path => wait(async()=>{const state=await evaluate(`({status:document.body.dataset.renderStatus,data:JSON.parse(document.getElementById('result').textContent||'{}')})`); if(state.status==='failed')throw Error(JSON.stringify(state)); return state.status==='ready'&&state.data.frames>2&&(!path||state.data.stats?.effective===path)?state.data:null;});
 const set=async(id,value,type='change')=>evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)}); ${typeof value==='boolean'?'e.checked':'e.value'}=${JSON.stringify(value)};e.dispatchEvent(new Event(${JSON.stringify(type)},{bubbles:true}));})()`);
 const picture=async name=>{const shot=(await cdp.call('Page.captureScreenshot',{format:'png'})).result.data;writeFileSync(resolve(out,`${name}.png`),Buffer.from(shot,'base64'));return shot;};
 const scenePixels=async()=>{const clip=await evaluate(`(()=>{const r=document.getElementById('canvas').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()`);return decodePng(Buffer.from((await cdp.call('Page.captureScreenshot',{format:'png',clip})).result.data,'base64'));};
 const difference=(a,b)=>{assert.equal(a.data.length,b.data.length);let changed=0,sum=0;for(let i=0;i<a.data.length;i+=4){let d=0;for(let c=0;c<3;c++){d+=Math.abs(a.data[i+c]-b.data[i+c]);}if(d>12)changed++;sum+=d;}return{changed,mean:sum/(a.width*a.height*3)};};
 const initial=await ready('deferred-tiled'); evidence.adapter=initial.adapter;
 if(initial.timestampSupported) await wait(async()=> /ms/.test(await evaluate(`document.getElementById('gpu').textContent`)));
 evidence.gpuReadout=await evaluate(`document.getElementById('gpu').textContent`);
 await picture('128-lights');
 await set('helpers',false);await evaluate(`document.getElementById('status').style.display='none';document.getElementById('hint').style.display='none'`);
 for(const count of [1,8,9,32,128,256,512,1024]){await set('count',String(count));const s=await wait(async()=>{const s=await ready('deferred-tiled');return s.stats.submittedPoints===count?s:null;});evidence.cases.push({name:`lights-${count}`,submitted:s.stats.submittedPoints});}
 await set('count','128'); await wait(async()=> (await ready('deferred-tiled')).stats.submittedPoints===128); const tiled=await scenePixels();
 await set('path','reference');await ready('deferred-reference');const reference=await scenePixels();const comparison=difference(tiled,reference);assert.ok(comparison.mean<1,JSON.stringify(comparison));evidence.cases.push({name:'reference-tiled-pixels',...comparison});
 await evaluate(`document.getElementById('ninth').click()`);await wait(async()=>(await ready()).active===1);const ninthOn=await scenePixels();await set('enabled',false);await wait(async()=>(await ready()).active===0);const ninthOff=await scenePixels();const ninth=difference(ninthOn,ninthOff);assert.ok(ninth.changed>300,JSON.stringify(ninth));evidence.cases.push({name:'ninth-light-contribution',...ninth});await set('enabled',true);await picture('ninth-light');
 await evaluate(`document.getElementById('reset').click()`);await set('path','forward');await ready();const forwardDifference=difference(reference,await scenePixels());assert.ok(forwardDifference.changed>300,JSON.stringify(forwardDifference));evidence.cases.push({name:'forward-visible-capacity-difference',...forwardDifference});assert.match(await evaluate(`document.getElementById('notice').textContent`),/8 槽/);await picture('forward-limited');evidence.cases.push({name:'forward-capacity-warning'});
 await set('path','tiled');await ready('deferred-tiled');await set('distribution','overlap');await set('count','256');await set('display','tiles');await ready('deferred-tiled');await wait(async()=>!(await evaluate(`document.getElementById('debug').hidden`)));const tileText=await evaluate(`document.getElementById('debug-info').textContent`);assert.match(tileText,/实际列表/);assert.ok(!/· 0 块/.test(tileText));await picture('tile-overflow');evidence.cases.push({name:'gpu-tile-overflow',detail:tileText});
 await set('distribution','sparse');await set('count','128');
 for(const channel of ['base-color','normal','metallic','roughness','emissive','occlusion','depth','position']) {await set('display',channel);await ready('deferred-tiled');await wait(async()=>!(await evaluate(`document.getElementById('debug').hidden`))&&(await evaluate(`document.getElementById('debug-info').textContent`)).startsWith(channel));if(channel==='normal')await picture('gbuffer-normal');evidence.cases.push({name:`readback-${channel}`});}
 // An in-flight readback may be superseded by rapid asynchronous profile requests.
 await evaluate(`for(const path of ['reference','tiled','forward','tiled']){const e=document.getElementById('path');e.value=path;e.dispatchEvent(new Event('change'));}`);await ready('deferred-tiled');evidence.cases.push({name:'rapid-profile-latest-wins'});
 await set('motion',true);await new Promise(r=>setTimeout(r,300));await set('motion',false);evidence.cases.push({name:'motion-toggle'});
 await cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await new Promise(r=>setTimeout(r,600));await ready('deferred-tiled');assert.ok(await evaluate(`document.documentElement.scrollWidth<=document.documentElement.clientWidth`));await picture('mobile');evidence.cases.push({name:'responsive-resize'});
 const before=await ready();assert.equal(before.errors.length,0);await evaluate(`window.__deferredExample.dispose()`);assert.equal(await evaluate(`document.body.dataset.renderStatus`),'disposed');await new Promise(r=>setTimeout(r,400));
 const disposed=await evaluate(`window.__deferredExample.snapshot()`);evidence.cleanup=disposed.resources;assert.equal(disposed.resources.resources,0,JSON.stringify(disposed.resources));
 evidence.cases.push({name:'dispose-no-browser-errors'});evidence.status='passed';

 await evaluate(`(()=>{const result=document.getElementById('result');result.dataset.status='passed';result.textContent=JSON.stringify({status:'passed',scope:'deferred-example-controls'});})()`);
 }});
 evidence.browserEvidence=browser.browserEvidence;evidence.browserDiagnostics=browser.browserDiagnostics;evidence.httpProvenance=browser.httpProvenance;
 evidence.status='passed';
} catch(error){evidence.status='failed';evidence.error=error.stack;throw error;}
finally{evidence.finishedAt=new Date().toISOString();writeFileSync(resolve(out,'example-browser.json'),JSON.stringify(evidence,null,2)+'\n');}
console.log(`[deferred-example] ${evidence.cases.length} browser checks passed.`);
async function wait(fn){const deadline=Date.now()+60000;while(Date.now()<deadline){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out waiting for example state.');}
