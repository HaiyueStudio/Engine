import type {InputActionMap, InputActionMapDescriptor, StandardGamepadSnapshot} from '@haiyue/engine/input';

export type InputBindingSample = Readonly<{device:'keyboard';code:string;down:boolean}>
  | Readonly<{device:'pointer';button:number;down:boolean}>
  | Readonly<{device:'gamepad';index:number;snapshot:StandardGamepadSnapshot}>;
export interface InputBindingConflict {readonly action:string;readonly otherActions:readonly string[];readonly sample:InputBindingSample;}
export interface InputBindingProfileData {readonly format:'haiyue-input-profile';readonly version:1;readonly bindings:InputActionMapDescriptor;}
export interface InputBindingProfileOptions {
  readonly map:InputActionMap;readonly captureAxisThreshold?:number;
  readonly conflict?:'reject'|'share'|'replace';readonly maxActions?:number;
  readonly onConflict?:(conflict:InputBindingConflict)=>void;readonly onChange?:(data:InputBindingProfileData)=>void;
}
export interface InputBindingProfile {
  beginRebind(action:string,kind:'button'|'negative'|'positive'):void;
  offer(sample:InputBindingSample):boolean;cancelRebind():void;
  exportData():InputBindingProfileData;restore(data:InputBindingProfileData):void;dispose():void;
}
