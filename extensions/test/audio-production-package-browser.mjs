import {createHyaAudio, createBrowserHyaAudioHost} from '/g11-packed-audio/hya-audio.js';
const check = (condition, message) => {if (!condition) throw new Error(message);};
const result = document.querySelector('#result'), cases = [];
const publish = data => {result.textContent = JSON.stringify(data); result.dataset.status = data.status;};
const waitFor = async predicate => {
  const deadline = performance.now() + 5000;
  while (!predicate()) {if (performance.now() > deadline) throw new Error('native audio completion timed out'); await new Promise(resolve => setTimeout(resolve, 10));}
};
let context, first, second;
try {
  // Real native audio graph and clock with a silent sink. Unsupported silence is a failure, never an audible fallback.
  context = new AudioContext({sampleRate: 48000, sinkId: {type: 'none'}});
  check(context.sinkId?.type === 'none', 'native silent sink required');
  const bytes = new ArrayBuffer(44 + 4800 * 2), view = new DataView(bytes);
  const text = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 48000, true);
  view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, 9600, true);
  for (let index = 0; index < 4800; index++) view.setInt16(44 + index * 2, 8192, true);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  let binary = ''; for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value);
  const documentValue = {format: 'haiyue-audio-events', version: 1, extension: 'org.haiyue.audio-events@1', playbackProfile: 'sample-accurate',
    clock: {sampleRate: 48000, lookAheadFrames: 4800, driftToleranceFrames: 64, driftPolicy: 'resync', lateDecodePolicy: 'catch-up', visibilityPolicy: 'pause-resume', suspendedPolicy: 'queue-until-resume'},
    browser: {autoplay: 'require-user-gesture'}, limits: {maxVoices: 4, maxVoicesPerResource: 3, maxDecodeJobs: 2, maxEventTokens: 32, maxDecodedFrames: 10000, maxDecodedBytes: 40000}, voiceStealing: 'reject',
    resources: [{id: 'tone', codec: 'wav', mediaType: 'audio/wav', sampleRate: 48000, channels: 1, frameLength: 4800, integrity: {algorithm: 'sha256', digest}, source: {kind: 'embedded', data: btoa(binary)}}],
    buses: [{id: 'master', gain: 1}], cues: [
      {id: 'one', resource: 'tone', owner: 'button', bus: 'master', gain: .5, rate: 1, offsetFrames: 0, durationFrames: 2400, overlap: 'allow', priority: 1},
      {id: 'loop', resource: 'tone', owner: 'panel', bus: 'master', gain: .5, rate: 1, offsetFrames: 0, loop: {startFrame: 0, endFrame: 4800, iterations: 'infinite'}, overlap: 'restart', priority: 1},
    ], timelineEvents: []};
  const native = await createBrowserHyaAudioHost(context), audit = {decodes: 0, decodedReleases: 0, voices: 0, voiceReleases: 0, ended: 0}, tokens = new Set();
  // Transparent lifetime audit around the actual public browser host, not an alternate decoder/scheduler.
  const host = {profile: native.profile, sampleRate: native.sampleRate, get state() {return native.state;}, nowFrame: () => native.nowFrame(), unlock: () => native.unlock(),
    resolve: (resource, signal) => native.resolve(resource, signal),
    async decode(...args) {
      const handle = await native.decode(...args); audit.decodes++; let released = false;
      return {...handle, release() {check(!released, 'decoded double release'); released = true; audit.decodedReleases++; handle.release();}};
    },
    schedule(request) {
      check(!tokens.has(request.token), 'voice token collision across packed owners'); tokens.add(request.token);
      const handle = native.schedule({...request, onEnded() {audit.ended++; request.onEnded();}}); audit.voices++; let released = false;
      return {...handle, release() {check(!released, 'voice double release'); released = true; audit.voiceReleases++; handle.release();}};
    },
  };
  first = await createHyaAudio(documentValue, host); second = await createHyaAudio(documentValue, host);
  let denied; try {await first.play('one');} catch (error) {denied = error;}
  check(denied?.code === 'E_AUDIO_RUNTIME_AUTOPLAY' && audit.voices === 0, 'factory preparation must not implicitly start audio');
  cases.push({id: 'packed-factory-native-decode-with-no-implicit-playback', decoded: audit.decodes});
  document.querySelector('#unlock').addEventListener('click', async event => {
    try {
      check(event.isTrusted, 'trusted native click required');
      await Promise.all([first.unlock(), second.unlock()]);
      check(context.state === 'running', 'native context unlock');
      const start = host.nowFrame(); await first.play('loop'); await second.play('loop');
      await waitFor(() => host.nowFrame() > start + 2048);
      check(host.nowFrame() > start && audit.voices === 2, 'native sample clock advances');
      cases.push({id: 'trusted-gesture-unlocks-two-packed-owners-on-real-shared-context', observedFrame: host.nowFrame()});
      await first.update({domain: 'composition', time: 0, rate: 1, operation: 'pause'});
      check(context.state === 'running', 'one owner must not suspend global context');
      check(!second.trace.some(entry => entry.operation === 'stopped'), 'other owner was not stopped');
      await first.update({domain: 'composition', time: 0, rate: 1, operation: 'resume'}); first.dispose();
      check(context.state === 'running', 'dispose must not close global context');
      await second.stop('loop'); await second.play('one');
      await waitFor(() => second.trace.some(entry => entry.operation === 'ended' && entry.details.cue === 'one'));
      cases.push({id: 'pause-resume-dispose-keeps-other-owner-native-audio-usable'});
      second.dispose(); first.dispose();
      await waitFor(() => audit.voices === audit.voiceReleases && audit.decodes === audit.decodedReleases);
      check(context.state === 'running', 'all borrowed owners leave native host open');
      cases.push({id: 'all-native-voice-and-decoded-handles-released-once', audit, uniqueVoiceTokens: [...tokens]});
      await context.close(); publish({status: 'passed', caseCount: cases.length, cases, native: 'real AudioContext with silent sink; packed factories; trusted browser click'});
    } catch (error) {first?.dispose(); second?.dispose(); await context.close().catch(() => {}); publish({status: 'failed', cases, error: String(error.stack ?? error)});}
  }, {once: true});
  result.dataset.ready = 'true';
} catch (error) {first?.dispose(); second?.dispose(); await context?.close().catch(() => {}); publish({status: 'failed', cases, error: String(error.stack ?? error)});}
