import {BrowserMultiplayerInput} from '@haiyue/engine/experimental/simulation';
import {BUTTONS, bindings, OperationLog} from './model';

// An input-only example: the Engine sampler owns input semantics; SVG draws the
// inspection surface without allocating a GPU device or starting a render scene.
const $ = <T extends Element = HTMLElement>(id: string): T => document.getElementById(id)! as unknown as T;
function round(name: string, x: number, y: number, label = name, radius = 24, color = ''): string {
  return `<g transform="translate(${x} ${y})"><g id="key-${name}" class="button"><g class="cap"><circle class="key" r="${radius}"/><text${color ? ` style="--key-ink:${color}"` : ''}>${label}</text></g></g></g>`;
}
function shoulder(name: string, x: number, y: number, trigger: boolean): string {
  return `<g transform="translate(${x} ${y})"><g id="key-${name}" class="button"><g class="cap"><rect class="key" x="-48" y="-19" width="96" height="38" rx="13"/><text>${name}</text>${trigger ? `<rect id="fill-${name}" class="trigger-fill" x="-32" y="11" width="0" height="3" rx="1.5"/>` : ''}</g></g></g>`;
}
function stick(name: string, x: number, y: number, side: string): string {
  return `<g transform="translate(${x} ${y})"><circle class="well" r="57"/><circle class="stick-travel" r="43"/><g id="stick-${side}"><g id="key-${name}" class="button stick"><g class="cap"><circle class="key" r="32"/><circle fill="none" stroke="#78899c" opacity=".4" r="25"/><text style="font-size:11px">${name}</text></g></g></g></g>`;
}
$('controller').innerHTML = `<svg viewBox="0 0 780 470" role="img" aria-labelledby="pad-title pad-description">
<title id="pad-title">标准 ABXY 游戏手柄</title><desc id="pad-description">左右摇杆、十字键、ABXY、肩键、扳机、返回键和菜单键随手柄输入实时高亮。</desc>
<defs><linearGradient id="shell" x2="0" y2="1"><stop stop-color="#42536a"/><stop offset="1" stop-color="#253449"/></linearGradient><radialGradient id="stick"><stop stop-color="#53677f"/><stop offset="1" stop-color="#34465d"/></radialGradient><filter id="shadow" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="18" stdDeviation="14" flood-color="#182b40" flood-opacity=".18"/></filter></defs>
${shoulder('LT', 213, 48, true)}${shoulder('RT', 567, 48, true)}${shoulder('LB', 213, 101, false)}${shoulder('RB', 567, 101, false)}
<path class="shell" filter="url(#shadow)" d="M204 132 C155 132 134 154 118 204 L80 358 C66 418 91 442 120 429 L239 359 Q258 351 283 358 Q390 396 497 358 Q522 351 541 359 L660 429 C689 442 714 418 700 358 L662 204 C646 154 625 132 576 132 Z"/>
<path d="M117 350 L169 207 M663 350 L611 207" fill="none" stroke="#52657d" stroke-width="2" opacity=".4"/>
${stick('L3', 222, 224, 'left')}${stick('R3', 480, 326, 'right')}
<circle class="well" cx="290" cy="328" r="57"/>
${[['Up', 290, 294, '▲'], ['Down', 290, 362, '▼'], ['Left', 256, 328, '◀'], ['Right', 324, 328, '▶']].map(([name, x, y, label]) => `<g transform="translate(${x} ${y})"><g class="button" id="key-${name}"><g class="cap"><rect class="key" x="-16" y="-16" width="32" height="32" rx="5"/><text style="font-size:12px">${label}</text></g></g></g>`).join('')}
${round('A', 568, 269, 'A', 24, '#8cdeac')}${round('B', 612, 224, 'B', 24, '#ff9c9e')}${round('X', 524, 224, 'X', 24, '#98c9ff')}${round('Y', 568, 179, 'Y', 24, '#f5d98c')}
${round('Back', 354, 232, '↶', 17)}${round('Menu', 426, 232, '≡', 17)}${round('Home', 390, 170, 'H', 18)}
<text class="guide" x="354" y="264">BACK</text><text class="guide" x="426" y="264">MENU</text><text class="guide" x="390" y="302">HAIYUE</text>
</svg>`;

function start(): void {
  const events = new AbortController(), log = new OperationLog();
  const device = $<HTMLSelectElement>('device');
  const keys = Object.fromEntries(BUTTONS.map(name => [name, $<SVGElement>('key-' + name)]));
  const startTime = performance.now();
  let pads: (Gamepad | null)[] = [], selected = -1, identity = '', deviceList = '';
  let sampler: BrowserMultiplayerInput | undefined, request = 0, stopped = false, paused = document.hidden;
  let logRevision = -1, lastVisual = '', lastError = '';
  let values: Record<string, number> = {};

  function draw(): void {
    const signature = JSON.stringify(values);
    if (signature !== lastVisual) {
      lastVisual = signature;
      for (const name of BUTTONS) keys[name]!.classList.toggle('active', (name === 'LT' || name === 'RT') ? (values[name] ?? 0) > 0.02 : (values[name] ?? 0) >= 0.5);
      for (const [side, x, y] of [['left', 'LeftX', 'LeftY'], ['right', 'RightX', 'RightY']] as const) {
        const vx = values[x] ?? 0, vy = values[y] ?? 0;
        $('stick-' + side).setAttribute('transform', `translate(${vx * 23} ${vy * 23})`);
        $(side + '-value').textContent = `X ${vx.toFixed(2)} · Y ${vy.toFixed(2)}`;
      }
      for (const name of ['LT', 'RT']) {
        const value = values[name] ?? 0;
        $('fill-' + name).setAttribute('width', String(64 * value));
        $(name.toLowerCase() + '-value').textContent = `${Math.round(value * 100)}%`;
        $<HTMLMeterElement>(name.toLowerCase() + '-meter').value = value;
      }
    }
    if (log.revision !== logRevision) {
      logRevision = log.revision;
      const rows = log.entries.map(entry => {
        const row = document.createElement('li'), title = document.createElement('strong'), time = document.createElement('time'), detail = document.createElement('span');
        title.textContent = entry.control; time.textContent = `${(entry.time / 1000).toFixed(2)}s`; detail.textContent = entry.detail;
        row.append(title, time, detail); return row;
      });
      $('log').replaceChildren(...rows); $('count').textContent = String(rows.length); $('empty').hidden = rows.length !== 0;
    }
    // Read-only diagnostics, also used by the focused browser verifier.
    document.body.dataset.gamepad = JSON.stringify({ready: true, selected, mapping: pads[selected]?.mapping ?? '', values, paused, disposed: stopped, logCount: log.entries.length});
  }
  function neutral(): void {
    values = {};
    if (sampler) {
      const previous = pads; pads = [];
      log.sample(sampler.sample(sampler.tick + 1).players[0]!, performance.now() - startTime);
      pads = previous;
    }
    draw();
  }
  function choose(index: number): void {
    neutral(); sampler?.dispose(); sampler = undefined; log.reset(); selected = index;
    const pad = pads[index]; identity = pad ? `${index}:${pad.id}:${pad.mapping}` : '';
    if (pad?.mapping === 'standard') sampler = new BrowserMultiplayerInput({players: [{id: 'controller', gamepadIndex: index, bindings}], getGamepads: () => pads});
    if (pad) log.add(performance.now() - startTime, '当前手柄', pad.id);
    device.value = index < 0 ? '' : String(index);
  }
  function frame(): void {
    if (stopped || paused) return;
    try {
      pads = typeof navigator.getGamepads === 'function' ? Array.from(navigator.getGamepads()) : [];
      lastError = '';
    } catch (error) {
      pads = []; lastError = `无法访问手柄：${error instanceof Error ? error.message : String(error)}`;
    }
    const connected = pads.flatMap((pad, index) => pad?.connected && index <= 31 ? [{pad, index}] : []);
    const list = JSON.stringify(connected.map(({pad, index}) => [index, pad.id, pad.mapping]));
    if (list !== deviceList) {
      for (const [index, id] of deviceList ? JSON.parse(deviceList) as [number, string, string][] : []) {
        if (!connected.some(p => p.index === index && p.pad.id === id)) log.add(performance.now() - startTime, '已断开', id);
      }
      deviceList = list;
      device.replaceChildren(...(connected.length ? connected.map(({pad, index}) => new Option(`${index + 1} · ${pad.id}`, String(index))) : [new Option('等待手柄连接', '')]));
      device.disabled = connected.length < 2;
      const current = connected.find(p => p.index === selected) ?? connected.find(p => p.pad.mapping === 'standard') ?? connected[0];
      const nextIdentity = current ? `${current.index}:${current.pad.id}:${current.pad.mapping}` : '';
      if (identity !== nextIdentity) choose(current?.index ?? -1);
      device.value = selected < 0 ? '' : String(selected);
    }
    const pad = pads[selected];
    $('connection').textContent = pad ? (pad.mapping === 'standard' ? '● 已连接' : '非标准映射') : '未连接';
    $('connection').dataset.connected = String(!!pad && pad.mapping === 'standard');
    $('hint').textContent = lastError || (typeof navigator.getGamepads !== 'function' ? '当前浏览器不支持 Gamepad API，请使用支持手柄的浏览器。' : !pad ? '连接 USB 或蓝牙手柄后，按任意按键唤醒。请保持此页面在前台。' : pad.mapping !== 'standard' ? '此设备未提供 standard 映射，无法可靠对应图中按键；请切换手柄的标准 / XInput 模式。' : '移动左右摇杆或按下任意按键。LT / RT 显示连续压力；按下摇杆可测试 L3 / R3。');
    if (sampler) {
      const snapshot = sampler.sample(sampler.tick + 1).players[0]!;
      values = Object.fromEntries(snapshot.actions.map(action => [action.action, action.value]));
      log.sample(snapshot, performance.now() - startTime);
    } else values = {};
    draw(); request = requestAnimationFrame(frame);
  }
  function suspend(): void { paused = true; cancelAnimationFrame(request); neutral(); }
  function resume(): void { if (stopped || document.hidden) return; if (paused) sampler?.reset(); paused = false; cancelAnimationFrame(request); frame(); }
  device.addEventListener('change', () => {choose(Number(device.value)); draw();}, {signal: events.signal});
  $('clear').addEventListener('click', () => {log.clear(); draw();}, {signal: events.signal});
  window.addEventListener('blur', suspend, {signal: events.signal});
  window.addEventListener('focus', resume, {signal: events.signal});
  document.addEventListener('visibilitychange', () => document.hidden ? suspend() : resume(), {signal: events.signal});
  window.addEventListener('pagehide', () => {
    stopped = true; cancelAnimationFrame(request); neutral(); sampler?.dispose(); events.abort(); draw();
  }, {once: true, signal: events.signal});
  draw(); if (!paused) frame();
}
start();
window.addEventListener('pageshow', event => {if (event.persisted) start();});
