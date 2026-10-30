import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../..',import.meta.url)),out=resolve(root,`artifacts/engine-0.2.2/g03/playground-${Date.now()}`);mkdirSync(out,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const cases=[];
let result;
try{result=await runChromeWebGpuFixture({root,fixture:'examples/gui-runtime/index.html',timeoutMs:60000,acceptedStatuses:['passed'],interact:async cdp=>{
 const evaluate=async expression=>{const r=await cdp.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
 const wait=condition=>evaluate(`(async()=>{const start=performance.now();while(!(${condition})){if(performance.now()-start>15000)throw Error('Playground readiness failed: '+document.querySelector('#status')?.textContent);await new Promise(requestAnimationFrame)}await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);return true})()`);
 const click=async(x,y)=>{await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});await evaluate('(async()=>{for(let i=0;i<4;i++)await new Promise(requestAnimationFrame)})()');};
 const capture=async id=>{const response=await cdp.call('Page.captureScreenshot',{format:'png'});const png=Buffer.from(response.result.data,'base64');writeFileSync(resolve(out,id+'.png'),png);cases.push({id,sha256:hash(png),mode:await evaluate('document.querySelector("canvas").dataset.layoutMode'),bytes:png.length});};
 await cdp.call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
 await wait('document.querySelector("canvas")?.dataset.ready==="true"');
 await wait('document.querySelector("canvas").dataset.layoutMode==="Flex"');await capture('flex');
 await click(1000,247);await click(1000,280);await wait('document.querySelector("canvas").dataset.layoutMode==="Manual"');await capture('manual');
 await click(1000,247);await click(1000,336);await wait('document.querySelector("canvas").dataset.layoutMode==="Grid"');await capture('grid');
 await click(1150,323);await capture('grid-resized-container');
 await cdp.call('Emulation.setDeviceMetricsOverride',{width:700,height:760,deviceScaleFactor:1,mobile:false});await evaluate('(async()=>{for(let i=0;i<8;i++)await new Promise(requestAnimationFrame)})()');await capture('grid-narrow-viewport');
 if(new Set(cases.slice(0,3).map(c=>c.sha256)).size!==3)throw Error('Mode switches did not change rendered output');
 if(cases[2].sha256===cases[3].sha256)throw Error('Container resize did not change rendered output');
 await evaluate(`(()=>{const n=document.createElement('pre');n.id='result';n.hidden=true;n.dataset.status='passed';n.textContent=JSON.stringify({status:'passed',caseCount:5});document.body.append(n)})()`);
 }});}catch(error){result={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};process.exitCode=1;}
writeFileSync(resolve(out,'result.json'),JSON.stringify({generatedAt:new Date().toISOString(),cases,inputs:Object.fromEntries(['examples/gui-runtime/main.ts','examples/gui-runtime/catalog.ts','examples/gui-runtime/layout-demo.ts','examples/gui-runtime/bundle.js','examples/shared/engine.js'].map(p=>[p,hash(readFileSync(resolve(root,p)))])),...result},null,2)+'\n');console.log(JSON.stringify({out,status:result.status,cases:cases.length,error:result.error}));
