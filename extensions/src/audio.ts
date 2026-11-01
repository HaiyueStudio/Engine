import{GameAudioRuntime}from'./audio/GameAudio';
import type{GameAudioOptions,GameAudio}from'./audio/types';
export type{GameAudioProfile,GameAudioOptions,GameAudioEmitterOptions,GameAudio}from'./audio/types';
export function createGameAudio(options:GameAudioOptions):GameAudio {return new GameAudioRuntime(options);}
