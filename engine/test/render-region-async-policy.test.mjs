import test from 'node:test';
import assert from 'node:assert/strict';
import {asyncGuiFixtureSpec,ASYNC_GUI_STAGES,validateAsyncGuiResult} from './render-region-async-policy.mjs';
function population(){const cases=[];for(const format of ['rgba8unorm','rgba16float'])for(const samples of [1,4])for(const stage of ASYNC_GUI_STAGES)cases.push({id:`${stage}-${format}-${samples}`,sha256:(stage==='switch-start'?'a':stage==='switch-middle'?'b':'c').repeat(64),switch:{candidate:{thumb:stage==='switch-start'?0:stage==='switch-middle'?.5:1,color:stage==='switch-start'?0:stage==='switch-middle'?.5:1,animating:['switch-start','switch-middle'].includes(stage)},ordinary:{thumb:stage==='switch-start'?0:stage==='switch-middle'?.5:1,color:stage==='switch-start'?0:stage==='switch-middle'?.5:1,animating:['switch-start','switch-middle'].includes(stage)}},fontListeners:0,imageListeners:0,channelsCompared:384*216*4,maxRawChannelDifference:0,regional:{records:{gui:stage.startsWith('static-')||['image-old-source-late','detached-image-late'].includes(stage)?0:1,scene:1},solves:0,guiUploads:0,bufferUploadBytes:0,textureUploads:0,textureUploadTexels:0,passes:1,draws:1,stats:{retainedColorBytes:0,workingColorBytes:0,workingRetiringColorBytes:0,regionDepthBytes:0,totalRegionAttachmentBytes:0,cachedRegions:0},gpuResourceSnapshot:{texture:{estimatedBytes:0}}},inertia:{frames:70,offset:113,referenceOffset:113}});return{status:'passed',caseCount:84,cases};}
test('async diagnostic rejects arguments and requires all image/font/inertia/lifecycle cohorts',()=>{assert.throws(()=>asyncGuiFixtureSpec(['--skip-font']));assert.equal(asyncGuiFixtureSpec().count,84);assert.equal(validateAsyncGuiResult(population()).cases.length,84);for(const change of [v=>v.cases.pop(),v=>v.cases[0].id=v.cases[1].id,v=>v.cases[0].channelsCompared=1]){const v=population();change(v);assert.throws(()=>validateAsyncGuiResult(v));}});
test('async acceptance rejects stale first-frame pixels, static work, failed inertia and leaked listeners',()=>{for(const change of [v=>v.cases[2].regional.records.gui=0,v=>v.cases[1].regional.guiUploads=1,v=>v.cases[8].inertia.referenceOffset=114,v=>v.cases.find(c=>c.id==='listener-teardown-rgba8unorm-1').fontListeners=1,v=>v.cases.find(c=>c.id==='listener-teardown-rgba8unorm-1').imageListeners=1,v=>v.cases[0].maxRawChannelDifference=3/255,v=>v.cases[0].regional.textureUploads=NaN]){const v=population();change(v);assert.throws(()=>validateAsyncGuiResult(v));}});
test('async acceptance applies the unchanged shared cache/work-set contract to every pixel comparison',()=>{for(const change of [v=>v.cases[0].regional.stats.cachedRegions=9,v=>v.cases[0].regional.stats.retainedColorBytes=64*1024*1024+1,v=>v.cases[0].regional.stats.workingColorBytes=1]){const v=population();change(v);assert.throws(()=>validateAsyncGuiResult(v));}});

test('switch animation requires real intermediate/final pixels, matching clocks and static skip',()=>{
 const get=(r,stage)=>r.cases.find(c=>c.id===stage+'-rgba8unorm-1');
 for(const mutate of [
  r=>get(r,'switch-middle').switch.candidate.thumb=1,
  r=>get(r,'switch-end').switch.ordinary.color=.9,
  r=>get(r,'switch-start').switch.candidate.animating=false,
  r=>get(r,'switch-middle').sha256=get(r,'switch-start').sha256,
  r=>get(r,'static-switch').regional.records.gui=1,
  r=>get(r,'switch-end').regional.solves=1,
 ]){const r=population();mutate(r);assert.throws(()=>validateAsyncGuiResult(r));}
});
