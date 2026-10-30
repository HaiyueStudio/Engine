import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {waitForProductionResult} from './production-observer.mjs';
test('busy production capture waits once for terminal status, disconnects and uses the original timeout',async()=>{
 let node={dataset:{status:''}},callback,disconnected=false,calls=0;
 const cdp={async call(method,params,timeout){calls++;assert.equal(method,'Runtime.evaluate');assert.equal(timeout,240000);assert.equal(params.awaitPromise,true);
  const completion=vm.runInNewContext(params.expression,{document:{documentElement:{},querySelector:()=>node},MutationObserver:class{constructor(fn){callback=fn;}observe(){}disconnect(){disconnected=true;}}});
  node.dataset.status='running';callback();assert.equal(disconnected,false);node.dataset.status='failed';callback();
  return {result:{result:{value:await completion}}};}};
 await waitForProductionResult(cdp,240000);assert.equal(calls,1);assert.equal(disconnected,true);
});
test('already complete status and inspector failures cannot turn into an unattended hang',async()=>{
 await waitForProductionResult({async call(_method,params){const value=await vm.runInNewContext(params.expression,{document:{querySelector:()=>({dataset:{status:'passed'}})}});return {result:{result:{value}}};}},240000);
 await assert.rejects(waitForProductionResult({async call(){return {result:{exceptionDetails:{text:'page gone'}}};}},240000));
 await assert.rejects(waitForProductionResult({},0));
});
