import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { NarrativeRuntime, connectNarrativeActions } from '@haiyue/extensions/narrative';
register('../../scripts/fixtures/visual-novel-stage/source-loader.mjs', import.meta.url);
const { VisualNovelStage } = await import('../src/visual-novel/stage/VisualNovelStage.ts');
const { stageActionHandler } = await import('../src/visual-novel/stage/narrative-stage.ts');

const tick = () => new Promise(resolve => setImmediate(resolve));
const slot = (id, order, assetId = id) => ({ id, assetId, order, bounds: [0, 0, 100, 80] });
const show = (...slots) => ({ op: 'show', presetId: 'shot', slots });
const event = (slotId, name) => ({ op: 'wait', wait: { kind: 'event', slotId, event: name } });
const duration = seconds => ({ op: 'wait', wait: { kind: 'duration', seconds } });
const cueTransition = (slotId, decorative = true) => ({ op: 'transition', slotId, transitionId: 'arrive', seconds: .2, decorative });
const definition = {
  schemaVersion: 1, id: 'stage-fixture', version: '1', start: 'cue', variables: {},
  nodes: {
    cue: { type: 'action', name: 'visualNovel.stage', next: 'done' },
    done: { type: 'end', ending: 'done', textKey: 'end' },
  },
};

function harness(t, config = {}) {
  let sequence = 0, activeLease = 0, activeLoads = 0, peakLoads = 0;
  const players = [], records = [], errors = [];
  const stage = new VisualNovelStage({
    prepareTimeoutMs: 2000, waitTimeoutSeconds: 1, onError: error => errors.push(error),
    ...config.options,
    port: {
      async acquire(spec, signal) {
        activeLoads++;
        peakLoads = Math.max(peakLoads, activeLoads);
        try {
          await config.load?.(spec, signal);
          activeLease++;
          records.push(['lease', spec.id]);
          return {
            value: {
              source: {}, bytes: 10, designSize: [100, 80],
              transitions: { arrive: { fromTime: 0, toTime: .25, stateId: 'arrived' } }, states: { arrived: { time: .25, data: { calm: true } } },
              ...config.asset?.(spec),
            },
            release() { activeLease--; records.push(['release', spec.id]); },
          };
        } finally { activeLoads--; }
      },
      async create(_asset, spec, generation, _signal, fail) {
        let time = 0, internal = 0;
        const live = {
          spec, generation, visible: false, disposed: false, requests: [], emitted: [], data: {},
          fail, next: null, invalidated: false,
          advance(request) {
            this.requests.push(request);
            if (config.ready?.(spec, request) === false) return this.frame([], false);
            time += request.deltaSeconds;
            internal++;
            const name = this.next;
            this.next = null;
            if (name) this.emitted.push(name);
            return this.frame(name ? [{ id: 'signal', part: 'state', instance: 'machine', sequence: internal, time, target: 'slot', kind: name }] : []);
          },
          frame(events, ready = true) { return { time, sequence: internal, generation, ready, events }; },
          seek(value) { time = value; internal++; records.push(['seek', spec.id, value]); return this.frame([]); },
          configure(data) { this.data = data; },
          resize(view) { return view.viewport; },
          takeInvalidation() { const result = this.invalidated; this.invalidated = false; return result; },
          setVisible(visible) { this.visible = visible; records.push([visible ? 'show' : 'hide', spec.id, generation]); },
          dispose() { this.disposed = true; records.push(['dispose', spec.id, generation]); },
        };
        players.push(live);
        records.push(['create', spec.id, generation]);
        return live;
      },
    },
  });
  t.after(() => stage.dispose());
  const frame = (deltaSeconds = .05, viewport = [320, 200], dpr = 1) => stage.frame({ sequence: ++sequence, deltaSeconds, viewport, dpr });
  const step = async () => { await tick(); frame(); };
  const wait = async (predicate, label = 'stage predicate') => {
    for (let index = 0; index < 50; index++) {
      if (predicate()) return;
      await step();
    }
    assert.fail(`Timed out waiting for ${label}`);
  };
  const flush = async promise => {
    let result, failure, settled = false;
    void promise.then(value => { result = value; settled = true; }, error => { failure = error; settled = true; });
    await wait(() => settled);
    if (failure) throw failure;
    return result;
  };
  const run = (actionId, cues, options = {}) => stage.run({ sessionId: 'play', actionId, cues, ...options });
  return { stage, players, records, errors, frame, wait, flush, run, active: () => activeLease, peak: () => peakLoads };
}

test('first frame and ordered suffix swap keep the committed shot visible until every candidate is ready', async t => {
  let ready = true;
  const h = harness(t, { ready: spec => spec.assetId !== 'right-new' || ready });
  const background = slot('background', 0), left = slot('left', 1), right = slot('right', 2), effect = slot('effect', 3);
  await h.flush(h.run(1, [[show(effect, right, left, background)]]));
  assert.deepEqual(h.players.map(p => p.spec.id), ['background', 'left', 'right', 'effect']);
  ready = false;
  const next = h.run(2, [[show(slot('right', 2, 'right-new'))]]);
  await h.wait(() => h.players.length === 6 && h.players[4].requests.length > 0);
  h.frame();
  assert.deepEqual(h.players[4].requests[0], h.players[4].requests[1]);
  assert.equal(h.stage.waiting.kind, 'resources');
  assert.deepEqual(h.stage.snapshot.map(spec => spec.assetId), ['background', 'left', 'right', 'effect']);
  assert.deepEqual(h.players.map(p => p.visible), [true,true,true,true,false,false]);
  ready = true;
  await h.flush(next);
  assert.deepEqual(h.players.map(p => p.visible), [true,true,false,false,true,true]);
  assert.ok(h.players[2].disposed && h.players[3].disposed);
  assert.equal(h.active(), 4);
  assert.equal(h.stage.snapshot[2].assetId, 'right-new');
  assert.deepEqual(h.records.filter(([name]) => name === 'create').slice(-2).map(([, id]) => id), ['right', 'effect']);
});

test('a failed new asset or failed prepared player preserves the preceding committed shot', async t => {
  const h = harness(t, { load: async spec => { if (spec.assetId === 'missing') throw Error('missing fixture'); } });
  await h.flush(h.run(1, [[show(slot('background', 0))]]));
  const failed = h.run(2, [[show(slot('bad', 1, 'missing'), slot('good', 2))]]);
  await assert.rejects(h.flush(failed), /missing fixture/);
  assert.equal(h.active(), 1);
  const badOwner = h.run(2, [[show(slot('bad', 1), slot('good', 2))]]);
  const rejected = assert.rejects(badOwner, /invalid HYA/);
  while (h.players.length < 3) await tick();
  h.players.at(-1).fail(Error('invalid HYA'));
  h.frame();
  await rejected;
  assert.equal(h.stage.snapshot[0].id, 'background');
  assert.deepEqual(h.players.map(p => p.disposed), [false, true, true]);
  assert.equal(h.active(), 1);
});

test('fast replacement, cancellation and disposal retire late resolutions under one concurrency budget', async t => {
  const blocked = Promise.withResolvers();
  const h = harness(t, { options: { concurrency: 1 }, load: spec => spec.assetId === 'blocked' ? blocked.promise : tick() });
  const old = h.run(1, [[show(slot('first', 0, 'blocked'))]]);
  const oldRejected = assert.rejects(old, { code: 'E_SCENE_FLOW_SUPERSEDED' });
  await tick();
  const newest = h.run(2, [[show(slot('newest', 0))]]);
  await oldRejected;
  assert.equal(h.peak(), 1);
  assert.equal(h.stage.snapshot.length, 0);
  blocked.resolve();
  await h.flush(newest);
  assert.deepEqual(h.stage.snapshot.map(value => value.id), ['newest']);
  assert.equal(h.active(), 1);
  const controller = new AbortController();
  const cancel = h.run(3, [[duration(.5)]], { signal: controller.signal });
  const cancelled = assert.rejects(cancel, { code: 'E_SCENE_FLOW_ABORTED' });
  controller.abort();
  await cancelled;
  h.stage.dispose();
  assert.equal(h.active(), 0);
  assert.deepEqual(h.records.slice(-2).map(([name]) => name), ['dispose', 'release']);
});

test('wait routes only a fresh event from the bound slot and completes a narrative action once', async t => {
  const h = harness(t);
  await h.flush(h.run(1, [[show(slot('left', 0), slot('right', 1))]]));
  const runtime = new NarrativeRuntime(definition);
  t.after(() => runtime.dispose());
  const cues = { cue: [[event('right', 'ready'), event('right', 'ready'), duration(.15)]] };
  const connection = connectNarrativeActions(runtime, { 'visualNovel.stage': stageActionHandler(runtime, h.stage, cues, () => false) });
  t.after(() => connection.dispose());
  runtime.start('story-run');
  await h.wait(() => h.stage.waiting?.kind === 'cues');
  h.players[0].next = 'ready';
  h.frame(.05);
  assert.deepEqual(h.stage.waiting.events, [{ slotId: 'right', name: 'ready' }]);
  h.players[1].next = 'ready';
  h.frame(.05);
  assert.deepEqual(h.stage.waiting.events, []);
  assert.equal(runtime.view.nodeId, 'cue');
  h.players[1].next = 'ready';
  await h.wait(() => runtime.view.nodeId === 'done');
  const revision = runtime.view.revision;
  h.frame();
  assert.equal(runtime.view.revision, revision);
});

test('a newly armed wait ignores events before the barrier and stale generations after replacement', async t => {
  const h = harness(t);
  await h.flush(h.run(1, [[show(slot('actor', 0))]]));
  const first = h.players[0];
  first.next = 'ready';
  const wait = h.run(2, [[show(slot('actor', 0, 'actor-new')), event('actor', 'ready')]]);
  await h.wait(() => h.stage.waiting?.kind === 'cues');
  assert.equal(first.emitted.length, 1);
  assert.equal(first.disposed, true);
  assert.ok(h.stage.waiting.events.length);
  h.players.at(-1).next = 'ready';
  await h.flush(wait);
  assert.equal(h.stage.waiting, null);
});

test('normal and reduced transitions converge, required waits survive skip, and state parameters reach the Player', async t => {
  const times = [];
  for (const reducedMotion of [false, true]) {
    const h = harness(t, { asset: () => ({ playback: { mode: 'hold' } }) });
    await h.flush(h.run(1, [[show(slot('actor', 0))]]));
    await h.flush(h.run(2, [[cueTransition('actor'), duration(.1)]], { reducedMotion }));
    times.push(h.stage.snapshot[0].time);
    assert.deepEqual(h.players.at(-1).data, { calm: true });
    assert.equal(h.stage.snapshot[0].stateId, 'arrived');
    await h.flush(h.run(3, [[{ op: 'state', slotId: 'actor', stateId: 'arrived' }]]));
    const pending = h.run(4, [[cueTransition('actor'), event('actor', 'ready')]], { reducedMotion });
    await h.wait(() => h.stage.waiting?.kind === 'cues');
    assert.equal(h.stage.snapshot[0].time, 0);
    h.stage.skipDecorations();
    h.frame();
    assert.ok(h.stage.waiting.events.length);
    h.players.at(-1).next = 'ready';
    await h.flush(pending);
  }
  assert.deepEqual(times, [.25, .25]);
});

test('recorded poses restore silently and remain fitted on viewport changes', async t => {
  const h = harness(t, { asset: () => ({ playback: { mode: 'hold' } }) });
  await h.flush(h.stage.restore('save', [{ ...slot('actor', 0), time: .31, stateId: 'arrived' }]));
  assert.equal(h.stage.snapshot[0].time, .31);
  assert.deepEqual(h.players[0].data, { calm: true });
  assert.deepEqual(h.players[0].emitted, []);
  h.frame(.05, [640, 400], 2);
  assert.deepEqual(h.players[0].requests.at(-1).viewport, [640, 400]);
  assert.equal(h.players[0].requests.at(-1).dpr, 2);
  assert.equal(h.stage.snapshot[0].time, .31);
  for (let index = 0; index < 12; index++) await h.flush(h.stage.restore('save', [{ ...slot('actor', 0), time: .31 }]));
  assert.equal(h.active(), 1);
  assert.equal(h.players.filter(p => !p.disposed).length, 1);
});

test('preload enforces retained byte budget, defers player creation and releases on promotion', async t => {
  const h = harness(t, { options: { concurrency: 2, maxPreloadBytes: 15 }, load: () => tick() });
  const largerShot = Array.from({ length: 9 }, (_, index) => slot('source-' + index, index));
  await assert.rejects(h.stage.preload(largerShot), /distinct sources/);
  await assert.rejects(h.stage.preload([slot('one', 0), slot('two', 1)]), /source byte budget/);
  assert.equal(h.active(), 0);
  assert.equal(h.peak(), 2);
  assert.deepEqual(await h.stage.preload([slot('one', 0), slot('one-copy', 1, 'one')]), { count: 1, bytes: 10 });
  assert.equal(h.players.length, 0);
  await h.flush(h.run(1, [[show(slot('one', 0))]]));
  assert.equal(h.active(), 1);
  assert.equal(h.players.length, 1);
  await h.flush(h.stage.restore('large-logical-shot', largerShot));
  assert.equal(h.stage.snapshot.length, 9);
});

test('loop playback preserves frame remainder and one-shot playback retains its final pose', async t => {
  const h = harness(t, { asset: spec => ({ playback: { mode: spec.id === 'background' ? 'loop' : 'once', duration: .3 } }) });
  await h.flush(h.run(1, [[show(slot('background', 0), slot('effect', 1))]]));
  await h.flush(h.stage.restore('save', [{ ...slot('background', 0), time: .25 }, { ...slot('effect', 1), time: .25 }]));
  const before = h.stage.snapshot[0].time;
  assert.ok(before >= .25 && before <= .3);
  h.frame(.12);
  assert.ok(Math.abs(h.stage.snapshot[0].time - ((before + .12) % .3)) < 1e-8);
  assert.equal(h.stage.snapshot[1].time, .3);
});

test('unresolved waits reject finitely and a repeated action identity shares its pending work', async t => {
  const h = harness(t, { options: { waitTimeoutSeconds: .1 } });
  await h.flush(h.run(1, [[show(slot('actor', 0))]]));
  const pending = h.run(2, [[event('actor', 'never')]]);
  assert.strictEqual(h.run(2, [[event('actor', 'never')]]), pending);
  const rejected = assert.rejects(pending, /Stage event wait expired/);
  await h.wait(() => h.stage.waiting === null);
  await rejected;
  assert.equal(h.active(), 1);
  await h.flush(h.run(2, [[duration(0)]]));
  assert.deepEqual(await h.run(2, []), { sessionId: 'play', actionId: 2 });
});
