import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeferredFixtureBuildOptions,parseDeferredFixtureOptions,validateDeferredFixtureEvidence,validateDeferredReuseEvidence } from './deferred-fixture-policy.mjs';
test('Deferred diagnostic modes are explicit, mutually exclusive and cannot silently ignore flags',()=>{
  assert.deepEqual(parseDeferredFixtureOptions(['--room','--integrated']),{mode:'room',preference:'low-power',tier:'diagnostic-g02-room'});
  assert.equal(parseDeferredFixtureOptions(['--full']).mode,'reference');
  assert.throws(()=>parseDeferredFixtureOptions(['--full','--room']),/Select/);
  assert.throws(()=>parseDeferredFixtureOptions(['--formal']),/Unknown/);
});
test('Deferred evidence rejects partial case matrices, missing errors and software adapters',()=>{
  const options=parseDeferredFixtureOptions([]);
  const evidence={schemaVersion:1,status:'passed',adapter:{vendor:'test',architecture:'test',isFallbackAdapter:false},validationErrors:[],cleanup:{ownerResidual:0,liveGpuResources:0},cases:[0,1,8,9,32,128,256].map(count=>({count}))};
  validateDeferredFixtureEvidence(evidence,options);
  assert.throws(()=>validateDeferredFixtureEvidence({...evidence,validationErrors:undefined},options),/validation/);
  assert.throws(()=>validateDeferredFixtureEvidence({...evidence,cases:evidence.cases.slice(1)},options),/cases/);
  assert.throws(()=>validateDeferredFixtureEvidence({...evidence,cleanup:{ownerResidual:1,liveGpuResources:0}},options),/cleanup/);
  assert.throws(()=>validateDeferredFixtureEvidence({...evidence,adapter:{...evidence.adapter,isFallbackAdapter:true}},options),/native/);
  assert.throws(()=>validateDeferredFixtureEvidence(evidence,parseDeferredFixtureOptions(['--full'])),/independent/);
});
test('Room acceptance requires full 720p coverage and all four named scenarios',()=>{
  const options=parseDeferredFixtureOptions(['--room']);
  const evidence={schemaVersion:1,status:'passed',adapter:{vendor:'test',architecture:'test',isFallbackAdapter:false},validationErrors:[],cleanup:{ownerResidual:0,liveGpuResources:0},resolution:[1280,720],cases:[128,256,128,256].map(count=>({count,completeCoverage:true,litPixels:200000}))};
  validateDeferredFixtureEvidence(evidence,options);
  assert.throws(()=>validateDeferredFixtureEvidence({...evidence,resolution:[640,360]},options),/coverage/);
  evidence.cases[0].completeCoverage=false;
  assert.throws(()=>validateDeferredFixtureEvidence(evidence,options),/coverage/);
});

test('full evidence cannot omit any vertex-color or auxiliary-coverage oracle',()=>{
  const evidence={schemaVersion:1,status:'passed',adapter:{vendor:'test',architecture:'test',isFallbackAdapter:false},validationErrors:[],cleanup:{ownerResidual:0,liveGpuResources:0},
    cases:[0,1,8,9,32,128,256].map(count=>({count})),
    geometryAssertions:['vertex-color-interpolation','vertex-color-forward-deferred','vertex-alpha-auxiliary','normal-map','uv0-uv1-transform-samplers','texture-alpha-mask','clipping-update','double-sided','environment-ambient-once','light-color-remove-add'].map(id=>({id})),
    oracle:[...reuseEvidence(),{id:'submitted-arena-ordering',frames:32,checkedWords:128,stableBinding:true},{id:'all-independent-contributions',contributions:Array.from({length:256},(_,gpuId)=>({gpuId}))},...Array.from({length:8},()=>({id:'view-reconstruction'})),...['jitter-reconstruction','four-view-source-reuse','gpu-driven-indirect'].map(id=>({id}))],
  };
  const options=parseDeferredFixtureOptions(['--full']);
  validateDeferredFixtureEvidence(evidence,options);
  assert.throws(()=>validateDeferredFixtureEvidence({...evidence,oracle:evidence.oracle.filter(c=>c.id!=='submitted-arena-ordering')},options),/submitted-arena-ordering/);
  for(const id of ['vertex-color-interpolation','vertex-color-forward-deferred','vertex-alpha-auxiliary']){
    assert.throws(()=>validateDeferredFixtureEvidence({...evidence,geometryAssertions:evidence.geometryAssertions.filter(item=>item.id!==id)},options),new RegExp(id));
  }
});


function reuseEvidence() {
  const counts={buffers:429,bindGroups:67,pipelines:27,sourceUploads:1};
  return [
    {id:'stationary-resource-reuse',frames:8,baseline:counts,current:counts},
    {id:'dynamic-resource-reuse',frames:8,current:counts,dynamic:{...counts,sourceUploads:8},createdGroups:[]},
  ];
}

test('resource-reuse evidence rejects extra bindings, missing observations and skipped light updates',()=>{
  const valid=reuseEvidence();
  validateDeferredReuseEvidence(valid);
  for(const changes of [{bindGroups:68},{buffers:430},{pipelines:28},{sourceUploads:1}]) {
    const bad=structuredClone(valid);Object.assign(bad[1].dynamic,changes);
    assert.throws(()=>validateDeferredReuseEvidence(bad),/Dynamic resource-reuse/);
  }
  for(const changes of [{frames:7},{createdGroups:undefined},{createdGroups:[{label:'unexpected'}]}]) {
    const bad=structuredClone(valid);Object.assign(bad[1],changes);
    assert.throws(()=>validateDeferredReuseEvidence(bad),/resource-reuse/);
  }
  assert.throws(()=>validateDeferredReuseEvidence(valid.slice(1)),/Missing/);
});

test('compatibility builds keep G02/G03 evidence directories separate', () => {
  assert.deepEqual(parseDeferredFixtureBuildOptions([]), {goal:'g02'});
  assert.deepEqual(parseDeferredFixtureBuildOptions(['--tiled']), {goal:'g03'});
  assert.deepEqual(parseDeferredFixtureBuildOptions(['--compatibility']), {goal:'g04'});
  assert.deepEqual(parseDeferredFixtureBuildOptions(['--performance']), {goal:'g05'});
  assert.deepEqual(parseDeferredFixtureBuildOptions(['--framegraph']), {goal:'g09'});
  assert.throws(() => parseDeferredFixtureBuildOptions(['--framegraph', '--compatibility']));
  for (const args of [['--performance','--tiled'], ['--unknown'], ['--tiled', '--compatibility'], ['--compatibility', '--compatibility']]) assert.throws(() => parseDeferredFixtureBuildOptions(args));
});
