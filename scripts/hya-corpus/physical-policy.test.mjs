import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePhysicalEvidence,physicalGamepadProgress} from './physical-policy.mjs';
const confirmation={confirmed:true,confirmedAt:'2026-10-26T00:00:00Z',note:'Operator performed the real hardware workflow.'};
const base={status:'awaiting-operator-confirmation',smoke:false,servedBytes:{status:'passed'},changed:[],failures:[],leases:0,resources:{totals:{resources:0}}};
function ime(){return{...base,profile:'browser-real-ime',events:['你好',''].flatMap(compositionData=>[
  {type:'compositionstart',isTrusted:true,responder:'1'},
  {type:'compositionupdate',isTrusted:true,responder:'1',compositionData},
  {type:'beforeinput',inputType:'insertCompositionText',isTrusted:true,responder:'1',compositionData},
  ...(compositionData===''?[{type:'keydown',key:'Escape',isTrusted:true,responder:'1'}]:[]),
  {type:'compositionend',isTrusted:true,responder:'1',compositionData},
 ]),
  commits:[{data:'你好'}],snapshots:[0,0,1].map(n=>({data:'你好',composing:false,viewport:[800+n*100,600]}))};}
function pad(){return{...base,profile:'physical-gamepad',polls:100,inputAudit:{readySamples:100,sceneActionLeaks:0,unarmedGuiControls:0},hardware:[{id:'Physical controller',buttons:16,axes:4}],commits:[{data:'AAA'},{data:'AA'}],controls:[
  {control:'button:0',phase:'down',time:100},{control:'button:0',phase:'up',time:1000},
  ...[-1,1,0].map(value=>({control:'axis:0',phase:'change',value}))]};}
test('smoke, missing operator or stale bytes cannot become physical acceptance',()=>{
  assert.deepEqual(validatePhysicalEvidence(ime(),confirmation),[]);
  for(const [field,value]of [['smoke',true],['changed',['source.ts']],['servedBytes',{status:'failed'}]]){
    const r=ime();r[field]=value;assert.ok(validatePhysicalEvidence(r,confirmation).length);
  }
  assert.ok(validatePhysicalEvidence(ime(),null).length);
});

test('native Chrome scoped end preserves false trust only with complete trusted sessions',()=>{
  const r=ime();r.browserEvidence={product:'Chrome/155.0.8059.85',nativeBackend:true,presentationMode:'visible-window'};
  r.events.filter(e=>e.type==='compositionend').forEach(e=>e.isTrusted=false);
  assert.deepEqual(validatePhysicalEvidence(r,confirmation),[]);
  for(const mutate of [v=>v.browserEvidence.product='Chrome/unknown',v=>v.browserEvidence.nativeBackend=false,
    v=>v.browserEvidence.presentationMode='headless',v=>v.events[0].isTrusted=false,
    v=>v.events[2].isTrusted=false,v=>v.events[3].responder='other',v=>v.events.splice(v.events.findLastIndex(e=>e.type==='compositionend'),1),
    v=>v.events.filter(e=>e.type==='compositionend').forEach(e=>e.compositionData='你好')]){
    const changed=structuredClone(r);mutate(changed);assert.ok(validatePhysicalEvidence(changed,confirmation).length);
  }
});

test('Windows IME Process/229 cancellation stays raw and requires the same composed session',()=>{
  const r=ime(),key=r.events.find(e=>e.type==='keydown');
  Object.assign(key,{key:'Process',keyCode:229,nativeComposing:true});
  assert.deepEqual(validatePhysicalEvidence(r,confirmation),[]);
  for(const mutate of [v=>v.events.find(e=>e.type==='keydown').nativeComposing=false,
    v=>v.events.find(e=>e.type==='keydown').isTrusted=false,
    v=>v.events.find(e=>e.type==='keydown').responder='other',
    v=>v.events.find(e=>e.type==='keydown').keyCode=0]){
    const changed=structuredClone(r);mutate(changed);assert.ok(validatePhysicalEvidence(changed,confirmation).length);
  }
});
test('IME requires trusted commit/cancel, exactly one data commit and real resize',()=>{
  for(const mutate of [r=>r.events.forEach(e=>e.isTrusted=false),r=>r.commits.push({data:'你好'}),r=>r.snapshots[1].data='cancel leaked',r=>r.snapshots.forEach(s=>s.viewport=[800,600])]){
    const r=ime();mutate(r);assert.ok(validatePhysicalEvidence(r,confirmation).length);
  }
});
test('gamepad requires hardware, actual hold duration, no repeats and centered axis',()=>{
  assert.deepEqual(validatePhysicalEvidence(pad(),confirmation),[]);
  for(const mutate of [r=>r.hardware=[],r=>r.controls[1].time=200,r=>r.controls.push({...r.controls[0]}),r=>r.controls.pop(),r=>r.commits.push({data:'AA'}),
    r=>r.inputAudit.readySamples=0,r=>r.inputAudit.sceneActionLeaks=1,r=>r.inputAudit.unarmedGuiControls=1]){
    const r=pad();mutate(r);assert.ok(validatePhysicalEvidence(r,confirmation).length);
  }
});

test('live gamepad progress uses the unchanged admission boundaries and rejects incomplete or repeated holds',()=>{
  const controls=[{control:'button:0',phase:'down',time:100},{control:'button:0',phase:'up',time:800},
    ...[-.5,.5,.15].map(value=>({control:'axis:0',value}))];
  const progress=physicalGamepadProgress(controls);
  assert.equal(progress.held,true);assert.equal(progress.left,true);assert.equal(progress.right,true);assert.equal(progress.center,true);
  for(const [index,value,field]of [[1,799.999,'held'],[2,-.499999,'left'],[3,.499999,'right'],[4,.150001,'center']]){
    const changed=structuredClone(controls);changed[index][index===1?'time':'value']=value;
    assert.equal(physicalGamepadProgress(changed)[field],false);
  }
  assert.equal(physicalGamepadProgress(controls.slice(0,1)).held,false);
  assert.equal(physicalGamepadProgress([...controls,controls[0]]).held,false);
  assert.equal(physicalGamepadProgress([]).axisValue,null);
});
