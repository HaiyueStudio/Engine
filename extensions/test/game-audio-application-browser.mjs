import{createGameAudioExample}from'/feature-consumer/browser/application.js';import{MemorySaveBackend}from'@haiyue/engine/save';
const result=document.getElementById('result'),checks=[];let app,context;
const assert=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);},publish=r=>{result.textContent=JSON.stringify(r);result.dataset.status=r.status;};
try{
 context=new AudioContext({sampleRate:48000,sinkId:{type:'none'}});assert(context.sinkId?.type==='none','native silent test sink');const backend=new MemorySaveBackend();app=createGameAudioExample({context,backend});assert(app.stats().voices===0,'actual application stays silent until unlock');
 document.getElementById('unlock').addEventListener('click',async event=>{try{
  assert(event.isTrusted,'trusted browser input');await app.play();assert(app.stats().voices===1,'actual application starts original mixer voice');app.move(-50);app.audio.update(16);await app.save();const saved=app.audio.exportProfile();app.audio.setMuted(true);app.audio.setVolumes({master:.3,sfx:.2});assert(await app.restore()&&JSON.stringify(app.audio.exportProfile())===JSON.stringify(saved),'original GameSaveService restores actual application profile');
  const mixer=app.mixer;await app.dispose();assert(mixer.stats.voices===0&&mixer.stats.audioNodes===0&&mixer.stats.buffers===0&&context.state==='running','application releases graph and preserves borrowed context');await backend.delete('engine-game-audio-example','audio');await context.close();publish({schemaVersion:1,status:'passed',checks,final:mixer.stats,qualification:false});
 }catch(error){await app?.dispose();await context.close().catch(()=>{});publish({schemaVersion:1,status:'failed',checks,error:String(error.stack??error)});}},{once:true});result.dataset.ready='true';
}catch(error){await app?.dispose();await context?.close().catch(()=>{});publish({schemaVersion:1,status:'failed',checks,error:String(error.stack??error)});}
