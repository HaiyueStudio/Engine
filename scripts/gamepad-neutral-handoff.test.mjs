import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from '../engine/test/helpers/internal-source.mjs';
const {GamepadInputLayers}=await importEngineSource('input/GamepadInputLayers.ts');
const {InputActionMap}=await importEngineSource('input/InputActionMap.ts');
const epsilon=1/65535;
const pad=value=>[{connected:true,buttons:Array.from({length:17},()=>({value:0,pressed:false})),axes:[value,-epsilon,epsilon,-epsilon]}];
test('a neutral physical drift value releases navigation ownership to the focused raw HYA route',()=>{
 const layers=new GamepadInputLayers(),raw=[],navigation=[];let focused=false;
 layers.add(InputActionMap.guiNavigation(),action=>{navigation.push(action);return true;},()=>true);
 layers.addRaw(sample=>{if(!focused||sample.control!=='axis:0')return false;raw.push(sample);return true;});
 layers.route(pad(epsilon),.5);focused=true;
 for(const value of [epsilon,epsilon,.05,-.05,-1,1,epsilon])assert.equal(layers.route(pad(value),.5)[0].axes[0],0);
 assert.ok(raw.some(s=>s.value===-1));assert.ok(raw.some(s=>s.value===1));assert.deepEqual(navigation,[]);
});
test('a held navigation claim remains until its own neutral boundary, including after unsubscribe',()=>{
 const layers=new GamepadInputLayers(),raw=[];let focused=false;
 const off=layers.add(InputActionMap.guiNavigation(),()=>true,()=>true);
 layers.addRaw(sample=>{if(!focused||sample.control!=='axis:0')return false;raw.push(sample);return true;});
 layers.route(pad(.9),.5);focused=true;off();
 for(const value of [.9,.4])assert.equal(layers.route(pad(value),.5)[0].axes[0],0);
 assert.equal(raw.length,0);layers.route(pad(.2),.5);assert.ok(raw.some(s=>s.value===.2));
});
test('neutral handoff preserves the former raw owner release without inventing an up edge for the new owner',()=>{
 const layers=new GamepadInputLayers(),old=[],next=[];
 layers.addRaw(sample=>{if(sample.control!=='axis:0')return false;old.push(sample);return true;});
 layers.route(pad(.9),.5);
 const off=layers.addRaw(sample=>{if(sample.control!=='axis:0')return false;next.push(sample);return true;});
 layers.route(pad(.9),.5);assert.equal(next.length,0);
 layers.route(pad(epsilon),.5);assert.equal(old.filter(s=>s.phases.includes('up')).length,1);
 assert.equal(next.some(s=>s.phases.includes('up')),false);
 layers.route(pad(.9),.5);assert.equal(next.filter(s=>s.phases.includes('down')).length,1);
 off();assert.equal(layers.route(pad(.9),.5)[0].axes[0],0);
});
test('blur release cannot replay a held input; a nonzero physical neutral permits a fresh press',()=>{
 const layers=new GamepadInputLayers(),events=[];
 layers.addRaw(sample=>{if(sample.control!=='axis:0')return false;events.push(sample);return true;});
 layers.route(pad(.9),.5);layers.release();layers.route(pad(.9),.5);layers.route(pad(.9),.5);
 assert.equal(events.filter(s=>s.phases.includes('down')).length,1);assert.equal(events.filter(s=>s.phases.includes('up')).length,1);
 layers.route(pad(epsilon),.5);layers.route(pad(.9),.5);assert.equal(events.filter(s=>s.phases.includes('down')).length,2);
});
test('disconnect delivers the original raw release and reconnect keeps the original sampler path',()=>{
 const layers=new GamepadInputLayers(),events=[];
 layers.addRaw(sample=>{if(sample.control!=='axis:0')return false;events.push(sample);return true;});
 layers.route(pad(.9),.5);layers.route([null],.5);layers.route(pad(.9),.5);
 assert.equal(events.filter(s=>s.phases.includes('down')).length,2);assert.equal(events.filter(s=>s.phases.includes('up')).length,1);
});
test('navigation alone still captures low-amplitude analog input before gameplay normalization',()=>{
 const layers=new GamepadInputLayers();layers.add(InputActionMap.guiNavigation(),()=>true,()=>true);
 for(const value of [epsilon,.01,.1,.2,.4,.9])assert.equal(layers.route(pad(value),.5)[0].axes[0],0);
});
