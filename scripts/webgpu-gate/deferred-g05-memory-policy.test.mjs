import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {captureG05ResourceSnapshot,summarizeG05ResourceRecords,validateG05RoomMemory} from './deferred-g05-memory-policy.mjs';
import {valid} from './deferred-g05-test-data.mjs';
import {parseG05RoomOptions} from './deferred-g05-policy.mjs';
const config=JSON.parse(readFileSync(new URL('../../config/lighting-performance-021.json',import.meta.url)));
test('resource estimates retain every buffer/texture, view identity and unclassified Deferred allocation',()=>{
 const records=[{id:0,type:'texture',label:'TransientMRT:camera:a:0',estimatedBytes:64},{id:1,type:'buffer',label:'DeferredTiles:camera:a',estimatedBytes:32},{id:2,type:'buffer',label:'DeferredAO.visibility',estimatedBytes:16},{id:3,type:'texture',label:'ordinary-hdr',estimatedBytes:8},{id:4,type:'buffer',label:'DeferredUnexpected',estimatedBytes:4}];
 const s=summarizeG05ResourceRecords(records);assert.equal(s.allocationEstimateBytes,124);assert.equal(s.deferredEstimateBytes,116);assert.equal(s.totals.ao.bytes,16);assert.equal(s.totals['other-deferred'].count,1);assert.equal(s.views[0].key,'camera:a');
 assert.throws(()=>summarizeG05ResourceRecords([...records,records[0]]),/duplicate/);
 const snapshot=captureG05ResourceSnapshot({getDebugSnapshot:()=>({enabled:true,resources:records})});assert.equal(snapshot.driverResidentMemory,false);assert.equal(snapshot.records.length,5);
 assert.throws(()=>captureG05ResourceSnapshot({getDebugSnapshot:()=>({enabled:false})}),/Detailed/);
});
test('steady room memory checks real totals and frozen per-view ceilings without declaring pending-generation/AO coverage',()=>{
 const r=valid(parseG05RoomOptions(['--case=dynamic-128-four-view'])),before=JSON.stringify(config),report=validateG05RoomMemory(r,config);
 assert.equal(report.status,'passed');assert.equal(report.checks.length,15);assert.match(report.scope,/two pending generations and AO need separate/);assert.equal(JSON.stringify(config),before);
 for(const mutate of [r=>delete r.resourceAttribution,r=>r.resourceAttribution.cpu.driverResidentMemory=true,r=>r.resources.gpu.buffer.estimatedBytes++,r=>r.resourceAttribution.cpu.records[0].estimatedBytes++,r=>r.resourceAttribution.gpu.records.pop()]){const copy=structuredClone(r);mutate(copy);assert.throws(()=>validateG05RoomMemory(copy,config));}
});
test('memory overflow, missing generations and new Deferred owners cannot pass using old totals',()=>{
 const r=valid(parseG05RoomOptions(['--case=1080p-128']));
 for(const phase of ['warm','cpu','gpu']){
  const s=r.resourceAttribution[phase];s.records.find(r=>r.type==='buffer').estimatedBytes=12*1024*1024;Object.assign(s,summarizeG05ResourceRecords(s.records));r.resources[phase].buffer.estimatedBytes=12*1024*1024;
 }
 const report=validateG05RoomMemory(r,config);assert.equal(report.status,'failed');assert.ok(report.checks.some(c=>c.metric==='conservativeViewAllocationBytes'&&!c.passed));
 const unknown=structuredClone(r);for(const phase of ['warm','cpu','gpu']){const s=unknown.resourceAttribution[phase];s.records.find(r=>r.type==='buffer').label='DeferredUnknown';Object.assign(s,summarizeG05ResourceRecords(s.records));}
 assert.throws(()=>validateG05RoomMemory(unknown,config),/Unattributed/);
 const growing=valid();const s=growing.resourceAttribution.gpu;s.records.find(r=>r.type==='buffer').estimatedBytes++;Object.assign(s,summarizeG05ResourceRecords(s.records));growing.resources.gpu.buffer.estimatedBytes++;
 assert.throws(()=>validateG05RoomMemory(growing,config),/grew/);
});
