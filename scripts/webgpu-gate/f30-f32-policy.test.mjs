import test from 'node:test';
import assert from 'node:assert/strict';
import {validateF30F32Pixels,F30_F32_CASE_IDS} from './f30-f32-policy.mjs';
function fixture(){return{schemaVersion:1,status:'passed',role:'native-correctness-regression',adapter:{isFallbackAdapter:false},maximumAllowedChannelDifference:0,failures:[],validationErrors:[],resourceResidue:[{buffers:0,textures:0,querySets:0,estimatedBytes:0}],cases:F30_F32_CASE_IDS.map(id=>({id,width:128,height:128,maximumChannelDifference:0,changedChannels:0,visibleChannels:30,candidateSha256:'a'.repeat(64),referenceSha256:'a'.repeat(64)}))};}
test('pixel gate accepts the complete native comparison matrix',()=>assert.equal(validateF30F32Pixels(fixture()).comparisons,50));
for(const[id,change]of [
 ['missing case',r=>r.cases.pop()],['duplicate identity',r=>r.cases[1].id=r.cases[0].id],['missing named workload',r=>r.cases[0].id='hya-unused'],['pixel changed',r=>r.cases[0].maximumChannelDifference=1],['blank reference',r=>r.cases[0].visibleChannels=0],['wrong frame size',r=>r.cases[0].width=64],['weakened tolerance',r=>r.maximumAllowedChannelDifference=1],['software adapter',r=>r.adapter.isFallbackAdapter=true],['GPU error',r=>r.validationErrors.push('validation')],['unreleased buffer',r=>r.resourceResidue[0].buffers=1],['mismatched hashes',r=>r.cases[0].referenceSha256='b'.repeat(64)],
])test('pixel gate rejects '+id,()=>{const r=fixture();change(r);assert.throws(()=>validateF30F32Pixels(r));});
