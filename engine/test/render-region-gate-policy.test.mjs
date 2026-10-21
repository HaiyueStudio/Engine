import test from 'node:test';
import assert from 'node:assert/strict';
import {regionFixtureSpec,REGION_EFFECTS,REGION_PARENT_FORMATS} from './render-region-gate-policy.mjs';
for(const [id,count,fixture]of [['regional',12,'pipeline'],['clipping',48,'clipping'],['surface',160,'clipping'],['fallback',36,'fallback'],['working-set',6,'fallback'],['scene',36,'scene'],['example',6,'example'],['submission',12,'submission'],['scene-projection',144,'scene-projection'],['scene-projection-fxaa',144,'scene-projection']])test(`regional route ${id} keeps its comparison population`,()=>{
 const spec=regionFixtureSpec(id==='regional'?[]:[`--${id}`]);assert.equal(spec.id,id);assert.equal(spec.count,count);assert.equal(spec.fixture,fixture);assert.equal(spec.workload.pixelTolerance,2);assert.ok(Object.isFrozen(spec.workload.msaa));
});
for(const effect of REGION_EFFECTS)test(`effect ${effect} declares native matrix and cancellation population`,()=>{
 const spec=regionFixtureSpec([`--effects=${effect}`]),deferred=['deferred','tiled'].includes(effect);assert.deepEqual(spec.query,{effect});assert.equal(spec.memory,true);assert.equal(spec.count,(deferred?1:2)*2*2*3*12);assert.deepEqual(spec.workload.msaa,deferred?[1]:[1,4]);assert.equal(spec.workload.cancelledAttempt,11);
});
test('clear history declares every clear mode and native sample count without a shared GPU reference',()=>{
 const spec=regionFixtureSpec(['--history']);assert.equal(spec.count,3*2*20);assert.equal(spec.memory,true);assert.equal(spec.mounted,false);assert.equal(spec.fixture,'history');assert.deepEqual(spec.workload.clearModes,['on-update','once','never-after-initialization']);assert.deepEqual(spec.workload.msaa,[1,4]);assert.equal(spec.workload.parentFormat,'rgba16float');assert.equal(spec.workload.pixelTolerance,2);
});

test('global overlays retain real controls, DPR and MSAA populations with explicit input scope',()=>{
 const spec=regionFixtureSpec(['--overlays']);assert.equal(spec.count,2*2*21);assert.equal(spec.memory,true);assert.equal(spec.fixture,'overlays');assert.deepEqual(spec.workload.dpr,[1,2]);assert.deepEqual(spec.workload.msaa,[1,4]);assert.deepEqual(spec.workload.controls,['GuiSelect','GuiModal','GuiToast']);assert.equal(spec.workload.pixelTolerance,2);assert.match(spec.workload.inputQualification,/G05/);
});

test('oversized native population uses an enforced small device and independent full-raster reference',()=>{
 const spec=regionFixtureSpec(['--oversized']);assert.equal(spec.count,2*2*2*3*7);assert.equal(spec.memory,true);assert.equal(spec.mounted,false);assert.match(spec.workload.deviceTextureLimit,/default native/);assert.deepEqual(spec.workload.formats,['rgba8unorm','rgba16float']);assert.deepEqual(spec.workload.depthConventions,['standard','reverse']);assert.equal(spec.workload.dependencyRejectionsPerCohort,1);assert.equal(spec.workload.pixelTolerance,2);
 const shards=['x','y','both'].map(axis=>regionFixtureSpec(['--oversized-'+axis]));assert.deepEqual(shards.map(s=>s.count),[56,56,56]);assert.equal(shards.reduce((n,s)=>n+s.count,0),spec.count);assert.deepEqual(shards.map(s=>s.query.axis),[0,1,2]);
 const probe=regionFixtureSpec(['--oversized-frustum-x']);assert.equal(probe.count,56);assert.deepEqual(probe.query,{axis:0,reference:'offcenter'});assert.match(probe.workload.referenceProbe,/does not replace/);
});

test('routing rejects unknown, ambiguous and empty effect selections before builds or browser work',()=>{
 for(const args of [['--effects='],['--effects=bad'],['--bad'],['--surface','--effects=taa'],['--scene','--example'],['scene']])assert.throws(()=>regionFixtureSpec(args));
});

test('spatial native modes keep603 entities, independent index reference and all formats/depth/MSAA states',()=>{
 for(const id of ['spatial-x','spatial-y','spatial-both','spatial-before-x']){const spec=regionFixtureSpec(['--'+id]);assert.equal(spec.count,2*2*2*7);assert.equal(spec.workload.entities,603);assert.deepEqual(spec.workload.spatialThresholds,[512,1000000]);assert.deepEqual(spec.workload.msaa,[1,4]);assert.equal(spec.query.spatial,1);assert.equal(spec.workload.legacyReproduction,id==='spatial-before-x');assert.match(spec.workload.qualification,/not oversized/);}
});
test('camera ownership routing preserves every effect, view, raw format, depth, sample and lifecycle state',()=>{
 const full=regionFixtureSpec(['--camera-views']);assert.equal(full.count,7*2*2*2*6*2);assert.equal(full.fixture,'camera-views');assert.equal(full.mounted,false);assert.equal(full.workload.pixelTolerance,2);assert.deepEqual(full.workload.viewSizes,[[160,80],[80,160]]);
 for(const effect of full.workload.effects){const shard=regionFixtureSpec(['--camera-views-'+effect]);assert.equal(shard.count,96);assert.deepEqual(shard.query,{effect});assert.equal(shard.workload.legacyReproduction,false);}
 assert.deepEqual(regionFixtureSpec(['--camera-views-before']).query,{effect:'none',legacy:1});assert.throws(()=>regionFixtureSpec(['--camera-views-bad']));
});
test('independent regional views retain formats, MSAA, depth, resource growth and real GUI population',()=>{
 const s=regionFixtureSpec(['--view-reuse']);assert.equal(s.count,2*2*2*9*2);assert.equal(s.memory,true);assert.equal(s.mounted,false);assert.equal(s.workload.longestCycles,300);assert.equal(s.workload.pixelTolerance,2);assert.deepEqual(s.workload.msaa,[1,4]);assert.deepEqual(s.workload.formats,['rgba8unorm','rgba16float']);assert.deepEqual(regionFixtureSpec(['--view-reuse-before']).query,{legacy:1});
});

for(const format of REGION_PARENT_FORMATS)test(`parent format ${format} preserves depth, cache and output conversion populations`,()=>{
 const spec=regionFixtureSpec([`--parent-format=${format}`]);assert.equal(spec.fixture,'parent-formats');assert.equal(spec.count,format==='rgba32float'?48:96);assert.equal(spec.workload.pixelTolerance,2);assert.deepEqual(spec.query,{format});assert.deepEqual(spec.workload.depthConventions,['standard','reverse']);
});
test('parent format routing rejects unknown formats and multiple selections',()=>{for(const args of [['--parent-format='],['--parent-alpha='],['--parent-alpha=../bad'],['--parent-format=../bad'],['--parent-format=rgba8unorm','--effects=taa']])assert.throws(()=>regionFixtureSpec(args));});

for(const format of REGION_PARENT_FORMATS)test(`nonopaque parent ${format} keeps the complete format population`,()=>{
 const spec=regionFixtureSpec([`--parent-alpha=${format}`]);assert.equal(spec.count,format==='rgba32float'?48:96);assert.deepEqual(spec.query,{format,alpha:.4});assert.equal(spec.workload.parentClearAlpha,.4);assert.equal(regionFixtureSpec([`--parent-format=${format}`]).workload.parentClearAlpha,1);
});
