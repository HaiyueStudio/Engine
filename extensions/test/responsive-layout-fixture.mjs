export const embeddedBytes = [1, 2, 3];
export const embeddedIntegrity = 'sha256-A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=';
const point = value => ({ unit: 'point', value });
const fill = () => ({ unit: 'fill' });

export function responsiveLayoutFixture() {
  const metric = (glyphId, advance = 600, bounds = [0, -200, 560, 800]) => ({ glyphId, advance, bounds, axisAdvance: { wght: 0.05 } });
  return {
    format: 'haiyue-responsive-layout-2d', version: 1, extension: 'org.haiyue.layout-2d@1',
    shaping: { stack: 'haiyue-text-shaping@1', backendRevision: 'hb-test-1', unicodeVersion: '15.1', graphemeRevision: 'uax29-43', bidiRevision: 'uax9-50' },
    assets: [
      { id: 'font', kind: 'font', family: 'Fixture Sans', weight: 400, style: 'normal', source: { kind: 'embedded', data: embeddedBytes, integrity: embeddedIntegrity }, metrics: { unitsPerEm: 1000, ascent: 800, descent: -200, lineGap: 100, missingGlyph: metric(0), glyphs: { A: metric(1), B: metric(2), f: metric(3), i: metric(4), ' ': metric(5, 300, [0, 0, 0, 0]), 'א': metric(6), 'ב': metric(7), '\n': metric(8, 0, [0, 0, 0, 0]) }, ligatures: { fi: metric(20, 900) }, kerning: { 'A|fi': -50 }, axes: { wght: { min: 100, default: 400, max: 900 } } } },
      { id: 'image', kind: 'image', width: 16, height: 16, filter: 'linear', wrapX: 'repeat', wrapY: 'mirror', source: { kind: 'embedded', data: embeddedBytes, integrity: embeddedIntegrity } },
      { id: 'remote', kind: 'blob', source: { kind: 'referenced', uri: '/asset.bin', integrity: embeddedIntegrity }, signature: 'fixture' },
      { id: 'hosted', kind: 'blob', source: { kind: 'hosted', slot: 'hero', fallbackAsset: 'image', integrity: embeddedIntegrity } },
      { id: 'copy', kind: 'blob', source: { kind: 'embedded', data: embeddedBytes, integrity: embeddedIntegrity } },
      { id: 'folder', kind: 'folder', children: ['font', 'image', 'remote', 'hosted', 'copy'] },
      { id: 'manifest', kind: 'manifest', source: { kind: 'embedded', data: embeddedBytes, integrity: embeddedIntegrity }, entries: { hero: 'image' } },
      { id: 'captions', kind: 'text', folderPath: 'locale', encoding: 'utf-8', source: { kind: 'embedded', data: embeddedBytes, integrity: embeddedIntegrity } },
      { id: 'audio', kind: 'audio', duration: 1, sampleRate: 48000, channels: 2, source: { kind: 'embedded', data: embeddedBytes, integrity: embeddedIntegrity } }
    ],
    textStyles: [{ id: 'body', fontAssets: ['font'], fontFamily: 'Fixture Sans', fontWeight: 400, fontStyle: 'normal', fontSize: 20, lineHeight: 24, tracking: 1, alignment: 'start', verticalAlignment: 'middle', direction: 'auto', language: 'und', script: 'Zyyy', axes: { wght: 600 }, features: { liga: true }, fills: [{ source: { kind: 'solid', color: [0.9, 0.8, 0.2, 1] } }], strokes: [{ source: { kind: 'solid', color: [0.1, 0.2, 0.3, 1] }, width: 1, join: 'round' }], background: { color: [0, 0, 0, 0.2], cornerRadius: 3 } }],
    textBlocks: [{ id: 'label', runs: [{ id: 'run', style: 'body', text: 'A fi אב', valuePort: 'labelText' }], width: 100, height: 52, wrap: 'grapheme', overflow: 'clip', paragraphSpacing: 2, origin: [2, 1], verticalTrim: { top: 1, bottom: 1 }, modifiers: [
      { kind: 'transform', range: { start: 0, end: 100, units: 'percent', falloffFrom: 5, falloffTo: 5, increment: 0, offset: 0, mode: 'clamp', strength: 1 }, translation: [2, 3], scale: [1.1, 1], rotation: 0.1, opacity: 0.8, variables: { wght: 10 } },
      { kind: 'follow-path', range: { start: 0, end: 100, units: 'percent' }, points: [0, 0, 50, 10, 100, 0], orient: true, radial: false, start: 0, end: 100, offset: 0 }
    ], input: { valuePort: 'inputText', selectionPort: 'selection', cursorPort: 'cursor', multiline: true, selectionRadius: 2 } }],
    artboards: [
      { id: 'main', width: 320, height: 180, root: 'root', nodes: [
        { id: 'root', kind: 'container', style: { display: 'flex', direction: 'row', width: fill(), height: fill(), padding: [point(4), point(4), point(4), point(4)], gap: [point(4), point(4)], justify: 'start', align: 'start' }, visual: { background: [0.05, 0.05, 0.08, 1], clip: true, cornerRadius: [4, 4, 4, 4] } },
        { id: 'text', parent: 'root', kind: 'text', text: 'label', style: { width: point(100), height: point(52), minWidth: point(80), maxWidth: point(120), aspectRatio: 2, margin: [point(1), point(2), point(1), point(2)], reflow: { duration: 1, easing: [0.25, 0.1, 0.25, 1] } } },
        { id: 'component', parent: 'root', kind: 'component', style: { width: point(60), height: point(60) }, component: { artboard: 'card', fit: 'contain', alignment: [0, 0], sizing: 'layout', playback: { mode: 'mix', speed: 2, quantize: 0.25, stateful: true, remapPort: 'phase', mixPort: 'mix' }, exposedInputs: ['phase', 'mix'], exposedEvents: ['activate'] } },
        { id: 'list', parent: 'root', kind: 'list', style: { width: point(80), height: point(60), overflow: 'scroll' }, list: { dataPort: 'items', templateArtboard: 'item', direction: 'column', itemExtent: 20, gap: 2, virtualize: true, buffer: 1, carousel: true } },
        { id: 'slice', parent: 'root', kind: 'n-slice', style: { position: 'absolute', inset: [point(200), point(90), point(20), point(10)], width: point(100), height: point(70) }, nSlice: { source: { kind: 'asset', asset: 'image' }, sourceSize: [16, 16], xCuts: [4, 12], yCuts: [4, 12], tileModes: ['stretch', 'repeat', 'mirror', 'stretch', 'repeat', 'mirror', 'stretch', 'repeat', 'mirror'] } },
        { id: 'scroller', parent: 'root', kind: 'container', style: { position: 'absolute', inset: [point(5), point(120), point(0), point(0)], width: point(100), height: point(40), overflow: 'scroll' }, scroll: { axis: 'x', mode: 'clamped', snap: 10, friction: 2, scrollbar: { node: 'bar', autoSize: true } } },
        { id: 'wide', parent: 'scroller', kind: 'image', asset: 'image', intrinsicSize: [300, 30], style: { width: point(300), height: point(30) } },
        { id: 'bar', parent: 'scroller', kind: 'leaf', intrinsicSize: [20, 3], style: { position: 'absolute', inset: [point(0), point(35), point(0), point(0)], width: point(20), height: point(3) }, visual: { background: [1, 1, 1, 1] } }
      ] },
      { id: 'card', width: 60, height: 60, root: 'card-root', nodes: [{ id: 'card-root', kind: 'leaf', style: { width: fill(), height: fill() }, visual: { background: [0.2, 0.6, 0.9, 1], borderColor: [1, 1, 1, 1], borderWidth: [1, 1, 1, 1], cornerRadius: [8, 8, 8, 8] } }] },
      { id: 'alternate', width: 30, height: 50, root: 'alt-root', nodes: [{ id: 'alt-root', kind: 'leaf', style: { width: fill(), height: fill() }, visual: { background: [0.8, 0.2, 0.4, 1] } }] },
      { id: 'item', width: 80, height: 20, root: 'item-root', nodes: [{ id: 'item-root', kind: 'leaf', style: { width: fill(), height: fill() }, visual: { background: [0.1, 0.8, 0.3, 1] } }] }
    ],
    instances: [{ id: 'stage', artboard: 'main', fit: 'fill', alignment: [0, 0] }]
  };
}

export async function loadResponsiveLayoutModules(workspace) {
  const [specRoot, runtimeRoot] = await Promise.all([
    transpileTree(new URL('../../animation-spec/src/', import.meta.url)),
    transpileTree(new URL('../src/animation/', import.meta.url))
  ]);
  const [spec, layoutRuntime, textRuntime] = await Promise.all([
    import(new URL('layout2d/parameterized/index.js', specRoot).href),
    import(new URL('layout/parameterized/index.js', runtimeRoot).href),
    import(new URL('text/parameterized/index.js', runtimeRoot).href)
  ]);
  void workspace;
  return { spec, runtime: { ...layoutRuntime, ...textRuntime } };
}

async function transpileTree(sourceUrl) {
  const { mkdtemp, mkdir, readFile, readdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ts = await import('typescript');
  const sourceRoot = fileURLToPath(sourceUrl), temporary = await mkdtemp(path.join(tmpdir(), 'haiyue-layout-test-'));
  for (const file of (await walk(sourceRoot, readdir, path)).filter(file => file.endsWith('.ts'))) {
    const output = path.join(temporary, path.relative(sourceRoot, file).replace(/\.ts$/, '.js'));
    await mkdir(path.dirname(output), { recursive: true });
    const compiled = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    await writeFile(output, compiled);
  }
  return new URL(`file:///${temporary.replaceAll('\\', '/')}/`);
}
async function walk(directory, readdir, path) { const result = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const resolved = path.join(directory, entry.name); if (entry.isDirectory()) result.push(...await walk(resolved, readdir, path)); else result.push(resolved); } return result; }
