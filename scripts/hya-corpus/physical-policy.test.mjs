import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePhysicalEvidence} from './physical-policy.mjs';
const confirmation={confirmed:true,confirmedAt:'2026-10-26T00:00:00Z',note:'Operator performed the real hardware workflow.'};
const base={status:'awaiting-operator-confirmation',smoke:false,servedBytes:{status:'passed'},changed:[],failures:[],leases:0,resources:{totals:{resources:0}}};
function ime(){return{...base,profile:'browser-real-ime',events:['compositionstart','compositionupdate','compositionend','compositionstart'].map(type=>({type,isTrusted:true})).concat({type:'keydown',key:'Escape',isTrusted:true}),
  commits:[{data:'你好'}],snapshots:[0,0,1].map(n=>({data:'你好',composing:false,viewport:[800+n*100,600]}))};}
function pad(){return{...base,profile:'physical-gamepad',polls:100,hardware:[{id:'Physical controller',buttons:16,axes:4}],commits:[{data:'AAA'},{data:'AA'}],controls:[
  {control:'button:0',phase:'down',time:100},{control:'button:0',phase:'up',time:1000},
  ...[-1,1,0].map(value=>({control:'axis:0',phase:'change',value}))]};}
test('smoke, missing operator or stale bytes cannot become physical acceptance',()=>{
  assert.deepEqual(validatePhysicalEvidence(ime(),confirmation),[]);
  for(const [field,value]of [['smoke',true],['changed',['source.ts']],['servedBytes',{status:'failed'}]]){
    const r=ime();r[field]=value;assert.ok(validatePhysicalEvidence(r,confirmation).length);
  }
  assert.ok(validatePhysicalEvidence(ime(),null).length);
});
test('IME requires trusted commit/cancel, exactly one data commit and real resize',()=>{
  for(const mutate of [r=>r.events.forEach(e=>e.isTrusted=false),r=>r.commits.push({data:'你好'}),r=>r.snapshots[1].data='cancel leaked',r=>r.snapshots.forEach(s=>s.viewport=[800,600])]){
    const r=ime();mutate(r);assert.ok(validatePhysicalEvidence(r,confirmation).length);
  }
});
test('gamepad requires hardware, actual hold duration, no repeats and centered axis',()=>{
  assert.deepEqual(validatePhysicalEvidence(pad(),confirmation),[]);
  for(const mutate of [r=>r.hardware=[],r=>r.controls[1].time=200,r=>r.controls.push({...r.controls[0]}),r=>r.controls.pop(),r=>r.commits.push({data:'AA'})]){
    const r=pad();mutate(r);assert.ok(validatePhysicalEvidence(r,confirmation).length);
  }
});
