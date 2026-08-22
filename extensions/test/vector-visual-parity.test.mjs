import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const workspace = path.resolve(import.meta.dirname, '..', '..');
const runtime = await transpileTree(path.join(workspace, 'extensions/src/animation/vector'));
const contract = await transpileTree(path.join(workspace, 'animation-spec/src/vector2d'));
const { VectorVisualRuntime, renderVectorCpu } = runtime;
const { parseVectorVisualDocument, VectorVisualDiagnostic } = contract;

function neutralFixture() {
  return {
    format: 'haiyue-vector-visual', version: 1, width: 32, height: 24, duration: 2,
    resources: [{ id: 'pixels', kind: 'image', width: 2, height: 2, source: { kind: 'embedded', resource: 'pixels.bin' }, colorSpace: 'srgb', filter: 'nearest', wrapX: 'clamp', wrapY: 'clamp' }],
    nodes: [
      { id: 'mask-source', drawOrder: 0, geometries: [{ kind: 'ellipse', cx: 16, cy: 12, rx: 10, ry: 8 }], paints: [{ kind: 'fill', source: { kind: 'solid', color: [1, 1, 1, 1] } }] },
      {
        id: 'visual', drawOrder: 1, opacity: 0.9, transform: [1, 0, 0, 1, 0, 0], clips: ['outer'],
        geometries: [
          { kind: 'path', commands: 'MLLZ', values: [2, 2, 30, 2, 16, 22], topologyPolicy: 'stable', frames: [{ time: 0, commands: 'MLLZ', values: [2, 2, 30, 2, 16, 22] }, { time: 2, commands: 'MLLZ', values: [4, 2, 28, 2, 16, 20] }] },
          { kind: 'rectangle', x: 4, y: 4, width: 24, height: 16, radii: [2, 3, 4, 1] },
          { kind: 'polygon', cx: 16, cy: 12, radius: 8, points: 5 },
          { kind: 'star', cx: 16, cy: 12, outerRadius: 9, innerRadius: 4, points: 5 },
          { kind: 'triangle', points: [3, 20, 16, 3, 29, 20] },
          { kind: 'image', resource: 'pixels', x: 8, y: 6, width: 16, height: 12, fit: 'cover', alignment: [0, 0], mesh: { positions: [8, 6, 24, 6, 24, 18, 8, 18], uvs: [0, 0, 1, 0, 1, 1, 0, 1], indices: [0, 1, 2, 0, 2, 3] } },
          { kind: 'n-slice', source: { kind: 'image', resource: 'pixels' }, x: 1, y: 1, width: 30, height: 22, sourceSize: [20, 20], xCuts: [4, 16], yCuts: [4, 16] },
        ],
        paints: [
          { kind: 'fill', source: { kind: 'solid', color: [1, 0, 0, 0.75] }, fillRule: 'nonzero', blendMode: 'normal' },
          { kind: 'fill', source: { kind: 'linear-gradient', start: [0, 0], end: [32, 0], stops: [{ offset: 0, color: [0, 1, 0, 1] }, { offset: 1, color: [0, 0, 1, 1] }] }, blendMode: 'screen' },
          { kind: 'stroke', source: { kind: 'radial-gradient', center: [16, 12], radius: 16, stops: [{ offset: 0, color: [1, 1, 1, 1] }, { offset: 1, color: [0, 0, 0, 1] }] }, width: 2, cap: 'round', join: 'miter', miterLimit: 4, dash: [3, 2], dashOffset: 1, trim: { start: 0.1, end: 0.9, offset: 0.05, mode: 'individual' }, transformMode: 'fixed', blendMode: 'multiply' },
        ],
        effectGroups: [{ id: 'fx', target: 'visual', blendMode: 'overlay', effects: [{ kind: 'feather', radiusX: 1, radiusY: 2, offsetX: 0, offsetY: 0, inner: false, space: 'local' }, { kind: 'opacity', value: 0.8 }, { kind: 'custom-path-port', port: 'path-filter', inputs: { amount: 0.5 }, execution: 'external-only' }] }],
      },
    ],
    clips: [{ id: 'inner', source: 'mask-source', inverted: true }, { id: 'outer', source: 'mask-source', operation: 'intersect', children: ['inner'] }],
  };
}

test('frozen visual census maps every object and property to source-neutral fields', async () => {
  const mapping = JSON.parse(await readFile(path.join(workspace, 'animation-spec/schema/vector-visual-census-map.json'), 'utf8'));
  const schema = JSON.parse(await readFile(path.join(workspace, 'animation-spec/schema/vector-visual.schema.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(workspace, 'animation-spec/schema/vector-visual.contract.json'), 'utf8'));
  assert.equal(Object.keys(mapping.objects).length, 29);
  assert.equal(Object.keys(mapping.properties).length, 77);
  assert.deepEqual(mapping.unmapped, []);
  assert.equal(schema.properties.format.const, 'haiyue-vector-visual');
  assert.equal(manifest.sourceNeutral, true);
  assert.equal(manifest.sourceRuntimeDependency, false);
  assert.equal(JSON.stringify(schema).includes('Rive'), false);
  assert.equal(JSON.stringify(manifest).includes('Rive'), false);
});

test('parser freezes a complete neutral vector/paint/composite/image document before materialization', () => {
  const source = neutralFixture();
  const parsed = parseVectorVisualDocument(source);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.nodes[1].paints[1].source.stops));
  source.nodes[1].drawOrder = 99;
  assert.equal(parsed.nodes[1].drawOrder, 1);
  assert.equal(parsed.nodes[1].geometries.length, 7);
  assert.equal(parsed.nodes[1].paints.length, 3);
});

test('parser rejects invalid numbers, topology, graph references, cycles, feather and allocation budgets', () => {
  const cases = [
    [doc => { doc.nodes[1].geometries[0].values.pop(); }, 'E_VECTOR_FORMAT'],
    [doc => { doc.nodes[1].opacity = Number.NaN; }, 'E_VECTOR_NUMBER'],
    [doc => { doc.nodes[1].geometries[0].frames[1].commands = 'MLZ'; doc.nodes[1].geometries[0].frames[1].values = [1, 1, 2, 2]; }, 'E_VECTOR_TOPOLOGY'],
    [doc => { doc.nodes[1].clips = ['missing']; }, 'E_VECTOR_REFERENCE'],
    [doc => { doc.nodes[1].effectGroups[0].target = 'missing'; }, 'E_VECTOR_REFERENCE'],
    [doc => { doc.clips[0].children = ['outer']; }, 'E_VECTOR_CYCLE'],
    [doc => { doc.nodes[1].geometries[6].source = { kind: 'node', node: 'visual' }; }, 'E_VECTOR_CYCLE'],
    [doc => { doc.nodes[1].effectGroups[0].effects[0].radiusX = 5000; }, 'E_VECTOR_NUMBER'],
  ];
  for (const [mutate, code] of cases) {
    const document = neutralFixture(); mutate(document);
    assert.throws(() => parseVectorVisualDocument(document), error => error instanceof VectorVisualDiagnostic && error.code === code);
  }
  assert.throws(() => parseVectorVisualDocument(neutralFixture(), { limits: { maxCommands: 2 } }), error => error.code === 'E_VECTOR_LIMIT');
  assert.throws(() => parseVectorVisualDocument(neutralFixture(), { limits: { maxOffscreenPixels: 100 } }), error => error.code === 'E_VECTOR_LIMIT');
  assert.throws(() => parseVectorVisualDocument(neutralFixture(), { limits: { maxImagePixels: 1 } }), error => error.code === 'E_VECTOR_LIMIT');
});

test('runtime evaluates paint order, animated extremes, solo and seek/loop/resize/mix without prior-frame state', () => {
  const parsed = parseVectorVisualDocument(neutralFixture());
  const engine = new VectorVisualRuntime(parsed);
  const middleA = engine.evaluate({ time: 1, width: 48, height: 36, mix: { opacity: 0.5, transform: [1, 0, 0, 1, 2, 3] } });
  engine.evaluate({ time: 0 });
  const middleB = engine.evaluate({ time: 1, width: 48, height: 36, mix: { opacity: 0.5, transform: [1, 0, 0, 1, 2, 3] } });
  assert.deepEqual(middleA.operations, middleB.operations);
  assert.equal(middleA.width, 48);
  const visualOperations = middleA.operations.filter(operation => operation.nodeId === 'visual');
  assert.equal(visualOperations[0].opacity, 0.9 * 0.5);
  assert.deepEqual(visualOperations.slice(0, 3).map(operation => operation.paintIndex), [0, 1, 2]);
  assert.equal(engine.evaluate({ time: 5, loop: true }).time, 1);
  const soloDoc = structuredClone(parsed);
  soloDoc.nodes[1].solo = true;
  const solo = new VectorVisualRuntime(soloDoc).evaluate({ time: 0 });
  assert.ok(solo.operations.every(operation => operation.nodeId === 'visual'));
});

test('CPU reference covers solid/linear/radial paint, stroke/dash/trim, nested inverted clip and every blend family', () => {
  const document = neutralFixture();
  document.clips[0].inverted = false;
  document.clips[1].children = [];
  const parsed = parseVectorVisualDocument(document);
  const engine = new VectorVisualRuntime(parsed);
  const plan = engine.evaluate({ time: 1, width: 32, height: 24 });
  const image = renderVectorCpu(plan, { samples: 4, maxPixels: 32 * 24, resolveImage: () => ({ width: 2, height: 2, pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) }) });
  assert.equal(image.pixels.length, 32 * 24 * 4);
  assert.ok(image.pixels.some(value => value > 0));
  assert.ok(image.pixels.every(Number.isFinite));
  const modes = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'add', 'subtract'];
  for (const mode of modes) {
    document.nodes[1].paints[0].blendMode = mode;
    const pixels = renderVectorCpu(new VectorVisualRuntime(parseVectorVisualDocument(document)).evaluate({ time: 0 })).pixels;
    assert.ok(pixels.every(Number.isFinite), mode);
  }
});

test('CPU reference applies image fit, mesh UVs, sampling metadata and raster N-slice mapping', () => {
  const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const base = { format: 'haiyue-vector-visual', version: 1, width: 4, height: 4, resources: [{ id: 'image', kind: 'image', width: 2, height: 2, source: { kind: 'embedded', resource: 'image.bin' }, filter: 'nearest', wrapX: 'clamp', wrapY: 'clamp' }], clips: [] };
  const cases = [
    { kind: 'image', resource: 'image', x: 0, y: 0, width: 4, height: 4, fit: 'fill' },
    { kind: 'image', resource: 'image', x: 0, y: 0, width: 4, height: 4, mesh: { positions: [0, 0, 4, 0, 4, 4, 0, 4], uvs: [0, 0, 1, 0, 1, 1, 0, 1], indices: [0, 1, 2, 0, 2, 3] } },
    { kind: 'n-slice', source: { kind: 'image', resource: 'image' }, x: 0, y: 0, width: 4, height: 4, sourceSize: [2, 2], xCuts: [0.5, 1.5], yCuts: [0.5, 1.5] },
  ];
  for (const geometry of cases) {
    const parsed = parseVectorVisualDocument({ ...base, nodes: [{ id: 'image-node', drawOrder: 0, geometries: [geometry], paints: [] }] });
    const image = renderVectorCpu(new VectorVisualRuntime(parsed).evaluate({ time: 0 }), { resolveImage: () => ({ width: 2, height: 2, pixels }) });
    assert.ok(image.pixels.some(value => value === 1));
    assert.ok(image.pixels.every(Number.isFinite));
  }
});

test('device loss, target retirement and idempotent dispose leave no residual owners', () => {
  const engine = new VectorVisualRuntime(parseVectorVisualDocument(neutralFixture()));
  engine.evaluate({ time: 0 });
  let destroyed = 0;
  const target = engine.acquireTarget('view:32x24', 32 * 24, () => ({ id: 1 }), () => { destroyed++; });
  assert.equal(target.id, 1);
  engine.retireTarget('view:32x24');
  assert.equal(engine.stats.retiredEntries, 1);
  engine.afterSubmit();
  assert.equal(destroyed, 1);
  engine.acquireTarget('view:32x24', 32 * 24, () => ({ id: 2 }), () => { destroyed++; });
  engine.recoverDevice(7);
  assert.equal(destroyed, 2);
  assert.equal(engine.stats.deviceGeneration, 7);
  assert.equal(engine.stats.targetEntries, 0);
  engine.dispose(); engine.dispose();
  assert.deepEqual({ geometry: engine.stats.geometryEntries, paint: engine.stats.paintEntries, targets: engine.stats.targetEntries, retired: engine.stats.retiredEntries }, { geometry: 0, paint: 0, targets: 0, retired: 0 });
  assert.throws(() => engine.evaluate({ time: 0 }), /E_VECTOR_RUNTIME_DISPOSED/);
});

async function transpileTree(sourceRoot) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'haiyue-vector-test-'));
  const files = (await walk(sourceRoot)).filter(file => file.endsWith('.ts'));
  for (const file of files) {
    const relative = path.relative(sourceRoot, file);
    const output = path.join(temporary, relative.replace(/\.ts$/, '.js'));
    const source = await readFile(file, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    await writeFile(output, compiled);
  }
  return import(pathToFileURL(path.join(temporary, 'index.js')).href);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(resolved));
    else result.push(resolved);
  }
  return result;
}
