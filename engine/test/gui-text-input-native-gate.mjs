import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url)),sha=p=>createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex'),paths=[];
for(const directory of ['engine/src/gui','engine/src/input','examples/gui-runtime']){
 const scan=dir=>{for(const e of readdirSync(resolve(root,dir),{withFileTypes:true})){const p=`${dir}/${e.name}`;if(e.isDirectory())scan(p);else if(/\.(?:ts|js|html)$/u.test(p))paths.push(p);}};scan(directory);
}
paths.push('examples/shared/engine.js','engine/test/gui-text-input-native-gate.mjs');
const fingerprints=Object.fromEntries(paths.map(p=>[p,sha(p)])),cases=[];let result;
try{
 result=await runChromeWebGpuFixture({root,fixture:'examples/gui-runtime/index.html',query:{'text-input':1},timeoutMs:90000,acceptedStatuses:['passed','failed'],interact:async cdp=>{
  const evaluate=async expression=>{const r=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
  const state=()=>evaluate("(()=>{const c=document.querySelector('canvas');return c?.dataset.ready==='true'&&c.dataset.textEditing?JSON.parse(c.dataset.textEditing):null;})()");
  const wait=async(predicate,label)=>{const start=Date.now();let last;while(Date.now()-start<15000){last=await state();if(last&&predicate(last))return last;await new Promise(r=>setTimeout(r,50));}throw Error(`Timed out ${label}: ${JSON.stringify(last)}`);};
  const field=(s,id)=>s.fields.find(f=>f.id===id);
  const key=async(code,key=code,modifiers=0)=>{
   // Headless macOS has no AppKit key-binding translation; CDP supplies the native edit command.
   const commands=process.platform==='darwin'&&(modifiers&2)?({KeyA:['selectAll'],KeyZ:[modifiers&8?'redo':'undo'],End:['moveToEndOfDocument'],Home:['moveToBeginningOfDocument']}[code]??[]):[];
   // CDP uses platform-native editing shortcuts; macOS uses Command for A/Z.
   if(process.platform==='darwin'&&(modifiers&2)){
    if(code.startsWith('Key'))modifiers=(modifiers&~2)|4;
    else if(code==='End'||code==='Home'){code=code==='End'?'ArrowDown':'ArrowUp';key=code;modifiers=(modifiers&~2)|4;}
   }
   const windowsVirtualKeyCode=({End:35,Home:36,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Backspace:8,Delete:46,Tab:9,Enter:13,Escape:27})[code]??(code.startsWith('Key')?code.charCodeAt(3):0);
   await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',code,key,modifiers,windowsVirtualKeyCode,...(commands.length?{commands}:{})});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',code,key,modifiers,windowsVirtualKeyCode});
  };
  const type=text=>cdp.call('Input.insertText',{text});
  const focus=async id=>{
   const s=await state(),f=field(s,id),r=await evaluate("(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};})()");
   const p={x:r.left+(f.rect.x+20)*r.width/s.viewport.width,y:r.top+(f.rect.y+f.rect.height/2)*r.height/s.viewport.height};
   await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});
   const focused=await wait(s=>s.focus===id&&s.hostElements===1,'focus '+id);
   assert.equal(await evaluate("document.activeElement?.hasAttribute('data-haiyue-text-input')"),true,'browser responder owns actual DOM focus');return focused;
  };
  const record=(id,s)=>{assert.equal(s.sceneActions,0);cases.push({id,state:s});};
  try{
   await wait(()=>true,'ready');await focus('text-a');await key('End');await key('ArrowLeft');await key('Backspace');
   let s=await wait(s=>field(s,'text-a').value==='AB','frozen emoji deletion');assert.deepEqual(field(s,'text-a').selection,[1,1]);record('trusted-browser-emoji-backspace',s);
   await type('😀');s=await wait(s=>field(s,'text-a').value==='A😀B','emoji insertion');record('native-full-codepoint-insertion',s);
   await key('ArrowLeft','ArrowLeft',8);await type('😁');s=await wait(s=>field(s,'text-a').value==='A😁B','surrogate-prefix replacement');record('shared-surrogate-selection-replacement',s);
   await key('KeyA','a',2);await type('e\u0301');await key('Backspace');s=await wait(s=>field(s,'text-a').value==='','combining deletion');record('combining-grapheme-deletion',s);
   await type('👩🏽‍💻');await key('Backspace');s=await wait(s=>field(s,'text-a').value==='','ZWJ deletion');record('ZWJ-grapheme-deletion',s);
   await key('KeyZ','z',2);s=await wait(s=>field(s,'text-a').value==='👩🏽‍💻','undo');await key('KeyZ','z',10);s=await wait(s=>field(s,'text-a').value==='','redo');record('host-undo-redo',s);
   await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',code:'Space',key:' ',text:' '});s=await wait(s=>field(s,'text-a').value===' ','held Space in text responder');assert.equal(s.sceneActions,0);await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',code:'Space',key:' '});await key('Backspace');record('text-space-consumed-before-scene',s);
   await focus('text-limit');await key('End');await key('ArrowLeft');await type('中');s=await wait(s=>field(s,'text-limit').value==='A😀B','limit rejection');
   assert.equal(await evaluate("document.querySelector('[data-haiyue-text-input]').value"),'A😀B');record('host-limit-rejection-resynchronizes',s);
   await focus('text-b');await key('KeyA','a',2);
   await cdp.call('Input.imeSetComposition',{text:'中文',selectionStart:1,selectionEnd:2});s=await wait(s=>field(s,'text-b').composing,'CDP IME preview');assert.equal(field(s,'text-b').value,'e\u0301👩🏽‍💻');assert.equal(field(s,'text-b').display,'中文');record('synthetic-IME-preedit-separate',s);
   await cdp.call('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});s=await wait(s=>!field(s,'text-b').composing,'CDP IME cancel');assert.equal(field(s,'text-b').value,'e\u0301👩🏽‍💻');record('synthetic-IME-cancel-restores-selection',s);
   await type('中文');s=await wait(s=>field(s,'text-b').value==='中文','post-cancel replacement');record('post-cancel-selection-replacement',s);
   await key('Tab');s=await wait(s=>s.focus==='text-limit'&&s.hostElements===1,'Tab host transfer');record('single-session-focus-transfer',s);
   await focus('text-password');await type('A😀');s=await wait(s=>field(s,'text-password').value.length>0,'password hint');assert.equal(await evaluate("document.querySelector('[data-haiyue-text-input]').type"),'password');
   const selection=field(s,'text-password').selection;
   await evaluate('window.__g06PasswordResponder=document.activeElement');
   const eyePoint=await evaluate(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect(),f=${JSON.stringify(field(s,'text-password').rect)},v=${JSON.stringify(s.viewport)};return {x:r.left+(f.x+f.width-18)*r.width/v.width,y:r.top+(f.y+f.height/2)*r.height/v.height};})()`);
   await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',...eyePoint,button:'left',clickCount:1});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',...eyePoint,button:'left',clickCount:1});
   await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');s=await state();assert.deepEqual(field(s,'text-password').selection,selection);assert.equal(s.focus,'text-password');assert.equal(await evaluate("document.activeElement===window.__g06PasswordResponder&&document.activeElement.type==='password'"),true);record('password-eye-keeps-responder-and-selection',s);
   await key('KeyA','a',2);const passwordClipboard=await evaluate("(()=>{const e=document.activeElement,data=new DataTransfer(),value=e.value;e.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));e.dispatchEvent(new ClipboardEvent('cut',{clipboardData:data,bubbles:true,cancelable:true}));return {text:data.getData('text/plain'),unchanged:e.value===value};})()");assert.deepEqual(passwordClipboard,{text:'',unchanged:true});record('native-password-input-hint-and-clipboard-guard',s);
   await key('Tab');s=await wait(s=>s.focus==='text-reset'&&s.hostElements===0,'Tab to button');assert.equal(await evaluate("document.activeElement===document.querySelector('canvas')"),true);record('host-close-restores-canvas-keyboard',s);
   await key('Tab');s=await wait(s=>s.focus==='text-multiline'&&s.hostElements===1,'Tab to multiline');assert.ok(s.scrollY>0);assert.equal(await evaluate("document.activeElement.tagName"),'TEXTAREA');
   await key('KeyA','a',2);await type('one\n😀\ne\u0301');s=await wait(s=>field(s,'text-multiline').value==='one\n😀\ne\u0301','multiline replacement');
   await key('End','End',2);await key('Backspace');s=await wait(s=>field(s,'text-multiline').value==='one\n😀\n','multiline combining deletion');record('multiline-native-responder-and-grapheme-deletion',s);
   await type('one\ntwo\nthree\nfour\nfive\nsix');s=await wait(s=>field(s,'text-multiline').value.endsWith('six'),'multiline vertical scrolling');
   const geometry=await evaluate("(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),c=document.querySelector('canvas').getBoundingClientRect();return {y:r.y,bottom:r.bottom,canvasTop:c.top,canvasBottom:c.bottom};})()");
   assert.ok(geometry.y>=geometry.canvasTop&&geometry.bottom<=geometry.canvasBottom,JSON.stringify(geometry));record('multiline-candidate-rectangle-visible',s);
   const clipboard=await evaluate("(()=>{const e=document.activeElement;e.setSelectionRange(0,3);e.dispatchEvent(new Event('select'));const data=new DataTransfer();e.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return data.getData('text/plain');})()");assert.equal(clipboard,'one');
   await evaluate("(()=>{const e=document.activeElement,data=new DataTransfer();data.setData('text/plain','😀');e.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()");s=await wait(s=>field(s,'text-multiline').value.startsWith('😀\n😀'),'clipboard selection replacement');record('synthetic-clipboard-roundtrip-through-browser-host',s);
   await key('KeyA','a',2);await evaluate("(()=>{const e=document.activeElement,data=new DataTransfer();data.setData('text/plain','A\\r\\n😀\\rB\\nC');e.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()");
   s=await wait(s=>field(s,'text-multiline').value==='A\r\n😀\rB\nC','mixed line endings');assert.deepEqual(field(s,'text-multiline').selection,[9,9]);
   assert.equal(await evaluate("document.activeElement.value"),'A\n😀\nB\nC');await key('ArrowLeft');await key('Backspace');s=await wait(s=>field(s,'text-multiline').value==='A\r\n😀\rBC','stored UTF-16 deletion after native newline normalization');record('multiline-CRLF-CR-LF-coordinate-projection',s);
   for(const id of ['text-reset','text-password','text-limit','text-b','text-a']){await key('Tab','Tab',8);await wait(s=>s.focus===id,'previous '+id);}
   await key('KeyA','a',2);await evaluate("(()=>{const e=document.activeElement,data=new DataTransfer();data.setData('text/plain','A\\r\\n😀');e.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()");s=await wait(s=>field(s,'text-a').value==='A\r\n😀','single-line raw value');assert.equal(await evaluate("document.activeElement.value"),'A😀');
   await key('Home');await key('End');await key('ArrowLeft');await key('Backspace');s=await wait(s=>field(s,'text-a').value==='A😀','single-line invisible CRLF keeps its UTF-16 caret');record('single-line-sanitization-preserves-stored-index-and-grapheme-delete',s);
   await evaluate("window.dispatchEvent(new Event('pagehide'))");s=await state();assert.equal(s.disposed,true);assert.equal(await evaluate("document.querySelectorAll('[data-haiyue-text-input]').length"),0);record('text-host-and-sampler-teardown',s);
   await evaluate(`(()=>{const n=document.createElement('pre');n.id='result';n.dataset.status='passed';n.textContent=${JSON.stringify(JSON.stringify({status:'passed',caseCount:cases.length,cases,qualification:'Native WebGPU public GUI path with CDP keyboard/text and synthetic IME protocol tests. Not real human IME or physical iPhone qualification.'}))};document.body.append(n);})()`);
  }catch(error){await evaluate(`(()=>{const n=document.createElement('pre');n.id='result';n.dataset.status='failed';n.textContent=${JSON.stringify(JSON.stringify({status:'failed',error:String(error.stack??error),caseCount:cases.length,cases}))};document.body.append(n);})()`);}
 }});
}catch(error){result={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure,cases};}
const changed=paths.filter(p=>sha(p)!==fingerprints[p]);if(changed.length)result={...result,status:'failed',changed};
const files=result.httpProvenance?.files??[],bad=files.filter(f=>{try{return sha(f.sourcePath)!==f.sha256;}catch{return true;}});if(!files.length||bad.length)result={...result,status:'failed',servedByteMismatch:bad};
const out=resolve(root,`artifacts/engine-0.2.2/g06/browser-text-${Date.now()}.json`);writeFileSync(out,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),fingerprints,...result},null,2)+'\n');
console.log(JSON.stringify({out,status:result.status,cases:result.caseCount,error:result.error}));if(result.status!=='passed'||result.caseCount!==21)process.exitCode=1;
