import{OwnerSafeAudioMixer}from'@haiyue/engine/audio';
import{createGameAudio}from'@haiyue/extensions/audio';
import type{GameAudio,GameAudioProfile}from'@haiyue/extensions/audio';
import{GameSaveService,LocalStorageSaveBackend}from'@haiyue/engine/save';
import type{GameSaveBackend}from'@haiyue/engine/save';

/** An explicit audio-lifetime example: one borrowed context, without a GUI/3D renderer. */
export function createGameAudioExample(options:{context?:AudioContext;backend?:GameSaveBackend}={}){
 const context=options.context??new AudioContext({sampleRate:48000});
 let createdMixer:OwnerSafeAudioMixer|undefined,createdAudio:GameAudio|undefined;
 try{
  const mixer=createdMixer=new OwnerSafeAudioMixer({context}),audio=createdAudio=createGameAudio({mixer,listener:()=>[0,0]});
  const buffer=context.createBuffer(1,context.sampleRate,context.sampleRate),samples=buffer.getChannelData(0);
  for(let i=0;i<samples.length;i++)samples[i]=Math.sin(2*Math.PI*440*i/context.sampleRate)*.16;
  mixer.installBuffer('tone',buffer);
  let position:readonly[number,number]=[0,0],sequence=0,voice:string|null=null,disposed=false;
  const unbind=audio.bindEmitter2D({owner:'scene',channel:'tone',position:()=>position,maxDistance:100,volume:.5});
  const saves=new GameSaveService<GameAudioProfile>({gameId:'engine-game-audio-example',dataVersion:1,backend:options.backend??new LocalStorageSaveBackend({namespace:'haiyue-engine-examples'}),ownsBackend:options.backend===undefined,maxSlots:1});
  const play=async()=>{await audio.resume();if(disposed)return;voice=audio.play({eventId:'tone-'+(++sequence),bufferId:'tone',owner:'scene',channel:'tone',bus:'sfx',loop:true,startTick:sequence});};
  const stop=()=>{if(voice!==null)mixer.stopVoice(voice);voice=null;};
  const move=(x:number,y=0)=>{if(!Number.isFinite(x)||!Number.isFinite(y))throw new TypeError('Position must be finite.');position=[x,y];};
  const save=async()=>{await saves.save({saveId:'audio',name:'Audio settings',data:audio.exportProfile()});};
  const restore=async()=>{const stored=await saves.load('audio');if(!disposed&&stored)audio.restoreProfile(stored.data);return stored!==null;};
  const dispose=async()=>{if(disposed)return;disposed=true;unbind();audio.dispose();mixer.dispose();await saves.dispose();if(options.context===undefined&&context.state!=='closed')await context.close();};
  return{context,mixer,audio,play,stop,move,save,restore,dispose,position:()=>position,stats:()=>mixer.stats};
 }catch(error){createdAudio?.dispose();createdMixer?.dispose();if(options.context===undefined)void context.close().catch(()=>undefined);throw error;}
}
