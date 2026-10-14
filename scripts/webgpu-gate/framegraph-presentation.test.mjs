import test from 'node:test';
import assert from 'node:assert/strict';
import {requireFrameGraphPresentation} from './framegraph-presentation.mjs';
function client(states) {
  const calls=[];
  return {calls,async call(method){calls.push(method);return method==='Runtime.evaluate'?{result:{result:{value:states.length>1?states.shift():states[0]}}}:{};}};
}
test('foreground request waits for actual visible/focused state, without emulating visibility or disabling throttling',async()=>{
  const c=client([{visible:'hidden',focused:true},{visible:'visible',focused:true}]);
  assert.deepEqual(await requireFrameGraphPresentation(c,{pollMs:0}),{visible:'visible',focused:true});
  assert.deepEqual(c.calls,['Page.bringToFront','Runtime.evaluate','Runtime.evaluate']);
});
test('hidden and unfocused pages fail before capture, with actionable state',async()=>{
  for(const state of [{visible:'hidden',focused:true},{visible:'visible',focused:false},undefined]) {
    await assert.rejects(()=>requireFrameGraphPresentation(client([state]),{timeoutMs:0}),e=>e.code==='G09_PRESENTATION_UNAVAILABLE'&&e.presentation===state);
  }
});
