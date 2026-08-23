import { parseHyaAudioEvents } from '/g08/audio-spec/index.js';
import { AudioEventRuntime, WebAudioBackend } from '/g08/audio-runtime/index.js';

const progress = document.querySelector('#progress');
const resultNode = document.querySelector('#result');

try {
  const sampleRate = 48_000;
  const wav = makePcm16Wav(sampleRate, 4_800, 0.25);
  const digest = await sha256Hex(wav);
  progress.textContent = 'decoding';
  const document = parseHyaAudioEvents({
    format: 'haiyue-audio-events',
    version: 1,
    extension: 'org.haiyue.audio-events@1',
    playbackProfile: 'sample-accurate',
    clock: {
      sampleRate,
      lookAheadFrames: 4_800,
      driftToleranceFrames: 1,
      driftPolicy: 'error',
      lateDecodePolicy: 'error',
      visibilityPolicy: 'continue',
      suspendedPolicy: 'queue-until-resume',
    },
    browser: { autoplay: 'attempt' },
    limits: {
      maxVoices: 2,
      maxVoicesPerResource: 2,
      maxDecodeJobs: 1,
      maxEventTokens: 16,
      maxDecodedFrames: 10_000,
      maxDecodedBytes: 100_000,
    },
    voiceStealing: 'reject',
    resources: [{
      id: 'tone',
      codec: 'wav',
      mediaType: 'audio/wav',
      integrity: { algorithm: 'sha256', digest },
      sampleRate,
      channels: 1,
      frameLength: 4_800,
      source: { kind: 'embedded', data: base64(wav) },
    }],
    buses: [{ id: 'master', gain: 1 }],
    cues: [{
      id: 'pulse',
      resource: 'tone',
      owner: 'fixture',
      bus: 'master',
      gain: 0.5,
      rate: 1,
      offsetFrames: 0,
      durationFrames: 480,
      overlap: 'allow',
      priority: 0,
    }],
    timelineEvents: [{
      id: 'pulse-at-10ms',
      clock: 'composition',
      time: 0.01,
      sequence: 0,
      cue: 'pulse',
      operation: 'start',
    }],
  });
  const context = new OfflineAudioContext(1, 2_400, sampleRate);
  const backend = new WebAudioBackend(context, { kind: 'offline' });
  const runtime = new AudioEventRuntime(document, backend);
  await runtime.prepare();
  await runtime.advance({ composition: 0, state: 0, event: 0 });
  progress.textContent = 'rendering';
  const rendered = await context.startRendering();
  const channel = rendered.getChannelData(0);
  const nonZero = [];
  for (let index = 0; index < channel.length; index++) {
    if (Math.abs(channel[index]) > 0.01) nonZero.push(index);
  }
  const schedule = runtime.trace.find(entry => entry.kind === 'scheduled');
  const evidence = {
    schema: 'haiyue-audio-offline-evidence@1',
    sampleRate,
    scheduledFrame: schedule?.frame ?? null,
    scheduledOffsetFrame: schedule?.offsetFrame ?? null,
    firstNonZeroFrame: nonZero[0] ?? null,
    lastNonZeroFrame: nonZero.at(-1) ?? null,
    peak: Math.max(...channel.map(Math.abs)),
    trace: runtime.trace,
    diagnostics: runtime.diagnostics,
    backendResidualBeforeDispose: backend.stats.scheduledNodes,
  };
  runtime.dispose();
  evidence.ownerResidual = {
    voices: runtime.stats.voices,
    decodedCache: runtime.assets.stats.cacheEntries,
    backendNodes: backend.stats.scheduledNodes,
  };
  if (evidence.scheduledFrame !== 480
    || evidence.scheduledOffsetFrame !== 0
    || evidence.firstNonZeroFrame !== 480
    || evidence.lastNonZeroFrame !== 959
    || evidence.peak < 0.12
    || Object.values(evidence.ownerResidual).some(value => value !== 0)) {
    throw new Error(`offline audio evidence mismatch: ${JSON.stringify(evidence)}`);
  }
  progress.textContent = 'complete';
  resultNode.dataset.status = 'passed';
  resultNode.textContent = JSON.stringify(evidence);
} catch (error) {
  resultNode.dataset.status = 'failed';
  resultNode.textContent = JSON.stringify({
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
}

function makePcm16Wav(sampleRate, frameLength, value) {
  const bytes = new ArrayBuffer(44 + frameLength * 2);
  const view = new DataView(bytes);
  text(view, 0, 'RIFF');
  view.setUint32(4, 36 + frameLength * 2, true);
  text(view, 8, 'WAVE');
  text(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(view, 36, 'data');
  view.setUint32(40, frameLength * 2, true);
  const sample = Math.round(value * 0x7fff);
  for (let index = 0; index < frameLength; index++) view.setInt16(44 + index * 2, sample, true);
  return bytes;
}

function text(view, offset, value) {
  for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
