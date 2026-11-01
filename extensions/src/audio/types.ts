import type{OwnerSafeAudioMixer,AudioMixerVolumes,AudioMixerBus,AudioMixerPlayRequest}from'@haiyue/engine/audio';
export interface GameAudioProfile {readonly format:'haiyue-game-audio';readonly version:1;readonly volumes:AudioMixerVolumes;readonly muted:boolean;}
export interface GameAudioOptions {readonly mixer:OwnerSafeAudioMixer;readonly listener?:()=>readonly[number,number];readonly profile?:GameAudioProfile;}
export interface GameAudioEmitterOptions {readonly owner:string;readonly channel:string;readonly position:()=>readonly[number,number];readonly maxDistance:number;readonly attenuation?:number;readonly volume?:number;readonly panStrength?:number;}
export interface GameAudio {
  play(request:AudioMixerPlayRequest):string|null;
  setListener(listener:()=>readonly[number,number]):void;
  bindEmitter2D(options:GameAudioEmitterOptions):()=>void;
  update(deltaMs:number):void;
  setVolumes(volumes:Partial<AudioMixerVolumes>):void;
  setMuted(muted:boolean):void;
  fadeBus(bus:AudioMixerBus,target:number,durationMs:number):void;
  exportProfile():GameAudioProfile;
  restoreProfile(profile:GameAudioProfile):void;
  suspend():Promise<void>;
  resume():Promise<void>;
  dispose():void;
}
