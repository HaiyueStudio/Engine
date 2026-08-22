export function stateMachineV2Fixture() {
  const channel = (id, family, valueKind, policy, extra = {}) => ({ id, target: 'root', path: id, family, valueKind, policy, ...extra });
  const hold = (time, value) => ({ time, value, interpolation: { kind: 'hold' } });
  const final = (time, value) => ({ time, value });
  return {
    format: 'haiyue-animation-state-machine@2', extension: 'org.haiyue.animation-state-machine@2',
    channels: [
      channel('transform.x', 'transform', 'number', 'override', { defaultValue: 0 }),
      channel('path.points', 'paint-path', 'vector', 'additive', { valueSize: 2, defaultValue: [0, 0] }),
      channel('paint.color', 'paint-path', 'color', 'override', { valueSize: 4, defaultValue: [0, 0, 0, 1] }),
      channel('rig.angle', 'rig', 'number', 'additive', { defaultValue: 0 }),
      channel('text.value', 'text-layout', 'string', 'discrete', { defaultValue: 'idle' }),
      channel('layout.width', 'text-layout', 'number', 'override', { defaultValue: 10 }),
      channel('resource.asset', 'resource-data', 'id', 'ownership', { defaultValue: 'a' }),
      channel('data.selection', 'resource-data', 'number', 'discrete', { defaultValue: 0 }),
      channel('visible', 'visibility-order', 'boolean', 'discrete', { defaultValue: true }),
      channel('draw.order', 'visibility-order', 'unsigned', 'discrete', { defaultValue: 0 }),
      channel('event.fire', 'event-audio-script', 'callback', 'ownership', { effectKind: 'event' }),
      channel('audio.play', 'event-audio-script', 'callback', 'ownership', { effectKind: 'audio' }),
      channel('script.call', 'event-audio-script', 'callback', 'ownership', { effectKind: 'script' }),
      channel('transform.rotation', 'transform', 'number', 'override', { numericMode: 'angle-radians', defaultValue: 3 }),
    ],
    clips: [
      {
        id: 'idle', name: 'Idle', duration: 2, fps: 60, tracks: [
          { id: 'idle-x', channel: 'transform.x', keys: [{ time: 0, value: 0, interpolation: { kind: 'linear' } }, final(2, 4)] },
          { id: 'idle-path', channel: 'path.points', keys: [{ time: 0, value: [0, 0], interpolation: { kind: 'linear' } }, final(2, [2, 4])] },
          { id: 'idle-paint', channel: 'paint.color', keys: [{ time: 0, value: [1, 0, 0, 1], interpolation: { kind: 'cubic-ease', controls: [0.25, 0.1, 0.25, 1] } }, final(2, [0, 0, 1, 1])] },
          { id: 'idle-rig', channel: 'rig.angle', keys: [{ time: 0, value: 0, interpolation: { kind: 'cubic-value', outTangent: [2], inTangent: [2] } }, final(2, 2)] },
          { id: 'idle-text', channel: 'text.value', keys: [hold(0, 'idle'), final(1, 'half')] },
          { id: 'idle-layout', channel: 'layout.width', keys: [{ time: 0, value: 10, interpolation: { kind: 'elastic', easing: 'out', amplitude: 1, period: 0.3 } }, final(2, 20)] },
          { id: 'idle-resource', channel: 'resource.asset', keys: [hold(0, 'a'), final(1, 'b')] },
          { id: 'idle-data', channel: 'data.selection', keys: [hold(0, 0), final(1, 1)] },
          { id: 'idle-visible', channel: 'visible', keys: [hold(0, true), final(1, false)] },
          { id: 'idle-order', channel: 'draw.order', keys: [hold(0, 0), final(1, 2)] },
          { id: 'idle-event', channel: 'event.fire', keys: [final(0.25, { name: 'quarter' }), final(1.25, { name: 'late' })] },
          { id: 'idle-audio', channel: 'audio.play', keys: [final(0.5, { asset: 'tone', sample: 24000 })] },
          { id: 'idle-script', channel: 'script.call', keys: [final(0.75, { protocol: 'fixture@1', port: 'tick' })] },
          { id: 'idle-rotation', channel: 'transform.rotation', keys: [{ time: 0, value: 3, interpolation: { kind: 'linear' } }, final(2, -3)] },
        ],
      },
      { id: 'active', duration: 1, tracks: [
        { id: 'active-x', channel: 'transform.x', keys: [final(0, 10)] },
        { id: 'active-text', channel: 'text.value', keys: [final(0, 'active')] },
        { id: 'active-resource', channel: 'resource.asset', keys: [final(0, 'active-asset')] },
        { id: 'active-event', channel: 'event.fire', keys: [final(0.4, { name: 'active' })] },
      ] },
      { id: 'accent', duration: 2, tracks: [
        { id: 'accent-x', channel: 'transform.x', keys: [final(0, 2)] },
        { id: 'accent-rig', channel: 'rig.angle', keys: [final(0, 3)] },
      ] },
    ],
    stateMachines: [{
      id: 'main', inputs: [
        { id: 'go', type: 'trigger' }, { id: 'enabled', type: 'boolean', defaultValue: true },
        { id: 'speed', type: 'number', defaultValue: 1 }, { id: 'blend', type: 'number', defaultValue: 0 },
        { id: 'additive', type: 'number', defaultValue: 0.5 }, { id: 'remap', type: 'number', defaultValue: 0 },
        { id: 'nestedMix', type: 'number', defaultValue: 0.5 }, { id: 'nestedPlay', type: 'boolean', defaultValue: true }, { id: 'childFire', type: 'trigger' },
      ],
      layers: [
        { id: 'base', order: 0, states: [
          { id: 'idle', motion: { kind: 'clip', clip: 'idle', playback: 'loop', speedInput: 'speed' } },
          { id: 'active', motion: { kind: 'clip', clip: 'active', playback: 'one-shot' } },
          { id: 'nested', motion: { kind: 'nested', component: 'child', timeRemapInput: 'remap', mixInput: 'nestedMix', playingInput: 'nestedPlay', inputBindings: { enabled: 'enabled', fire: 'childFire' } } },
        ], transitions: [
          { id: 'base-entry', from: '@entry', to: 'idle', conditionGroups: [], duration: 0 },
          { id: 'activate', from: 'idle', to: 'active', conditionGroups: [
            [{ kind: 'trigger', input: 'go' }, { kind: 'input', input: 'enabled', comparator: 'equal', value: true }],
            [{ kind: 'custom', protocol: 'fixture-condition@1', port: 'activate' }],
          ], duration: 0.5, pauseWhenExiting: true, interpolation: { kind: 'cubic-ease', controls: [0.42, 0, 0.58, 1] }, effects: [
            { channel: 'event.fire', phase: 'start', payload: { name: 'transition-start' } },
            { channel: 'event.fire', phase: 'complete', payload: { name: 'transition-complete' } },
          ] },
          { id: 'nest', from: 'active', to: 'nested', conditionGroups: [], exitTime: 1, duration: 0 },
          { id: 'leave-nested', from: 'nested', to: '@exit', conditionGroups: [[{ kind: 'observable', protocol: 'fixture-observable@1', port: 'done', comparator: 'equal', value: true }]], duration: 0 },
        ] },
        { id: 'overlay', order: 1, weight: 0.5, mode: 'additive', mask: { include: ['transform.x', 'rig.angle'] }, states: [
          { id: 'blend', motion: { kind: 'blend-1d', input: 'blend', children: [{ threshold: 0, motion: { kind: 'clip', clip: 'idle', playback: 'loop' } }, { threshold: 1, motion: { kind: 'clip', clip: 'accent', playback: 'loop' } }] } },
          { id: 'add', motion: { kind: 'blend-additive', base: { kind: 'clip', clip: 'idle', playback: 'loop' }, children: [{ motion: { kind: 'clip', clip: 'accent', playback: 'loop' }, weightInput: 'additive' }] } },
        ], transitions: [
          { id: 'overlay-entry', from: '@entry', to: 'blend', conditionGroups: [], duration: 0 },
          { id: 'overlay-add', from: 'blend', to: 'add', conditionGroups: [[{ kind: 'input', input: 'enabled', comparator: 'equal', value: false }]], duration: 0 },
        ] },
      ],
    }],
    components: [{ id: 'child', target: 'root/child', source: { kind: 'clip', clip: 'active' }, playback: 'remap', exposedInputs: ['enabled'], exposedEvents: ['done'] }],
  };
}

export function v1StateMachineFixture() {
  return {
    clips: [{ id: 'idle', start: 0, duration: 2 }, { id: 'active', start: 2, duration: 1 }],
    stateMachine: {
      format: 'haiyue-animation-state-machine@1', id: 'legacy', name: 'Legacy',
      parameters: [{ name: 'go', type: 'trigger' }, { name: 'blend', type: 'float', defaultValue: 0 }],
      layers: [{ id: 'base', name: 'Base', initialStateId: 'idle', states: [
        { id: 'idle', name: 'Idle', motion: { kind: 'clip', clipId: 'idle' }, loop: 'repeat', speed: 1 },
        { id: 'active', name: 'Active', motion: { kind: 'clip', clipId: 'active' }, loop: 'once' },
      ], transitions: [{ id: 'go', from: '*', to: 'active', conditions: [{ parameter: 'go', operator: 'triggered' }], duration: 0.2, destinationOffset: 0.25, interruption: 'source' }] }],
    },
  };
}

export async function loadStateMachineV2Modules() {
  const [specRoot, runtimeRoot] = await Promise.all([
    transpileTree(new URL('../../animation-spec/src/state-machine-v2/', import.meta.url)),
    transpileTree(new URL('../src/hya-state-machine/v2/', import.meta.url)),
  ]);
  const [spec, runtime] = await Promise.all([import(new URL('index.js', specRoot).href), import(new URL('index.js', runtimeRoot).href)]);
  return { spec, runtime };
}

async function transpileTree(sourceUrl) {
  const { mkdtemp, mkdir, readFile, readdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const path = await import('node:path'); const { fileURLToPath } = await import('node:url'); const ts = await import('typescript');
  const sourceRoot = fileURLToPath(sourceUrl), temporary = await mkdtemp(path.join(tmpdir(), 'haiyue-state-machine-v2-'));
  for (const file of (await walk(sourceRoot, readdir, path)).filter(file => file.endsWith('.ts'))) { const output = path.join(temporary, path.relative(sourceRoot, file).replace(/\.ts$/, '.js')); await mkdir(path.dirname(output), { recursive: true }); const compiled = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText; await writeFile(output, compiled); }
  return new URL(`file:///${temporary.replaceAll('\\', '/')}/`);
}
async function walk(directory, readdir, path) { const result = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const resolved = path.join(directory, entry.name); if (entry.isDirectory()) result.push(...await walk(resolved, readdir, path)); else result.push(resolved); } return result; }
