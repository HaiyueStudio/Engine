import test from 'node:test';
import assert from 'node:assert/strict';
import {loadG07Modules} from './data-binding-parity-fixture.mjs';

const {runtime}=await loadG07Modules();
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function setup(){
 const jobs=[],released=[];
 const owner=new runtime.DataResourceOwner({acquire(kind,id,signal){const job={kind,id,signal,...deferred()};jobs.push(job);return job.promise;}});
 const finish=(index,value=jobs[index].id,release=()=>released.push(value))=>jobs[index].resolve({value,release});
 return{owner,jobs,released,finish};
}

test('staged image keeps the committed value alive until explicit frame-boundary commit',async()=>{
 const s=setup(),initial=s.owner.replace('icon','image','old');s.finish(0);await initial;
 const pending=s.owner.stage('icon','image','new');assert.equal(s.owner.value('icon'),'old');assert.deepEqual(s.released,[]);
 s.finish(1);assert.equal(await pending,'new');assert.equal(s.owner.value('icon'),'old');assert.equal(s.owner.isStagedReady('icon'),true);
 assert.deepEqual(s.owner.commitStaged(['icon']),{values:['new'],releaseErrors:[]});assert.equal(s.owner.value('icon'),'new');assert.deepEqual(s.released,['old']);
 s.owner.dispose();s.owner.dispose();assert.deepEqual(s.released,['old','new']);
});

test('batch commit validates every resource before publishing any slot or releasing previous values',async()=>{
 const s=setup();for(const [slot,id]of [['a','old-a'],['b','old-b']]){const p=s.owner.replace(slot,'image',id);s.finish(s.jobs.length-1);await p;}
 const a=s.owner.stage('a','image','new-a'),b=s.owner.stage('b','image','new-b');s.finish(2);await a;
 assert.throws(()=>s.owner.commitStaged(['a','b']),e=>e.code==='E_DATA_RUNTIME_STATE');assert.equal(s.owner.value('a'),'old-a');assert.equal(s.owner.value('b'),'old-b');assert.deepEqual(s.released,[]);
 s.finish(3);await b;assert.deepEqual(s.owner.commitStaged(['a','b']).values,['new-a','new-b']);assert.deepEqual(s.released,['old-a','old-b']);
 assert.deepEqual(s.owner.stagedStats,{pending:0,ready:0});s.owner.dispose();
});

test('staged decode rejection and cancellation preserve the last valid committed image',async()=>{
 const s=setup(),initial=s.owner.replace('icon','image','old');s.finish(0);await initial;
 const failed=s.owner.stage('icon','image','bad');s.jobs[1].reject(Error('decode failed'));await assert.rejects(failed,/decode failed/);
 assert.equal(s.owner.value('icon'),'old');assert.equal(s.jobs[1].signal.aborted,true);assert.deepEqual(s.released,[]);
 const cancelled=s.owner.stage('icon','image','cancelled');s.owner.cancelStaged('icon');assert.equal(s.jobs[2].signal.aborted,true);s.finish(2);await assert.rejects(cancelled,e=>e.code==='E_DATA_RUNTIME_STATE');
 assert.equal(s.owner.value('icon'),'old');assert.deepEqual(s.released,['cancelled']);s.owner.dispose();
});

test('latest staged generation wins both before and after an older candidate becomes ready',async()=>{
 const s=setup(),first=s.owner.stage('slot','image','first'),second=s.owner.stage('slot','image','second');
 s.finish(0);await assert.rejects(first,e=>e.code==='E_DATA_RUNTIME_STATE');s.finish(1);await second;
 const third=s.owner.stage('slot','image','third');assert.deepEqual(s.released,['first','second']);assert.equal(s.jobs[1].signal.aborted,true);
 s.finish(2);await third;s.owner.commitStaged(['slot']);assert.equal(s.owner.value('slot'),'third');s.owner.dispose();assert.deepEqual(s.released,['first','second','third']);
});

test('duplicate slots and incomplete candidates cannot partially commit; retire cancels both generations',async()=>{
 const s=setup(),initial=s.owner.replace('slot','image','old');s.finish(0);await initial;
 const next=s.owner.stage('slot','image','next');s.finish(1);await next;
 assert.throws(()=>s.owner.commitStaged(['slot','slot']),e=>e.code==='E_DATA_RUNTIME_PATH');assert.equal(s.owner.value('slot'),'old');
 s.owner.retire('slot');assert.deepEqual(s.released,['next','old']);assert.equal(s.owner.value('slot'),undefined);assert.deepEqual(s.owner.stagedStats,{pending:0,ready:0});s.owner.dispose();
});

test('dispose releases ready candidates, rejects late results and does not leave ownership behind',async()=>{
 const s=setup(),old=s.owner.replace('a','image','old');s.finish(0);await old;
 const ready=s.owner.stage('a','image','ready'),late=s.owner.stage('b','image','late');s.finish(1);await ready;s.owner.dispose();
 s.finish(2);await assert.rejects(late,e=>e.code==='E_DATA_RUNTIME_STATE');assert.deepEqual(s.released,['ready','old','late']);
 assert.equal(s.owner.stats.entries,0);assert.deepEqual(s.owner.stagedStats,{pending:0,ready:0});assert.throws(()=>s.owner.stage('c','image','x'),e=>e.code==='E_DATA_RUNTIME_STATE');
});

test('all new slots are visible before borrowed releases; release faults are reported after atomic commit',async()=>{
 const s=setup(),a=s.owner.replace('a','image','old-a');s.finish(0,'old-a',()=>{assert.equal(s.owner.value('a'),'new-a');assert.equal(s.owner.value('b'),'new-b');throw Error('host release failed');});await a;
 const b=s.owner.replace('b','image','old-b');s.finish(1);await b;
 const na=s.owner.stage('a','image','new-a'),nb=s.owner.stage('b','image','new-b');s.finish(2);s.finish(3);await Promise.all([na,nb]);
 const result=s.owner.commitStaged(['a','b']);assert.deepEqual(result.values,['new-a','new-b']);assert.equal(result.releaseErrors.length,1);assert.match(result.releaseErrors[0].message,/host release failed/);
 assert.deepEqual(s.released,['old-b']);s.owner.dispose();assert.deepEqual(s.released,['old-b','new-a','new-b']);
});

test('synchronous reentrant acquisition failure cannot erase a newer candidate',async()=>{
 let owner,newer,calls=0;
 owner=new runtime.DataResourceOwner({acquire(){if(++calls===1){newer=owner.stage('slot','image','newer');throw Error('first port failure');}return Promise.resolve({value:'newer',release(){}});}});
 await assert.rejects(owner.stage('slot','image','older'),/first port failure/);await newer;assert.equal(owner.isStagedReady('slot'),true);owner.commitStaged(['slot']);assert.equal(owner.value('slot'),'newer');owner.dispose();
});


const DataResourceOwner=runtime.DataResourceOwner;
const stateError=e=>e.code==='E_DATA_RUNTIME_STATE';
test('failed value validation releases the candidate and clears its ready state',async()=>{
 const fault=Error('value unavailable');let releases=0;const owner=new DataResourceOwner({async acquire(){return {get value(){throw fault},release(){releases++}}}});
 await assert.rejects(owner.stage('slot','image','new'),e=>e===fault);assert.deepEqual(owner.stagedStats,{pending:0,ready:0});assert.equal(releases,1);owner.dispose();assert.equal(releases,1);
});
test('every value is read before publication, and logical commit performs no reads or borrowed releases',async()=>{
 let fail=false,reads=0;const fault=Error('temporarily unavailable'),released=[];
 const owner=new DataResourceOwner({async acquire(_kind,id){return {get value(){reads++;if(fail&&id==='new-b')throw fault;return id},release(){released.push(id)}}}});
 for(const key of ['a','b']){await owner.stage(key,'image','old-'+key);owner.commitStaged([key]);}
 await Promise.all(['a','b'].map(key=>owner.stage(key,'image','new-'+key)));fail=true;
 assert.throws(()=>owner.prepareStaged(['a','b']),e=>e===fault);assert.equal(owner.value('a'),'old-a');assert.equal(owner.value('b'),'old-b');assert.deepEqual(released,[]);
 fail=false;const step=owner.prepareStaged(['a','b']),before=reads;assert.deepEqual(step.values,['new-a','new-b']);step.commit();step.commit();assert.equal(reads,before);assert.deepEqual(released,[]);assert.deepEqual(step.publish(),[]);assert.deepEqual(released,['old-a','old-b']);step.publish();assert.deepEqual(released,['old-a','old-b']);owner.dispose();assert.equal(released.length,4);
});
test('rollback preserves committed and staged handles and allows a later retry',async()=>{
 const released=[],owner=new DataResourceOwner({async acquire(_kind,id){return {value:id,release(){released.push(id)}}}});
 await owner.stage('slot','image','old');owner.commitStaged(['slot']);await owner.stage('slot','image','new');const step=owner.prepareStaged(['slot']);step.rollback();step.rollback();step.commit();assert.equal(owner.value('slot'),'old');assert.deepEqual(step.publish(),[]);assert.deepEqual(released,[]);assert.equal(owner.isStagedReady('slot'),true);owner.commitStaged(['slot']);assert.equal(owner.value('slot'),'new');owner.dispose();assert.deepEqual(released,['old','new']);
});
test('prepared validation rejects reentrant mutations and nested commits without dropping the old value',async()=>{
 let owner,probe=false;const observed=[];owner=new DataResourceOwner({async acquire(_kind,id){return {get value(){if(probe&&id==='new'){assert.throws(()=>owner.retire('slot'),stateError);assert.throws(()=>owner.commitStaged(['slot']),stateError);observed.push('blocked');}return id},release(){}}}});
 await owner.stage('slot','image','old');owner.commitStaged(['slot']);await owner.stage('slot','image','new');probe=true;const step=owner.prepareStaged(['slot']);assert.deepEqual(observed,['blocked']);assert.throws(()=>owner.stage('other','image','x'),stateError);assert.throws(()=>owner.cancelStaged('slot'),stateError);assert.equal(owner.value('slot'),'old');step.rollback();owner.cancelStaged('slot');owner.dispose();
});
test('dispose before logical commit invalidates the step and releases both generations once',async()=>{
 const released=[],owner=new DataResourceOwner({async acquire(_kind,id){return {value:id,release(){released.push(id)}}}});
 await owner.stage('slot','image','old');owner.commitStaged(['slot']);await owner.stage('slot','image','new');const step=owner.prepareStaged(['slot']);owner.dispose();step.commit();step.rollback();assert.deepEqual(step.publish(),[]);assert.equal(owner.stats.entries,0);assert.equal(owner.stagedStats.pending,0);assert.deepEqual(released.sort(),['new','old']);
});
test('dispose between logical commit and publication drains old and new handles despite a release failure',async()=>{
 const fault=Error('old release failed'),released=[],owner=new DataResourceOwner({async acquire(_kind,id){return {value:id,release(){released.push(id);if(id==='old')throw fault}}}});
 await owner.stage('slot','image','old');owner.commitStaged(['slot']);await owner.stage('slot','image','new');const step=owner.prepareStaged(['slot']);step.commit();assert.deepEqual(released,[]);assert.throws(()=>owner.dispose(),e=>e===fault);assert.equal(owner.stats.entries,0);assert.deepEqual(released,['old','new']);assert.deepEqual(step.publish(),[]);owner.dispose();
});
test('value-getter reentrant acquisition cannot publish or erase a superseded candidate',async()=>{
 let owner,newer;const released=[];owner=new DataResourceOwner({async acquire(_kind,id){return {get value(){if(id==='old')newer=owner.stage('slot','image','new');return id},release(){released.push(id)}}}});
 await assert.rejects(owner.stage('slot','image','old'),stateError);await newer;owner.commitStaged(['slot']);assert.equal(owner.value('slot'),'new');assert.deepEqual(released,['old']);owner.dispose();assert.deepEqual(released,['old','new']);
});
test('validation plus release failure reports both faults and never retries the borrowed release',async()=>{
 const valueFault=Error('value failed'),releaseFault=Error('release failed');let releases=0;
 const owner=new DataResourceOwner({async acquire(){return {get value(){throw valueFault},release(){releases++;throw releaseFault}}}});
 await assert.rejects(owner.stage('slot','image','broken'),e=>e instanceof AggregateError&&e.errors[0]===valueFault&&e.errors[1]===releaseFault);assert.deepEqual(owner.stagedStats,{pending:0,ready:0});owner.dispose();assert.equal(releases,1);
});
test('disposal during a prepared value read cannot resurrect any handle or logical slot',async()=>{
 let owner,probe=false;const released=[];owner=new DataResourceOwner({async acquire(_kind,id){return {get value(){if(probe&&id==='new')owner.dispose();return id},release(){released.push(id)}}}});
 await owner.stage('slot','image','old');owner.commitStaged(['slot']);await owner.stage('slot','image','new');probe=true;assert.throws(()=>owner.prepareStaged(['slot']),stateError);assert.equal(owner.stats.entries,0);assert.equal(owner.stagedStats.pending,0);assert.deepEqual(released.sort(),['new','old']);
});
test('one unpublished batch bounds retained publication ownership and finishes before the next batch',async()=>{
 const released=[],owner=new DataResourceOwner({async acquire(_kind,id){return {value:id,release(){released.push(id)}}}});
 await owner.stage('slot','image','old');owner.commitStaged(['slot']);await owner.stage('slot','image','new');const first=owner.prepareStaged(['slot']);first.commit();await owner.stage('slot','image','latest');assert.throws(()=>owner.prepareStaged(['slot']),stateError);first.publish();owner.commitStaged(['slot']);assert.equal(owner.value('slot'),'latest');owner.dispose();assert.deepEqual(released,['old','new','latest']);
});
test('retired late handles are released without reading their opaque values',async()=>{
 let finish,reads=0,releases=0;const owner=new DataResourceOwner({acquire(){return new Promise(resolve=>finish=resolve)}}),loading=owner.stage('slot','image','late');owner.dispose();finish({get value(){reads++;throw Error('late value must not be touched')},release(){releases++}});await assert.rejects(loading,stateError);assert.equal(reads,0);assert.equal(releases,1);assert.equal(owner.stats.entries,0);
});
test('real queued data and resource stages roll back together after a later text/layout failure',async()=>{
 const {frameProduction}=await(await import(new URL('./responsive-layout-fixture.mjs',import.meta.url))).loadResponsiveLayoutModules();
 const {data}=await(await import(new URL('./data-binding-parity-fixture.mjs',import.meta.url))).loadG07Modules();
 const document=data.parseHyaDataBinding({format:'haiyue-data-binding',version:1,extension:'org.haiyue.data-binding@1',enums:[],models:[{id:'Root',properties:[{id:'score',kind:'number',defaultValue:0}]}],instances:[{id:'root',model:'Root',scope:'local',values:{score:0}}],converters:[],propertyGroups:[],components:[],bindings:[]});
 const queued=new frameProduction.ProductionDataOwner(document),released=[],resources=new DataResourceOwner({async acquire(_kind,id){return {value:id,release(){released.push(id)}}}});let fail=true,callbacks=0,observations=0;
 await resources.stage('image','image','old');resources.commitStaged(['image']);await resources.stage('image','image','new');
 queued.run(write=>{callbacks++;write.set('root',['score'],8)});queued.subscribe(()=>{observations++;assert.equal(resources.value('image'),'new')});
 const frame=new frameProduction.ProductionFrameTransaction([...queued.stages('data'),{id:'resources',phase:'atomic-data',prepare(){assert.equal(queued.readPrepared('root',['score']),8);const step=resources.prepareStaged(['image']);return {value:step.values,commit:step.commit,rollback:step.rollback,publish(){assert.deepEqual(step.publish(),[])} }},dispose(){resources.dispose()}},{id:'layout',phase:'text-layout',prepare(){if(fail)throw Error('font pending');return {commit(){},rollback(){}}}}]);
 const request={sequence:1,deltaSeconds:0,viewport:[100,100],dpr:1};
 try{assert.throws(()=>frame.advance(request),/font pending/);assert.equal(queued.read('root',['score']),0);assert.equal(resources.value('image'),'old');assert.equal(observations,0);assert.deepEqual(released,[]);assert.equal(callbacks,1);fail=false;frame.advance(request);assert.equal(queued.read('root',['score']),8);assert.equal(resources.value('image'),'new');assert.equal(observations,1);assert.equal(callbacks,1);assert.deepEqual(released,['old']);}finally{frame.dispose();queued.dispose();resources.dispose();}assert.deepEqual(released,['old','new']);
});

test('prepared retirement never reads a retired opaque value or releases it in logical commit',async()=>{
 let fail=false,reads=0,releases=0;const owner=new DataResourceOwner({async acquire(){return {get value(){reads++;if(fail)throw Error('opaque value unavailable');return 'image'},release(){releases++}}}});
 await owner.stage('hero','image','old');owner.commitStaged(['hero']);fail=true;const before=reads,step=owner.prepareStaged([],['hero']);assert.deepEqual(step.values,[]);assert.equal(reads,before);assert.equal(releases,0);step.commit();step.commit();assert.equal(owner.value('hero'),undefined);assert.equal(owner.stats.handles,0);assert.equal(releases,0);assert.deepEqual(step.publish(),[]);step.publish();assert.equal(releases,1);owner.dispose();assert.equal(releases,1);
});

test('retirement rollback keeps the old handle and a retry can clear without an acquisition',async()=>{
 let acquisitions=0,releases=0;const owner=new DataResourceOwner({async acquire(){acquisitions++;return{value:'old',release(){releases++}}}});await owner.stage('hero','image','old');owner.commitStaged(['hero']);const cancelled=owner.prepareStaged([],['hero']);cancelled.rollback();cancelled.commit();assert.equal(owner.value('hero'),'old');assert.equal(releases,0);const retry=owner.prepareStaged([],['hero']);retry.commit();retry.publish();assert.equal(owner.value('hero'),undefined);assert.equal(acquisitions,1);assert.equal(releases,1);owner.dispose();
});

test('a mixed replacement and retirement fails atomically before either old slot is changed',async()=>{
 let fail=false;const released=[],owner=new DataResourceOwner({async acquire(_kind,id){return{get value(){if(fail&&id==='new')throw Error('new value failed');return id},release(){released.push(id)}}}});
 for(const slot of ['replace','clear']){await owner.stage(slot,'image',slot);owner.commitStaged([slot])}await owner.stage('replace','image','new');fail=true;assert.throws(()=>owner.prepareStaged(['replace'],['clear']),/new value failed/);assert.equal(owner.value('replace'),'replace');assert.equal(owner.value('clear'),'clear');assert.deepEqual(released,[]);fail=false;const step=owner.prepareStaged(['replace'],['clear']);step.commit();assert.equal(owner.value('replace'),'new');assert.equal(owner.value('clear'),undefined);assert.deepEqual(released,[]);step.publish();assert.deepEqual(released.sort(),['clear','replace']);owner.dispose();assert.deepEqual(released.sort(),['clear','new','replace']);
});

test('retirement rejects staged conflicts and duplicate cross-operation slots without touching handles',async()=>{
 const released=[],owner=new DataResourceOwner({async acquire(_kind,id){return{value:id,release(){released.push(id)}}}});await owner.stage('hero','image','old');owner.commitStaged(['hero']);await owner.stage('hero','image','new');assert.throws(()=>owner.prepareStaged([],['hero']),e=>e.code==='E_DATA_RUNTIME_STATE');assert.throws(()=>owner.prepareStaged(['hero'],['hero']),e=>e.code==='E_DATA_RUNTIME_PATH');assert.equal(owner.value('hero'),'old');assert.deepEqual(released,[]);owner.cancelStaged('hero');const step=owner.prepareStaged([],['hero']);step.rollback();assert.equal(owner.value('hero'),'old');owner.dispose();assert.deepEqual(released,['new','old']);
});

test('dispose invalidates a prepared retirement and does not release the same handle twice',async()=>{
 let releases=0;const owner=new DataResourceOwner({async acquire(){return{value:'old',release(){releases++}}}});await owner.stage('hero','image','old');owner.commitStaged(['hero']);const step=owner.prepareStaged([],['hero']);owner.dispose();step.commit();step.rollback();assert.deepEqual(step.publish(),[]);assert.equal(releases,1);assert.equal(owner.stats.entries,0);owner.dispose();assert.equal(releases,1);
});

test('retirement publication reports cleanup faults once and dispose drains an unpublished old handle',async()=>{
 const fault=Error('old release failed');let releases=0;const owner=new DataResourceOwner({async acquire(){return{value:'old',release(){releases++;throw fault}}}});await owner.stage('hero','image','old');owner.commitStaged(['hero']);const step=owner.prepareStaged([],['hero']);step.commit();assert.throws(()=>owner.dispose(),e=>e===fault);assert.equal(releases,1);assert.deepEqual(step.publish(),[]);assert.equal(owner.stats.entries,0);owner.dispose();assert.equal(releases,1);
});
