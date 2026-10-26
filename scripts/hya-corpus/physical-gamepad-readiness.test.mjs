import test from 'node:test';
import assert from 'node:assert/strict';
import {physicalGamepadReadiness as step} from './physical-gamepad-readiness.mjs';
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
