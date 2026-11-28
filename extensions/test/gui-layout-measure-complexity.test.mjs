import test from 'node:test';
import assert from 'node:assert/strict';
import {GuiRoot,GuiElement} from '@haiyue/engine/gui';
import {attachGuiLayout,createGuiContainer} from '../dist/gui-layout.js';
for(const size of [128,512])test(`default measurement reuses the arrange index for ${size} intrinsic leaves`,()=>{
  const root=new GuiRoot(),panel=root.add(createGuiContainer('column',{style:{width:200,height:size*10}}));
  const rows=Array.from({length:size},(_,i)=>panel.add(new GuiElement({id:'row-'+i,width:100,height:10})));
  const binding=attachGuiLayout(root);for(const row of rows)binding.setStyle(row,{height:'auto'});
  let lookups=0,measurements=0;const find=GuiElement.prototype.findById;
  GuiElement.prototype.findById=function(...args){lookups++;return find.apply(this,args);};
  root.measureElement=element=>{measurements++;return {width:100,height:10,minWidth:0,minHeight:0};};
  try{root.layout(200,size*10);assert.equal(lookups,0);assert.ok(measurements>=size);assert.equal(rows.at(-1).rect.y,(size-1)*10);}
  finally{GuiElement.prototype.findById=find;binding.dispose();root.destroy();}
});
test('a failed default measurement cannot retain a stale node index',()=>{
  const root=new GuiRoot(),panel=root.add(createGuiContainer('column',{style:{width:100,height:40}}));
  const child=panel.add(new GuiElement({id:'same',width:20,height:10})),binding=attachGuiLayout(root);binding.setStyle(child,{height:'auto'});
  root.measureElement=()=>{throw Error('measurement failed');};
  assert.throws(()=>root.layout(100,40),/measurement failed/);panel.remove(child);
  const replacement=panel.add(new GuiElement({id:'same',width:30,height:10}));binding.setStyle(replacement,{height:'auto'});
  let seen=false;root.measureElement=element=>{if(element===replacement)seen=true;return {width:30,height:10,minWidth:0,minHeight:0};};
  root.layout(100,40);assert.ok(seen);assert.equal(replacement.rect.height,10);binding.dispose();root.destroy();
});
