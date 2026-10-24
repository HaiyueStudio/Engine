import {createBorrowedBrowserAudioHost} from '/g11-audio-build/animation/audio/BrowserProductionAudioHost.js';

const check = (condition, message) => {if (!condition) throw new Error(message);};
const cases = [];
// Self-authored deterministic PCM16 WAV; the analytical reference below does not use the audio renderer.
async function wav(sampleRate, length, sample) {
  const bytes = new ArrayBuffer(44 + length * 2), view = new DataView(bytes);
  const string = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  string(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); string(8, 'WAVE'); string(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); string(36, 'data'); view.setUint32(40, length * 2, true);
  for (let index = 0; index < length; index++) view.setInt16(44 + index * 2, Math.round(sample(index) * 32768), true);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  let binary = ''; for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value);
  return {bytes, resource: {id: 'own-mit-wave', codec: 'wav', mediaType: 'audio/wav', sampleRate, channels: 1,
    frameLength: length, integrity: {algorithm: 'sha256', digest}, source: {kind: 'embedded', data: btoa(binary)}}};
}
function nearSamples(samples, from, to, expected, tolerance = 1e-5) {
  let maximum = 0;
  for (let index = from; index < to; index++) maximum = Math.max(maximum, Math.abs(samples[index] - expected));
  check(maximum <= tolerance, `PCM mismatch ${from}..${to}: ${maximum} > ${tolerance}`);
  return maximum;
}
try {
  const context = new OfflineAudioContext(1, 2048, 48000);
  const host = createBorrowedBrowserAudioHost(context, 'offline');
  const source = await wav(48000, 3840, index => index < 960 ? .5 : -.5);
  const resolved = await host.resolve(source.resource, new AbortController().signal);
  check(new Uint8Array(resolved).every((value, index) => value === new Uint8Array(source.bytes)[index]), 'embedded byte resolution');
  const decoded = await host.decode(source.resource, new AbortController().signal, resolved);
  check(decoded.sampleRate === 48000 && decoded.frames === 3840 && decoded.channels === 1 && decoded.bytes === 15360, 'native PCM metadata');
  let ended = 0;
  const voice = host.schedule({token: 'analytical', value: decoded.value, startFrame: 240, offsetFrame: 120,
    stopFrame: 1440, durationFrames: 1200, gain: .5, rate: 1, bus: 'sfx', onEnded() {ended++;}});
  voice.setGain(.25, 480);
  // Native playbackRate is k-rate: use an explicitly render-quantum-aligned control point.
  voice.setRate(2, 768);
  const rendered = await context.startRendering(), samples = rendered.getChannelData(0);
  const differences = [nearSamples(samples, 0, 240, 0), nearSamples(samples, 242, 480, .25),
    nearSamples(samples, 480, 920, .125), nearSamples(samples, 930, 1438, -.125), nearSamples(samples, 1440, 2048, 0)];
  check(ended === 1, 'native completion exactly once'); voice.release(); voice.release(); decoded.release(); decoded.release();
  check(ended === 1, 'idempotent release');
  cases.push({id: 'real-native-start-offset-gain-rate-stop-vs-independent-PCM', maximumSampleDifference: Math.max(...differences),
    startFrame: 240, gainFrame: 480, rateFrame: 768, stopFrame: 1440, ended});

  const loopContext = new OfflineAudioContext(1, 1536, 48000), loopHost = createBorrowedBrowserAudioHost(loopContext, 'offline');
  const loopSource = await wav(48000, 480, index => index >= 100 && index < 400 ? .25 : -.25);
  const loopDecoded = await loopHost.decode(loopSource.resource, new AbortController().signal, loopSource.bytes);
  let loopEnded = 0;
  const loopVoice = loopHost.schedule({token: 'loop', value: loopDecoded.value, startFrame: 128, offsetFrame: 100,
    stopFrame: 1280, gain: 1, rate: 1, bus: 'music', loop: {startFrame: 100, endFrame: 400}, onEnded() {loopEnded++;}});
  const loopSamples = (await loopContext.startRendering()).getChannelData(0);
  nearSamples(loopSamples, 0, 128, 0); nearSamples(loopSamples, 128, 1280, .25); nearSamples(loopSamples, 1280, 1536, 0);
  check(loopEnded === 1, 'native loop completion'); loopVoice.release(); loopDecoded.release();
  cases.push({id: 'real-native-loop-region-retains-source-frame-units', loopEnded});

  const differingContext = new OfflineAudioContext(1, 1024, 48000), differingHost = createBorrowedBrowserAudioHost(differingContext, 'offline');
  const differingSource = await wav(44100, 882, () => .5);
  const differing = await differingHost.decode(differingSource.resource, new AbortController().signal, differingSource.bytes);
  check(differing.sampleRate === 44100 && differing.frames === 882, 'source PCM metadata must not be silently resampled to context rate');
  const differingVoice = differingHost.schedule({token: 'differing-source-rate', value: differing.value, startFrame: 128,
    offsetFrame: 441, stopFrame: 512, gain: 1, rate: 1, bus: 'master', onEnded() {}});
  const differingSamples = (await differingContext.startRendering()).getChannelData(0);
  nearSamples(differingSamples, 140, 500, .5, .001); nearSamples(differingSamples, 512, 1024, 0);
  differingVoice.release(); differing.release();
  cases.push({id: 'real-44100-source-in-48000-host-preserves-declared-offset-and-metadata', decodedRate: differing.sampleRate, frames: differing.frames});

  for (const [name, value] of [['bad-integrity', {...source.resource, integrity: {algorithm: 'sha256', digest: '0'.repeat(64)}}],
    ['undefined-raw-pcm-layout', {...source.resource, codec: 'pcm-f32'}]]) {
    let error;
    try {await host.decode(value, new AbortController().signal, source.bytes);} catch (caught) {error = caught;}
    check(error?.code === (name === 'bad-integrity' ? 'E_AUDIO_RUNTIME_INTEGRITY' : 'E_AUDIO_RUNTIME_PROFILE'), name);
    cases.push({id: name, code: error.code});
  }
  let crossOrigin;
  try {await host.resolve({...source.resource, source: {kind: 'referenced', uri: 'https://example.invalid/track.wav'}}, new AbortController().signal);} catch (error) {crossOrigin = error;}
  check(crossOrigin?.code === 'E_AUDIO_RUNTIME_PORT', 'cross-origin resolution must require an explicit application host');
  cases.push({id: 'default-browser-host-rejects-cross-origin-before-network', code: crossOrigin.code});
  const result = {status: 'passed',caseCount: cases.length,cases,reference: 'analytical self-authored PCM; browser native OfflineAudioContext, no audio mocks'};
  document.querySelector('#result').textContent = JSON.stringify(result); document.querySelector('#result').dataset.status = result.status;
} catch (error) {
  const result = {status: 'failed', cases, error: String(error.stack ?? error)};
  document.querySelector('#result').textContent = JSON.stringify(result); document.querySelector('#result').dataset.status = result.status;
}
