export const AUDIO_BYTES = Uint8Array.from([1, 2, 3, 4]);
export const AUDIO_DIGEST = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';

export function audioEventFixture() {
  const resource = (id, source) => ({
    id,
    codec: 'wav',
    mediaType: 'audio/wav',
    integrity: { algorithm: 'sha256', digest: AUDIO_DIGEST },
    sampleRate: 48_000,
    channels: 1,
    frameLength: 4_800,
    source,
  });
  return {
    format: 'haiyue-audio-events',
    version: 1,
    extension: 'org.haiyue.audio-events@1',
    playbackProfile: 'sample-accurate',
    clock: {
      sampleRate: 48_000,
      lookAheadFrames: 4_800,
      driftToleranceFrames: 64,
      driftPolicy: 'resync',
      lateDecodePolicy: 'catch-up',
      visibilityPolicy: 'pause-resume',
      suspendedPolicy: 'queue-until-resume',
    },
    browser: { autoplay: 'attempt' },
    limits: {
      maxVoices: 4,
      maxVoicesPerResource: 3,
      maxDecodeJobs: 4,
      maxEventTokens: 128,
      maxDecodedFrames: 100_000,
      maxDecodedBytes: 1_000_000,
    },
    voiceStealing: 'steal-oldest',
    resources: [
      resource('embedded-tone', { kind: 'embedded', data: 'AQIDBA==' }),
      resource('referenced-tone', { kind: 'referenced', uri: './tone.wav' }),
      resource('hosted-tone', { kind: 'hosted', key: 'project/tone' }),
    ],
    buses: [
      { id: 'master', gain: 1 },
      { id: 'sfx', parent: 'master', gain: 0.5 },
      { id: 'music', parent: 'master', gain: 0.8 },
    ],
    cues: [
      {
        id: 'blip', resource: 'embedded-tone', owner: 'button', bus: 'sfx',
        gain: 0.8, rate: 1, offsetFrames: 0, durationFrames: 2_400,
        overlap: 'allow', priority: 10,
      },
      {
        id: 'loop', resource: 'embedded-tone', owner: 'state-a', bus: 'music',
        gain: 0.5, rate: 1, offsetFrames: 100,
        loop: { startFrame: 100, endFrame: 1_100, iterations: 'infinite' },
        overlap: 'restart', priority: 5,
      },
      {
        id: 'remote', resource: 'referenced-tone', owner: 'listener', bus: 'sfx',
        gain: 1, rate: 2, offsetFrames: 0, durationFrames: 1_200,
        overlap: 'ignore', priority: 1,
      },
    ],
    timelineEvents: [
      { id: 'composition-start', clock: 'composition', time: 0.01, sequence: 0, cue: 'blip', operation: 'start' },
      { id: 'composition-stop', clock: 'composition', time: 0.04, sequence: 1, cue: 'blip', operation: 'stop' },
      { id: 'state-loop', clock: 'state', time: 0, sequence: 0, cue: 'loop', operation: 'start' },
      { id: 'event-remote', clock: 'event', time: 0.02, sequence: 0, cue: 'remote', operation: 'start' },
    ],
  };
}

export class FakeAudioBackend {
  profile = 'sample-accurate';
  kind = 'offline';
  sampleRate = 48_000;
  state = 'running';
  frame = 0;
  decodeCalls = [];
  schedules = [];
  stops = [];
  gainChanges = [];
  rateChanges = [];
  released = 0;
  disposed = 0;
  resumeCalls = 0;
  suspendCalls = 0;
  resumeError = null;
  decodeGate = null;

  currentFrame() { return this.frame; }

  async decode(request, signal) {
    this.decodeCalls.push(request.resource.id);
    if (this.decodeGate) await this.decodeGate.wait(signal);
    let released = false;
    return {
      sampleRate: request.resource.sampleRate,
      channels: request.resource.channels,
      frameLength: request.resource.frameLength,
      payload: { resource: request.resource.id },
      release: () => {
        if (released) return;
        released = true;
        this.released++;
      },
    };
  }

  schedule(request) {
    const record = { ...request, ended: false, disposed: false };
    this.schedules.push(record);
    return {
      voiceId: request.voiceId,
      stop: frame => {
        if (record.ended) return;
        this.stops.push([request.voiceId, frame]);
        record.ended = true;
        request.onEnded();
      },
      setGain: (gain, frame) => this.gainChanges.push([request.voiceId, gain, frame]),
      setRate: (rate, frame) => this.rateChanges.push([request.voiceId, rate, frame]),
      dispose: () => {
        if (record.disposed) return;
        record.disposed = true;
        if (!record.ended) {
          record.ended = true;
          request.onEnded();
        }
      },
    };
  }

  end(voiceId) {
    const record = this.schedules.find(entry => entry.voiceId === voiceId);
    if (record && !record.ended) {
      record.ended = true;
      record.onEnded();
    }
  }

  async resume() {
    this.resumeCalls++;
    if (this.resumeError) throw this.resumeError;
    this.state = 'running';
  }

  async suspend() {
    this.suspendCalls++;
    this.state = 'suspended';
  }

  dispose() { this.disposed++; this.state = 'closed'; }
}

export function audioResolver(bytes = AUDIO_BYTES) {
  return {
    requests: [],
    disposed: 0,
    async resolve(request, signal) {
      this.requests.push(request.resource.id);
      if (signal.aborted) throw new Error('aborted');
      return bytes.slice();
    },
    dispose() { this.disposed++; },
  };
}

export function deferredGate() {
  const waits = [];
  return {
    waits,
    wait(signal) {
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal };
        waits.push(entry);
      });
    },
    resolve(index = 0) { waits[index]?.resolve(); },
    reject(error, index = 0) { waits[index]?.reject(error); },
  };
}

export async function loadG08Modules() {
  const [specRoot, runtimeRoot] = await Promise.all([
    transpileRoot('audio-spec', new URL('../../animation-spec/src/audio/', import.meta.url)),
    transpileRoot('audio-runtime', new URL('../src/animation/audio/', import.meta.url)),
  ]);
  const [audio, runtime] = await Promise.all([
    import(new URL('audio-spec/index.js', specRoot).href),
    import(new URL('audio-runtime/index.js', runtimeRoot).href),
  ]);
  return { audio, runtime };
}

async function transpileRoot(name, sourceUrl) {
  const { mkdtemp, mkdir, readFile, readdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ts = await import('typescript');
  const temporary = await mkdtemp(path.join(tmpdir(), 'haiyue-g08-'));
  const sourceRoot = fileURLToPath(sourceUrl);
  for (const file of (await walk(sourceRoot, readdir, path)).filter(file => file.endsWith('.ts'))) {
    const output = path.join(temporary, name, path.relative(sourceRoot, file).replace(/\.ts$/, '.js'));
    await mkdir(path.dirname(output), { recursive: true });
    const compiled = ts.transpileModule(await readFile(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText;
    await writeFile(output, compiled);
  }
  return new URL(`file:///${temporary.replaceAll('\\', '/')}/`);
}

async function walk(directory, readdir, path) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(resolved, readdir, path));
    else result.push(resolved);
  }
  return result;
}
