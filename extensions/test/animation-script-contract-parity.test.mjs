import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadG09Modules, scriptDocumentFixture } from './animation-script-parity-fixture.mjs';

const { script } = await loadG09Modules();

test('sandboxed script v1 freezes portable artifacts for every neutral protocol', () => {
  const parsed = script.parseSandboxedAnimationScriptDocument(scriptDocumentFixture());
  assert.equal(parsed.extension, 'org.haiyue.sandboxed-animation-script@1');
  assert.deepEqual(parsed.programs.map(program => program.protocol), [
    'node', 'layout', 'converter', 'path-effect', 'transition-condition', 'listener-action', 'util',
  ]);
  assert.equal(parsed.language.sourcePolicy, 'build-time-only');
  assert.equal(parsed.language.modulePolicy, 'closed-manifest');
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.programs));
  assert.ok(Object.isFrozen(parsed.programs[0].functions[0].instructions));
  assert.ok(Object.isFrozen(parsed.shaders[0].bindings));
});

test('parser rejects source execution, unknown versions, prototype keys, cycles and private locations', () => {
  const source = scriptDocumentFixture();
  source.programs[0].sourceText = 'return 1';
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(source), error => error.code === 'E_ANIMATION_SCRIPT_FORMAT' && error.path.endsWith('.sourceText'));

  const version = scriptDocumentFixture();
  version.version = 2;
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(version), error => error.code === 'E_ANIMATION_SCRIPT_VERSION');

  const revision = scriptDocumentFixture();
  revision.language.sourceRevisionSha256 = '0'.repeat(64);
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(revision), error => error.code === 'E_ANIMATION_SCRIPT_PROTOCOL');

  const polluted = scriptDocumentFixture();
  polluted.programs[0].functions[0].instructions = [{ op: 'load-input', to: 0, name: '__proto__' }, { op: 'return' }];
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(polluted), error => error.code === 'E_ANIMATION_SCRIPT_FORMAT');

  const privatePath = scriptDocumentFixture();
  privatePath.programs[0].functions[0].instructions = [{ op: 'return', location: { sourceId: 'C:\\secret\\asset.lua', line: 1, column: 1 } }];
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(privatePath), error => error.code === 'E_ANIMATION_SCRIPT_FORMAT');

  const cyclic = scriptDocumentFixture();
  cyclic.self = cyclic;
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(cyclic), error => error.code === 'E_ANIMATION_SCRIPT_FORMAT');

  let accessorReads = 0;
  const accessor = scriptDocumentFixture();
  Object.defineProperty(accessor, 'extension', { enumerable: true, get() { accessorReads += 1; return 'forged'; } });
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(accessor), error => error.code === 'E_ANIMATION_SCRIPT_FORMAT');
  assert.equal(accessorReads, 0);

  const inherited = scriptDocumentFixture();
  Object.setPrototypeOf(inherited, { inherited: true });
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(inherited), error => error.code === 'E_ANIMATION_SCRIPT_FORMAT');
});

test('parser rejects instruction, register, reference, capability and protocol violations before runtime', () => {
  const instruction = scriptDocumentFixture();
  instruction.programs[0].functions[0].instructions = [{ op: 'global-get', to: 0 }, { op: 'return' }];
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(instruction), error => error.code === 'E_ANIMATION_SCRIPT_ARTIFACT');

  const register = scriptDocumentFixture();
  register.programs[0].functions[0].instructions = [{ op: 'move', to: 0, from: 9 }, { op: 'return' }];
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(register), error => error.code === 'E_ANIMATION_SCRIPT_LIMIT');

  const reference = scriptDocumentFixture();
  reference.programs[0].entrypoints.init = 'missing';
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(reference), error => error.code === 'E_ANIMATION_SCRIPT_REFERENCE');

  const emptyConstants = scriptDocumentFixture();
  emptyConstants.programs[0].constants = [];
  emptyConstants.programs[0].functions[0].instructions = [{ op: 'load-constant', to: 0, constant: 0 }, { op: 'return', value: 0 }];
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(emptyConstants), error => error.code === 'E_ANIMATION_SCRIPT_REFERENCE');

  const undeclared = scriptDocumentFixture();
  undeclared.programs[0].functions[0].instructions = [{ op: 'capability', capability: 'data.read', arguments: [] }, { op: 'return' }];
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(undeclared), error => error.code === 'E_ANIMATION_SCRIPT_CAPABILITY');

  const protocol = scriptDocumentFixture();
  protocol.programs.find(program => program.protocol === 'transition-condition').capabilities = ['data.write'];
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(protocol), error => error.code === 'E_ANIMATION_SCRIPT_CAPABILITY');
});

test('all CPU, heap, output, promise and shader ceilings are hard document limits', () => {
  for (const [key, value] of [
    ['maxPrograms', 129], ['maxProgramBytes', 1_048_577], ['maxFunctions', 513], ['maxInstructionsPerFunction', 16_385],
    ['maxInstructionsPerInvocation', 1_000_001], ['maxInstructionsPerScope', 10_000_001],
    ['maxHeapBytes', 16_777_217], ['maxOutputCommands', 4_097], ['maxPendingPromises', 65],
    ['maxShaderSourceBytes', 262_145], ['maxShaderBindings', 33], ['maxTextures', 17],
    ['maxStorageBytes', 67_108_865], ['maxDrawsPerFrame', 257],
  ]) {
    const document = scriptDocumentFixture();
    document.limits[key] = value;
    assert.throws(() => script.parseSandboxedAnimationScriptDocument(document), error => error.code === 'E_ANIMATION_SCRIPT_LIMIT', key);
  }
  const shader = scriptDocumentFixture();
  shader.shaders[0].bindings[0].maxBytes = 65_537;
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(shader), error => error.code === 'E_ANIMATION_SCRIPT_LIMIT');
});

test('frozen G09 census identities cover every object, property, module, symbol and asset', async () => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const census = JSON.parse(await readFile(path.join(workspace, 'docs/for-ai/rive-hya/runtime-census.json'), 'utf8'));
  const contract = script.G09_SCRIPT_CENSUS_CONTRACT;
  const objects = census.objects.filter(entry => entry.goal === contract.goal);
  const properties = census.properties.filter(entry => entry.goal === contract.goal);
  const modules = census.scripts.modules;
  const symbols = census.scripts.symbols.filter(entry => entry.goal === contract.goal);
  const assets = census.assets.filter(entry => entry.goal === contract.goal);
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(objects.length, contract.objectCount);
  assert.equal(properties.length, contract.propertyCount);
  assert.equal(modules.length, contract.moduleCount);
  assert.equal(symbols.length, contract.symbolCount);
  assert.equal(assets.length, contract.assetCount);
  assert.equal(digest(objects.map(entry => `${entry.typeKey}:${entry.name}`)), contract.objectIdentitySha256);
  assert.equal(digest(properties.map(entry => `${entry.key}:${entry.owner}.${entry.name}`)), contract.propertyIdentitySha256);
  assert.equal(digest(modules.map(entry => `${entry.name}:${entry.source}`)), contract.moduleIdentitySha256);
  assert.equal(digest(symbols.map(entry => `${entry.name}:${entry.source}`)), contract.symbolIdentitySha256);
  assert.equal(digest(assets.map(entry => `${entry.typeKey}:${entry.name}`)), contract.assetIdentitySha256);
  assert.ok([...objects, ...properties, ...symbols, ...assets].every(entry => entry.fixtureOwner === contract.goal && entry.diagnostic && entry.diagnostic !== 'UNCLASSIFIED'));
  assert.equal(new Set(contract.solutions).size, contract.solutions.length);
});

test('script contracts and runtime contain no source-format branch or class vocabulary', async () => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  for (const root of ['animation-spec/src/script', 'extensions/src/animation-script']) {
    for (const file of (await walk(path.join(workspace, root))).filter(file => file.endsWith('.ts'))) {
      assert.doesNotMatch(await readFile(file, 'utf8'), /rive/i, file);
    }
  }
});

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(resolved));
    else result.push(resolved);
  }
  return result;
}
