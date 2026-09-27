import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTiledRoomOptions,validateTiledRoomResult,summarizeTiledRoomTiming} from './deferred-tiled-room-policy.mjs';
test('room capture scope cannot silently override frozen sample counts or workload',()=>{
  assert.deepEqual(parseTiledRoomOptions(['--count=128','--overlap','--integrated','--reference','--full']),{count:128,overlap:true,preference:'low-power',algorithm:'reference',full:true,idleMs:30000});
  assert.throws(()=>parseTiledRoomOptions(['--samples=1']));assert.throws(()=>parseTiledRoomOptions(['--count=128','--count=256']));
  assert.throws(()=>validateTiledRoomResult({status:'passed',schemaVersion:1},parseTiledRoomOptions([])),/adapter/);
});
test('lighting percentile uses paired cull plus resolve samples and does not sum separate percentiles',()=>{
  const raw=Array.from({length:20},(_,i)=>({cpuRuntimeMs:1,frameWallMs:20,gpuSpanMs:18,gpuPassSumMs:15,cullMs:i<10?10:1,resolveMs:i<10?1:10}));
  const summary=summarizeTiledRoomTiming(raw);assert.equal(summary.cullMs,10);assert.equal(summary.resolveMs,10);assert.equal(summary.lightingMs,11);
});

test('cooldown may be extended without reducing the frozen minimum',()=>{
  assert.equal(parseTiledRoomOptions(['--full','--idle-ms=120000']).idleMs,120000);
  for(const value of ['29999','300001','NaN','Infinity','120000.5','1e5',''])assert.throws(()=>parseTiledRoomOptions([`--idle-ms=${value}`]),/idle/);
  assert.throws(()=>parseTiledRoomOptions(['--idle-ms=30000','--idle-ms=120000']),/one/);
});
