import { Entity, HaiyueEngine } from '@haiyue/engine';
import { GuiRoot } from '@haiyue/engine/gui';
import { RttEngine } from '@haiyue/engine/rtt';
import { OwnerSafeAudioMixer } from '@haiyue/engine/audio';
import { NarrativeRuntime } from '@haiyue/extensions/narrative';
import { I18n } from '@haiyue/extensions/i18n';
import { ReadingPlayback } from 'g04:read';
import { GuiReading } from 'g04:gui';
import { ReadingAudio } from 'g04:voice';
import { GameAudioRuntime } from 'g04:game-audio';

const stage = document.querySelector('#stage'), result = document.querySelector('#result');
stage.width = 540; stage.height = 450;
const background = { r: .05, g: .10, b: .18, a: 1 };
const fixture = '中文排版 e\u0301 👩‍👩‍👧‍👦 🇨🇳。晚潮涨起来了，守灯人正在等风停下来。';
const story = {
  schemaVersion: 1, id: 'g04-reading', version: '1', start: 'one', variables: {},
  nodes: {
    one: { type: 'dialogue', speakerKey: 'keeper', textKey: 'one', next: 'two' },
    two: { type: 'dialogue', textKey: 'two', next: 'stage' },
    stage: { type: 'action', name: 'visualNovel.stage', next: 'choice' },
    choice: { type: 'choice', textKey: 'choice', options: [
      { id: 'stay', textKey: 'stay', next: 'end' },
      { id: 'leave', textKey: 'leave', next: 'end' },
    ] },
    end: { type: 'end', textKey: 'end', ending: 'done' },
  },
};
const lines = { first: { nodeId: 'one', textKey: 'one', voices: { 'zh-Hans': 'zh-line', en: 'en-line' } } };
const cases = [], images = {}, errors = [];
let engine, target, scene, root, surface, environment, scoped = false, serial = 0;
const cleanups = [];
const pass = (id, fields = {}) => cases.push({ id, ...fields });
const check = (value, label) => { if (!value) throw Error(label); };
const descendants = root => [root, ...root.children.flatMap(descendants)];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const approx = (actual, expected) => Math.abs(actual - expected) < 1e-4;

function locale() {
  const i18n = new I18n({ locale: 'zh-Hans', fallbackLocale: 'en' });
  i18n.register({ schemaVersion: 1, locale: 'zh-Hans', messages: {
    one: fixture, keeper: '守灯人', two: '雨停了。', choice: '选择前路', stay: '沿着亮起路灯的小径，回到港口接过守灯人的工作。', leave: '登船离开', end: '结局',
  } });
  i18n.register({ schemaVersion: 1, locale: 'en', messages: {
    one: 'A lamp lights the harbor.', keeper: 'Lightkeeper', two: 'The rain stops.', choice: 'Choose a path',
    stay: 'Take the well-lit path and return to the harbor to help the lightkeeper.', leave: 'Board the last boat', end: 'End',
  } });
  cleanups.push(() => i18n.dispose());
  return i18n;
}

const frame = () => scene.update(++serial * 16, 0);
const currentTextRows = () => descendants(surface.panel).filter(child => /:line:\d+$/u.test(child.id));
const key = (type, value, repeat = false) => stage.dispatchEvent(new KeyboardEvent(type, { key: value, code: value, bubbles: true, cancelable: true, repeat }));
const press = code => { key('keydown', code); key('keyup', code); };
function click(element) {
  const rect = stage.getBoundingClientRect(), targetBox = element.rect;
  const pointer = { clientX: rect.left + targetBox.x + targetBox.width / 2, clientY: rect.top + targetBox.y + targetBox.height / 2,
    pointerId: 20, pointerType: 'mouse', button: 0, bubbles: true, cancelable: true };
  stage.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
  stage.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
}
async function pixels() {
  const stride = Math.ceil(target.width * 4 / 256) * 256;
  const buffer = engine.device.createBuffer({ size: stride * target.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const encoder = engine.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target.colorTexture }, { buffer, bytesPerRow: stride }, [target.width, target.height]);
    engine.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const value = new Uint8Array(buffer.getMappedRange()), tight = new Uint8ClampedArray(target.width * target.height * 4);
    for (let y = 0; y < target.height; y++) tight.set(value.subarray(y * stride, y * stride + target.width * 4), y * target.width * 4);
    buffer.unmap();
    if (target.colorTexture.format.startsWith('bgra')) for (let i = 0; i < tight.length; i += 4) [tight[i],tight[i + 2]] = [tight[i + 2],tight[i]];
    return tight;
  } finally { buffer.destroy(); }
}
function image(bytes) {
  const mirror = document.createElement('canvas');
  mirror.width = target.width; mirror.height = target.height;
  mirror.getContext('2d').putImageData(new ImageData(bytes, target.width, target.height), 0, 0);
  return mirror.toDataURL('image/png').split(',')[1];
}
function patch(bytes, box) {
  const left = Math.max(0, Math.ceil(box.x)), right = Math.min(target.width, Math.floor(box.x + box.width));
  const top = Math.max(0, Math.ceil(box.y)), bottom = Math.min(target.height, Math.floor(box.y + box.height));
  const data = [];
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const i = (y * target.width + x) * 4;
    data.push(...bytes.subarray(i, i + 4));
  }
  return data;
}

async function nativeUi() {
  const runtime = new NarrativeRuntime(story), i18n = locale(), marks = new Set();
  const playback = new ReadingPlayback({ runtime, i18n, lines, read: marks, minReadMs: 80 });
  cleanups.push(() => { playback.dispose(); runtime.dispose(); });
  playback.setPreferences({ textSpeed: 2 });
  runtime.start('native-reading');
  surface = new GuiReading({ root, gui: scene.guiSystem, playback, document });
  cleanups.push(() => surface.dispose());
  surface.setInsets({ left: 14, top: 18, right: 21, bottom: 24 });
  frame();
  stage.focus();
  frame();
  scene.guiSystem.focus.focus(surface.controls.continue);
  const geometry = currentTextRows().map(label => ({ ...label.rect }));
  const untouched = await pixels();
  playback.tick(500);
  frame();
  check(currentTextRows()[0].text === '中', 'Unexpected first grapheme');
  const partial = await pixels();
  const crop = { ...geometry[0], width: 9 };
  const before = patch(untouched, crop), one = patch(partial, crop);
  check(!same(before,one) && one.length > 0, 'First Unicode glyph did not render');
  const originalRevision = runtime.view.revision;
  key('keydown','Enter');
  for (let i = 0; i < 12; i++) key('keydown','Enter',true);
  frame();
  check(runtime.view.revision === originalRevision && playback.view.visible === playback.view.offsets.length - 1, 'Held confirm advanced or did not finish revealing');
  const shown = await pixels();
  check(same(geometry,currentTextRows().map(label => label.rect)), 'Reveal moved a line rectangle');
  check(same(one, patch(shown,crop)), 'Revealing later glyphs changed the already committed fragment');
  check(currentTextRows().map(label => label.text).join('').trim() === fixture, 'Actual GuiLabel text missing Unicode clusters');
  images['dialogue-complete'] = image(shown);
  pass('native-glyphs-fixed-line-raster-and-held-confirm', { rows: geometry.length, codeUnits: fixture.length,
    graphemes: playback.view.visible, heldRepeats: 12, repeatedActionCount: runtime.view.revision - originalRevision });
  key('keyup','Enter'); press('Enter'); frame();
  check(runtime.view.nodeId === 'two', 'Second confirm did not advance one line');

  click(surface.controls.history); frame();
  check(scene.guiSystem.focus.modal === surface.historyMenu, `Pointer did not open history; ${JSON.stringify(surface.controls.history.rect)}`);
  const blockedRevision = runtime.view.revision;
  playback.tick(3000);
  check(blockedRevision === runtime.view.revision, 'Modal allowed story to advance');
  press('Escape'); frame();
  check(scene.guiSystem.focus.focused === surface.controls.history, 'Escape did not return focus to history opener');
  click(surface.controls.settings); frame();
  check(scene.guiSystem.focus.modal === surface.settingsMenu, 'Pointer did not open settings');
  const contrast = descendants(surface.settingsMenu).find(child => child.id.endsWith(':contrast'));
  click(contrast); frame();
  check(playback.view.preferences.highContrast && surface.panel.style.backgroundColor === '#000000', 'High contrast did not use reading theme');
  press('Escape'); frame();
  check(scene.guiSystem.focus.focused === surface.controls.settings, 'Settings did not return focus');
  pass('native-pointer-modal-consumption-and-keyboard-focus-return', { opener: scene.guiSystem.focus.focused.id });

  playback.setPreferences({ textSpeed: 0, fontScale: 2, reducedMotion: true });
  runtime.advance(); frame();
  check(playback.view.kind === 'action', 'Mandatory cue was skipped');
  playback.tick(2000);
  check(runtime.view.nodeId === 'stage', 'Manual host boundary advanced itself');
  runtime.completeAction(runtime.view.action.id);
  target.resize(344,440); scene.renderView.target = target.renderTarget;
  stage.width = 344; stage.height = 440;
  frame();
  const choice = descendants(surface.panel).find(child => child.id.endsWith('choice:stay'));
  scene.guiSystem.focus.focus(choice);
  check(choice.children.length > 1, 'Large CJK option did not wrap');
  check(surface.panel.rect.x === 14 && surface.panel.rect.y + surface.panel.rect.height === 416, 'Reading panel violated safe area');
  await i18n.setLocale('en'); frame();
  check(scene.guiSystem.focus.focused === choice && choice.children.map(label => label.text).join('').trim() ===
    'Take the well-lit path and return to the harbor to help the lightkeeper.', 'Locale switch dropped option focus or content');
  images['narrow-choice'] = image(await pixels());
  pass('native-narrow-large-text-safe-area-and-locale-focus', { panel: surface.panel.rect, optionRows: choice.children.length, locale: playback.view.locale });
  press('Enter'); frame();
  check(runtime.view.ending === 'done', 'Focused choice did not invoke NarrativeRuntime');
  pass('native-choice-and-required-stage-boundary', { ending: runtime.view.ending });
  playback.dispose(); runtime.dispose();
}

async function nativeHistory() {
  const runtime = new NarrativeRuntime({ ...story, nodes: { one: { ...story.nodes.one, next: 'one' } } });
  const i18n = locale();
  const playback = new ReadingPlayback({ runtime, i18n, lines, maxHistory: 10000 });
  cleanups.push(() => { playback.dispose(); runtime.dispose(); });
  playback.setPreferences({ textSpeed: 0 });
  runtime.start('long-history');
  for (let i = 0; i < 12000; i++) runtime.advance();
  surface = new GuiReading({ root, gui: scene.guiSystem, playback });
  const historySurface = surface;
  cleanups.push(() => historySurface.dispose());
  frame();
  const start = performance.now();
  surface.openHistory(); frame();
  const openMs = performance.now() - start;
  const tail = surface.historyList.stats;
  check(tail.logicalItems === 10000 && tail.rowInstances <= 9, 'History built more than a bounded GUI row pool');
  surface.historyList.setScrollOffset(0); frame();
  const head = surface.historyList.stats;
  check(head.first === 0 && head.rowInstances <= 9 && tail.first > 9900, 'History did not realize head and tail with the same viewport window');
  images['virtual-history'] = image(await pixels());
  press('Escape'); frame();
  playback.setPreferences({ fontScale: 2, highContrast: true });
  surface.openHistory(); frame();
  const restyled = descendants(surface.historyList.element).filter(element => typeof element.text === 'string' && element.text.length > 0);
  check(restyled.length > 0 && restyled.every(element => element.style.fontSize === 18 && element.style.color === '#ffffff'),
    'Reopened history did not reuse the current text size and contrast');
  pass('native-virtual-history-window', { seeded: 12001, retained: 10000, tail, head, openMs, restyled: restyled.length });
  playback.dispose(); runtime.dispose();
}

async function nativeAudio() {
  const context = new AudioContext(), gains = [], gainWrites = [];
  const clockSource = context.createConstantSource();
  clockSource.offset.value = 0;
  clockSource.connect(context.destination);
  clockSource.start();
  const createGain = context.createGain.bind(context);
  context.createGain = () => {
    const node = createGain(), param = node.gain, set = param.setValueAtTime.bind(param), writes = [];
    param.setValueAtTime = (value, time) => { writes.push([value, time]); return set(value, time); };
    gains.push(param); gainWrites.push(writes);
    return node;
  };
  const scheduled = index => gainWrites.at(index)?.at(-1)?.[0];
  const matches = async (expected, label) => {
    const until = performance.now() + 2000;
    while (!expected.every(([index, target]) => approx(gains.at(index)?.value, target)) && performance.now() < until) await delay(4);
    check(expected.every(([index, target]) => approx(gains.at(index)?.value, target) && approx(scheduled(index), target)), label + ': ' +
      JSON.stringify({ expected, actual: gains.map(gain => gain.value), gainWrites, context: context.state,
        audioTime: context.currentTime, acquired, released }));
  };
  const mixer = new OwnerSafeAudioMixer({ context }), sceneAudio = new GameAudioRuntime({ mixer }), other = new GameAudioRuntime({ mixer });
  const acquired = [], released = [];
  const reading = new ReadingAudio({ gameAudio: sceneAudio, duckFactor: .4, resolve: async id => {
    acquired.push(id); return { bufferId: id, release() { released.push(id); } };
  } });
  const runtime = new NarrativeRuntime(story), i18n = locale();
  const playback = new ReadingPlayback({ runtime, i18n, lines, audio: reading });
  try {
    await mixer.unlock();
    const warmupDeadline = performance.now() + 5000;
    while (context.currentTime < .02 && performance.now() < warmupDeadline) await delay(10);
    check(context.currentTime >= .02, `Muted Web Audio clock did not start (${context.state}, ${context.currentTime}s)`);
    const audioStartTime = context.currentTime;
    for (const id of ['music','other','zh-line','en-line']) {
      const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * .75), context.sampleRate);
      for (let i = 0; i < buffer.length; i++) buffer.getChannelData(0)[i] = Math.sin(i * .05) * .04;
      mixer.installBuffer(id, buffer);
    }
    const song = (id, volume) => ({ bufferId: id, eventId: id, owner: id, channel: 'bed', bus: 'music', loop: true, volume, startTick: 1 });
    reading.setMusicVoice(sceneAudio.play(song('music', .8)));
    other.play(song('other', .6));
    runtime.start('audio');
    await matches([[4,.32],[5,.6]], 'Current line did not attenuate just the owned track');
    const entry = playback.history()[0];
    playback.setModal(true);
    await i18n.setLocale('en');
    const revision = runtime.view.revision;
    check(await playback.replayVoice(entry), 'English history voice did not start');
    sceneAudio.setVolumes({ music: .42 });
    mixer.setGain('music','bed',.7);
    playback.setPreferences({ voiceVolume: .5 });
    await matches([[4,.28],[5,.6],[-1,.5]], 'Transient gain did not compose with current settings');
    const limit = performance.now() + 3000;
    while (reading.historyPending && performance.now() < limit) await delay(10);
    await matches([[4,.7],[1,.42]], 'Natural history end did not restore current gain');
    check(!reading.historyPending && revision === runtime.view.revision, 'History replay changed the story');
    check(acquired.at(-1) === 'en-line', 'History replay resolved the wrong language');
    await playback.replayVoice(entry);
    playback.setActive(false);
    check(!reading.historyPending, 'Background did not cancel replay');
    await matches([[4,.7]], 'Background did not restore gain');
    playback.setActive(true);
    await playback.replayVoice(entry);
    playback.setModal(false);
    check(!reading.historyPending, 'Modal closure did not cancel replay');
    await matches([[4,.7]], 'Modal closure did not restore gain');
    await playback.replayVoice(entry);
    playback.confirm();
    playback.confirm();
    check(runtime.view.nodeId === 'two' && !reading.historyPending, 'Cut did not cancel replay');
    await matches([[4,.7]], 'Cut did not restore gain');
    pass('native-web-audio-scene-only-duck-and-restore', { acquired, released, voiceGain: .5,
      persistentMusic: sceneAudio.exportProfile().volumes.music, sceneTrackGain: gains[4].value,
      otherTrackGain: gains[5].value, activeVoices: mixer.stats.voices, borrowedContext: context.state,
      musicGainWrites: gainWrites[4], unrelatedGainWrites: gainWrites[5], audioStartTime });
    playback.dispose(); sceneAudio.dispose();
    check(mixer.stats.voices === 1 && context.state === 'running', 'Reader lifecycle stopped another owner');
    pass('native-audio-owner-cleanup', { retainedControlVoices: mixer.stats.voices, context: context.state });
  } finally {
    clockSource.stop(); clockSource.disconnect();
    playback.dispose(); runtime.dispose(); sceneAudio.dispose(); other.dispose(); mixer.dispose(); await context.close();
  }
}

try {
  engine = new HaiyueEngine({ canvas: stage, msaaSamples: 1, renderProfile: 'simple', devicePixelRatio: 1, clearColor: background });
  await engine.init();
  const adapter = engine.adapter.info;
  environment = { userAgent: navigator.userAgent, vendor: adapter.vendor, architecture: adapter.architecture, fallback: adapter.isFallbackAdapter };
  check(!adapter.isFallbackAdapter && !/swiftshader|software/iu.test(adapter.description || adapter.architecture), 'Native adapter required');
  engine.device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  engine.device.pushErrorScope('validation'); scoped = true;
  target = new RttEngine(engine, stage.width, stage.height, background);
  scene = engine.createScene({ render3D: false, render2D: false, gui: { loadOp: 'clear', font: { fontSize: 32, atlasSize: 512 } } });
  scene.renderView.target = target.renderTarget;
  root = new GuiRoot();
  scene.add(new Entity('Reading surface').addComponent(root));
  await nativeUi();
  await nativeHistory();
  await nativeAudio();
  const validation = await engine.device.popErrorScope(); scoped = false;
  if (validation) errors.push(validation.message);
  check(errors.length === 0, errors.join(' | '));
  result.textContent = JSON.stringify({ status: 'passed', cases, errors, environment, images });
  result.dataset.status = 'passed';
} catch (error) {
  result.textContent = JSON.stringify({ status: 'failed', cases, errors, environment, images, error: String(error?.stack ?? error) });
  result.dataset.status = 'failed';
} finally {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  if (scoped) await engine.device.popErrorScope();
  scene?.destroy(); target?.destroy(); engine?.destroy();
}
