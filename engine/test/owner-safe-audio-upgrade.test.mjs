import test from'node:test';import assert from'node:assert/strict';
import{OwnerSafeAudioMixer as Mixer}from'../dist/audio.js';import{OwnerSafeAudioMixer as Legacy}from'./owner-safe-audio-legacy.mjs';
import{AudioContextAudit,audioBuffer,audioRequest}from'./owner-safe-audio-fixture.mjs';
async function create(Type=Mixer,options={}){const context=new AudioContextAudit(),mixer=new Type({context,...options});mixer.installBuffer('tone',audioBuffer('tone'));await mixer.unlock();return{context,mixer};}
test('seeded scheduling/stop/ending traces remain equivalent to the frozen mixer at both admission workloads',async()=>{
 for(const maximum of[32,128]){
  const current=await create(Mixer,{maxVoicesTotal:maximum,maxVoicesPerOwner:maximum/4}),old=await create(Legacy,{maxVoicesTotal:maximum,maxVoicesPerOwner:maximum/4});let seed=12345;
  for(let i=0;i<5000;i++){
   seed=(Math.imul(seed,1664525)+1013904223)>>>0;const owner='p'+(seed%9),channel='c'+(seed>>>8)%40,operation=seed%17;
   const run=({mixer,context})=>{try{if(operation===0)return mixer.releaseOwner(owner);if(operation===1)return mixer.stop(owner,channel);if(operation===2){const source=context.sources[(seed>>>16)%Math.max(1,context.sources.length)];source?.finish();return null;}return mixer.play({...audioRequest('event'+i,owner,channel,(seed>>>16)%11-5),replaceChannel:operation!==3});}catch(e){return[e.constructor.name,e.message];}};
   assert.deepEqual(run(current),run(old),'result '+maximum+'/'+i);assert.deepEqual(current.mixer.stats,old.mixer.stats,'accounting '+maximum+'/'+i);
  }
  assert.deepEqual(current.context.trace,old.context.trace);current.mixer.dispose();old.mixer.dispose();assert.deepEqual(current.mixer.stats,old.mixer.stats);
 }
});
test('global-first then owner-only eviction ordering remains compatible when both budgets are full',async()=>{
 for(const Type of[Mixer,Legacy]){const{mixer,context}=await create(Type,{maxVoicesTotal:3,maxVoicesPerOwner:2});mixer.play(audioRequest('a','one','a',5));mixer.play(audioRequest('b','one','b',6));mixer.play(audioRequest('c','two','c',0));mixer.play(audioRequest('d','one','d',10));assert.deepEqual(context.trace.filter(t=>t[0]==='stop').map(t=>t[1]),[2,0]);assert.equal(mixer.stats.voices,2);mixer.dispose();}
});
test('volume snapshots, gain controls and explicit capability probing preserve original experimental identity',async()=>{
 const{OwnerSafeAudioMixer:experimental}=await import('../dist/experimental/audio.js');assert.equal(experimental,Mixer);
 const lazy=new Mixer();assert.deepEqual(lazy.getCapabilities(),{stereoPan:null,maxDecodedChannels:2});lazy.dispose();
 const{mixer,context}=await create();assert.equal(mixer.getCapabilities().stereoPan,true);mixer.setMasterVolume(.8);mixer.setBusVolume('sfx',.3);const volume=mixer.getVolumes();assert(Object.isFrozen(volume));assert.deepEqual(volume,{master:.8,music:1,sfx:.3,ui:1});
 mixer.play(audioRequest('a'));assert.equal(mixer.setGain('owner','channel',.2),true);assert.equal(context.gains.at(-1).gain.value,.2);assert.equal(mixer.setGain('owner','missing',1),false);assert.throws(()=>mixer.setGain('owner','channel',NaN));context.state='interrupted';assert.equal(mixer.stats.state,'suspended');mixer.dispose();
 const noPan=new AudioContextAudit({pan:false}),mono=new Mixer({context:noPan});assert.equal(mono.getCapabilities().stereoPan,false);mono.dispose();
});
test('invalid requests preserve existing voices and failed source/node creation retires every partial node',async()=>{
 const{mixer,context}=await create();mixer.play(audioRequest('a'));const voice=context.sources[0];
 for(const fields of[{volume:NaN},{pan:2},{frequency:0},{loop:'yes'},{replaceChannel:'yes'}])assert.throws(()=>mixer.play({...audioRequest('invalid'),...fields}));assert.equal(voice.stops,0);assert.equal(mixer.stats.voices,1);
 mixer.releaseOwner('owner');for(const flag of['failStart','failGain','failConnect']){context[flag]=true;assert.throws(()=>mixer.play(audioRequest(flag)));assert.equal(mixer.stats.voices,0);assert.equal(mixer.stats.owners,0);assert.equal(mixer.stats.audioNodes,4);assert(context.sources.at(-1).disconnections>0);}
 mixer.dispose();assert.equal(mixer.stats.audioNodes,0);assert.equal(context.closed,0);
});
test('late/replaced/removed decodes cannot resurrect an old buffer generation or a disposed mixer',async()=>{
 const context=new AudioContextAudit();context.deferDecode=true;const mixer=new Mixer({context});
 const a=mixer.decodeAndInstall('tone',new ArrayBuffer(12)),aRejected=assert.rejects(a,e=>e.code==='E_ASSET_JOB_ABORTED');const b=mixer.decodeAndInstall('tone',new ArrayBuffer(12));context.decodeRequests[0].resolve(audioBuffer('old'));await aRejected;context.decodeRequests[1].resolve(audioBuffer('new'));await b;assert.equal(mixer.stats.buffers,1);
 const c=mixer.decodeAndInstall('tone',new ArrayBuffer(12)),cRejected=assert.rejects(c,e=>e.code==='E_ASSET_JOB_ABORTED');mixer.removeBuffer('tone');context.decodeRequests[2].resolve(audioBuffer('removed'));await cRejected;assert.equal(mixer.stats.buffers,0);
 const d=mixer.decodeAndInstall('tone',new ArrayBuffer(12)),dRejected=assert.rejects(d,/disposed/);mixer.dispose();assert.equal(mixer.stats.decodeJobs,1);context.decodeRequests[3].resolve(audioBuffer('disposed'));await dRejected;assert.equal(mixer.stats.decodeJobs,0);assert.equal(mixer.stats.buffers,0);
});
test('current eviction performs no sorting and current statistics do not iterate voice maps',async()=>{
 for(const Type of[Legacy,Mixer]){const{mixer}=await create(Type,{maxVoicesTotal:2,maxVoicesPerOwner:2});mixer.play(audioRequest('a','one','a'));mixer.play(audioRequest('b','two','b'));
  const sort=Array.prototype.sort,values=Map.prototype.values;let sorts=0,iterations=0;
  try{Array.prototype.sort=function(...args){sorts++;return Reflect.apply(sort,this,args);};mixer.play(audioRequest('c','three','c'));Map.prototype.values=function(...args){iterations++;return Reflect.apply(values,this,args);};mixer.stats;}
  finally{Array.prototype.sort=sort;Map.prototype.values=values;}
  assert.equal(sorts,Type===Legacy?1:0);assert.equal(iterations,Type===Legacy?2:0);mixer.dispose();
 }
});
test('the explicit platform host shares mixer ownership, buffer generations and bus controls',async()=>{
 const calls=[],outputs=[],tone=audioBuffer('tone');
 const host={
  state:'suspended',get stereoPan(){return this.state==='running';},sampleRate:48000,nodeCount:4,
  async resume(){this.state='running';},async suspend(){this.state='suspended';},close(){this.state='closed';calls.push('close');},
  async decodeAudioData(){return tone;},prepareBuffer(buffer){calls.push(['prepare',buffer]);},releaseBuffer(buffer){calls.push(['release',buffer]);},
  setMasterVolume(value){calls.push(['master',value]);},setBusVolume(bus,value){calls.push([bus,value]);},
  openVoice(buffer,options){
   const voice={nodeCount:3,stereoPan:true,buffer,options,
    start(ended){this.ended=ended;},stop(){this.stopped=true;},dispose(){this.disposed=true;},
    setGain(gain){this.gain=gain;},setPan(pan){this.pan=pan;}};
   outputs.push(voice);return voice;
  },
 };
 assert.throws(()=>new Mixer({host,context:new AudioContextAudit()}),/cannot be combined/);
 const mixer=new Mixer({host,maxVoicesTotal:1,maxVoicesPerOwner:1});
 assert.equal(mixer.getCapabilities().stereoPan,false);
 assert.equal(await mixer.decodeAndInstall('tone',new ArrayBuffer(12)),tone);
 await mixer.resume();assert.equal(mixer.getCapabilities().stereoPan,true);
 const first=mixer.play(audioRequest('old')),replacement=mixer.play(audioRequest('new'));
 assert.notEqual(first,replacement);assert.equal(outputs[0].stopped,true);assert.equal(outputs[0].disposed,true);
 outputs[0].ended();assert.equal(mixer.stats.voices,1);assert.equal(mixer.stats.audioNodes,7);
 mixer.setGain('owner','channel',.5);mixer.setPan('owner','channel',1);
 assert.equal(outputs[1].gain,.5);assert.equal(outputs[1].pan,1);
 mixer.setMasterVolume(0);mixer.setBusVolume('ui',4);
 await mixer.suspend();assert.equal(mixer.play(audioRequest('locked')),null);
 assert.equal(mixer.removeBuffer('tone'),true);assert.equal(outputs[1].disposed,undefined);
 mixer.dispose();assert.equal(outputs[1].disposed,true);assert.equal(mixer.stats.audioNodes,0);
 assert.deepEqual(calls,[['prepare',tone],['master',0],['ui',4],['release',tone],'close']);
});
