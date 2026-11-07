import test from 'node:test';
import assert from 'node:assert/strict';
import {GuiElement,GuiLabel,GuiInput,GuiButton,GuiRoot,GuiSystem,GuiFocusManager,GuiTree,GuiScrollView} from '@haiyue/engine/gui';
import {createGuiVirtualList,createGuiVirtualTree} from '@haiyue/extensions/gui-collections';
const data=n=>Array.from({length:n},(_,i)=>({id:'k'+i,value:i}));
function rows(Control=GuiLabel){const counts={created:0,disposed:0,bound:0,unbound:0,active:0},instances=[];return {counts,instances,createRow(){counts.created++;const element=new Control({width:'100%',height:28,text:'',value:''});let bound=false,disposed=false;const row={element,bind(item,key,index){assert(!bound);bound=true;counts.bound++;counts.active++;row.binding={item,key,index};if(Control===GuiInput)element.setValue(key);else element.text=key;return()=>{assert(bound);bound=false;counts.unbound++;counts.active--;row.binding=null;};},dispose(){assert(!disposed);assert(!bound);disposed=true;counts.disposed++;}};instances.push(row);return row;}};}
function list(n=1000,extra={}){const r=rows(),items=data(n),value=createGuiVirtualList({items,keyOf:x=>x.id,rowHeight:28,height:560,createRow:r.createRow,...extra});value.element.layout({x:0,y:0,width:400,height:560});return {value,items,...r};}
const action=(element,name)=>{let consumed=false;element.handleAction({action:name,source:'keyboard',get consumed(){return consumed;},consume(){consumed=true;}});return consumed;};
const fail=e=>e.code==='E_GUI_COLLECTION_LIMIT';

test('1000/10000 logical items and all frozen offsets allocate only the visible window',()=>{
 for(const n of [1000,10000]){const s=list(n);for(const offset of [0,280,2800,14000,2801]){s.value.setScrollOffset(offset);assert(s.value.stats.rowInstances<=(offset%28?25:24));assert.equal(s.counts.active,s.value.stats.boundRows);assert.equal(s.counts.created-s.counts.disposed,s.value.stats.rowInstances);for(const row of s.instances.filter(r=>r.binding))assert.equal(row.binding.item.id,row.binding.key);}s.value.dispose();assert.equal(s.counts.active,0);assert.equal(s.counts.created,s.counts.disposed);}
});
test('overlap keeps original rows and static repeated layout does not rebind or allocate',()=>{
 const s=list();s.value.setScrollOffset(280);const old=new Map(s.instances.filter(r=>r.binding).map(r=>[r.binding.key,r]));s.value.setScrollOffset(308);for(const r of s.instances.filter(r=>r.binding))if(old.has(r.binding.key))assert.equal(r,old.get(r.binding.key));const before={...s.counts};for(let i=0;i<30;i++)s.value.element.layout({x:0,y:0,width:400,height:560});assert.deepEqual(s.counts,before);s.value.setItems(s.items);assert.deepEqual(s.counts,before);s.value.dispose();
});
test('one and ten percent immutable updates only rebind changed window rows',()=>{
 for(const n of [1000,10000])for(const percent of [1,10]){const s=list(n),before=s.counts.bound,changed=Math.ceil(n*percent/100),items=s.items.map((x,i)=>i<changed?{...x,value:-i}:x);s.value.setItems(items);assert.equal(s.counts.bound-before,Math.min(changed,s.value.stats.boundRows));s.value.dispose();}
});
test('insert, delete and sort preserve top stable key and partial-row offset',()=>{
 const s=list();s.value.setScrollOffset(2803);s.value.setItems([{id:'new',value:-1},...s.items]);assert.equal(s.value.element.scrollY,2831);s.value.setItems([...s.items].reverse());assert.equal(s.value.element.scrollY,899*28+3);s.value.setItems(s.items.filter(x=>x.id!=='k100'));assert.equal(s.value.element.scrollY,99*28+3);s.value.dispose();
});
test('alignment, finite scroll and invalid input are checked before changing data',()=>{
 const s=list(),before=s.value.stats;for(const items of [[{id:'x'},{id:'x'}],[{id:''}],Array(3)])assert.throws(()=>s.value.setItems(items),fail);assert.deepEqual(s.value.stats,before);assert.throws(()=>s.value.setScrollOffset(NaN),fail);assert.throws(()=>s.value.scrollToKey('missing'),fail);assert.throws(()=>s.value.setSelection('missing'),fail);assert.throws(()=>s.value.scrollToKey('k10','bad'),fail);s.value.scrollToKey('k50','start');assert.equal(s.value.element.scrollY,1400);s.value.scrollToKey('k50','end');assert.equal(s.value.element.scrollY,868);assert.throws(()=>s.value.setScrollOffset(Infinity),fail);s.value.dispose();
});
test('geometry, logical and overscan limits are independent and bounded',()=>{
 for(const options of [{rowHeight:0},{rowHeight:NaN},{height:Infinity},{height:10000},{overscan:33},{overscan:-1},{maxItems:0},{maxItems:1000001},{maxItems:1}])assert.throws(()=>list(2,options),fail);
 const s=list(1000,{overscan:0});s.value.setScrollOffset(280);assert.equal(s.value.stats.rowInstances,20);s.value.setScrollOffset(281);assert.equal(s.value.stats.rowInstances,21);s.value.dispose();
});
test('cross-window navigation scrolls with the original focus manager, remembers stable selection and deletion successor',()=>{
 const focus=new GuiFocusManager(),s=list(1000,{focus});focus.setRoots([s.value.element]);s.value.setSelection('k19');focus.focus(s.value.element);assert(action(s.value.element,'down'));assert.equal(s.value.selectedKey,'k20');assert(s.value.element.scrollY>0);assert(s.value.element.children.includes(focus.focused));const slot=focus.focused;s.value.setItems(s.items.filter(x=>x.id!=='k20'));assert.equal(s.value.selectedKey,'k21');assert.equal(focus.focused.children[0].text,'k21');s.value.setItems([]);assert.equal(s.value.selectedKey,null);assert.equal(focus.focused,s.value.element);s.value.dispose();
});
test('focused editor is blurred and composition canceled before its pooled row is rebound',()=>{
 const focus=new GuiFocusManager(),r=rows(GuiInput),s=createGuiVirtualList({items:data(1000),keyOf:x=>x.id,rowHeight:28,height:560,createRow:r.createRow,focus});s.element.layout({x:0,y:0,width:400,height:560});focus.setRoots([s.element]);const editor=r.instances[0].element;focus.focus(editor);editor.beginComposition();editor.updateComposition('preedit');s.setScrollOffset(14000);assert.equal(editor.isComposing,false);assert.equal(focus.focused,s.element);assert.equal(r.counts.active,s.stats.boundRows);s.dispose();
});
test('inserting before an edited row keeps both stable row and original focused editor',()=>{
 const focus=new GuiFocusManager(),r=rows(GuiInput),items=data(1000),s=createGuiVirtualList({items,keyOf:x=>x.id,rowHeight:28,height:560,createRow:r.createRow,focus});s.element.layout({x:0,y:0,width:400,height:560});focus.setRoots([s.element]);const editor=r.instances[10].element;focus.focus(editor);s.setSelection('k10');s.setItems([{id:'new'},...items]);assert.equal(focus.focused,editor);assert.equal(r.instances[10].binding.key,'k10');assert.equal(s.selectedKey,'k10');assert.equal(r.instances[10].binding.index,11);s.dispose();
});
test('full tree graph validates hidden duplicates/cycles atomically, expands ancestors on scroll and skips disabled rows',()=>{
 const r=rows(),nodes=[{key:'parent',value:0,children:data(1000).map((v,i)=>({key:v.id,value:i,disabled:i===20}))}],s=createGuiVirtualTree({nodes,createRow:r.createRow,rowHeight:28,height:560});assert.equal(s.stats.logicalItems,1001);assert.equal(s.stats.boundRows,1);s.scrollToKey('k500');assert.deepEqual(s.getExpandedKeys(),['parent']);assert(s.stats.boundRows<=24);s.setSelection('k19');action(s.element,'down');assert.equal(s.selectedKey,'k21');const before=s.stats;assert.throws(()=>s.setNodes([{key:'a',value:0,children:[{key:'a',value:1}]}]),fail);const cycle={key:'cycle',value:0};cycle.children=[cycle];assert.throws(()=>s.setNodes([cycle]),fail);assert.deepEqual(s.stats,before);for(const keys of [['parent','parent'],['unknown']])assert.throws(()=>s.setExpandedKeys(keys),fail);s.setExpandedKeys([]);assert.equal(s.selectedKey,'parent');assert.equal(s.stats.boundRows,1);s.dispose();
});
test('tree left/right uses the expanded logical model and deep chains do not recurse',()=>{
 const r=rows();let node={key:'k9999',value:0};for(let i=9998;i>=0;i--)node={key:'k'+i,value:i,children:[node]};const s=createGuiVirtualTree({nodes:[node],createRow:r.createRow,rowHeight:28,height:560});s.scrollToKey('k9999');s.setSelection('k9999');action(s.element,'left');assert.equal(s.selectedKey,'k9998');action(s.element,'left');assert(!s.getExpandedKeys().includes('k9998'));action(s.element,'right');assert(s.getExpandedKeys().includes('k9998'));s.dispose();
});
test('collapsing an edited branch emits only its final parent selection',()=>{
 const r=rows(),changes=[],s=createGuiVirtualTree({nodes:[{key:'parent',value:0,children:[{key:'child',value:1}]},{key:'sibling',value:2}],expandedKeys:['parent'],createRow:r.createRow,rowHeight:28,height:560,onSelection:key=>changes.push(key)});s.setSelection('child');changes.length=0;s.setExpandedKeys([]);assert.equal(s.selectedKey,'parent');assert.deepEqual(changes,['parent']);s.dispose();
});
test('all row unbind/dispose callbacks run exactly once even when one cleanup throws',()=>{
 const r=rows(),s=createGuiVirtualList({items:data(30),keyOf:x=>x.id,rowHeight:28,height:560,createRow(){const row=r.createRow(),dispose=row.dispose;row.dispose=()=>{dispose();if(r.counts.disposed===1)throw Error('observer');};return row;}});assert.throws(()=>s.dispose(),AggregateError);s.dispose();assert.equal(r.counts.created,r.counts.disposed);assert.equal(r.counts.active,0);assert.throws(()=>s.setItems([]),fail);
});
test('existing GuiTree identity, data and first-screen rendering remain compatible',()=>{
 const tree=new GuiTree({nodes:data(1000).map(x=>({key:x.id,label:x.id})),height:560});tree.layout({x:0,y:0,width:400,height:560});assert(!(tree instanceof GuiScrollView));assert.equal(tree.visibleNodes.length,20);tree.setSelectedKey('k5');assert.equal(tree.selectedKey,'k5');assert.equal(tree.getRowAt(2,2)?.node.key,'k0');
});

class Surface extends EventTarget {tabIndex=0;captured=new Set();getBoundingClientRect(){return {left:0,top:0,width:400,height:560};}focus(){}setPointerCapture(id){this.captured.add(id);}hasPointerCapture(id){return this.captured.has(id);}releasePointerCapture(id){this.captured.delete(id);}}
test('removing all focused rows returns to the collection container through the original domain',()=>{
 const canvas=new Surface(),system=new GuiSystem({canvas,displayWidth:400,displayHeight:560}),root=new GuiRoot();system.roots.add(root);root.add(new GuiButton({width:100,height:20,text:'outside'}));const r=rows(GuiInput),s=createGuiVirtualList({items:data(30),keyOf:x=>x.id,rowHeight:28,height:560,createRow:r.createRow});root.add(s.element);root.layout(400,560);system.inputDomain.refresh();system.focus.focus(r.instances[0].element);s.setItems([]);assert.equal(system.focus.focused,s.element);s.dispose();assert.equal(s.element.parent,null);assert.equal(s.element.disabled,true);assert.equal(s.element.visible,false);assert.notEqual(system.focus.focused,s.element);system.destroy();root.destroy();
});
test('the original input owner cancels capture and active drag synchronously before rebind, without an explicit focus option',()=>{
 const canvas=new Surface(),system=new GuiSystem({canvas,displayWidth:400,displayHeight:560}),root=new GuiRoot();system.roots.add(root);system.renderer.prepare=()=>{};let ended=0,canceled=0,reboundAfterEnd=false;
 const r=rows(GuiButton),s=createGuiVirtualList({items:data(1000),keyOf:x=>x.id,rowHeight:28,height:560,createRow(){const row=r.createRow();row.element.setDragSource({getData:()=>({key:row.binding.key}),onEnd:()=>ended++});row.element.on('pointercancel',()=>canceled++);const bind=row.bind;row.bind=(...args)=>{if(ended)reboundAfterEnd=true;return bind(...args);};return row;}});root.add(s.element);root.layout(400,560);system.inputDomain.refresh();
 const send=(type,x,y)=>{const event={type,pointerId:1,pointerType:'mouse',button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:y,isTrusted:true,preventDefault(){}};system.inputDomain.onPointer(event);};
 send('pointerdown',20,12);send('pointermove',42,12);assert(system.dragSession);s.setScrollOffset(14000);assert.equal(system.dragSession,null);assert.equal(ended,1);assert(canceled>=1);assert.equal(canvas.captured.size,0);assert(reboundAfterEnd);send('pointerup',42,12);assert.equal(ended,1);s.dispose();system.destroy();root.destroy();
});

for (const explicitFocus of [true, false]) for (const Control of [GuiInput, GuiButton]) {
 test(`collection navigation focuses the live ${Control.name} after one direction, explicit focus=${explicitFocus}`,()=>{
  const canvas=new Surface(),system=new GuiSystem({canvas,displayWidth:400,displayHeight:560}),root=new GuiRoot();system.roots.add(root);
  const r=rows(Control),s=createGuiVirtualList({items:data(1000),keyOf:x=>x.id,rowHeight:28,height:560,createRow:r.createRow,...(explicitFocus?{focus:system.focus}:{})});root.add(s.element);root.layout(400,560);system.inputDomain.refresh();
  const row=key=>r.instances.find(x=>x.binding?.key===key).element;
  system.focus.focus(row('k0'));system.dispatchAction('down','gamepad');assert.equal(s.selectedKey,'k1');assert.equal(system.focus.focused,row('k1'));assert.equal(row('k1').focused,true);
  if(Control===GuiInput){row('k1').insertText('z');assert(row('k1').value.includes('z'));assert.equal(row('k0').value,'k0');}
  else{let clicks=0;row('k1').onClick=()=>clicks++;system.dispatchAction('confirm','gamepad');assert.equal(clicks,1);}
  system.dispatchAction('up','gamepad');assert.equal(system.focus.focused,row('k0'));assert.equal(row('k0').focused,true);
  s.setScrollOffset(14000);s.setScrollOffset(0);system.focus.focus(row('k0'));system.dispatchAction('down','keyboard');assert.equal(system.focus.focused,row('k1'));
  s.dispose();system.destroy();root.destroy();assert.equal(r.counts.created,r.counts.disposed);assert.equal(r.counts.active,0);
 });
}

test('collection row focus skips disabled and hidden descendants and falls back for label-only rows',()=>{
 const focus=new GuiFocusManager(),targets=[];
 const s=createGuiVirtualList({items:data(3),keyOf:x=>x.id,rowHeight:28,height:560,focus,createRow(){
  const element=new GuiElement({width:'100%',height:28}),disabled=element.add(new GuiButton({disabled:true})),hidden=element.add(new GuiInput({visible:false})),group=element.add(new GuiElement({height:28})),input=group.add(new GuiInput());targets.push({element,disabled,hidden,input});
  return{element,bind(){return()=>{};},dispose(){}};
 }});s.element.layout({x:0,y:0,width:400,height:560});focus.setRoots([s.element]);focus.focus(targets[0].input);action(s.element,'down');assert.equal(s.selectedKey,'k1');assert.equal(focus.focused,targets[1].input);s.dispose();
 const label=list(3,{focus});focus.setRoots([label.value.element]);label.value.setSelection('k0');focus.focus(label.value.element);action(label.value.element,'down');assert.equal(label.value.selectedKey,'k1');assert(label.value.element.children.includes(focus.focused));label.value.dispose();
});
