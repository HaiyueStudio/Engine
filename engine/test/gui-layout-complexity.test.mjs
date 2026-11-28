import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
const {GuiElement}=await importEngineSource('gui/components/GuiElement.ts');
const {GuiScrollView}=await importEngineSource('gui/components/GuiScrollView.ts');
const {retainGuiLayout,withGuiAssignments}=await importEngineSource('gui/GuiLayoutState.ts');
for(const depth of [1,2,4,8])test(`${depth} nested scroll views arrange a leaf once in final coordinates`,()=>{
  const root=new GuiElement({width:200,height:200});let parent=root;
  for(let i=0;i<depth;i++)parent=parent.add(new GuiScrollView({width:180,height:180,contentHeight:240,scrollY:5}));
  const leaf=parent.add(new GuiElement({x:'10%',y:20,width:'50%',height:10}));let count=0;const layout=leaf.layout;
  leaf.layout=function(...args){count++;return layout.apply(this,args);};root.layout({x:0,y:0,width:200,height:200});
  assert.equal(count,1);assert.equal(leaf.rect.x,18);assert.equal(leaf.rect.y,20-depth*5);assert.equal(leaf.rect.width,90);
});
test('horizontal scrolling, clamping and retained rectangle assignments still use the final viewport',()=>{
  const scroll=new GuiScrollView({axis:'horizontal',width:100,height:40,contentWidth:200,scrollX:150});
  const child=scroll.add(new GuiElement({x:120,width:10,height:10}));let count=0;const layout=child.layout;
  child.layout=function(...args){count++;return layout.apply(this,args);};scroll.layout({x:10,y:20,width:300,height:200});
  assert.equal(scroll.scrollX,100);assert.equal(child.rect.x,30);assert.equal(count,1);
  retainGuiLayout(scroll,{x:50,y:60,width:150,height:50});count=0;scroll.layout({x:0,y:0,width:999,height:999});
  assert.equal(scroll.scrollX,50);assert.equal(child.rect.x,120);assert.equal(child.rect.y,60);assert.equal(count,1);
  retainGuiLayout(scroll,{x:0,y:0,width:0,height:0},{display:'none'});count=0;scroll.layout({x:0,y:0,width:100,height:100});assert.equal(count,0);
});
test('nested assignment scopes restore the outer rectangle even after a nested failure',()=>{
  const element=new GuiElement(),parent={x:0,y:0,width:100,height:100},outer={x:10,y:20,width:30,height:40},inner={x:50,y:60,width:20,height:10};
  withGuiAssignments(new Map([[element,outer]]),()=>{
    element.layout(parent);assert.deepEqual(element.rect,outer);
    assert.throws(()=>withGuiAssignments(new Map([[element,inner]]),()=>{element.layout(parent);assert.deepEqual(element.rect,inner);throw Error('nested');}),/nested/);
    element.layout(parent);assert.deepEqual(element.rect,outer);
  });
});
