const result = document.querySelector('#result');
const progress = document.querySelector('#progress');
const frame = document.querySelector('iframe');
const edited = new URLSearchParams(location.search).get('edited') === 'true';
const proof = {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(condition, message) { if (!condition) throw new Error(message); }
async function until(label, predicate, timeout = 16_000) {
  progress.textContent = label;
  const end = performance.now() + timeout;
  do {
    const value = predicate();
    if (value) return value;
    await sleep(30);
  } while (performance.now() < end);
  throw new Error(label + ' timed out. State ' + JSON.stringify({
    notice: frame.contentDocument?.getElementById('notice')?.textContent,
    node: app?.session?.view.reading?.nodeId, slots: app?.session?.view.slots, audio: app?.mixer.stats,
  }));
}
let app;
const gains = [];
const voiceSources = [];
const gpuErrors = [];
const $ = id => frame.contentDocument.getElementById(id);
const view = () => app.session.view;
const node = id => until(id, () => view().reading?.nodeId === id);
const still = id => until(id + ' ready', () => !$(id).disabled);
async function click(id) { await still(id); $(id).click(); }
function change(id, value) {
  $(id).value = value;
  $(id).dispatchEvent(new frame.contentWindow.Event('change', { bubbles: true }));
}
async function open() {
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
  frame.src = './index.html';
  await loaded;
  const win = frame.contentWindow;
  const proto = win.AudioParam.prototype;
  const setValue = proto.setValueAtTime;
  proto.setValueAtTime = function(value, ...args) {
    gains.push(value);
    return setValue.call(this, value, ...args);
  };
  const sourcePrototype = win.AudioBufferSourceNode.prototype;
  const startSource = sourcePrototype.start;
  sourcePrototype.start = function(...args) {
    if (!this.loop) voiceSources.push(this);
    return startSource.apply(this, args);
  };
  app = (await win.eval("import('./bundle.js')")).app;
  await app.ready;
  app.engine.device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
}
async function verifyHistorySuspension() {
  const win = frame.contentWindow, doc = frame.contentDocument;
  const source = voiceSources.at(-1);
  assert(source, 'History replay did not schedule a voice.');
  const { context } = source;
  const count = voiceSources.length;
  let focused = true;
  Object.defineProperty(doc, 'hasFocus', { configurable: true, value: () => focused });
  try {
    for (const event of ['focus', 'visibility']) {
      progress.textContent = 'suspend history during ' + event + ' loss';
      if (event === 'focus') {
        focused = false;
        win.dispatchEvent(new win.Event('blur'));
      } else {
        Object.defineProperty(doc, 'hidden', { configurable: true, value: true });
        doc.dispatchEvent(new win.Event('visibilitychange'));
      }
      await until('history audio suspended', () => context.state === 'suspended');
      const pausedAt = context.currentTime;
      await sleep(160);
      assert(context.currentTime === pausedAt, 'Audio advanced while the page was in the background.');
      assert(view().audio.voices === 2, 'Backgrounding stopped the history voice.');
      if (event === 'focus') {
        focused = true;
        win.dispatchEvent(new win.Event('focus'));
      } else {
        delete doc.hidden;
        doc.dispatchEvent(new win.Event('visibilitychange'));
      }
      await until('original history voice resumes', () => context.state === 'running' && context.currentTime > pausedAt + .03);
      assert(view().audio.voices === 2 && voiceSources.length === count && voiceSources.at(-1) === source,
        'Returning failed to continue the same voice.');
    }
    proof.historyForeground = { focus: true, visibility: true, sameSource: true };
  } finally {
    delete doc.hasFocus;
    delete doc.hidden;
  }
}
const snapshotStorage = () => JSON.stringify(Object.entries(frame.contentWindow.localStorage).sort());
async function choice(option) {
  await node('arrival/fork');
  const button = await until('choose ' + option, () => {
    const target = $('choices').querySelector('[data-option="' + option + '"]');
    return target && !target.disabled && target;
  });
  button.click();
  await node('pier/story');
}
async function finish(option, ending, signal = 'signal') {
  await choice(option);
  const keeper = view().slots.find(slot => slot.id === 'keeper');
  assert(keeper.bounds[0] === (edited ? 255 : 155), 'Preset did not apply to the second chapter.');
  await click('advance');
  await until('render animated effect', () => view().slots.find(slot => slot.assetId === signal && slot.time > .05));
  if (!edited) {
    await node('ending/' + ending);
    await click('advance');
  }
  await node('ending/' + ending + (edited ? '' : '-end'));
  return view().reading.text;
}
async function verify() {
  await open();
  assert(!app.session.listReplays().length, 'A replay was unlocked before playing.');
  await click('new');
  await node('arrival/watch');
  const before = view().slots;
  assert(before.map(slot => slot.id).join(',') === 'background,keeper,traveler,weather', 'Expected four ordered layers.');
  const moving = await until('all four HYA motions advance', () => {
    const after = view().slots;
    return before.every((slot, index) => after[index]?.id === slot.id &&
      Math.abs(after[index].time - slot.time) > .02) && after;
  });
  proof.layers = moving.map(slot => ({ id: slot.id, assetId: slot.assetId, time: slot.time, bounds: slot.bounds }));
  if (edited) {
    $('immediate').click();
    await click('advance');
    proof.editedEnding = await finish('signal', 'relight', 'gold-signal');
    assert(proof.editedEnding.includes('双灯引航'), 'Edited route missed the new localized ending.');
    return;
  }
  assert(view().reading.locale === 'zh-Hans', 'Default locale is not Chinese.');
  await until('live dialogue and BGM', () => view().audio.voices === 2);
  await until('dialogue completes', () => view().audio.voices === 1);
  const startGain = gains.length;
  await click('voice');
  await until('history voice and BGM', () => view().audio.voices === 2);
  await verifyHistorySuspension();
  await until('history voice completes', () => view().audio.voices === 1);
  proof.voiceGainSequence = gains.slice(startGain);
  assert(proof.voiceGainSequence.some(value => Math.abs(value - .58 * .36) < 1e-5), 'History replay did not attenuate BGM.');
  assert(proof.voiceGainSequence.some(value => Math.abs(value - .58) < 1e-5), 'History replay did not restore BGM.');
  $('contrast').click();
  $('immediate').click();
  await click('advance');
  await node('arrival/fork');
  await click('save');
  await until('manual save committed', () => $('notice').textContent === '存档已保存');
  const beforeReload = snapshotStorage();
  await app.dispose();
  assert(app.mixer.stats.voices === 0 && app.mixer.stats.buffers === 0 && app.mixer.stats.audioNodes === 0,
    'Audio resources leaked during the first player teardown.');
  await open();
  assert(!view().reading && snapshotStorage().length >= beforeReload.length, 'Browser restart did not retain local storage.');
  await click('continue');
  await node('arrival/fork');
  assert(view().reading.preferences.highContrast && view().reading.preferences.textSpeed === 0, 'Reading preferences did not survive restart.');
  proof.continuedAt = view().reading.nodeId;
  proof.lantern = await finish('stay', 'lantern');
  await until('first replay unlocked', () => app.session.listReplays().includes('lantern-cg'));
  assert(!app.session.listReplays().includes('tide-cg'), 'The other replay unlocked prematurely.');
  await click('load');
  await node('arrival/fork');
  change('language', 'en');
  await until('English reading locale', () => view().reading.locale === 'en');
  proof.tide = await finish('leave', 'tide');
  await until('both endings unlocked', () => app.session.listReplays().length === 2);
  await click('load');
  await node('arrival/fork');
  const beforeReplay = snapshotStorage();
  const beforeReplaySlots = view().slots.map(slot => slot.id + ':' + slot.assetId).join();
  for (const id of ['lantern-cg', 'tide-cg']) {
    change('replays', id);
    await click('replay');
    await until(id + ' replay', () => view().replayId === id && view().reading?.nodeId === 'pier/story');
    await click('advance');
    await until(id + ' end', () => view().reading?.nodeId === 'ending/' + id.replace('-cg', ''));
    await click('advance');
    await until(id + ' final', () => view().reading?.kind === 'end');
    $('return').click();
    await node('arrival/fork');
    assert(!view().replayId && snapshotStorage() === beforeReplay, 'Replay wrote progress or changed persistent data.');
    assert(view().slots.map(slot => slot.id + ':' + slot.assetId).join() === beforeReplaySlots, 'Replay exit did not restore the original shot.');
  }
  proof.replays = app.session.listReplays();
  proof.replayExit = view().reading.nodeId;
  $('contrast').click();
}
try {
  await verify();
  await app.engine.device.queue.onSubmittedWorkDone();
  assert(gpuErrors.length === 0, gpuErrors.join('\n'));
  proof.gpuErrors = gpuErrors;
  const adapter = await navigator.gpu.requestAdapter();
  assert(adapter, 'The system did not expose a WebGPU adapter.');
  proof.gpu = { architecture: adapter.info.architecture, vendor: adapter.info.vendor, device: adapter.info.device };
  result.textContent = JSON.stringify(proof);
  result.dataset.status = 'passed';
} catch (failure) {
  result.textContent = JSON.stringify({ progress: progress.textContent, error: failure.stack ?? String(failure), proof });
  result.dataset.status = 'failed';
}
