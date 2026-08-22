export function dataBindingFixture() {
  return {
    format: 'haiyue-data-binding', version: 1, extension: 'org.haiyue.data-binding@1',
    enums: [{ id: 'status', values: [{ key: 'idle', value: 0 }, { key: 'active', value: 1 }] }],
    models: [
      { id: 'Child', properties: [{ id: 'name', kind: 'string', defaultValue: 'child' }] },
      { id: 'Item', properties: [{ id: 'name', kind: 'string', defaultValue: '' }, { id: 'selected', kind: 'boolean', defaultValue: false }] },
      { id: 'Root', defaultInstance: 'root-default', properties: [
        { id: 'score', kind: 'number', defaultValue: 1.25 }, { id: 'count', kind: 'integer', defaultValue: 1 },
        { id: 'title', kind: 'string', defaultValue: 'default' }, { id: 'numericText', kind: 'string', defaultValue: '12.5000' }, { id: 'enabled', kind: 'boolean', defaultValue: true },
        { id: 'hidden', kind: 'boolean', defaultValue: false }, { id: 'color', kind: 'color', defaultValue: [1, 0, 0, 1] },
        { id: 'fire', kind: 'trigger', defaultValue: false }, { id: 'status', kind: 'enum', enum: 'status', defaultValue: 0 },
        { id: 'child', kind: 'model', model: 'Child', defaultValue: 'child-1' }, { id: 'items', kind: 'list', item: { kind: 'model', model: 'Item' }, defaultValue: ['item-1'] },
        { id: 'image', kind: 'image', nullable: true, defaultValue: null }, { id: 'artboard', kind: 'artboard', nullable: true, defaultValue: null },
      ] },
    ],
    instances: [
      { id: 'child-1', model: 'Child', scope: 'local', values: { name: 'nested' } },
      { id: 'item-1', model: 'Item', scope: 'local', values: { name: 'one' } },
      { id: 'item-2', model: 'Item', scope: 'local', values: { name: 'two' } },
      { id: 'root-default', model: 'Root', scope: 'default', values: { title: 'default title', child: 'child-1', items: ['item-1'] } },
      { id: 'root-global', model: 'Root', scope: 'global', values: { title: 'global title', child: 'child-1', items: ['item-1'] } },
      { id: 'root-local', model: 'Root', scope: 'local', values: { score: 2.345, title: 'local title', enabled: true, hidden: false, child: 'child-1', items: ['item-1'], image: 'image-a', artboard: 'board-a' } },
    ],
    converters: [
      { id: 'score-text', version: 1, operations: [{ op: 'round', decimals: 1 }, { op: 'to-string', decimals: 1 }] },
      { id: 'not', version: 1, operations: [{ op: 'boolean-not' }] },
      { id: 'custom-double', version: 1, operations: [{ op: 'custom', protocol: 'haiyue.converter.fixture@1', port: 'double', arguments: { factor: 2 } }] },
      { id: 'range-label', version: 1, operations: [{ op: 'range-map', input: [0, 10], output: [0, 100], clamp: true }, { op: 'to-string', decimals: 0 }] },
      { id: 'smooth', version: 1, operations: [{ op: 'interpolate', duration: 1, easing: [0, 0, 1, 1] }] },
      { id: 'formula-double', version: 1, operations: [{ op: 'formula', tokens: [{ kind: 'input', value: 'input' }, { kind: 'value', value: 2 }, { kind: 'operator', value: '*' }] }] },
      { id: 'items-length', version: 1, operations: [{ op: 'list-length' }] },
      { id: 'degrees', version: 1, operations: [{ op: 'degrees-to-radians' }] },
      { id: 'number-list', version: 1, operations: [{ op: 'number-to-list', model: 'Item' }] },
      { id: 'edge', version: 1, operations: [{ op: 'to-trigger', mode: 'change' }] },
      { id: 'title-format', version: 1, operations: [{ op: 'string-trim', side: 'both' }, { op: 'string-pad', length: 15, text: '_', side: 'end' }] },
      { id: 'numeric-clean', version: 1, operations: [{ op: 'string-trim', side: 'both' }, { op: 'to-number' }, { op: 'to-string', decimals: 3 }, { op: 'remove-trailing-zeros' }] },
      { id: 'color-hex', version: 1, operations: [{ op: 'to-string', colorFormat: 'hex' }] },
    ],
    propertyGroups: [
      { id: 'activate', version: 1, operations: [{ op: 'set', path: ['enabled'], value: true }, { op: 'trigger', path: ['fire'] }, { op: 'list-insert', path: ['items'], index: 1, value: 'item-2' }] },
      { id: 'reorder', version: 1, operations: [{ op: 'list-move', path: ['items'], from: 1, to: 0 }] },
    ],
    bindings: [
      { id: 'b-score', target: 'button', targetPath: ['value'], source: { mode: 'explicit', instance: 'root-local', path: ['score'] }, converter: 'score-text', direction: 'two-way' },
      { id: 'b-score-raw', target: 'button', targetPath: ['rawValue'], source: { mode: 'explicit', instance: 'root-local', path: ['score'] }, direction: 'two-way' },
      { id: 'b-score-smooth', target: 'button', targetPath: ['smoothValue'], source: { mode: 'explicit', instance: 'root-local', path: ['score'] }, converter: 'smooth', direction: 'read' },
      { id: 'b-fire', target: 'button', targetPath: ['fire'], source: { mode: 'explicit', instance: 'root-local', path: ['fire'] }, direction: 'two-way' },
      { id: 'b-custom', target: 'button', targetPath: ['custom'], source: { mode: 'explicit', instance: 'root-local', path: ['score'] }, converter: 'custom-double', direction: 'read' },
      { id: 'b-title-default', target: 'button', targetPath: ['label'], source: { mode: 'default', model: 'Root', path: ['title'] }, direction: 'read' },
      { id: 'b-title-global', target: 'button', targetPath: ['label'], source: { mode: 'global', model: 'Root', path: ['title'] }, direction: 'read' },
      { id: 'b-title-auto', target: 'button', targetPath: ['label'], source: { mode: 'auto', model: 'Root', path: ['title'] }, direction: 'read' },
      { id: 'b-formula', target: 'button', targetPath: ['formula'], source: { mode: 'explicit', instance: 'root-local', path: ['score'] }, converter: 'formula-double', direction: 'read' },
      { id: 'b-range', target: 'button', targetPath: ['range'], source: { mode: 'explicit', instance: 'root-local', path: ['score'] }, converter: 'range-label', direction: 'read' },
      { id: 'b-list-length', target: 'list', targetPath: ['length'], source: { mode: 'explicit', instance: 'root-local', path: ['items'] }, converter: 'items-length', direction: 'read' },
      { id: 'b-radians', target: 'button', targetPath: ['radians'], source: { mode: 'explicit', instance: 'root-local', path: ['score'] }, converter: 'degrees', direction: 'read' },
      { id: 'b-number-list', target: 'list', targetPath: ['generated'], source: { mode: 'explicit', instance: 'root-local', path: ['count'] }, converter: 'number-list', direction: 'read' },
      { id: 'b-edge', target: 'button', targetPath: ['changed'], source: { mode: 'explicit', instance: 'root-local', path: ['enabled'] }, converter: 'edge', direction: 'read' },
      { id: 'b-title-format', target: 'button', targetPath: ['formatted'], source: { mode: 'explicit', instance: 'root-local', path: ['title'] }, converter: 'title-format', direction: 'read' },
      { id: 'b-numeric-clean', target: 'button', targetPath: ['numeric'], source: { mode: 'explicit', instance: 'root-local', path: ['numericText'] }, converter: 'numeric-clean', direction: 'read' },
      { id: 'b-color', target: 'button', targetPath: ['color'], source: { mode: 'explicit', instance: 'root-local', path: ['color'] }, converter: 'color-hex', direction: 'read' },
      { id: 'b-disabled', target: 'button', targetPath: ['disabled'], source: { mode: 'explicit', instance: 'root-local', path: ['enabled'] }, converter: 'not', direction: 'read' },
      { id: 'b-hidden', target: 'button', targetPath: ['hidden'], source: { mode: 'explicit', instance: 'root-local', path: ['hidden'] }, direction: 'read' },
      { id: 'b-child-name', target: 'child', targetPath: ['label'], source: { mode: 'explicit', instance: 'root-local', path: ['child', 'name'] }, direction: 'two-way' },
      { id: 'b-items', target: 'list', targetPath: ['items'], source: { mode: 'explicit', instance: 'root-local', path: ['items'] }, direction: 'two-way' },
    ],
    components: [{ id: 'component', stateful: true, model: 'Root', exposedProperties: ['score', 'title'], exposedInputs: ['activate'], exposedEvents: ['changed'] }],
  };
}

export function interactionFixture() {
  const report = name => ({ kind: 'report-event', name });
  return {
    format: 'haiyue-interaction', version: 1, extension: 'org.haiyue.interaction@1', dragThreshold: 4,
    limits: { maxEventQueue: 128, maxEventRecursion: 8, maxPointers: 4 },
    targets: [
      { id: 'root', order: 0, hitArea: { kind: 'rect', rect: [0, 0, 200, 200] }, focusable: true, tabIndex: 0 },
      { id: 'clip', parent: 'root', order: -1, hitArea: { kind: 'rect', rect: [0, 0, 40, 40] } },
      { id: 'button', parent: 'root', component: 'nested-card', order: 10, transform: [1, 0, 0, 1, 10, 10], hitArea: { kind: 'rect', rect: [0, 0, 80, 40] }, clips: ['clip'], focusable: true, tabIndex: 1 },
      { id: 'knob', parent: 'button', order: 20, transform: [1, 0, 0, 1, 5, 5], hitArea: { kind: 'ellipse', center: [10, 10], radius: [10, 10] }, focusable: true, tabIndex: 2 },
      { id: 'custom-hit', parent: 'root', order: 5, hitArea: { kind: 'geometry', port: 'layout-path@1' } },
    ],
    listeners: [
      { id: 'root-capture', target: 'root', event: 'pointer-down', phases: ['capture'], actions: [report('root-capture')] },
      { id: 'button-down', target: 'button', event: 'pointer-down', phases: ['target'], pointerButton: 0, actions: [{ kind: 'pointer-capture' }, { kind: 'data-set', binding: 'b-score-raw', value: 42 }, { kind: 'state-input', machine: 'main', input: 'active', value: true }, report('button-down')] },
      { id: 'root-bubble', target: 'root', event: 'pointer-down', phases: ['bubble'], actions: [report('root-bubble')] },
      { id: 'button-enter', target: 'button', event: 'pointer-enter', phases: ['target'], actions: [report('pointer-enter')] },
      { id: 'button-exit', target: 'button', event: 'pointer-exit', phases: ['target'], actions: [report('pointer-exit')] },
      { id: 'button-move', target: 'button', event: 'pointer-move', phases: ['target'], actions: [report('pointer-move')] },
      { id: 'button-up', target: 'button', event: 'pointer-up', phases: ['target'], actions: [report('pointer-up')] },
      { id: 'button-drag-start', target: 'button', event: 'drag-start', phases: ['target'], actions: [report('drag-start')] },
      { id: 'button-drag', target: 'button', event: 'drag', phases: ['target'], actions: [report('drag')] },
      { id: 'button-drag-end', target: 'button', event: 'drag-end', phases: ['target'], actions: [{ kind: 'pointer-release' }, report('drag-end')] },
      { id: 'button-click', target: 'button', event: 'click', phases: ['target'], actions: [{ kind: 'data-trigger', binding: 'b-fire' }, { kind: 'property-group', group: 'activate' }, { kind: 'state-control', machine: 'main', operation: 'play' }, { kind: 'align-target', target: 'button', alignment: [0, 0], preserveOffset: true }, { kind: 'open-url', url: 'https://example.invalid/help', target: 'new-context' }, { kind: 'component-input', component: 'nested-card', input: 'open', value: true }, { kind: 'component-event', component: 'nested-card', event: 'pressed' }, { kind: 'audio', operation: 'play', target: 'click' }, { kind: 'semantic', operation: 'announce', target: 'button', value: 'pressed' }, { kind: 'custom', protocol: 'haiyue.listener.fixture@1', port: 'after-click' }] },
      { id: 'button-key', target: 'button', event: 'keyboard', phases: ['target'], key: 'Enter', keyPhase: 'down', modifiers: [], actions: [report('keyboard')] },
      { id: 'button-text', target: 'button', event: 'text-input', phases: ['target'], actions: [report('text-input')] },
      { id: 'button-data', target: 'button', event: 'data-change', phases: ['target'], actions: [report('data-change')] },
      { id: 'button-gamepad', target: 'button', event: 'gamepad', phases: ['target'], gamepad: { index: 0, control: 'south', phase: 'down' }, actions: [report('gamepad')] },
      { id: 'button-focus', target: 'button', event: 'focus', phases: ['target'], actions: [report('focus')] },
      { id: 'button-blur', target: 'button', event: 'blur', phases: ['target'], actions: [report('blur')] },
      { id: 'button-semantic', target: 'button', event: 'semantic-action', phases: ['target'], semanticAction: 'tap', actions: [report('semantic-tap')] },
      { id: 'knob-semantic-increase', target: 'knob', event: 'semantic-action', phases: ['target'], semanticAction: 'increase', actions: [report('semantic-increase')] },
      { id: 'knob-semantic-decrease', target: 'knob', event: 'semantic-action', phases: ['target'], semanticAction: 'decrease', actions: [report('semantic-decrease')] },
      { id: 'reported', target: 'button', event: 'reported-event', phases: ['target'], actions: [{ kind: 'component-event', component: 'nested-card', event: 'reported' }] },
    ],
  };
}

export function semanticsFixture() {
  return {
    format: 'haiyue-semantics', version: 1, extension: 'org.haiyue.semantics@1',
    nodes: [
      { id: 'semantic-root', target: 'root', role: 'group', label: { kind: 'literal', value: 'Demo' }, readingOrder: 0, navigationOrder: 0 },
      { id: 'semantic-button', target: 'button', parent: 'semantic-root', role: 'button', label: { kind: 'binding', binding: 'b-title-auto' }, value: { kind: 'binding', binding: 'b-score-raw' }, hint: { kind: 'literal', value: 'Activate' }, traits: ['button'], state: { hidden: { kind: 'binding', binding: 'b-hidden' }, disabled: { kind: 'binding', binding: 'b-disabled' } }, capabilities: { expandable: false, selectable: true, checkable: false, toggleable: false, requirable: false, enablable: true, focusable: true }, actions: ['tap', 'focus'], live: 'polite', readingOrder: 1, navigationOrder: 2 },
      { id: 'semantic-heading', target: 'root', parent: 'semantic-root', role: 'heading', label: { kind: 'literal', value: 'Status' }, headingLevel: 2, traits: ['header'], readingOrder: 0.5, navigationOrder: 1 },
      { id: 'semantic-slider', target: 'knob', parent: 'semantic-root', role: 'slider', label: { kind: 'literal', value: 'Volume' }, value: { kind: 'binding', binding: 'b-score-raw' }, traits: ['adjustable'], actions: ['increase', 'decrease', 'focus'], readingOrder: 2, navigationOrder: 1 },
    ],
    reducedMotion: { mode: 'respect', decorative: 'pause', essential: 'reduce', durationScale: 0.2, disableParallax: true },
  };
}

export async function loadG07Modules() {
  const [specRoot, runtimeRoot] = await Promise.all([
    transpileRoots([
      ['data-binding', new URL('../../animation-spec/src/data-binding/', import.meta.url)],
      ['interaction', new URL('../../animation-spec/src/interaction/', import.meta.url)],
      ['semantics', new URL('../../animation-spec/src/semantics/', import.meta.url)],
    ]),
    transpileRoots([['interaction', new URL('../src/animation/interaction/', import.meta.url)]]),
  ]);
  const [data, interaction, semantics, runtime] = await Promise.all([
    import(new URL('data-binding/index.js', specRoot).href), import(new URL('interaction/index.js', specRoot).href),
    import(new URL('semantics/index.js', specRoot).href), import(new URL('interaction/index.js', runtimeRoot).href),
  ]);
  return { data, interaction, semantics, runtime };
}

async function transpileRoots(roots) {
  const { mkdtemp, mkdir, readFile, readdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const path = await import('node:path'); const { fileURLToPath } = await import('node:url'); const ts = await import('typescript');
  const temporary = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-'));
  for (const [name, sourceUrl] of roots) { const sourceRoot = fileURLToPath(sourceUrl); for (const file of (await walk(sourceRoot, readdir, path)).filter(file => file.endsWith('.ts'))) { const output = path.join(temporary, name, path.relative(sourceRoot, file).replace(/\.ts$/, '.js')); await mkdir(path.dirname(output), { recursive: true }); const compiled = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText; await writeFile(output, compiled); } }
  return new URL(`file:///${temporary.replaceAll('\\', '/')}/`);
}
async function walk(directory, readdir, path) { const result = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const resolved = path.join(directory, entry.name); if (entry.isDirectory()) result.push(...await walk(resolved, readdir, path)); else result.push(resolved); } return result; }
