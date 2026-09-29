import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseG05CostOptions,validateG05CostResult} from './deferred-g05-cost-policy.mjs';
import {valid as room} from './deferred-g05-test-data.mjs';
import {summarizeG05ResourceRecords} from './deferred-g05-memory-policy.mjs';
const config=JSON.parse(readFileSync(new URL('../../config/lighting-performance-021.json',import.meta.url)));
function valid(ao='off',caseId='small-8'){
 const options=parseG05CostOptions([`--case=${caseId}`,`--ao=${ao}`]),r=room(options);
 r.creationCosts={schemaVersion:1,ao,settings:ao==='off'?null:{radius:2,intensity:3,resolutionScale:1,quality:'high'},scope:'API time, not isolated driver compiler time',counts:{cold:2,warm:2,cpu:2,gpu:2},records:[{method:'createShaderModule',stage:'profile',label:'test',status:'passed',bytes:32,sha256:'a'.repeat(64),callMs:1},{method:'createRenderPipelineAsync',stage:'first-frame',label:'test',status:'passed',shaderIds:[0],callMs:1,settleMs:2}]};
 for(const phase of ['warm','cpu','gpu']){
  const s=r.resourceAttribution[phase],records=s.records;records.push({id:5,type:'buffer',label:'DeferredAO.neutral',estimatedBytes:260},{id:8,type:'buffer',label:'DeferredAO.neutral',estimatedBytes:260});
  if(ao!=='off'){records.push({id:6,type:'buffer',label:'DeferredAO.visibility',estimatedBytes:256+Math.ceil(r.width*2/256)*256*r.height},{id:7,type:'texture',label:'DeferredAO.visibility:0',estimatedBytes:2*r.width*r.height});}
  Object.assign(s,summarizeG05ResourceRecords(records));
  for(const type of ['buffer','texture']){const rows=records.filter(r=>r.type===type);Object.assign(r.resources[phase][type],{current:rows.length,estimatedBytes:rows.reduce((n,r)=>n+r.estimatedBytes,0)});}
 }
 r.allocationBudget={limitBytes:536870912,reservedBytes:50000000,peakReservedBytes:50000000};r.cleanup.allocationBudgetReservedBytes=0;
 r.tilePlan={tileCount:Math.ceil(r.width/16)*Math.ceil(r.height/16),storedTiles:0,fullListTiles:Math.ceil(r.width/16)*Math.ceil(r.height/16),memoryLimitedTiles:1,viewBytes:60000000};
 return {options,r};
}
test('cost options freeze room/quality and require explicit AO selection',()=>{
 assert.equal(parseG05CostOptions(['--case=small-8','--ao=ssao']).ao,'ssao');
 assert.equal(parseG05CostOptions(['--case=1080p-128','--ao=gtao']).caseId,'1080p-128');
 for(const args of [[],['--case=small-8','--ao=bad'],['--ao=gtao'],['--case=small-8','--ao=gtao','--static'],['--case=small-8','--ao=gtao','--idle-ms=30000']])assert.throws(()=>parseG05CostOptions(args));
});
test('cost attribution retains shader variants, linked pipelines and full AO storage',()=>{
 for(const ao of ['off','gtao','sao','ssao']){const {options,r}=valid(ao),report=validateG05CostResult(r,options,config);assert.equal(report.uniqueShaderBytes,32);assert.equal(report.pipelineCalls,1);assert.equal(report.memory[0].aoBytes,ao==='off'?520:3687176);}
});
test('cold or steady creation omissions and false shader attribution cannot pass',()=>{
 for(const mutate of [r=>r.creationCosts.counts.cpu++,r=>r.creationCosts.records[0].bytes=0,r=>r.creationCosts.records[0].sha256='missing',r=>r.creationCosts.records[1].shaderIds=[99],r=>r.creationCosts.records[1].settleMs=0,r=>r.creationCosts.settings={},r=>r.resourceAttribution.cpu.driverResidentMemory=true,r=>r.resources.gpu.buffer.current++,r=>r.creationCosts.records[0].stage='gpu']){const {options,r}=valid();mutate(r);assert.throws(()=>validateG05CostResult(r,options,config));}
});

test('1080p AO over-budget evidence cannot pass merely because pixels and cleanup pass',()=>{
 const {options,r}=valid('gtao','1080p-128');
 const mutated=structuredClone(config);mutated.memory.maxDeferredBytesPerViewGeneration=1;assert.throws(()=>validateG05CostResult(r,options,mutated),/AO allocation budget exceeded.*per-view limit 1/);
});
test('compact AO still fails the frozen limit if the old full tile allocation is retained',()=>{
 const {options,r}=valid('gtao','1080p-128');
 for(const phase of ['warm','cpu','gpu']){
  const s=r.resourceAttribution[phase];s.records.push({id:9,type:'buffer',label:'DeferredTiles:real-frame-view:0',estimatedBytes:4308480});Object.assign(s,summarizeG05ResourceRecords(s.records));
  r.resources[phase].buffer.current++;r.resources[phase].buffer.estimatedBytes+=4308480;
 }
 assert.throws(()=>validateG05CostResult(r,options,config),/AO allocation budget exceeded/);
});
