import assert from 'node:assert/strict';
import test from 'node:test';
import {GuiRoot, GuiButton, GuiInput, GuiElement, GuiModal, GuiSystem, serializeGuiElement, deserializeGuiElement} from '../dist/gui.js';

class Style {
  value=''; priority=''; writes=0;
  getPropertyValue(){return this.value;}
  getPropertyPriority(){return this.priority;}
  setProperty(_name,value,priority=''){this.value=value;this.priority=priority;this.writes++;}
  removeProperty(){this.value='';this.priority='';this.writes++;}
}
class Surface extends EventTarget {
  style=new Style();tabIndex=0;
  ownerDocument=Object.assign(new EventTarget(),{hidden:false,defaultView:new EventTarget()});
  getBoundingClientRect(){return {left:10,top:20,width:200,height:100};}
  focus(){}
}
function setup() {
  const canvas=new Surface(),engine={canvas,displayWidth:200,displayHeight:100,width:400,height:200};
  const a=new GuiSystem(engine),b=new GuiSystem(engine),ra=new GuiRoot(),rb=new GuiRoot();
  for(const [system,root] of [[a,ra],[b,rb]]){system.roots.add(root);system.renderer.prepare=()=>{};}
  const ready=()=>{ra.layout(200,100);rb.layout(200,100);a.inputDomain.refresh();};
  const pointer=(x,y,type='pointermove',pointerType='mouse')=>{
    const e=new Event(type,{cancelable:true});Object.assign(e,{pointerId:1,pointerType,clientX:x+10,clientY:y+20,button:0,buttons:0});canvas.dispatchEvent(e);
  };
  return {canvas,a,b,ra,rb,ready,pointer,close(){a.destroy();b.destroy();ra.destroy();rb.destroy();}};
}

test('mouse uses text and pointer defaults, restores the application cursor in gaps and on leave',()=>{
  const s=setup();try{
    s.canvas.style.setProperty('cursor','crosshair','important');
    s.rb.add(new GuiInput({width:80,height:30}));s.rb.add(new GuiButton({x:100,width:80,height:30}));s.ready();
    s.pointer(20,10);assert.equal(s.canvas.style.value,'text');
    const writes=s.canvas.style.writes;s.pointer(21,10);assert.equal(s.canvas.style.writes,writes,'unchanged hover does not rewrite CSS');
    s.pointer(120,10);assert.equal(s.canvas.style.value,'pointer');
    s.pointer(90,80);assert.equal(s.canvas.style.value,'crosshair');assert.equal(s.canvas.style.priority,'important');
    s.pointer(20,10);s.pointer(20,10,'pointerleave');assert.equal(s.canvas.style.value,'crosshair');
  }finally{s.close();}
});

test('top GUI ownership, ignored controls and modals use the same hit routing as clicks',()=>{
  const s=setup();try{
    s.ra.add(new GuiButton({width:80,height:30}));const input=s.rb.add(new GuiInput({width:80,height:30}));s.ready();
    s.pointer(20,10);assert.equal(s.canvas.style.value,'text');
    input.pointerFilter='ignore';s.a.inputDomain.refresh();assert.equal(s.canvas.style.value,'pointer');
    const modal=s.rb.add(new GuiModal());modal.show();s.ready();assert.equal(s.canvas.style.value,'','modal blocks cursor from the lower button');
    modal.hide();s.ready();assert.equal(s.canvas.style.value,'pointer');
  }finally{s.close();}
});

test('stationary mouse refreshes after controls disable, hide, detach or a layer is destroyed',()=>{
  const s=setup();try{
    const button=s.rb.add(new GuiButton({width:80,height:30}));s.ready();s.pointer(20,10);assert.equal(s.canvas.style.value,'pointer');
    button.setDisabled(true);s.a.inputDomain.refresh();assert.equal(s.canvas.style.value,'');
    button.setDisabled(false);button.visible=false;s.a.inputDomain.refresh();assert.equal(s.canvas.style.value,'');
    button.visible=true;s.a.inputDomain.refresh();assert.equal(s.canvas.style.value,'pointer');
    s.rb.remove(button);s.a.inputDomain.refresh();assert.equal(s.canvas.style.value,'');
    s.rb.add(button);s.ready();assert.equal(s.canvas.style.value,'pointer');s.b.destroy();assert.equal(s.canvas.style.value,'');
  }finally{s.close();}
});

test('custom cursors, parent inheritance and subclass defaults require no extra control registry',()=>{
  const s=setup();try{
    class CustomButton extends GuiButton {}
    const parent=s.rb.add(new GuiElement({width:90,height:40,style:{cursor:'grab'}}));
    const child=parent.add(new GuiElement({width:80,height:30}));s.rb.add(new CustomButton({x:100,width:80,height:30}));s.ready();
    s.pointer(20,10);assert.equal(s.canvas.style.value,'grab');
    child.style.cursor='help';s.a.inputDomain.refresh();assert.equal(s.canvas.style.value,'help');
    s.pointer(120,10);assert.equal(s.canvas.style.value,'pointer');
    const restored=deserializeGuiElement(serializeGuiElement(child));assert.equal(restored.style.cursor,'help');
  }finally{s.close();}
});

test('touch does not acquire a browser cursor; blur and document hiding restore prior state',()=>{
  const s=setup();try{
    s.rb.add(new GuiButton({width:80,height:30}));s.ready();s.pointer(20,10,'pointermove','touch');assert.equal(s.canvas.style.value,'');
    s.pointer(20,10);s.canvas.ownerDocument.defaultView.dispatchEvent(new Event('blur'));assert.equal(s.canvas.style.value,'');
    s.pointer(20,10);s.canvas.ownerDocument.hidden=true;s.canvas.ownerDocument.dispatchEvent(new Event('visibilitychange'));assert.equal(s.canvas.style.value,'');
  }finally{s.close();}
});

test('application cursor edits during hover survive leaving or final disposal',()=>{
  const s=setup();try{
    s.rb.add(new GuiButton({width:80,height:30}));s.ready();s.pointer(20,10);
    s.canvas.style.setProperty('cursor','wait');s.pointer(20,10,'pointerleave');assert.equal(s.canvas.style.value,'wait');
    s.pointer(20,10);assert.equal(s.canvas.style.value,'pointer');s.b.destroy();assert.equal(s.canvas.style.value,'wait');
  }finally{s.close();}
});

test('non-DOM hosts without a style object keep input operational',()=>{
  const s=setup();try{
    delete s.canvas.style;s.rb.add(new GuiInput({width:80,height:30}));s.ready();assert.doesNotThrow(()=>s.pointer(20,10));
  }finally{s.close();}
});
