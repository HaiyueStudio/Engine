import assert from 'node:assert/strict';
import test from 'node:test';
import {GuiElement,GuiRoot,GuiInput,GuiFocusManager} from '@haiyue/engine/gui';
import {GuiCollapse} from '@haiyue/extensions/gui-controls';
import {GuiTabContainer} from '@haiyue/extensions/gui-layout';

function fixture(kind) {
  const root=new GuiRoot(),focus=new GuiFocusManager(),contents=[new GuiElement(),new GuiElement()];
  const input=contents[0].add(new GuiInput({value:'business text'}));
  const control=kind==='collapse'
    ? new GuiCollapse({items:contents.map((content,i)=>({key:String(i),title:String(i),content})),expandedKeys:['0','1'],focus})
    : new GuiTabContainer({pages:contents.map((content,i)=>({id:String(i),title:String(i),content,closable:true})),focus});
  root.add(control.element);focus.setRoots([root.root]);focus.focus(input);
  return {root,focus,contents,input,control};
}

for(const kind of ['collapse','tabs'])for(const phase of ['beforeBlur','changed'])test(`${kind} releases every borrowed frame when a ${phase} observer throws and retries disposal safely`,()=>{
  const f=fixture(kind),observer=Error('application focus observer');let reentries=0;
  const off=(phase==='beforeBlur'?f.focus.subscribeBeforeBlur.bind(f.focus):f.focus.subscribe.bind(f.focus))(()=>{reentries++;f.control.dispose();throw observer;});
  try {
    assert.throws(()=>f.control.dispose(),error=>error instanceof AggregateError&&error.errors.includes(observer));
    assert.ok(reentries>=1);assert.equal(f.control.element.parent,null);
    for(const content of f.contents)assert.equal(content.parent,null);
    assert.doesNotThrow(()=>f.control.dispose());
    // A persistent application observer may still prevent the external focus owner from changing.
    // Removing that observer allows its existing reconcile contract to repair the detached target.
    off();f.focus.reconcile();assert.equal(f.focus.focused,null);
    assert.equal(f.input.value,'business text');assert.equal(f.input.disabled,false);
    const reused=new GuiTabContainer({pages:f.contents.map((content,i)=>({id:String(i),title:String(i),content}))});
    reused.dispose();for(const content of f.contents)assert.equal(content.parent,null);
  } finally {off();f.focus.dispose();f.root.destroy();}
});

for(const kind of ['collapse','tabs'])test(`${kind} permits a reentrant disposal from focus without duplicate cleanup`,()=>{
  const f=fixture(kind);let calls=0;const off=f.focus.subscribeBeforeBlur(()=>{calls++;f.control.dispose();});
  try {f.control.dispose();f.control.dispose();assert.equal(calls,1);assert.equal(f.focus.focused,null);assert(f.contents.every(c=>c.parent===null));}
  finally {off();f.focus.dispose();f.root.destroy();}
});

test('tab disposal aggregates independent focus, detach and header errors after releasing every frame',()=>{
  const f=fixture('tabs'),detach=Error('detach observer'),header=Error('header observer'),focus=Error('focus observer');
  const originalRemove=f.root.root.remove,button=f.control.header.children[0].children[0],originalDisable=button.setDisabled;
  f.root.root.remove=function(child){const result=originalRemove.call(this,child);if(child===f.control.element)throw detach;return result;};
  button.setDisabled=function(value){originalDisable.call(this,value);throw header;};
  const off=f.focus.subscribeBeforeBlur(()=>{throw focus;});
  try {
    assert.throws(()=>f.control.dispose(),error=>error instanceof AggregateError&&[detach,header,focus].every(item=>error.errors.includes(item)));
    assert.equal(f.control.element.parent,null);assert(f.contents.every(c=>c.parent===null));
    off();f.focus.reconcile();
    new GuiTabContainer({pages:f.contents.map((content,i)=>({id:String(i),title:String(i),content}))}).dispose();
    assert.doesNotThrow(()=>f.control.dispose());
  } finally {off();f.root.root.remove=originalRemove;button.setDisabled=originalDisable;f.focus.dispose();f.root.destroy();}
});

test('collapse continues through a failing event unbind and disables all headers before reporting cleanup errors',()=>{
  const f=fixture('collapse'),fault=Error('unbind observer'),headers=f.control.element.children.map(section=>section.children[0]);
  const titles=headers.map(header=>header.children.find(child=>child.themeControlType==='GuiCollapseHeader'));
  const first=titles[0],originalOff=first.off;let otherUnbinds=0;
  first.off=function(...args){originalOff.apply(this,args);throw fault;};
  const restored=[];
  for(const header of headers)for(const child of header.children)if(child!==first&&typeof child.off==='function'){
    const off=child.off;child.off=function(...args){otherUnbinds++;return off.apply(this,args);};restored.push(()=>{child.off=off;});
  }
  try {
    assert.throws(()=>f.control.dispose(),error=>error instanceof AggregateError&&error.errors.includes(fault));
    assert.ok(otherUnbinds>=2);assert(titles.every(title=>title.disabled));assert(f.contents.every(content=>content.parent===null));
    assert.equal(f.control.element.parent,null);assert.equal(f.focus.focused,null);
    new GuiTabContainer({pages:f.contents.map((content,i)=>({id:String(i),title:String(i),content}))}).dispose();
    assert.doesNotThrow(()=>f.control.dispose());
  } finally {first.off=originalOff;for(const restore of restored)restore();f.focus.dispose();f.root.destroy();}
});

test('malformed UTF-16 tab IDs reject structurally before borrowing any content',()=>{
  for(const id of ['\ud800','\udfff','prefix\ud800suffix']){
    const contents=[new GuiElement(),new GuiElement()];
    assert.throws(()=>new GuiTabContainer({pages:[{id:'valid-first',title:'first',content:contents[0]},{id,title:'bad',content:contents[1]}]}),error=>error.code==='invalid-input'&&!(error instanceof URIError));
    assert(contents.every(content=>content.parent===null));
    new GuiTabContainer({pages:contents.map((content,i)=>({id:String(i),title:String(i),content}))}).dispose();
  }
});

test('Unicode and punctuation tab IDs preserve distinct encoded identities and state',()=>{
  const ids=['章节/一','😀:close','a%2Fb','a/b'],control=new GuiTabContainer({id:'unicode',pages:ids.map(id=>({id,title:id,content:new GuiElement()}))});
  try {
    assert.deepEqual(control.header.children.map(node=>node.id),ids.map(id=>'unicode:tab:'+encodeURIComponent(id)));
    control.activate(ids[1]);const saved=control.serialize();control.activate(ids[2]);control.restore(saved);assert.equal(control.activeId,ids[1]);
  } finally {control.dispose();}
});

test('a constructor failure after attaching active content rolls back every acquired frame and node',()=>{
  const contents=[new GuiElement(),new GuiElement()],fault=Error('post-attach observer'),add=GuiElement.prototype.add;
  try {
    GuiElement.prototype.add=function(child){const result=add.call(this,child);if(child===contents[1])throw fault;return result;};
    assert.throws(()=>new GuiTabContainer({activeId:'1',pages:contents.map((content,i)=>({id:String(i),title:String(i),content}))}),error=>error===fault);
  } finally {GuiElement.prototype.add=add;}
  assert(contents.every(content=>content.parent===null));
  new GuiTabContainer({pages:contents.map((content,i)=>({id:String(i),title:String(i),content}))}).dispose();
});

test('constructor rollback reports both the original and detach failures after releasing all frames',()=>{
  const contents=[new GuiElement(),new GuiElement()],initial=Error('attach observer'),rollback=Error('detach observer');
  const add=GuiElement.prototype.add,remove=GuiElement.prototype.remove;
  try {
    GuiElement.prototype.add=function(child){const result=add.call(this,child);if(child===contents[1])throw initial;return result;};
    GuiElement.prototype.remove=function(child){const result=remove.call(this,child);if(child===contents[1])throw rollback;return result;};
    assert.throws(()=>new GuiTabContainer({activeId:'1',pages:contents.map((content,i)=>({id:String(i),title:String(i),content}))}),error=>error instanceof AggregateError&&error.errors.includes(initial)&&error.errors.includes(rollback));
  } finally {GuiElement.prototype.add=add;GuiElement.prototype.remove=remove;}
  assert(contents.every(content=>content.parent===null));
  new GuiTabContainer({pages:contents.map((content,i)=>({id:String(i),title:String(i),content}))}).dispose();
});

test('a later frame ownership conflict releases an earlier successful constructor lease',()=>{
  const free=new GuiElement(),owned=new GuiElement(),owner=new GuiTabContainer({pages:[{id:'first',title:'first',content:new GuiElement()},{id:'inactive',title:'inactive',content:owned}]});
  try {
    assert.throws(()=>new GuiTabContainer({pages:[{id:'free',title:'free',content:free},{id:'owned',title:'owned',content:owned}]}),/already belongs/);
    new GuiTabContainer({pages:[{id:'reuse',title:'reuse',content:free}]}).dispose();
    assert.equal(owner.pages[1].content,owned);assert.equal(owned.parent,null);
  } finally {owner.dispose();}
});
