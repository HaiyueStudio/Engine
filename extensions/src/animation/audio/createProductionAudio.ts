import {ProductionAudioOwner} from './ProductionAudioOwner.js';
import type {ProductionAudioHost} from './ProductionAudioHost.js';
import type {RuntimeAudioDocument} from './runtime-types.js';

type AudioFacade = Pick<ProductionAudioOwner, 'update' | 'play' | 'stop' | 'setBusGain' | 'unlock' | 'trace' | 'dispose'>;

/** Preparation stays silent; unlock calls the original host within the caller's gesture. */
export async function createProductionAudio(document: RuntimeAudioDocument, host: ProductionAudioHost,
  options: Readonly<{signal?: AbortSignal}> = {}): Promise<AudioFacade> {
  const owner = new ProductionAudioOwner(document, host, options);
  try {
    await owner.prepare();
    return Object.freeze({update: owner.update.bind(owner), play: owner.play.bind(owner), stop: owner.stop.bind(owner),
      setBusGain: owner.setBusGain.bind(owner), unlock: owner.unlock.bind(owner),
      get trace() {return owner.trace;}, dispose: owner.dispose.bind(owner)});
  } catch (error) {
    owner.dispose();
    throw error;
  }
}
