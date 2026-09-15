import assert from 'node:assert/strict';
import test from 'node:test';
import { IndexedSpriteRenderer } from '../dist/experimental-indexed-sprite.js';
import { createAuditGpuDevice, getAuditGpuDeviceState } from '../../scripts/benchmark/real-renderer-audit-device.mjs';

test('staging reuse preserves stable priority, active upload range, defaults, errors and recovery', () => {
  const writes=[];
  const device=createAuditGpuDevice({behaviors:{'queue.writeBuffer':({args,defaultImplementation})=>{
    if(args[2] instanceof ArrayBuffer)writes.push({source:args[2],bytes:args[4],floats:new Float32Array(args[2].slice(0,args[4]))});
    return defaultImplementation();
  }}});
  const renderer=new IndexedSpriteRenderer(device,[{id:'dot',width:1,height:1,format:'rgba8',pixels:new Uint8Array([255,255,255,255])}],[],{targetFormat:'rgba8unorm'});
  renderer.uploadAll();
  const render=commands=>{const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[]});renderer.render(pass,commands,480,960);pass.end();};
  const c=(x,priority=0)=>({spriteId:'dot',x,y:0,priority});
  render([c(30,2),c(10,1),c(20,1)]);
  assert.deepEqual([0,36,72].map(i=>writes.at(-1).floats[i]),[10,20,30]);
  const source=writes.at(-1).source;
  render([{...c(8),flipY:true,tint:[.2,.3,.4,.5]}]);
  render([c(9)]);
  assert.equal(writes.at(-1).source,source);
  assert.equal(writes.at(-1).bytes,144);
  assert.deepEqual([...writes.at(-1).floats.slice(20,24)],[1,1,1,1]);
  assert.deepEqual([...writes.at(-1).floats.slice(24,36)],[1,0,0,0,0,1,0,0,0,0,1,0]);
  assert.throws(()=>render([c(1),{...c(2),colorMatrix:[1]}]),/twelve/);
  render([c(4)]);assert.equal(writes.at(-1).floats[0],4);
  render(Array.from({length:100},(_,i)=>c(i)));const grown=writes.at(-1).source;
  assert.notEqual(grown,source);render([c(5)]);assert.equal(writes.at(-1).source,grown);
  const count=writes.length;render([]);assert.equal(writes.length,count);
  const next=createAuditGpuDevice();renderer.recover(next);renderer.uploadAll();
  const encoder=next.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[]});renderer.render(pass,[c(6)],480,960);pass.end();
  renderer.dispose();renderer.dispose();
  for(const gpu of [device,next])for(const type of ['buffer','texture'])assert.equal(getAuditGpuDeviceState(gpu).snapshot().resources[type].live,0);
});
