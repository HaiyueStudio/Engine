import test from 'node:test';
import assert from 'node:assert/strict';
import {physicalGamepadReadiness as step,physicalGamepadSelection,physicalGamepadDetection} from './physical-gamepad-readiness.mjs';
const neutral={focused:true,foreground:true,connected:true,buttons:[0,0],axes:[0,0]};
test('loading or an unfocused window never starts a GUI consumption assertion',()=>{
  for(const previous of ['waiting-focus','ready']){
    assert.equal(step(previous,{...neutral,focused:false,axes:[1]}),'waiting-focus');
    assert.equal(step(previous,{...neutral,foreground:false}),'waiting-focus');
  }
  assert.equal(step('waiting-focus',{...neutral,connected:false}),'waiting-controller');
});
test('focus must start neutral, then held buttons and the whole axis range stay in the same run',()=>{
  assert.equal(step('waiting-focus',{...neutral,buttons:[1]}),'waiting-neutral');
  assert.equal(step('waiting-focus',{...neutral,axes:[-.2]}),'waiting-neutral');
  assert.equal(step('waiting-focus',neutral),'ready');
  for(const axes of [[.05],[-1],[1],[0]])assert.equal(step('ready',{...neutral,buttons:[1],axes}),'ready');
});
test('focus loss and disconnect require a new neutral acquisition; no artificial focus is restored',()=>{
  const lost=step('ready',{...neutral,focused:false,buttons:[1]});
  assert.equal(step(lost,{...neutral,buttons:[1]}),'waiting-neutral');
  assert.equal(step('ready',{...neutral,connected:false}),'waiting-controller');
  assert.equal(step('waiting-controller',{...neutral,axes:[1]}),'waiting-neutral');
  assert.equal(step('waiting-neutral',neutral),'ready');
});

test('native slots may contain holes and a selected controller never silently switches',()=>{
  const pad={connected:true,index:2},other={connected:true,index:3},pads=[null,null,pad,other];
  assert.equal(physicalGamepadSelection(pads).pad,pad);assert.equal(physicalGamepadSelection(pads).index,2);
  assert.equal(physicalGamepadSelection([null,null,null,other],2),null);
  assert.equal(physicalGamepadSelection(pads,3).pad,other);assert.equal(physicalGamepadSelection([null,{connected:false}]),null);
});

test('detection explains preparation, browser exposure, focus and stale sampling separately',()=>{
  const state={requested:true,foreground:true,suspended:false,polls:10,lastSampleAgeMs:20,connectedIndices:[2],selectedIndex:2,prepared:true};
  assert.equal(physicalGamepadDetection(state).state,'detected');
  for(const [change,expected]of [[{requested:false},'start-required'],[{foreground:false},'foreground-required'],[{suspended:true},'sampling-paused'],[{polls:0},'sampling-paused'],[{lastSampleAgeMs:1501},'sampling-paused'],[{connectedIndices:[]},'waiting-browser'],[{selectedIndex:1},'selected-disconnected'],[{prepared:false},'waiting-neutral']])assert.equal(physicalGamepadDetection({...state,...change}).state,expected);
  assert.equal(physicalGamepadDetection({...state,lastSampleAgeMs:1500}).state,'detected');
});
