import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGpuStateObserver } from './framegraph-gpu-state-observer.mjs';
const line='GPU-1234, NVIDIA GeForce GTX 1070 Ti, 582.78, P0, 1607, 4006, 55, 20, 10, 65.1, Not Active, Not Active, Not Active\n';
async function output() {const root=resolve('artifacts/engine-0.2.1/g09');await mkdir(root,{recursive:true});return resolve(await mkdtemp(resolve(root,'gpu-observer-test-')),'telemetry.jsonl');}
function processFixture(schedule) {
  const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.pid=123;p.kills=0;
  p.kill=()=>{p.kills++;setImmediate(()=>p.emit('close',null,'SIGTERM'));return true;};
  return {process:p,spawnProcess:(_exe,args,options)=>{assert(args.includes('200'));assert.equal(options.windowsHide,true);setImmediate(()=>schedule(p));return p;}};
}
test('persistent GPU observer retains split stdout lines and stops only its own child once',async()=>{
  const path=await output(),f=processFixture(p=>{p.stdout.write(line.slice(0,12));p.stdout.write(line.slice(12));setTimeout(()=>p.stdout.write(line),15);});
  const o=await startGpuStateObserver(path,{spawnProcess:f.spawnProcess}),a=await o.stop(),b=await o.stop();
  assert.deepEqual(a,b);assert.equal(f.process.kills,1);assert.equal(a.stopped,true);assert.equal(a.unexpectedExit,false);assert.equal(a.error,'');
  assert.equal((await readFile(path,'utf8')).trim().split('\n').length,2);
});
test('invalid telemetry or empty startup terminates observer and retains failed metadata',async()=>{
  for(const outputLine of ['bad\n','']){
    const f=processFixture(p=>p.stdout.write(outputLine));
    await assert.rejects(startGpuStateObserver(await output(),{spawnProcess:f.spawnProcess,startupTimeoutMs:50}),e=>{assert.equal(e.observer.stopped,true);assert.equal(e.observer.stopRequested,true);return /did not start/.test(e.message);});
    assert.equal(f.process.kills,1);
  }
});
test('an observer exit before deliberate shutdown is a failure even after valid rows',async()=>{
  const f=processFixture(p=>{p.stdout.write(line);setTimeout(()=>p.stdout.write(line),10);});
  const o=await startGpuStateObserver(await output(),{spawnProcess:f.spawnProcess});f.process.emit('close',3,null);
  const result=await o.stop();assert.equal(result.unexpectedExit,true);assert.equal(result.closeInfo.code,3);assert.equal(f.process.kills,0);
});
