import { HaiyueEngine } from '@haiyue/engine';
import { OwnerSafeAudioMixer } from '@haiyue/engine/audio';
import { getEngineDiagnosticsSnapshot } from '@haiyue/engine/diagnostics';
import { I18n } from '@haiyue/extensions/i18n';
import { createVisualNovel, validateVisualNovelDefinition } from '@haiyue/extensions/visual-novel';

const moduleStartedAt = performance.timeOrigin + performance.now();
const $ = id => document.getElementById(id);
const labels = {
  'zh-Hans': {
    new:'新故事', continue:'继续游戏', advance:'继续', chapter:'启程', 'chapter-label':'当前章节', 'slot-label':'存档位置',
    save:'保存', load:'读取', 'history-label':'对白历史', voice:'重听配音', 'replays-label':'结局回看', replay:'回看', return:'返回故事',
    'settings-label':'阅读设置','immediate-label':'即时显示','contrast-label':'高对比度','size-label':'字号',
    arrival:'雾港', pier:'防波堤', ending:'最后的灯', saved:'存档已保存', loaded:'已恢复存档', empty:'这个位置还没有可用存档',
    ready:'开始故事，或从最近的存档继续。', working:'正在准备下一幕…', locked:'尚未解锁', noVoice:'这条对白没有配音',
    'lantern-cg':'守灯', 'tide-cg':'随潮',
    'splash-title':'末班渡船即将驶离','splash-copy':'在雾散前，决定把最后一盏灯留给谁。',
  },
  en: {
    new:'New story', continue:'Continue game', advance:'Continue', chapter:'Departure', 'chapter-label':'Chapter', 'slot-label':'Save slot',
    save:'Save', load:'Load', 'history-label':'Dialogue history', voice:'Replay voice', 'replays-label':'Ending gallery', replay:'Replay', return:'Return',
    'settings-label':'Reading settings','immediate-label':'Instant text','contrast-label':'High contrast','size-label':'Text size',
    arrival:'Harbor', pier:'Breakwater', ending:'The last light', saved:'Game saved', loaded:'Game restored', empty:'No readable save in this slot',
    ready:'Start a story or continue from your latest save.', working:'Preparing the next scene…', locked:'Locked', noVoice:'No voice for this line',
    'lantern-cg':'The Watch', 'tide-cg':'The Tide',
    'splash-title':'The last ferry is leaving','splash-copy':'Before the fog lifts, decide who the last lantern should guide.',
  },
};
const copy = key => labels[$('language').value]?.[key] ?? key;
const notice = message => { $('notice').textContent = message; };
const error = value => { notice(value.message ?? String(value)); };
const engine = new HaiyueEngine({ canvas:$('canvas'), msaaSamples:1, renderProfile:'simple', diagnostics:{enabled: true} });
const mixer = new OwnerSafeAudioMixer();
let session, i18n, unsubscribe, busy = false, disposed = false;
let audioUnlocked = false;
let audioActivity = Promise.resolve();
const events = new AbortController();
const assetRoot = new URL('./project/', import.meta.url);
const previousKeys = new Map();
function list(select, pairs) {
  const signature = JSON.stringify(pairs);
  if (previousKeys.get(select) === signature) return;
  previousKeys.set(select, signature);
  const value = select.value;
  select.replaceChildren(...pairs.map(([key,text]) => new Option(text,key)));
  if (pairs.some(([key]) => key === value)) select.value = value;
}
function render() {
  const view = session?.view, reading = view?.reading, started = !!reading;
  const waiting = busy || view?.transitioning;
  $('chapter').textContent = reading ? copy(reading.nodeId?.split('/')[0]) : copy('chapter');
  $('line').textContent = reading?.kind === 'end' ? reading.text : '';
  $('splash').hidden = started;
  $('advance').disabled = !started || waiting || reading.kind !== 'dialogue';
  $('save').disabled = !started || waiting || !!view.replayId || !['dialogue','choice'].includes(reading.kind);
  $('return').hidden = !view?.replayId;
  for (const id of ['new','continue','load']) $(id).disabled = !session || waiting;
  const replayRows = session?.listReplays().map(id => [id,copy(id)]) ?? [];
  list($('replays'), replayRows.length ? replayRows : [['',copy('locked')]]);
  $('replay').disabled = !started || waiting || !!view.replayId || !replayRows.length;
  list($('history'), (view?.history ?? []).map(row => [row.key, i18n.text(row.textKey,row.params)]));
  $('voice').disabled = !started || waiting || !$('history').value;
  $('immediate').checked = reading?.preferences.textSpeed === 0;
  $('contrast').checked = reading?.preferences.highContrast ?? false;
  $('size').value = reading?.preferences.fontScale ?? 1;
  const choices = reading?.choices ?? [];
  const signature = JSON.stringify([choices, !!waiting]);
  if (previousKeys.get($('choices')) !== signature) {
    previousKeys.set($('choices'), signature);
    $('choices').replaceChildren(...choices.map(choice => {
      const button = document.createElement('button');
      button.textContent = choice.text; button.dataset.option = choice.id;
      button.disabled = !choice.enabled || waiting;
      button.onclick = () => session.choose(choice.id);
      return button;
    }));
  }
}
function translate() {
  document.documentElement.lang = $('language').value;
  for (const id of ['new','continue','advance','chapter-label','slot-label','save','load','history-label','voice',
    'replays-label','replay','return','settings-label','immediate-label','contrast-label','size-label','splash-title','splash-copy']) $(id).textContent = copy(id);
  render();
}
function listen(id,event,run) { $(id).addEventListener(event,run,{signal:events.signal}); }
function syncAudioActivity() {
  if (!audioUnlocked || disposed) return;
  audioActivity = audioActivity.then(async () => {
    if (disposed) return;
    const background = document.hidden || !document.hasFocus();
    if (background && mixer.stats.state === 'running') await mixer.suspend();
    else if (!background && mixer.stats.state === 'suspended') await mixer.resume();
  }).catch(failure => { if (!disposed) error(failure); });
}
function interact(id, operation) {
  listen(id,'click', async () => {
    if (!session || busy) return;
    busy = true; notice(copy('working')); render();
    try {
      await mixer.unlock();
      audioUnlocked = true;
      if (document.hidden) syncAudioActivity();
      notice(await operation() ?? '');
    }
    catch (failure) { error(failure); }
    finally { busy = false; render(); }
  });
}

const ready = (async () => {
  await engine.init();
  const response = await fetch(new URL('compiled.json', assetRoot));
  if (!response.ok) throw new Error('Build the story before opening the player.');
  const story = await response.json();
  validateVisualNovelDefinition(story.definition);
  i18n = new I18n({ locale:story.defaultLocale, fallbackLocale:story.defaultLocale });
  for (const pack of Object.values(story.locales)) i18n.register(pack);
  if (disposed) { i18n.dispose(); return; }
  const locale = localStorage.getItem('last-lantern-language');
  if (locale && Object.hasOwn(story.locales,locale)) {
    await i18n.setLocale(locale); $('language').value = locale;
  }
  session = createVisualNovel({ engine, i18n, story, mixer, assetRoot, storage:localStorage, music:'music', onError:error });
  unsubscribe = session.subscribe(render);
  engine.run();
  translate(); notice(copy('ready'));
})();
void ready.catch(error);
interact('new', () => session.start(crypto.randomUUID()));
interact('continue', async () => await session.continueLatest() ? copy('loaded') : copy('empty'));
interact('load', async () => await session.load($('slot').value) ? copy('loaded') : copy('empty'));
interact('save', async () => { await session.save($('slot').value, { name:$('chapter').textContent }); return copy('saved'); });
interact('voice', async () => await session.replayVoice($('history').value) ? '' : copy('noVoice'));
interact('replay', () => session.startReplay($('replays').value));
listen('return','click',() => session?.endReplay());
listen('advance','click',() => session?.advance());
listen('immediate','change',() => session?.setPreferences({ textSpeed:$('immediate').checked ? 0 : 28 }));
listen('contrast','change',() => session?.setPreferences({ highContrast:$('contrast').checked }));
listen('size','input',() => session?.setPreferences({ fontScale:Number($('size').value) }));
listen('history','change',render);
listen('language','change', async () => {
  if (!i18n) return;
  try { await i18n.setLocale($('language').value); localStorage.setItem('last-lantern-language',$('language').value); translate(); }
  catch (failure) { error(failure); }
});
document.addEventListener('visibilitychange', syncAudioActivity, { signal:events.signal });
window.addEventListener('blur', syncAudioActivity, { signal:events.signal });
window.addEventListener('focus', syncAudioActivity, { signal:events.signal });
async function dispose() {
  if (disposed) return;
  disposed = true; events.abort(); unsubscribe?.();
  try { await session?.dispose(); }
  finally { i18n?.dispose(); mixer.dispose(); engine.destroy(); }
}
window.addEventListener('pagehide', () => { void dispose().catch(error); }, { signal:events.signal });
export const app = { engine, mixer, ready, moduleStartedAt, get session() { return session; },
  diagnostics: () => getEngineDiagnosticsSnapshot(engine), dispose };
