import test from'node:test';import assert from'node:assert/strict';
import{OwnerSafeAudioMixer}from'@haiyue/engine/audio';import{createGameAudio}from'../dist/audio.js';
import{AudioContextAudit,audioBuffer,audioRequest}from'../../engine/test/owner-safe-audio-fixture.mjs';
async function setup(options={}){const context=new AudioContextAudit(options),mixer=new OwnerSafeAudioMixer({context}),game=createGameAudio({mixer});mixer.installBuffer('tone',audioBuffer('tone'));await mixer.unlock();return{context,mixer,game,close(){game.dispose();mixer.dispose();}};}
test('muting preserves configured volumes, profiles validate atomically and fades advance once from caller delta',async()=>{
 const f=await setup(),{game,mixer}=f;game.setVolumes({master:.7,sfx:.8});game.setMuted(true);assert.equal(mixer.getVolumes().master,0);assert.equal(game.exportProfile().volumes.master,.7);
 game.setVolumes({master:.6});assert.equal(mixer.getVolumes().master,0);game.fadeBus('sfx',0,1000);game.update(250);assert(Math.abs(game.exportProfile().volumes.sfx-.6)<1e-12);game.setMuted(false);assert.equal(mixer.getVolumes().master,.6);
 game.fadeBus('sfx',1,1000);game.update(500);assert.equal(game.exportProfile().volumes.sfx,.8);game.update(100000);assert.equal(game.exportProfile().volumes.sfx,1);
 const before=game.exportProfile();assert(Object.isFrozen(before)&&Object.isFrozen(before.volumes));for(const value of[{...before,format:'bad'},{...before,muted:1},{...before,volumes:{master:1}},{...before,volumes:{...before.volumes,ui:5}}])assert.throws(()=>game.restoreProfile(value));assert.deepEqual(game.exportProfile(),before);
 for(const delta of[-1,NaN,Infinity])assert.throws(()=>game.update(delta));game.fadeBus('music',0,0);assert.equal(mixer.getVolumes().music,0);game.restoreProfile(before);assert.deepEqual(mixer.getVolumes(),before.volumes);f.close();
});
test('distance gain is applied before source start; pan, dry gain and unbinding never compound attenuation',async()=>{
 const f=await setup();let position=[50,0],listener=[0,0];f.game.setListener(()=>listener);
 const unbind=f.game.bindEmitter2D({owner:'owner',channel:'channel',position:()=>position,maxDistance:100});f.game.play({...audioRequest('first'),volume:.8,pan:-.2});
 assert.equal(f.context.gains.at(-1).gain.writes[0][0],.4);assert.equal(f.context.panners.at(-1).pan.value,.5);
 f.game.update(16);f.game.update(16);assert.equal(f.context.gains.at(-1).gain.value,.4);position=[100,0];f.game.update(16);assert.equal(f.context.gains.at(-1).gain.value,0);assert.equal(f.context.panners.at(-1).pan.value,1);
 position=[0,0];f.game.update(16);assert.equal(f.context.gains.at(-1).gain.value,.8);unbind();unbind();assert.equal(f.context.panners.at(-1).pan.value,-.2);
 const second=f.game.bindEmitter2D({owner:'owner',channel:'channel',position:()=>position,maxDistance:100,attenuation:2,volume:.4});position=[50,0];f.game.update(0);assert.equal(f.context.gains.at(-1).gain.value,.1);listener=[50,0];f.game.update(0);assert.equal(f.context.gains.at(-1).gain.value,.4);second();f.close();
});
test('external channel replacements and other wrappers retain their voice/gain/pan after update and disposal',async()=>{
 const f=await setup(),second=createGameAudio({mixer:f.mixer});f.game.bindEmitter2D({owner:'owner',channel:'channel',position:()=>[50,0],maxDistance:100});f.game.play(audioRequest('first'));
 const external=f.mixer.play({...audioRequest('external'),volume:.9,pan:-.7});f.game.update(16);assert.equal(f.context.gains.at(-1).gain.value,.9);assert.equal(f.context.panners.at(-1).pan.value,-.7);f.game.dispose();assert.equal(f.context.sources.at(-1).stops,0);assert.equal(f.mixer.stats.voices,1);
 second.play({...audioRequest('second'),volume:.6});assert.equal(f.mixer.stopVoice(external),false);second.dispose();assert.equal(f.mixer.stats.voices,0);assert.equal(f.context.closed,0);f.mixer.dispose();
});
test('only live voice IDs are retained by the original lease; 10,000 natural endings leave no stale stop work',async()=>{
 const f=await setup();for(let i=0;i<10000;i++){f.game.play(audioRequest('e'+i,'owner','c'+i));f.context.sources.at(-1).finish();}assert.equal(f.mixer.stats.voices,0);assert.equal(f.mixer.stats.owners,0);
 let stopped=0;const stop=f.mixer.stopVoice.bind(f.mixer);f.mixer.stopVoice=id=>{stopped++;return stop(id);};f.game.dispose();assert.equal(stopped,0);assert.equal(f.mixer.stats.audioNodes,4);f.mixer.dispose();assert.equal(f.mixer.stats.audioNodes,0);
});
test('emitter limits, invalid geometry and missing stereo reject without silently degrading',async()=>{
 const f=await setup();for(const options of[{maxDistance:0},{attenuation:0},{panStrength:-1},{volume:5},{position:()=>[NaN,0]}])assert.throws(()=>f.game.bindEmitter2D({owner:'owner',channel:'bad',position:()=>[0,0],maxDistance:100,...options}));
 const releases=[];for(let i=0;i<128;i++)releases.push(f.game.bindEmitter2D({owner:'owner',channel:'e'+i,position:()=>[0,0],maxDistance:1}));assert.throws(()=>f.game.bindEmitter2D({owner:'owner',channel:'overflow',position:()=>[0,0],maxDistance:1}));releases[0]();const release=f.game.bindEmitter2D({owner:'owner',channel:'new',position:()=>[1e308,0],maxDistance:1,panStrength:0});f.game.setListener(()=>[-1e308,0]);f.game.update(16);release();f.close();for(const unbind of releases)unbind();
 const mono=await setup({pan:false});assert.throws(()=>mono.game.bindEmitter2D({owner:'owner',channel:'a',position:()=>[0,0],maxDistance:100}),e=>e.code==='E_AUDIO_CAPABILITY_UNAVAILABLE');mono.close();
 const context=new AudioContextAudit();let created=0;const mixer=new OwnerSafeAudioMixer({contextFactory:()=>{created++;return context;}}),game=createGameAudio({mixer});assert.equal(created,0);assert.throws(()=>game.bindEmitter2D({owner:'owner',channel:'a',position:()=>[0,0],maxDistance:1}),e=>e.code==='E_AUDIO_CAPABILITY_UNAVAILABLE');await game.resume();assert.equal(created,1);const off=game.bindEmitter2D({owner:'owner',channel:'a',position:()=>[0,0],maxDistance:1});off();game.dispose();mixer.dispose();
});
test('invalid position samples commit no fade or spatial work; all borrowed host operations retain original lifecycle',async()=>{
 const f=await setup();let pos=[0,0];f.game.bindEmitter2D({owner:'owner',channel:'channel',position:()=>pos,maxDistance:100});f.game.play(audioRequest('a'));f.game.fadeBus('music',0,1000);const before=f.game.exportProfile();pos=[NaN,0];assert.throws(()=>f.game.update(500));assert.deepEqual(f.game.exportProfile(),before);
 await f.game.suspend();assert.equal(f.mixer.stats.state,'suspended');assert.equal(f.game.play(audioRequest('not-running')),null);await f.game.resume();assert.equal(f.mixer.stats.state,'running');f.game.dispose();f.game.dispose();assert.equal(f.context.closed,0);assert.equal(f.mixer.stats.voices,0);assert.throws(()=>f.game.update(0),e=>e.code==='E_RESOURCE_OWNER_RELEASED');f.mixer.dispose();
});
test('configuration and position accessors are snapshotted once before validation or spatial work',async()=>{
 const f=await setup();let reads=0;f.game.restoreProfile({format:'haiyue-game-audio',version:1,volumes:{master:1,music:1,sfx:1,ui:1},get muted(){reads++;return reads===1?false:'invalid';}});assert.equal(reads,1);assert.equal(f.game.exportProfile().muted,false);
 let x=0;const position=[0,0];Object.defineProperty(position,'0',{get(){x++;return x===1?50:NaN;}});f.game.bindEmitter2D({owner:'owner',channel:'channel',position:()=>position,maxDistance:100});assert.equal(x,1);f.close();
});
test('static emitters and zero-time fade updates append no redundant native parameter events',async()=>{
 const f=await setup();let position=[50,0];f.game.bindEmitter2D({owner:'owner',channel:'channel',position:()=>position,maxDistance:100});f.game.play(audioRequest('static'));const gain=f.context.gains.at(-1).gain,pan=f.context.panners.at(-1).pan;
 for(let i=0;i<1000;i++)f.game.update(16);assert.equal(gain.writes.length,1);assert.equal(pan.writes.length,1);
 position=[-50,0];f.game.update(16);assert.equal(gain.writes.length,1);assert.equal(pan.writes.length,2);
 f.mixer.setGain('owner','channel',.8);f.game.update(16);assert.equal(gain.value,.4);assert.equal(gain.writes.length,3);
 f.game.fadeBus('music',0,1000);const bus=f.context.gains[1].gain,before=bus.writes.length;f.game.update(0);assert.equal(bus.writes.length,before);f.close();
});
