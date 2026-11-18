import { app } from './bundle.js';

const session = () => app.session;
const id = name => document.getElementById(name);
const metadata = await fetch('./device-config.json', { cache: 'no-store' }).then(response => response.json());
const historyOnly = metadata.profile === 'history-audio';
const audit = [];
const errors = [];
const gpuErrors = [];
let trustedPointer = 0, trustedKey = 0, hidden = false, foregroundReturned = false;
const audioNote = ['audio', '等当前配音结束，用页面的「对白历史」下拉框和旁边的「重听配音」按钮，确认背景音乐降低，配音结束后恢复。'];
const foregroundNote = ['foreground', '再点一次「重听配音」，听到配音后立刻切到其他程序，稍等再返回。确认同一条配音从暂停处继续，并且页面仍可操作。'];
const notes = historyOnly ? [audioNote, foregroundNote] : [
  ['read', '用键盘 Tab 和 Enter 开始故事，推进到第一组选项。'],
  ['save', '先保存到位置 1。用鼠标选择留下并读到结局，读取位置 1 后选择离开，读到另一个结局。'],
  audioNote, foregroundNote,
];
const panel = document.createElement('section');
panel.style.cssText = 'max-width:74rem;margin:2rem auto;padding:1rem;color:#f1f4e3;background:#172b34;border:1px solid #547175;line-height:1.6';
const title = document.createElement('h2');
title.textContent = historyOnly ? 'G07 配音切回复测' : 'G07 真实设备验收';
panel.append(title);
const version = document.createElement('p');
version.textContent = '候选 ' + metadata.revision.slice(0, 12) + ' · ' + metadata.host;
panel.append(version);
if (historyOnly) {
  const step = document.createElement('p');
  step.textContent = '先点「新故事」，停在第一条对白。只需完成下列听音复测。';
  panel.append(step);
}
const checklist = new Map();
for (const [key, text] of notes) {
  const label = document.createElement('label');
  label.style.display = 'block';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  label.append(checkbox, ' ' + text);
  panel.append(label);
  checklist.set(key, checkbox);
}
const status = document.createElement('p');
status.setAttribute('role', 'status');
const button = document.createElement('button');
button.textContent = '保存真实设备记录';
button.disabled = true;
panel.append(button, status);
document.querySelector('main').append(panel);

await app.ready;
let historyReplay, historyObservation;
if (historyOnly) {
  const sourcePrototype = AudioBufferSourceNode.prototype;
  const start = sourcePrototype.start;
  sourcePrototype.start = function(...args) {
    const probe = historyReplay;
    if (!this.loop && probe) {
      probe.starts++;
      if (probe.starts === 1) {
        const context = this.context;
        const observation = historyObservation;
        const { signal } = observation;
        const mark = state => {
          if (probe.timing.length < 12) probe.timing.push({ state, time: performance.now(), audioTime: context.currentTime });
        };
        mark('started');
        context.addEventListener('statechange', () => mark(context.state), { signal });
        this.addEventListener('ended', () => { mark('ended'); observation.abort(); }, { once: true, signal });
      }
    }
    return start.apply(this, args);
  };
}
const gainChanges = [];
const gain = AudioParam.prototype.setValueAtTime;
AudioParam.prototype.setValueAtTime = function(value, ...args) {
  if (gainChanges.length < 300) gainChanges.push({ value, time: performance.now() });
  return gain.call(this, value, ...args);
};
app.engine.device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason?.message ?? event.reason)));
const markLeave = () => {
  hidden = true;
  if (historyReplay?.starts === 1 && !historyObservation.signal.aborted) historyReplay.background = true;
};
const markReturn = () => {
  if (hidden) foregroundReturned = true;
  if (historyReplay?.background) historyReplay.returned = true;
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) markLeave();
  else markReturn();
});
window.addEventListener('blur', markLeave);
window.addEventListener('focus', markReturn);
document.addEventListener('keydown', event => {
  if (event.isTrusted && (event.key === 'Enter' || event.key === 'Tab' || event.key === ' ')) trustedKey++;
}, true);
document.addEventListener('pointerdown', event => {
  if (event.isTrusted && !panel.contains(event.target)) trustedPointer++;
}, true);

function state() {
  const { reading, audio, replayId } = session().view;
  return { node: reading?.nodeId ?? null, entry: reading?.lineId ?? null, kind: reading?.kind ?? null,
    voices: audio.voices, replayId, time: performance.now() };
}
let lastNode = null;
session().subscribe(() => {
  const current = state();
  if (current.node !== lastNode && audit.length < 550) {
    lastNode = current.node; audit.push({ ...current, type: 'node' });
  }
});
for (const control of ['new', 'advance', 'save', 'load', 'continue', 'voice', 'replay', 'return']) {
  id(control).addEventListener('click', event => {
    if (!event.isTrusted || audit.length >= 550) return;
    const mark = state();
    audit.push({ ...mark, type: control, trusted: true, slot: id('slot').value });
    if (historyOnly && control === 'voice') {
      historyObservation?.abort();
      historyObservation = new AbortController();
      historyReplay = { starts: 0, returned: false, timing: [] };
    }
    if (['save', 'load', 'continue'].includes(control)) {
      const wait = setInterval(() => {
        if (id(control).disabled && performance.now() - mark.time < 6_000) return;
        clearInterval(wait);
        if (audit.length < 550) audit.push({ ...state(), type: control + '-settled', notice: id('notice').textContent });
      }, 60);
    }
  }, true);
}
button.disabled = false;
button.onclick = async event => {
  if (!event.isTrusted) return;
  button.disabled = true;
  try {
    await app.engine.device.queue.onSubmittedWorkDone();
    const adapter = app.engine.adapter.info;
    const reply = await fetch('/__vn-device', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...metadata, verifiedByOperator: Object.fromEntries([...checklist].map(([key, field]) => [key, field.checked])),
        adapter: { vendor: adapter.vendor, architecture: adapter.architecture, description: adapter.description, fallback: adapter.isFallbackAdapter },
        userAgent: navigator.userAgent, trustedPointer, trustedKey, foregroundReturned, historyReplay, audit, gainChanges, errors, gpuErrors }),
    });
    const outcome = await reply.json();
    status.textContent = outcome.status === 'passed' ? '验收记录已保存。' : '本轮记录已保存，缺项为 ' + outcome.failures.join('、');
  } catch (error) { status.textContent = String(error?.message ?? error); }
  finally { button.disabled = false; }
};
