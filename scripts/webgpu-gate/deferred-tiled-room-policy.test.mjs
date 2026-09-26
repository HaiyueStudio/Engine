import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTiledRoomOptions,validateTiledRoomResult,summarizeTiledRoomTiming} from './deferred-tiled-room-policy.mjs';
test('room capture scope cannot silently override frozen sample counts or workload',()=>{
  assert.deepEqual(parseTiledRoomOptions(['--count=128','--overlap','--integrated','--reference','--full']),{count:128,overlap:true,preference:'low-power',algorithm:'reference',full:true});
  assert.throws(()=>parseTiledRoomOptions(['--samples=1']));assert.throws(()=>parseTiledRoomOptions(['--count=128','--count=256']));
  assert.throws(()=>validateTiledRoomResult({status:'passed',schemaVersion:1},parseTiledRoomOptions([])),/adapter/);
});
test('lighting percentile uses paired cull plus resolve samples and does not sum separate percentiles',()=>{
  const raw=Array.from({length:20},(_,i)=>({cpuRuntimeMs:1,frameWallMs:20,gpuSpanMs:18,gpuPassSumMs:15,cullMs:i<10?10:1,resolveMs:i<10?1:10}));
  const summary=summarizeTiledRoomTiming(raw);assert.equal(summary.cullMs,10);assert.equal(summary.resolveMs,10);assert.equal(summary.lightingMs,11);
});
