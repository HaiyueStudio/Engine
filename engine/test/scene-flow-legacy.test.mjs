import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from '@haiyue/engine/scene';
import { AssetManager } from '@haiyue/engine/assets';
import { createMockEngine, createMockGpuDevice } from './helpers.mjs';
import { setImmediate as tick } from 'node:timers/promises';

test('legacy loadMany still loads and assigns sequentially, including visible earlier assignment before later failure',async()=>{
 const engine=createMockEngine(),manager=new AssetManager(createMockGpuDevice()),events=[];let finishFirst;
 engine.assetManager=manager;manager.registerLoader({type:'unit',extensions:['unit'],load:async url=>{events.push('load:'+url);if(url==='first.unit')return await new Promise(r=>finishFirst=r);throw Error('second failed');}});
 const scene=new Scene(engine,{render3D:false,render2D:false,gui:false});
 try{
  const task=scene.loadMany([{url:'first.unit',assign:()=>events.push('assign:first')},{url:'second.unit',assign:()=>events.push('assign:second')}]);task.catch(()=>{});await tick();assert.deepEqual(events,['load:first.unit']);finishFirst(1);await assert.rejects(task,/second failed/);assert.deepEqual(events,['load:first.unit','assign:first','load:second.unit']);assert.equal(manager.size,0);
 }finally{scene.destroy();manager.dispose();}
});
