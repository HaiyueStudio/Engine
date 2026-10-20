import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {G05_LOW_LIMIT_CASES,validateG05LowLimits} from './deferred-g05-low-limits-policy.mjs';
const valid=()=>({schemaVersion:1,status:'passed',physicalLowLimitQualified:true,suite:'g05-native-low-limits',adapter:{vendor:'amd',architecture:'rdna-1',isFallbackAdapter:false},validationErrors:[],cases:G05_LOW_LIMIT_CASES.flatMap(c=>c.algorithms.map(algorithm=>({status:'passed',key:c.key,algorithm,requested:c.requested,actual:c.requested,limitSource:'native-device.limits',strict:{reason:`device-limit:${c.key}`,observed:c.requested,supported:c.required,code:'E_DEFERRED_LIGHTING_CAPABILITY'},forward:{requested:`deferred-${algorithm}`,effective:'forward',completeCoverage:false,reason:`device-limit:${c.key}`,recordResult:false},deferredCreated:[],systemDestroyed:true,deviceDestroyed:true})))});
test('native low-limit matrix requires all real reduced limits, strict rejection and explicit restricted fallback',()=>{
 const r=valid();validateG05LowLimits(r);assert.equal(r.cases.length,7);
 for(const mutate of [r=>r.cases.pop(),r=>r.cases[0].actual=8,r=>r.cases[0].limitSource='injected',r=>r.cases[0].strict.supported=4,r=>r.cases[0].forward.completeCoverage=true,r=>r.cases[0].forward.recordResult=true,r=>r.cases[0].deferredCreated=[{label:'DeferredAO.neutral'}],r=>r.cases[0].deviceDestroyed=false,r=>r.validationErrors=['validation']]){const r=valid();mutate(r);assert.throws(()=>validateG05LowLimits(r));}
});
test('source binding threshold remains tied to frozen 1024/8 source ABI',()=>{
 const config=JSON.parse(readFileSync(new URL('../../config/lighting-performance-021.json',import.meta.url)));
 assert.equal(G05_LOW_LIMIT_CASES.find(c=>c.key==='maxStorageBufferBindingSize').required,16+config.layout.lightStrideBytes*(config.layout.localCapacity+config.layout.directionalCapacity));
});

test('native limits clamped above requirements are unavailable, never physical coverage',()=>{
 const r=valid();r.status='unavailable';r.physicalLowLimitQualified=false;
 const row=r.cases[0];Object.assign(row,{status:'unavailable',actual:8,reason:'native-limit-at-or-above-engine-requirement'});delete row.strict;delete row.forward;
 validateG05LowLimits(r);
 for(const mutate of [r=>r.status='passed',r=>r.physicalLowLimitQualified=true,r=>r.cases[0].actual=4,r=>r.cases[0].forward={effective:'forward'},r=>r.cases[0].deviceDestroyed=false]){const bad=structuredClone(r);mutate(bad);assert.throws(()=>validateG05LowLimits(bad));}
});
