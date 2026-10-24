import {AUDIO_BYTES} from './audio-event-parity-fixture.mjs';
import assert from 'node:assert/strict';

export function hostFixture() {
  const host = {
    profile: 'sample-accurate', sampleRate: 48000, state: 'running', frame: 0,
    requests: [], decoded: [], controls: [], released: 0, unlocks: 0, resolves: [],
    nowFrame() {return this.frame;},
    async unlock() {this.unlocks++; this.state = 'running';},
    async resolve(value, signal) {assert.equal(signal.aborted, false); this.resolves.push(value.id); return AUDIO_BYTES.slice();},
    async decode(value, signal, bytes) {
      assert.deepEqual(new Uint8Array(bytes), AUDIO_BYTES);
      const record = {resource: value.id, signal, released: 0}; this.decoded.push(record);
      if (this.gate) await this.gate;
      return {value: record, sampleRate: value.sampleRate, channels: value.channels, frames: value.frameLength,
        bytes: value.frameLength * value.channels * 4, release: () => {record.released++;}};
    },
    schedule(request) {
      this.requests.push(request);
      if (this.syncEnd) request.onEnded();
      if (this.throwSchedule) throw new Error('host schedule failed');
      let released = false;
      return {
        stop: frame => {this.controls.push(['stop', request.token, frame]); request.onEnded();},
        setGain: (value, frame) => this.controls.push(['gain', request.token, value, frame]),
        setRate: (value, frame) => this.controls.push(['rate', request.token, value, frame]),
        release: () => {assert.equal(released, false); released = true; this.released++; request.onEnded();},
      };
    },
  };
  return host;
}
