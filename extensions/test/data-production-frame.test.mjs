import test from 'node:test';
import assert from 'node:assert/strict';
import {dataBindingFixture,loadG07Modules} from './data-binding-parity-fixture.mjs';

const {data,runtime}=await loadG07Modules();
const create=()=>new runtime.DataBindingRuntime(data.parseHyaDataBinding(dataBindingFixture()));

test('composition data preparation leaves triggers visible to state and defers observers until publication',()=>{
 const owner=create(),batches=[];owner.subscribe(batch=>batches.push(batch));const token=owner.captureFrame();
 owner.runTransaction(id=>{owner.set('root-local',['score'],8,id);owner.trigger('root-local',['fire'],id);});
 const batch=owner.advance(0,'prepare');assert.equal(batches.length,0);assert.equal(owner.read('root-local',['fire']),true);assert.equal(owner.read('root-local',['score']),8);
 assert.throws(()=>owner.advance(),e=>e.code==='E_DATA_RUNTIME_STATE');owner.releaseFrame(token);owner.publishPreparedAdvance(batch);
 assert.equal(batches.length,1);assert.deepEqual(batches[0].changes.map(c=>c.kind),['set','trigger']);assert.equal(owner.read('root-local',['fire']),false);
 assert.throws(()=>owner.publishPreparedAdvance(batch),e=>e.code==='E_DATA_RUNTIME_STATE');owner.dispose();
});

test('downstream text or geometry failure rolls the entire unpublished data frame back without notifications',()=>{
 const owner=create(),batches=[];owner.subscribe(batch=>batches.push(batch));const before=owner.read('root-local',['score']),token=owner.captureFrame();
 owner.runTransaction(id=>{owner.set('root-local',['score'],99,id);owner.trigger('root-local',['fire'],id);});owner.advance(.5,'prepare');
 owner.restoreFrame(token);assert.equal(owner.read('root-local',['score']),before);assert.equal(owner.read('root-local',['fire']),false);assert.equal(batches.length,0);
 assert.equal(owner.advance().changes.length,0);assert.equal(owner.stats.pendingChanges,0);owner.dispose();
});

test('frame rollback restores converter interpolation clocks and edge-trigger histories',()=>{
 const owner=create();assert.equal(owner.readBinding('b-score-smooth'),2.345);assert.equal(owner.readBinding('b-edge'),false);
 const token=owner.captureFrame();owner.runTransaction(id=>{owner.set('root-local',['score'],10,id);owner.set('root-local',['enabled'],false,id);});owner.readBinding('b-score-smooth');
 owner.advance(.5,'prepare');assert.ok(Math.abs(owner.readBinding('b-score-smooth')-6.1725)<.001);assert.equal(owner.readBinding('b-edge'),true);
 owner.restoreFrame(token);assert.equal(owner.readBinding('b-score-smooth'),2.345);assert.equal(owner.readBinding('b-edge'),false);owner.dispose();
});

test('frame rollback restores component instance bindings and disposes owners created by the abandoned frame',()=>{
 const owner=create(),binding=owner.createComponentBinding('component','root-local'),token=owner.captureFrame();
 binding.rebind('root-global');const abandoned=owner.createComponentBinding('component','root-global');assert.equal(binding.read('title'),'global title');
 owner.restoreFrame(token);assert.equal(binding.read('title'),'local title');assert.equal(owner.stats.componentOwners,1);
 assert.throws(()=>abandoned.read('title'),e=>e.code==='E_DATA_RUNTIME_STATE');binding.dispose();owner.dispose();
});

test('frame checkpoint is owner-bound, single-use and cannot survive disposal',()=>{
 const owner=create(),other=create(),token=owner.captureFrame();
 assert.throws(()=>owner.captureFrame(),e=>e.code==='E_DATA_RUNTIME_STATE');assert.throws(()=>other.restoreFrame(token),e=>e.code==='E_DATA_RUNTIME_STATE');
 assert.throws(()=>owner.restoreFrame({}),e=>e.code==='E_DATA_RUNTIME_STATE');owner.releaseFrame(token);assert.throws(()=>owner.restoreFrame(token),e=>e.code==='E_DATA_RUNTIME_STATE');
 const second=owner.captureFrame();owner.dispose();assert.throws(()=>owner.restoreFrame(second),e=>e.code==='E_DATA_RUNTIME_STATE');other.dispose();
});

test('restoring a frame also abandons an unfinished transaction and its pending writes',()=>{
 const owner=create(),before=owner.read('root-local',['score']),token=owner.captureFrame(),transaction=owner.beginTransaction();
 owner.set('root-local',['score'],12,transaction);owner.restoreFrame(token);assert.equal(owner.read('root-local',['score']),before);assert.equal(owner.stats.transactionActive,false);
 owner.runTransaction(id=>owner.set('root-local',['score'],5,id));assert.equal(owner.advance().changes.length,1);owner.dispose();
});

test('throwing deferred observers cannot leave an unconsumed trigger or a prepared frame behind',()=>{
 const owner=create(),subscription=owner.subscribe(()=>{throw Error('consumer failure');});const token=owner.captureFrame();owner.runTransaction(id=>owner.trigger('root-local',['fire'],id));
 const batch=owner.advance(0,'prepare');owner.releaseFrame(token);assert.throws(()=>owner.publishPreparedAdvance(batch),/consumer failure/);
 assert.equal(owner.read('root-local',['fire']),false);subscription.unsubscribe();assert.doesNotThrow(()=>owner.advance());owner.dispose();
});

test('trigger identity preserves instance IDs with reserved delimiters through preparation and publication',()=>{
 const source=JSON.parse(JSON.stringify(dataBindingFixture()).replaceAll('root-local','root|local'));
 const owner=new runtime.DataBindingRuntime(data.parseHyaDataBinding(source));owner.runTransaction(id=>owner.trigger('root|local',['fire'],id));
 const batch=owner.advance(0,'prepare');assert.equal(owner.read('root|local',['fire']),true);owner.publishPreparedAdvance(batch);assert.equal(owner.read('root|local',['fire']),false);owner.dispose();
});

test('stateful converter history belongs to the resolved model instance, including auto-context rebinding',()=>{
 const source=dataBindingFixture(),binding=source.bindings.find(b=>b.id==='b-score-smooth');binding.source={mode:'auto',model:'Root',path:['score']};
 const owner=new runtime.DataBindingRuntime(data.parseHyaDataBinding(source));const local=owner.read('root-local',['score']),global=owner.read('root-global',['score']);
 assert.equal(owner.readBinding('b-score-smooth',['root-local']),local);assert.equal(owner.readBinding('b-score-smooth',['root-global']),global);
 owner.runTransaction(id=>{owner.set('root-local',['score'],10,id);owner.set('root-global',['score'],20,id);});
 assert.equal(owner.readBinding('b-score-smooth',['root-local']),local);assert.equal(owner.readBinding('b-score-smooth',['root-global']),global);owner.advance(.5);
 assert.ok(Math.abs(owner.readBinding('b-score-smooth',['root-local'])-(local+10)/2)<.001);
 assert.ok(Math.abs(owner.readBinding('b-score-smooth',['root-global'])-(global+20)/2)<.001);owner.dispose();
});
