import assert from 'node:assert/strict';import {GuiInput} from '@haiyue/engine/gui';
import {GuiForm,GuiFormItem} from '../../artifacts/gui-p2/unit-compiled/gui-forms.js';
assert.equal(typeof globalThis.gc,'function');const form=new GuiForm(),references=[];
function cycle(index){const input=new GuiInput({value:'Field '+index}),item=new GuiFormItem({label:'Name',control:input}),off=form.register({key:'field',item,read:()=>input.value,write:value=>input.setValue(value)});references.push(new WeakRef(item));off();item.dispose();}
for(let i=0;i<32;i++)cycle(i);for(let i=0;i<4;i++){await new Promise(resolve=>setTimeout(resolve,0));globalThis.gc();}
const retained=references.filter(reference=>reference.deref()).length;console.log(JSON.stringify({cycles:32,retained,activeFields:Object.keys(form.getValues()).length}));form.dispose();assert.equal(retained,0,'Unregistered field controllers must not stay retained by a live form.');
