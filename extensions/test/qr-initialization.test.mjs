import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {guiApi,guiExtension} from './helpers/private-gui-source.mjs';
const {GuiRoot}=await guiApi(),{GuiQRCode}=await guiExtension('gui-assets/QRCode.ts');
const matrix=()=>({size:21,cells:new Uint8Array(441)}),rasterize=()=>({source:{width:64,height:64},dispose(){}}),settle=()=>new Promise(resolve=>setTimeout(resolve,0));
test('invalid QR initial values reject synchronously before acquiring any root subscription',()=>{
 const root=new GuiRoot(),subscribe=root.onDispose;let subscriptions=0,encodes=0;root.onDispose=function(callback){subscriptions++;return subscribe.call(this,callback);};
 try{for(const value of ['x'.repeat(8193),42,null]){let instance;try{assert.throws(()=>{instance=new GuiQRCode({root,value,encode(){encodes++;return matrix();},rasterize});},/8192/);}finally{instance?.dispose();}}assert.equal(subscriptions,0);assert.equal(encodes,0);}finally{root.destroy();}
});
test('valid initial QR generation owns its errors and explicit invalid updates still reject',async()=>{
 const q=new GuiQRCode({value:'initial',encode:matrix,rasterize});try{await settle();assert.equal(q.feedback.text,'Ready');assert.equal(q.value,'initial');await assert.rejects(q.setValue('x'.repeat(8193)),/8192/);assert.equal(q.value,'initial');assert.equal(await q.setValue(''),true);assert.equal(await q.setValue('x'.repeat(8192)),true);}finally{q.dispose();}
});
for(const stage of ['encode','rasterize'])test(`initial QR ${stage} failure is visible and does not escape as a rejected task`,async()=>{
 const error=new Error(stage+' failed'),q=new GuiQRCode({value:'initial',encode(){if(stage==='encode')throw error;return matrix();},rasterize(){throw error;}});try{await settle();assert.equal(q.feedback.text,error.message);}finally{q.dispose();}
});
test('a pending initial QR cannot replace a newer value and is cancelled on disposal',async()=>{
 const requests=[],released=[];const q=new GuiQRCode({value:'initial',encode:(text,signal)=>new Promise(resolve=>requests.push({text,signal,resolve})),rasterize(){return{source:{width:64,height:64},dispose(){released.push('released');}};}});
 const newer=q.setValue('new');assert(requests[0].signal.aborted);requests[1].resolve(matrix());assert.equal(await newer,true);requests[0].resolve(matrix());await settle();assert.equal(q.value,'new');assert.equal(q.feedback.text,'Ready');const last=q.setValue('last');q.dispose();assert(requests[2].signal.aborted);requests[2].resolve(matrix());assert.equal(await last,false);assert.deepEqual(released,['released']);
});
test('invalid QR initialization stays safe under strict unhandled-rejection mode',()=>{
 const helper=new URL('./helpers/private-gui-source.mjs',import.meta.url).href;
 const source=`import assert from 'node:assert/strict';import {guiExtension} from ${JSON.stringify(helper)};const {GuiQRCode}=await guiExtension('gui-assets/QRCode.ts');assert.throws(()=>new GuiQRCode({value:'x'.repeat(8193),encode:()=>({size:21,cells:new Uint8Array(441)}),rasterize:()=>({source:{width:1,height:1},dispose(){}})}),/8192/);await new Promise(resolve=>setTimeout(resolve,30));console.log('strict initialization passed');`;
 const child=spawnSync(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',source],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/strict initialization passed/);
});
