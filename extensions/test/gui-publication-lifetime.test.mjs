import test from 'node:test';
import assert from 'node:assert/strict';
import {guiApi,guiExtension} from './helpers/private-gui-source.mjs';
const {GuiRoot,GuiButton,GuiFocusManager}=await guiApi();
const {GuiQRCode}=await guiExtension('gui-assets/QRCode.ts');
const {GuiNotificationCenter}=await guiExtension('gui-overlays/notification.ts');
const {GuiPopover}=await guiExtension('gui-overlays/popover.ts');
const matrix=()=>({size:21,cells:new Uint8Array(441)});
for(const interruption of ['dispose','replace','throw'])test(`QR ${interruption} during image publication preserves exact lease ownership`,async()=>{
 const root=new GuiRoot(),released=[],sources=[0,1,2].map(()=>({width:64,height:64}));let index=0,interrupted=false,replacement;
 const qr=new GuiQRCode({root,encode:matrix,rasterize:()=>{const i=index++;return {source:sources[i],dispose:()=>released.push(i)};}});root.add(qr.element);
 assert.equal(await qr.setValue('old'),true);
 const off=root.onInvalidation(()=>{if(!interrupted&&qr.image.image.source===sources[1]){interrupted=true;if(interruption==='dispose')qr.dispose();else if(interruption==='replace')replacement=qr.setValue('latest');else throw new Error('publication failed');}});
 assert.equal(await qr.setValue('candidate'),false);assert.ok(interrupted);
 if(interruption==='replace'){assert.equal(await replacement,true);assert.equal(qr.image.image.source,sources[2]);}
 if(interruption==='throw'){assert.equal(qr.image.image.source,sources[0]);assert.deepEqual(released,[1]);}
 qr.dispose();qr.dispose();root.destroy();off();
 assert.deepEqual([...released].sort(),Array.from({length:index},(_,i)=>i));assert.equal(new Set(released).size,released.length);
});
test('QR source disposal and newer request during Ready notification do not report stale success',async()=>{
 const root=new GuiRoot();let released=0,armed=false;
 const qr=new GuiQRCode({root,encode:matrix,rasterize:()=>({source:{width:64,height:64},dispose:()=>released++})});root.add(qr.element);
 const off=root.onInvalidation(()=>{if(armed&&qr.feedback.text==='Ready'){armed=false;qr.dispose();}});armed=true;
 assert.equal(await qr.setValue('value'),false);assert.equal(released,1);qr.dispose();root.destroy();off();
});
for(const stage of ['add','update','retire','throw'])test(`notification ${stage} callback cannot publish into a disposed center or retain borrowed actions`,()=>{
 const root=new GuiRoot(),focus=new GuiFocusManager(),center=new GuiNotificationCenter({root,focusManager:focus,durationMs:10}),action=new GuiButton({text:'Action'});let once=false,armed=false;
 if(stage==='update'||stage==='retire')center.open({key:'notice',title:'Old',action:stage==='update'?action:undefined});
 const off=root.onInvalidation(()=>{
  if(!armed||once)return;
  const attached=action.parent&&root.findById(action.id)===action;
  if(stage==='retire'||stage==='update'||attached){once=true;if(stage==='throw')throw new Error('publication failed');center.dispose();}
 });armed=true;
 if(stage==='throw')assert.throws(()=>center.open({key:'notice',title:'New',action}),/publication failed/);
 else center.open({key:'notice',title:'New',action});
 assert.ok(once);center.dispose();center.dispose();assert.deepEqual(center.keys,[]);assert.equal(action.parent,null);
 off();root.destroy();
 const otherRoot=new GuiRoot(),popover=new GuiPopover({root:otherRoot,focusManager:focus,content:action,trigger:'manual'});
 popover.dispose();otherRoot.destroy();focus.dispose();
});
test('notification same-key replacement from an add callback keeps only the newer item',()=>{
 const root=new GuiRoot(),focus=new GuiFocusManager(),center=new GuiNotificationCenter({root,focusManager:focus,durationMs:0}),oldAction=new GuiButton(),newAction=new GuiButton();let once=false;
 const off=root.onInvalidation(()=>{if(!once&&root.findById(oldAction.id)===oldAction){once=true;center.open({key:'same',title:'Newest',action:newAction});}});
 center.open({key:'same',title:'Old',action:oldAction});
 assert.deepEqual(center.keys,['same']);assert.equal(oldAction.parent,null);assert.ok(root.findById(newAction.id));
 center.dispose();assert.equal(newAction.parent,null);root.destroy();off();focus.dispose();
});
