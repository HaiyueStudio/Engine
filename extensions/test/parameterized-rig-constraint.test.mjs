import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../..');
const contract = await transpileTree(path.join(root, 'animation-spec/src/deformable2d/parameterized'));
const runtime = await transpileTree(path.join(root, 'extensions/src/deformable-animation/parameterized'));
const { parseParameterizedRigDocument, encodeParameterizedRigDocument, decodeParameterizedRigDocument, ParameterizedRigDiagnostic } = contract;
const { ParameterizedRigSolver, RigRuntimeError, ParameterizedRigGpuSkinner } = runtime;

function rigFixture({ constraints = defaultConstraints(), instances = defaultInstances() } = {}) {
  return {
    format: 'haiyue-parameterized-rig-2d', version: 2, extension: 'org.haiyue.deformable-mesh-2d@2', width: 100, height: 100, duration: 2,
    parameters: [
      { id: 'x', default: 0, min: -10, max: 10 }, { id: 'y', default: 0, min: -10, max: 10 },
      { id: 'rotation', default: 0, min: -Math.PI, max: Math.PI }, { id: 'scroll', default: 0, min: -100, max: 100 },
      { id: 'velocity', default: 0, min: -100, max: 100 },
    ],
    rigs: [{
      id: 'arm',
      bones: [
        { id: 'root', length: 10, bind: transform(0, 0), inverseBind: [1, 0, 0, 1, 0, 0] },
        { id: 'child', parent: 'root', length: 10, bind: transform(10, 0), inverseBind: [1, 0, 0, 1, -10, 0] },
        { id: 'target', length: 0, bind: transform(15, 10), inverseBind: [1, 0, 0, 1, -15, -10] },
        { id: 'follower', length: 2, bind: transform(0, 20), inverseBind: [1, 0, 0, 1, 0, -20] },
        { id: 'scroller', length: 2, bind: transform(0, 0), inverseBind: [1, 0, 0, 1, 0, 0] },
      ],
      meshes: [{ id: 'mesh', positions: [10, 0, 20, 0, 10, 2], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2], influenceOffsets: [0, 1, 2, 3], jointIndices: [1, 1, 1], weights: [1, 1, 1] }],
      drawables: [{ id: 'drawable', mesh: 'mesh', texture: 'texture', visible: true, drawOrder: 2, opacity: 1, blendMode: 'normal', masks: [] }],
      paths: [{ id: 'route', points: [0, 30, 10, 30, 20, 40] }],
      constraints,
      drivers: [
        { id: 'move-root', parameter: 'x', input: [-10, 10], output: [-10, 10], target: { kind: 'bone', id: 'root', property: 'x' } },
        { id: 'rotate-child', parameter: 'rotation', input: [-Math.PI, Math.PI], output: [-Math.PI, Math.PI], target: { kind: 'bone', id: 'child', property: 'rotation' } },
        { id: 'fade', parameter: 'y', input: [-10, 10], output: [0, 1], target: { kind: 'drawable', id: 'drawable', property: 'opacity' } },
      ],
      joysticks: [{ id: 'stick', xParameter: 'x', yParameter: 'y', center: [50, 50], size: [100, 100] }],
    }],
    instances,
  };
}

function defaultConstraints() {
  return [
    { id: 'move', kind: 'translation', order: 0, strength: 0.5, constrained: 'follower', target: 'target', sourceSpace: 'world', destinationSpace: 'world', copyFactor: 1, copyFactorY: 1 },
    { id: 'rotate', kind: 'rotation', order: 1, strength: 0.5, constrained: 'follower', target: 'target', copyFactor: 1, offset: 0 },
    { id: 'scale', kind: 'scale', order: 2, strength: 0.5, constrained: 'follower', target: 'root', copyFactor: 1, copyFactorY: 1 },
    { id: 'path', kind: 'follow-path', order: 3, strength: 1, constrained: 'follower', path: 'route', distance: 15, orient: true },
    { id: 'scrolling', kind: 'scroll', order: 4, strength: 1, constrained: 'scroller', axis: 'x', offsetParameterX: 'scroll', velocityParameterX: 'velocity', viewport: [20, 20], content: [100, 20], physics: { kind: 'clamped', friction: 2, speedMultiplier: 1 } },
  ];
}
function defaultInstances() { return [{ id: 'main', rig: 'arm' }, { id: 'nested', rig: 'arm', parentInstance: 'main', parentBone: 'child', transform: transform(2, 0) }]; }
function transform(x, y, rotation = 0, scaleX = 1, scaleY = 1) { return { x, y, rotation, scaleX, scaleY, skew: 0 }; }

test('parameterized rig parser and HYRG 2.0 codec freeze a source-neutral deterministic ABI', () => {
  const source = rigFixture();
  source.rigs[0].drawables[0].culling = true;
  Object.assign(source.rigs[0].joysticks[0], { origin: [4, 5], handleDrawable: 'drawable', invertX: true });
  Object.assign(source.rigs[0].constraints.find(constraint => constraint.kind === 'scroll'), { virtualize: true, virtualizeBuffer: 2, interactive: true, threshold: 0.2, dragMultiplier: 1.5 });
  const parsed = parseParameterizedRigDocument(source);
  assert.ok(Object.isFrozen(parsed));
  assert.equal(parsed.extension, 'org.haiyue.deformable-mesh-2d@2');
  const first = encodeParameterizedRigDocument(parsed), second = encodeParameterizedRigDocument(parsed);
  assert.deepEqual(new Uint8Array(first), new Uint8Array(second));
  assert.equal(new DataView(first).getUint16(4, true), 2);
  const decoded = decodeParameterizedRigDocument(first);
  assert.deepEqual([...decoded.rigs[0].meshes[0].positions], [10, 0, 20, 0, 10, 2]);
  assert.deepEqual([...decoded.rigs[0].meshes[0].jointIndices], [1, 1, 1]);
  assert.deepEqual([...decoded.rigs[0].paths[0].points], [0, 30, 10, 30, 20, 40]);
  assert.equal(decoded.rigs[0].drawables[0].culling, true);
  assert.deepEqual(decoded.rigs[0].joysticks[0].origin, [4, 5]);
  assert.equal(decoded.rigs[0].constraints.find(constraint => constraint.kind === 'scroll').virtualizeBuffer, 2);
  const drawable = new ParameterizedRigSolver(decoded).evaluate({ time: 0 }).instances.get('main').drawables[0];
  assert.equal(drawable.texture, 'texture');
  assert.equal(drawable.culling, true);
});

test('published schema, binary contract and frozen census are complete and source-neutral', async () => {
  const schemaText = await readFile(path.join(root, 'animation-spec/schema/parameterized-rig-2d.schema.json'), 'utf8');
  const contractText = await readFile(path.join(root, 'animation-spec/schema/parameterized-rig-2d.contract.json'), 'utf8');
  const census = JSON.parse(await readFile(path.join(root, 'animation-spec/schema/parameterized-rig-census-map.json'), 'utf8'));
  const schema = JSON.parse(schemaText), binary = JSON.parse(contractText);
  assert.equal(schema.properties.extension.const, 'org.haiyue.deformable-mesh-2d@2');
  assert.equal(schema.additionalProperties, false);
  assert.equal(binary.binary.magic, 'HYRG');
  assert.equal(binary.compatibleLegacyExtension, 'org.haiyue.deformable-mesh-2d@1');
  assert.equal(binary.legacySemanticsChanged, false);
  assert.deepEqual(census.counts, { objects: 22, properties: 92 });
  assert.equal(Object.keys(census.objects).length, census.counts.objects);
  assert.equal(Object.keys(census.properties).length, census.counts.properties);
  assert.deepEqual(census.unmapped, []);
  assert.doesNotMatch(`${schemaText}\n${contractText}`, /\brive\b/i);
});

test('parser rejects invalid weights, cycles, references, NaN, degenerate paths and all hard budgets before runtime', () => {
  const cases = [
    [doc => { doc.rigs[0].meshes[0].weights[0] = 0.5; }, 'E_RIG_WEIGHT'],
    [doc => { doc.rigs[0].bones[0].parent = 'child'; }, 'E_RIG_CYCLE'],
    [doc => { doc.instances[0].parentInstance = 'nested'; }, 'E_RIG_CYCLE'],
    [doc => { doc.rigs[0].constraints[0].target = 'missing'; }, 'E_RIG_REFERENCE'],
    [doc => { doc.rigs[0].bones[0].bind.x = Number.NaN; }, 'E_RIG_NUMBER'],
    [doc => { doc.rigs[0].paths[0].points = [1, 1, 1, 1]; }, 'E_RIG_DEGENERATE'],
    [doc => { doc.rigs[0].constraints.push({ id: 'bad-ik', kind: 'ik', order: 9, strength: 1, constrained: 'child', target: 'target', chainLength: 2, iterations: 129 }); }, 'E_RIG_NUMBER'],
    [doc => { doc.rigs[0].drivers.push({ id: 'bad-driver', parameter: 'x', input: [0, 1], output: [0, 1], target: { kind: 'constraint', id: 'move', property: 'offset' } }); }, 'E_RIG_FORMAT'],
    [doc => { doc.rigs[0].constraints.push({ id: 'bad-bar', kind: 'scrollbar', order: 9, strength: 1, constrained: 'child', scrollConstraint: 'move' }); }, 'E_RIG_REFERENCE'],
    [doc => { doc.instances[0].parameterMap = { missing: 'x' }; }, 'E_RIG_REFERENCE'],
  ];
  for (const [mutate, code] of cases) { const document = rigFixture(); mutate(document); assert.throws(() => parseParameterizedRigDocument(document), error => error instanceof ParameterizedRigDiagnostic && error.code === code, code); }
  for (const limits of [{ maxBones: 2 }, { maxVertices: 2 }, { maxInfluences: 2 }, { maxConstraints: 2 }, { maxGpuBytes: 32 }]) assert.throws(() => parseParameterizedRigDocument(rigFixture(), { limits }), error => error.code === 'E_RIG_LIMIT');
  const binary = encodeParameterizedRigDocument(parseParameterizedRigDocument(rigFixture())); new DataView(binary).setUint16(6, 1, true);
  assert.throws(() => decodeParameterizedRigDocument(binary), error => error.code === 'E_RIG_BINARY');
});

test('ordered constraints, joystick, drivers, nested rig, random seek/rewind and parameter mixing are canonical', () => {
  const solver = new ParameterizedRigSolver(parseParameterizedRigDocument(rigFixture()));
  const options = { time: 0.75, parameters: { scroll: 10, velocity: 8, rotation: 0.25 }, joysticks: { 'main:stick': [75, 25] }, layers: [{ id: 'b', weight: 0.25, mode: 'additive', values: { rotation: 0.2 } }, { id: 'a', weight: 0.5, values: { rotation: -0.2 } }] };
  const first = solver.evaluate(options); solver.evaluate({ time: 0 }); const replay = solver.evaluate(options);
  assert.deepEqual(snapshot(first), snapshot(replay));
  const main = first.instances.get('main');
  assert.deepEqual(main.constraintOrder, ['move', 'rotate', 'scale', 'path', 'scrolling']);
  assert.ok(Math.abs(main.parameters.get('x') - 5) < 1e-9, 'joystick x resolves from canonical input');
  assert.ok(main.drawables[0].opacity < 0.5, 'joystick y drives drawable opacity');
  assert.ok(first.instances.get('nested').bones[0].world[4] !== main.bones[0].world[4], 'nested instance composes through parent bone');
  assert.equal(solver.evaluate({ time: 5, loop: true }).time, 1);
  assert.throws(() => solver.evaluate({ time: 0, layers: [{ id: 'same', weight: 1, values: { x: 1 } }, { id: 'same', weight: 1, values: { x: 2 } }] }), error => error.code === 'E_RIG_RUNTIME_FORMAT');
  assert.throws(() => solver.evaluate({ time: 0, layers: [{ id: 'bad', weight: Number.NaN, values: {} }] }), error => error.code === 'E_RIG_RUNTIME_FORMAT');
  assert.throws(() => solver.evaluate({ time: 0, joysticks: { stick: [Number.NaN, 0] } }), error => error.code === 'E_RIG_RUNTIME_FORMAT');
  solver.dispose(); solver.dispose();
  assert.throws(() => solver.evaluate({ time: 0 }), error => error instanceof RigRuntimeError && error.code === 'E_RIG_RUNTIME_DISPOSED');
});

test('distance/transform/translation/scale/rotation/follow-path/scrollbar families honor order, strength and spaces', () => {
  const evaluate = (constraint, mutate = () => {}) => {
    const document = rigFixture({ constraints: [constraint], instances: [{ id: 'main', rig: 'arm' }] }); mutate(document);
    return new ParameterizedRigSolver(parseParameterizedRigDocument(document)).evaluate({ time: 0, parameters: { scroll: 40 } }).instances.get('main');
  };
  const translation = evaluate({ id: 'translation', kind: 'translation', order: 0, strength: 0.5, constrained: 'follower', target: 'target', sourceSpace: 'world', destinationSpace: 'world' });
  const translated = translation.bones.find(bone => bone.id === 'follower'); assert.ok(Math.abs(translated.world[4] - 7.5) < 1e-6 && Math.abs(translated.world[5] - 15) < 1e-6);
  const distance = evaluate({ id: 'distance', kind: 'distance', order: 0, strength: 1, constrained: 'follower', target: 'target', distance: 5, mode: 'exact' });
  const distant = distance.bones.find(bone => bone.id === 'follower'), target = distance.bones.find(bone => bone.id === 'target'); assert.ok(Math.abs(Math.hypot(distant.world[4] - target.world[4], distant.world[5] - target.world[5]) - 5) < 1e-6);
  const rotation = evaluate({ id: 'rotation', kind: 'rotation', order: 0, strength: 0.5, constrained: 'follower', target: 'target', sourceSpace: 'world', destinationSpace: 'world' }, doc => { doc.rigs[0].bones[2].bind.rotation = 1; });
  assert.ok(Math.abs(Math.atan2(rotation.bones[3].world[1], rotation.bones[3].world[0]) - 0.5) < 1e-6);
  const scale = evaluate({ id: 'scale', kind: 'scale', order: 0, strength: 1, constrained: 'follower', target: 'target', sourceSpace: 'local', destinationSpace: 'local' }, doc => { doc.rigs[0].bones[2].bind.scaleX = 2; doc.rigs[0].bones[2].bind.scaleY = 3; });
  assert.ok(Math.abs(Math.hypot(scale.bones[3].world[0], scale.bones[3].world[1]) - 2) < 1e-6);
  const transformed = evaluate({ id: 'transform', kind: 'transform', order: 0, strength: 1, constrained: 'follower', target: 'target', sourceSpace: 'world', destinationSpace: 'world', copyFactor: 1, copyFactorY: 1, offset: transform(1, 2, 0.25, 0, 0) }, doc => { doc.rigs[0].bones[2].bind.rotation = 0.5; doc.rigs[0].bones[2].bind.scaleX = 2; doc.rigs[0].bones[2].bind.scaleY = 2; });
  assert.ok(Math.abs(transformed.bones[3].world[4] - 16) < 1e-6 && Math.abs(transformed.bones[3].world[5] - 12) < 1e-6);
  const pathPose = evaluate({ id: 'path', kind: 'follow-path', order: 0, strength: 1, constrained: 'follower', path: 'route', distance: 15, orient: true });
  assert.ok(pathPose.bones[3].world[4] > 10 && pathPose.bones[3].world[5] > 30);
  const scrollDocument = rigFixture({ constraints: [
    { id: 'scroll', kind: 'scroll', order: 0, strength: 1, constrained: 'scroller', axis: 'x', offsetParameterX: 'scroll', viewport: [20, 20], content: [100, 20] },
    { id: 'bar', kind: 'scrollbar', order: 1, strength: 1, constrained: 'follower', scrollConstraint: 'scroll', autoSize: true },
  ], instances: [{ id: 'main', rig: 'arm' }] });
  const scrollbar = new ParameterizedRigSolver(parseParameterizedRigDocument(scrollDocument)).evaluate({ time: 0, parameters: { scroll: 40 } }).instances.get('main').bones[3];
  assert.ok(Math.abs(Math.hypot(scrollbar.world[0], scrollbar.world[1]) - 0.2) < 1e-6);

  const limited = evaluate({ id: 'limited', kind: 'translation', order: 0, strength: 1, constrained: 'follower', target: 'target', sourceSpace: 'world', destinationSpace: 'local', limitSpace: 'world', minX: 25, maxX: 25 }, doc => { doc.rigs[0].bones[0].bind.x = 10; doc.rigs[0].bones[3].parent = 'root'; doc.rigs[0].bones[3].bind.x = 0; doc.rigs[0].bones[2].bind.x = 30; });
  assert.ok(Math.abs(limited.bones[3].world[4] - 25) < 1e-6, 'translation limits are applied in the declared space');

  const spanPath = evaluate({ id: 'span-path', kind: 'follow-path', order: 0, strength: 1, constrained: 'follower', path: 'route', distance: 0, distanceEnd: 20, orient: true });
  assert.ok(Math.atan2(spanPath.bones[3].world[1], spanPath.bones[3].world[0]) > 0.1, 'distanceEnd determines list span orientation');

  const closedPath = evaluate({ id: 'closed-path', kind: 'follow-path', order: 0, strength: 1, constrained: 'follower', path: 'route', distance: 51.50281539872885 }, doc => { doc.rigs[0].paths[0].closed = true; });
  assert.ok(Math.abs(closedPath.bones[3].world[4] - 5) < 1e-5 && Math.abs(closedPath.bones[3].world[5] - 30) < 1e-5, 'closed path distances wrap canonically');
});

test('nested rigs compose through a parent instance even without a parent bone', () => {
  const document = rigFixture({ constraints: [], instances: [{ id: 'main', rig: 'arm', transform: transform(7, 0) }, { id: 'nested', rig: 'arm', parentInstance: 'main', transform: transform(2, 0) }] });
  const result = new ParameterizedRigSolver(parseParameterizedRigDocument(document)).evaluate({ time: 0 });
  assert.ok(Math.abs(result.instances.get('nested').bones[0].world[4] - 9) < 1e-6);
});

test('analytic two-bone IK reaches its target and exposes exact non-convergence/degenerate failures', () => {
  const ik = [{ id: 'ik', kind: 'ik', order: 0, strength: 1, constrained: 'child', target: 'target', chainLength: 2, tolerance: 1e-4, iterations: 32, nonConvergence: 'error' }];
  const pose = new ParameterizedRigSolver(parseParameterizedRigDocument(rigFixture({ constraints: ik, instances: [{ id: 'main', rig: 'arm' }] }))).evaluate({ time: 0 }).instances.get('main');
  const child = pose.bones.find(bone => bone.id === 'child'), target = pose.bones.find(bone => bone.id === 'target');
  const tip = [child.world[0] * child.length + child.world[4], child.world[1] * child.length + child.world[5]];
  assert.ok(Math.hypot(tip[0] - target.world[4], tip[1] - target.world[5]) < 1e-4);
  const unreachable = rigFixture({ constraints: ik, instances: [{ id: 'main', rig: 'arm' }] }); unreachable.rigs[0].bones[2].bind.x = 100;
  assert.throws(() => new ParameterizedRigSolver(parseParameterizedRigDocument(unreachable)).evaluate({ time: 0 }), error => error.code === 'E_RIG_RUNTIME_NON_CONVERGENCE');
  const degenerate = rigFixture({ constraints: ik, instances: [{ id: 'main', rig: 'arm' }] }); degenerate.rigs[0].bones[0].length = 0;
  assert.throws(() => new ParameterizedRigSolver(parseParameterizedRigDocument(degenerate)).evaluate({ time: 0 }), error => error.code === 'E_RIG_RUNTIME_DEGENERATE');
  const coincident = rigFixture({ constraints: ik, instances: [{ id: 'main', rig: 'arm' }] }); coincident.rigs[0].bones[1].bind.x = 0;
  assert.throws(() => new ParameterizedRigSolver(parseParameterizedRigDocument(coincident)).evaluate({ time: 0 }), error => error.code === 'E_RIG_RUNTIME_DEGENERATE');
});

test('GPU skinner owns buffers, rebuilds after device loss and disposes without residuals', () => {
  installGpuConstants(); const first = fakeDevice(), second = fakeDevice();
  const skinner = new ParameterizedRigGpuSkinner(first.device, { maxGpuBytes: 1024 * 1024 });
  const document = parseParameterizedRigDocument(rigFixture({ constraints: [], instances: [{ id: 'main', rig: 'arm' }] }));
  const mesh = document.rigs[0].meshes[0]; skinner.uploadMesh('mesh', mesh, document.rigs[0].bones.length);
  const pose = new ParameterizedRigSolver(document).evaluate({ time: 0 }).instances.get('main');
  const encoder = first.device.createCommandEncoder(); skinner.skin('mesh', pose.bones, encoder);
  assert.equal(skinner.stats.meshCount, 1); assert.equal(skinner.stats.bufferCount, 7);
  skinner.recoverDevice(second.device, 4);
  assert.equal(skinner.stats.generation, 4); assert.equal(skinner.stats.meshCount, 1);
  assert.ok(first.buffers.every(buffer => buffer.destroyed));
  skinner.dispose(); skinner.dispose();
  assert.deepEqual({ meshes: skinner.stats.meshCount, buffers: skinner.stats.bufferCount, bytes: skinner.stats.allocatedBytes }, { meshes: 0, buffers: 0, bytes: 0 });
  assert.ok(second.buffers.every(buffer => buffer.destroyed));

  const limited = fakeDevice(); limited.device.limits.maxBufferSize = 32;
  const limitedSkinner = new ParameterizedRigGpuSkinner(limited.device);
  assert.throws(() => limitedSkinner.uploadMesh('mesh', mesh, document.rigs[0].bones.length), /E_RIG_GPU_UNSUPPORTED_LIMITS/);
  assert.equal(limitedSkinner.stats.meshCount, 0);
  limited.device.limits.maxBufferSize = 1024 * 1024;
  limitedSkinner.uploadMesh('mesh', mesh, document.rigs[0].bones.length);
  limitedSkinner.dispose();

  const tiled = fakeDevice(); tiled.device.limits.maxComputeWorkgroupsPerDimension = 1;
  const tiledSkinner = new ParameterizedRigGpuSkinner(tiled.device), vertexCount = 130;
  tiledSkinner.uploadMesh('wide', { id: 'wide', positions: new Float32Array(vertexCount * 2), uvs: new Float32Array(vertexCount * 2), indices: new Uint32Array([0, 1, 2]), influenceOffsets: Uint32Array.from({ length: vertexCount + 1 }, (_, index) => index), jointIndices: new Uint32Array(vertexCount), weights: new Float32Array(vertexCount).fill(1) }, 1);
  tiledSkinner.skin('wide', [{ id: 'root', parent: -1, length: 1, local: transform(0, 0), world: Float32Array.from([1, 0, 0, 1, 0, 0]), inverseBind: [1, 0, 0, 1, 0, 0] }], tiled.device.createCommandEncoder());
  assert.deepEqual(tiled.dispatches, [[1, 3]]);
  tiledSkinner.dispose();
});

function snapshot(result) { return [...result.instances].map(([id, pose]) => [id, pose.bones.map(bone => [...bone.world]), pose.meshes.map(mesh => [...mesh.positions]), pose.drawables.map(drawable => [drawable.id, drawable.visible, drawable.drawOrder, drawable.opacity])]); }
function installGpuConstants() { globalThis.GPUBufferUsage = { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, UNIFORM: 8, VERTEX: 16 }; }
function fakeDevice() {
  const buffers = [], dispatches = [];
  const layout = {};
  const device = {
    limits: { maxStorageBuffersPerShaderStage: 8, maxBufferSize: 1024 * 1024, maxStorageBufferBindingSize: 1024 * 1024, maxUniformBufferBindingSize: 1024 * 1024, maxComputeWorkgroupsPerDimension: 65535 }, lost: new Promise(() => {}),
    queue: { writeBuffer() {} },
    createShaderModule() { return {}; }, createComputePipeline() { return { getBindGroupLayout() { return layout; } }; },
    createBuffer(options) { const buffer = { size: options.size, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(buffer); return buffer; },
    createBindGroup(options) { return options; },
    createCommandEncoder() { return { beginComputePass() { return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups(...dimensions) { dispatches.push(dimensions); }, end() {} }; } }; },
  };
  return { device, buffers, dispatches };
}

async function transpileTree(sourceRoot) { const temporary = await mkdtemp(path.join(tmpdir(), 'haiyue-rig-test-')); for (const file of (await walk(sourceRoot)).filter(file => file.endsWith('.ts'))) { const output = path.join(temporary, path.relative(sourceRoot, file).replace(/\.ts$/, '.js')); const compiled = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText; await writeFile(output, compiled); } return import(pathToFileURL(path.join(temporary, 'index.js')).href); }
async function walk(directory) { const result = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const resolved = path.join(directory, entry.name); if (entry.isDirectory()) result.push(...await walk(resolved)); else result.push(resolved); } return result; }
