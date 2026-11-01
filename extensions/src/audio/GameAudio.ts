import{OwnerSafeAudioMixer}from'@haiyue/engine/audio';
import type{AudioMixerVolumes,AudioMixerBus,AudioMixerPlayRequest}from'@haiyue/engine/audio';
import{EngineError,EngineErrorCode}from'@haiyue/engine/core';
import type{GameAudio,GameAudioOptions,GameAudioProfile,GameAudioEmitterOptions}from'./types';

interface SpatialGain {readonly pan:number;readonly factor:number;readonly volume?:number;}
interface VoiceLease {play(request:AudioMixerPlayRequest,spatial?:SpatialGain):string|null;spatial(owner:string,channel:string,value:SpatialGain|null):boolean;release():void;}
interface MixerPort {readonly version:1;acquire():VoiceLease;}
interface Emitter {readonly owner:string;readonly channel:string;position:(()=>readonly[number,number])|null;readonly maxDistance:number;readonly attenuation:number;readonly panStrength:number;readonly volume:number|undefined;}
interface Fade {readonly start:number;readonly target:number;readonly duration:number;elapsed:number;}
const buses:readonly AudioMixerBus[]=['music','sfx','ui'],volumeKeys:readonly(keyof AudioMixerVolumes)[]=['master',...buses],origin=()=>[0,0]as const;
const unavailable=(message:string)=>new EngineError(EngineErrorCode.AudioCapabilityUnavailable,message,{docsPath:'errors/E_AUDIO_CAPABILITY_UNAVAILABLE',hint:'Resume the original mixer, check stereoPan, and pair the Engine/extensions 0.2.3 candidates.'});
function amount(value:number,label:string,minimum=0,maximum=4):number {if(!Number.isFinite(value)||value<minimum||value>maximum)throw new RangeError('Invalid game audio '+label+'.');return value;}
function id(value:string):string {if(typeof value!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/u.test(value))throw new TypeError('Invalid audio owner/channel.');return value;}
function point(value:readonly[number,number]):readonly[number,number] {const x=value?.[0],y=value?.[1];if(!value||value.length!==2||!Number.isFinite(x)||!Number.isFinite(y))throw new TypeError('Audio positions require two finite render-unit coordinates.');return [x,y];}
function volumes(value:Partial<AudioMixerVolumes>,base:AudioMixerVolumes):AudioMixerVolumes {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!volumeKeys.includes(k as keyof AudioMixerVolumes)))throw new TypeError('Invalid audio volume configuration.');
  const result={...base};for(const key of volumeKeys)if(Object.hasOwn(value,key))result[key]=amount(value[key]!,key);return Object.freeze(result);
}
function profile(value:GameAudioProfile):GameAudioProfile {
  if(!value||typeof value!=='object')throw new TypeError('Invalid haiyue-game-audio/v1 profile.');
  const format=value.format,version=value.version,muted=value.muted,data=value.volumes;
  if(format!=='haiyue-game-audio'||version!==1||typeof muted!=='boolean'||Object.keys(value).some(k=>!['format','version','volumes','muted'].includes(k))||!data||volumeKeys.some(k=>!Object.hasOwn(data,k)))throw new TypeError('Invalid haiyue-game-audio/v1 profile.');
  return Object.freeze({format:'haiyue-game-audio',version:1,volumes:volumes(data,{master:1,music:1,sfx:1,ui:1}),muted});
}

/** Configuration and bounded emitters; the original mixer alone owns live voices/nodes. */
export class GameAudioRuntime implements GameAudio {
  private readonly mixer:OwnerSafeAudioMixer;
  private readonly lease:VoiceLease;
  private listener:(()=>readonly[number,number])|null;
  private readonly emitters=new Map<string,Emitter>();
  private readonly fades=new Map<AudioMixerBus,Fade>();
  private configured:AudioMixerVolumes;
  private muted=false;
  private dead=false;
  constructor(options:GameAudioOptions){
    if(!options||!(options.mixer instanceof OwnerSafeAudioMixer)||options.listener!==undefined&&typeof options.listener!=='function')throw new TypeError('GameAudio requires the original mixer and a listener callback.');
    const initial=options.profile===undefined?null:profile(options.profile);
    this.mixer=options.mixer;this.configured=this.mixer.getVolumes();this.listener=options.listener??origin;this.alive();
    const port=(this.mixer as unknown as Record<symbol,MixerPort|undefined>)[Symbol.for('haiyue.audio.game-lease.v1')];
    if(port?.version!==1||typeof port.acquire!=='function')throw unavailable('The original mixer does not provide compatible voice ownership.');
    this.lease=port.acquire();if(initial)this.restoreProfile(initial);
  }
  private alive():void {const stats=this.mixer.stats;if(this.dead||stats.disposed||stats.state==='closed')throw new EngineError(EngineErrorCode.ResourceOwnerReleased,'Game audio or its borrowed mixer is released.');}
  private stereo():void {if(this.mixer.getCapabilities().stereoPan!==true)throw unavailable('2D emitters require an initialized stereo-panner host.');}
  private spatial(emitter:Emitter,listener:readonly[number,number]):SpatialGain {
    if(!emitter.position)throw new EngineError(EngineErrorCode.ResourceOwnerReleased,'Audio emitter is released.');
    const p=point(emitter.position()),dx=p[0]-listener[0],dy=p[1]-listener[1],factor=Math.pow(Math.max(0,1-Math.hypot(dx,dy)/emitter.maxDistance),emitter.attenuation),pan=emitter.panStrength===0?0:Math.max(-1,Math.min(1,dx/emitter.maxDistance*emitter.panStrength));
    return {pan,factor,...(emitter.volume===undefined?{}:{volume:emitter.volume})};
  }
  play(request:AudioMixerPlayRequest):string|null {
    this.alive();if(this.mixer.stats.state!=='running')return this.lease.play(request);const emitter=this.emitters.get(request.owner+'\u0000'+request.channel);
    if(!emitter)return this.lease.play(request);
    this.stereo();const spatial=this.spatial(emitter,point(this.listener!()));this.alive();
    return this.lease.play(request,this.emitters.get(emitter.owner+'\u0000'+emitter.channel)===emitter?spatial:undefined);
  }
  setListener(listener:()=>readonly[number,number]):void {this.alive();if(typeof listener!=='function')throw new TypeError('Audio listener requires a callback.');this.listener=listener;}
  bindEmitter2D(options:GameAudioEmitterOptions):()=>void {
    this.alive();if(!options||typeof options.position!=='function')throw new TypeError('Audio emitter requires a position callback.');
    const owner=id(options.owner),channel=id(options.channel),key=owner+'\u0000'+channel;
    if(this.emitters.has(key)||this.emitters.size>=128)throw new RangeError('Game audio emitter is duplicate or exceeds 128 bindings.');
    const maxDistance=amount(options.maxDistance,'maxDistance',Number.MIN_VALUE,Number.MAX_VALUE),attenuation=amount(options.attenuation??1,'attenuation',Number.MIN_VALUE,Number.MAX_VALUE),panStrength=amount(options.panStrength??1,'panStrength',0,Number.MAX_VALUE),volume=options.volume===undefined?undefined:amount(options.volume,'emitter volume');
    this.stereo();const emitter:Emitter={owner,channel,position:options.position,maxDistance,attenuation,panStrength,volume},spatial=this.spatial(emitter,point(this.listener!()));this.alive();
    if(this.emitters.has(key)||this.emitters.size>=128)throw new RangeError('An emitter callback changed the binding capacity.');
    this.emitters.set(key,emitter);this.lease.spatial(owner,channel,spatial);
    return()=>{if(this.emitters.get(key)!==emitter)return;this.emitters.delete(key);emitter.position=null;this.lease.spatial(owner,channel,null);};
  }
  update(deltaMs:number):void {
    this.alive();amount(deltaMs,'deltaMs',0,Number.MAX_VALUE);
    const listener=this.emitters.size?point(this.listener!()):[0,0]as const;if(this.dead)return;
    const samples:{key:string;emitter:Emitter;spatial:SpatialGain}[]=[];
    for(const[key,emitter]of [...this.emitters.entries()]){if(this.emitters.get(key)!==emitter||!emitter.position)continue;samples.push({key,emitter,spatial:this.spatial(emitter,listener)});if(this.dead)return;}
    if(this.dead)return;
    for(const[bus,fade]of this.fades){fade.elapsed+=Math.min(deltaMs,fade.duration-fade.elapsed);const value=fade.start+(fade.target-fade.start)*(fade.elapsed/fade.duration);if(value!==this.configured[bus]){this.configured=Object.freeze({...this.configured,[bus]:value});this.mixer.setBusVolume(bus,value);}if(fade.elapsed===fade.duration)this.fades.delete(bus);}
    for(const{key,emitter,spatial}of samples)if(this.emitters.get(key)===emitter)this.lease.spatial(emitter.owner,emitter.channel,spatial);
  }
  setVolumes(value:Partial<AudioMixerVolumes>):void {
    this.alive();const next=volumes(value,this.configured);
    for(const key of volumeKeys)if(Object.hasOwn(value,key)){if(key==='master')this.mixer.setMasterVolume(this.muted?0:next.master);else{this.fades.delete(key);this.mixer.setBusVolume(key,next[key]);}}
    this.configured=next;
  }
  setMuted(value:boolean):void {this.alive();if(typeof value!=='boolean')throw new TypeError('Audio mute must be boolean.');this.muted=value;this.mixer.setMasterVolume(value?0:this.configured.master);}
  fadeBus(bus:AudioMixerBus,target:number,durationMs:number):void {
    this.alive();if(!buses.includes(bus))throw new TypeError('Unknown game audio bus.');amount(target,'fade target');amount(durationMs,'fade duration',0,Number.MAX_VALUE);
    if(durationMs===0||target===this.configured[bus]){this.setVolumes({[bus]:target});return;}this.fades.set(bus,{start:this.configured[bus],target,duration:durationMs,elapsed:0});
  }
  exportProfile():GameAudioProfile {this.alive();return Object.freeze({format:'haiyue-game-audio',version:1,volumes:Object.freeze({...this.configured}),muted:this.muted});}
  restoreProfile(value:GameAudioProfile):void {
    this.alive();const next=profile(value);this.fades.clear();this.configured=next.volumes;this.muted=next.muted;this.mixer.setMasterVolume(this.muted?0:this.configured.master);for(const bus of buses)this.mixer.setBusVolume(bus,this.configured[bus]);
  }
  async suspend():Promise<void> {this.alive();await this.mixer.suspend();}
  async resume():Promise<void> {this.alive();await this.mixer.resume();}
  dispose():void {if(this.dead)return;this.dead=true;for(const emitter of this.emitters.values())emitter.position=null;this.emitters.clear();this.fades.clear();this.listener=null;this.lease.release();}
}
