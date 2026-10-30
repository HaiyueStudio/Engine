import {audioRuntimeFail} from './diagnostics.js';
import {WebAudioBackend} from './WebAudioBackend.js';
import type {ProductionAudioHost} from './ProductionAudioHost.js';
import type {DecodedAudioHandle, RuntimeAudioResource} from './runtime-types.js';

const MAX_ENCODED_AUDIO_BYTES = 64 * 1024 * 1024;

/** Internal transport. The public factory borrows an explicit AudioContext and uses realtime mode. */
export function createBorrowedBrowserAudioHost(context: AudioContext, kind: 'realtime' | 'offline' = 'realtime'): ProductionAudioHost {
  if (!context || typeof context.createBufferSource !== 'function' || typeof context.decodeAudioData !== 'function' || context.state === 'closed')
    audioRuntimeFail('E_AUDIO_RUNTIME_PORT', '$.host.audio.context', 'an open native audio context is required');
  const backend = new WebAudioBackend(context, {ownsContext: false, kind});
  const decoded = new WeakMap<object, DecodedAudioHandle>();
  const frame = () => backend.currentFrame();
  return Object.freeze({
    profile: 'sample-accurate' as const,
    get sampleRate() {return backend.sampleRate;},
    get state() {return backend.state;},
    nowFrame: frame,
    unlock: () => backend.resume(),
    resolve: resolveBrowserAudio,
    async decode(resource: RuntimeAudioResource, signal: AbortSignal, encoded: ArrayBuffer) {
      if (signal.aborted) audioRuntimeFail('E_AUDIO_RUNTIME_ABORTED', `resources.${resource.id}`, 'decode was cancelled');
      if (!(encoded instanceof ArrayBuffer) || encoded.byteLength > MAX_ENCODED_AUDIO_BYTES)
        audioRuntimeFail('E_AUDIO_RUNTIME_LIMIT', `resources.${resource.id}`, 'encoded audio exceeds the browser host byte ceiling');
      if (resource.codec === 'pcm-f32')
        audioRuntimeFail('E_AUDIO_RUNTIME_PROFILE', `resources.${resource.id}.codec`, 'raw PCM requires an explicit decoder host with a declared channel layout');
      const hash = await crypto.subtle.digest('SHA-256', encoded);
      const observed = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
      if (observed !== resource.integrity.digest)
        audioRuntimeFail('E_AUDIO_RUNTIME_INTEGRITY', `resources.${resource.id}.integrity`, 'encoded audio SHA-256 mismatch');
      let decoder = backend;
      if (resource.sampleRate !== context.sampleRate) {
        if (typeof OfflineAudioContext !== 'function')
          audioRuntimeFail('E_AUDIO_RUNTIME_PROFILE', `resources.${resource.id}.sampleRate`, 'native decode at the declared source sample rate is unavailable');
        // decodeAudioData resamples to its context rate. Preserve source-frame offsets with an owned decoder context.
        const decodeContext = new OfflineAudioContext(resource.channels, 1, resource.sampleRate);
        decoder = new WebAudioBackend(decodeContext as unknown as AudioContext, {kind: 'offline', ownsContext: false});
      }
      let handle: DecodedAudioHandle;
      try {handle = await decoder.decode({resource, bytes: encoded}, signal);}
      finally {if (decoder !== backend) decoder.dispose();}
      const token = Object.freeze({}); decoded.set(token, handle);
      let released = false;
      return Object.freeze({value: token, sampleRate: handle.sampleRate, channels: handle.channels, frames: handle.frameLength,
        bytes: handle.frameLength * handle.channels * 4,
        release() {if (released) return; released = true; decoded.delete(token); handle.release();}});
    },
    schedule(request: Parameters<ProductionAudioHost['schedule']>[0]) {
      const value = request.value;
      const buffer = value && typeof value === 'object' ? decoded.get(value) : undefined;
      if (!buffer) audioRuntimeFail('E_AUDIO_RUNTIME_DECODE', request.token, 'decoded value is not owned by this browser host');
      for (const [name, number] of [['startFrame', request.startFrame], ['offsetFrame', request.offsetFrame],
        ['stopFrame', request.stopFrame], ['durationFrames', request.durationFrames]] as const) {
        if (number !== undefined && (!Number.isSafeInteger(number) || number < 0))
          audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', `voices.${request.token}.${name}`, 'audio positions must be nonnegative safe sample frames');
      }
      const stop = request.stopFrame ?? (request.durationFrames === undefined ? undefined : request.startFrame + request.durationFrames);
      if (stop !== undefined && (!Number.isSafeInteger(stop) || stop < request.startFrame
        || request.durationFrames !== undefined && stop !== request.startFrame + request.durationFrames))
        audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', request.token, 'stop frame and duration do not describe the same voice interval');
      if (!Number.isFinite(request.gain) || request.gain < 0 || !Number.isFinite(request.rate) || request.rate < .0625 || request.rate > 16)
        audioRuntimeFail('E_AUDIO_RUNTIME_PROFILE', request.token, 'voice gain/rate is outside the sample-accurate profile');
      const voice = backend.schedule({voiceId: request.token, decoded: buffer, whenFrame: request.startFrame,
        offsetFrame: request.offsetFrame, gain: request.gain, rate: request.rate, onEnded: request.onEnded,
        ...(stop === undefined ? {} : {stopFrame: stop}), ...(request.loop === undefined ? {} : {loop: request.loop})});
      return Object.freeze({
        stop: (at = frame()) => voice.stop(checkedFrame(at)),
        setGain: (gain: number, at = frame()) => {
          if (!Number.isFinite(gain) || gain < 0) audioRuntimeFail('E_AUDIO_RUNTIME_PROFILE', request.token, 'gain must be finite and nonnegative');
          voice.setGain(gain, checkedFrame(at));
        },
        setRate: (rate: number, at = frame()) => {
          if (!Number.isFinite(rate) || rate < .0625 || rate > 16) audioRuntimeFail('E_AUDIO_RUNTIME_PROFILE', request.token, 'rate is outside the audio profile');
          voice.setRate(rate, checkedFrame(at));
        },
        release: () => voice.dispose()});
    },
  });
}

function checkedFrame(frame: number): number {
  if (!Number.isSafeInteger(frame) || frame < 0) audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', '$.host.audio.frame', 'audio controls require a nonnegative safe sample frame');
  return frame;
}

async function resolveBrowserAudio(resource: RuntimeAudioResource, signal: AbortSignal): Promise<ArrayBuffer> {
  if (signal.aborted) audioRuntimeFail('E_AUDIO_RUNTIME_ABORTED', `resources.${resource.id}`, 'resource load was cancelled');
  if (resource.source.kind === 'hosted') audioRuntimeFail('E_AUDIO_RUNTIME_PORT', `resources.${resource.id}.source`, 'hosted audio needs an application resource resolver');
  if (resource.source.kind === 'embedded') {
    if (resource.source.data.length > Math.ceil(MAX_ENCODED_AUDIO_BYTES / 3) * 4)
      audioRuntimeFail('E_AUDIO_RUNTIME_LIMIT', `resources.${resource.id}`, 'embedded audio exceeds the browser host byte ceiling');
    const binary = atob(resource.source.data);
    return Uint8Array.from(binary, character => character.charCodeAt(0)).buffer;
  }
  if (typeof location === 'undefined') audioRuntimeFail('E_AUDIO_RUNTIME_PORT', `resources.${resource.id}.source`, 'browser base URL is unavailable');
  const url = new URL(resource.source.uri, location.href);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin || url.username || url.password)
    audioRuntimeFail('E_AUDIO_RUNTIME_PORT', `resources.${resource.id}.source`, 'default browser audio resolution is same-origin HTTP(S) only');
  const response = await fetch(url, {signal, redirect: 'error', credentials: 'same-origin'});
  if (!response.ok) audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', `resources.${resource.id}.source`, `audio HTTP status ${response.status}`);
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_ENCODED_AUDIO_BYTES) {
    await response.body?.cancel();
    audioRuntimeFail('E_AUDIO_RUNTIME_LIMIT', `resources.${resource.id}`, 'encoded audio exceeds the browser host byte ceiling');
  }
  const reader = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_ENCODED_AUDIO_BYTES) audioRuntimeFail('E_AUDIO_RUNTIME_LIMIT', `resources.${resource.id}`, 'streamed audio exceeds the browser host byte ceiling');
      chunks.push(value);
    }
  } catch (error) {await reader.cancel().catch(() => undefined); throw error;}
  finally {reader.releaseLock();}
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
  return bytes.buffer;
}
