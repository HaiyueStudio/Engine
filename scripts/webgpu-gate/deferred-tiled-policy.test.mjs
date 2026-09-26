import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTiledFixtureOptions,validateTiledFixtureResult,validateSourceCapacityCases} from './deferred-tiled-policy.mjs';
import {tileFrustum,sphereIntersectsFrustum,validateTileMembership} from './deferred-tile-oracle.mjs';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
test('independent closest-surface oracle handles interior, faces, corners and tangency',()=>{
  const box=tileFrustum(identity,16,16,0,0);
  assert.equal(sphereIntersectsFrustum([0,0,.5,.01],box),true);
  assert.equal(sphereIntersectsFrustum([0,0,-.1,.1],box),true);
  assert.equal(sphereIntersectsFrustum([0,0,-.11,.1],box),false);
  assert.equal(sphereIntersectsFrustum([1.1,1.1,.5,.12],box),false,'corner sphere intersects separate planes but misses convex box');
  assert.equal(sphereIntersectsFrustum([1.1,1.1,.5,.15],box),true);
  assert.equal(sphereIntersectsFrustum([1.1,1.1,1.1,.15],box),false);
  assert.equal(sphereIntersectsFrustum([1.1,1.1,1.1,.18],box),true);
});
test('membership oracle rejects a missing light, accepts only explicit same-frame fallback',()=>{
  const plan={columns:1,rows:1,storedTiles:1,tileCapacity:128},source={records:[{identity:[2,1,0,0],positionRange:[0,0,.5,.2]}]};
  const words=new Uint32Array(132);words[0]=4;
  assert.throws(()=>validateTileMembership(words,plan,source,identity,16,16),/false negatives/);
  words[1]=1;words[4]=0;assert.equal(validateTileMembership(words,plan,source,identity,16,16).falseNegatives,0);
  words[1]=0;words[2]=1;assert.equal(validateTileMembership(words,plan,source,identity,16,16).overflowTiles,1);
  assert.equal(validateTileMembership(new Uint32Array(1),{...plan,storedTiles:0},source,identity,16,16).references,1);
});
test('tiled evidence distinguishes smoke from render and rejects incomplete cases or fake adapter',()=>{
  assert.deepEqual(parseTiledFixtureOptions(['--render','--integrated']),{mode:'render',preference:'low-power'});
  assert.throws(()=>parseTiledFixtureOptions(['--skip-failures']));
  const smoke={status:'passed',schemaVersion:1,adapter:{vendor:'test',architecture:'test',isFallbackAdapter:false},validationErrors:[],overflowTiles:4,acceptedPerTile:256,storedPrefix:128};
  validateTiledFixtureResult(smoke,'compute-smoke');
  assert.throws(()=>validateTiledFixtureResult(smoke,'render'),/cases/);
  assert.throws(()=>validateTiledFixtureResult({...smoke,adapter:{...smoke.adapter,isFallbackAdapter:true}},'compute-smoke'),/Native/);
  assert.throws(()=>validateTiledFixtureResult({...smoke,validationErrors:undefined},'compute-smoke'),/validation/);
});

test('source capacity evidence requires strict rejection, explicit fallback and recovery without truncation',()=>{
  const cases=['strict','forward'].map(failurePolicy=>({failurePolicy,requested:1025,recovered:1024,diagnostics:{reason:'point-capacity',completeCoverage:false},thrown:failurePolicy==='strict'?{reason:'point-capacity',observed:1025,supported:1024}:null}));
  validateSourceCapacityCases(cases);
  assert.throws(()=>validateSourceCapacityCases(cases.slice(1)));
  for(const change of [c=>{c[0].thrown=null;},c=>{c[1].diagnostics.completeCoverage=true;},c=>{c[1].recovered=8;},c=>{c[0].thrown.observed=1024;}]){
    const modified=structuredClone(cases);change(modified);assert.throws(()=>validateSourceCapacityCases(modified));
  }
});
