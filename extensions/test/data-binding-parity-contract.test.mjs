import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dataBindingFixture, interactionFixture, loadG07Modules, semanticsFixture } from './data-binding-parity-fixture.mjs';

const { data, interaction, semantics } = await loadG07Modules();

test('three source-neutral v1 contracts parse and deep-freeze the complete host surface', () => {
  const dataDocument = data.parseHyaDataBinding(dataBindingFixture()), interactionDocument = interaction.parseHyaInteraction(interactionFixture()), semanticsDocument = semantics.parseHyaSemantics(semanticsFixture());
  assert.equal(dataDocument.extension, 'org.haiyue.data-binding@1'); assert.equal(interactionDocument.extension, 'org.haiyue.interaction@1'); assert.equal(semanticsDocument.extension, 'org.haiyue.semantics@1');
  assert.ok([dataDocument, dataDocument.models, dataDocument.models[2].properties, interactionDocument, interactionDocument.listeners, semanticsDocument, semanticsDocument.nodes].every(Object.isFrozen));
  assert.deepEqual(new Set(dataDocument.models[2].properties.map(property => property.kind)), new Set(['number', 'integer', 'string', 'boolean', 'color', 'trigger', 'enum', 'model', 'list', 'image', 'artboard']));
  assert.deepEqual(new Set(interactionDocument.listeners.map(listener => listener.event)), new Set(['pointer-enter', 'pointer-exit', 'pointer-move', 'pointer-down', 'pointer-up', 'drag-start', 'drag', 'drag-end', 'click', 'keyboard', 'text-input', 'gamepad', 'focus', 'blur', 'data-change', 'semantic-action', 'reported-event']));
});

test('strict parsers reject unknown fields, cycles, references, singular transforms and hard budgets before runtime', () => {
  const unknown = dataBindingFixture(); unknown.models[0].surprise = true;
  assert.throws(() => data.parseHyaDataBinding(unknown), error => error.code === 'E_DATA_BINDING_FORMAT' && error.path === '$.models[0].surprise');
  const cycle = dataBindingFixture(); cycle.models[0].properties.push({ id: 'root', kind: 'model', model: 'Root' });
  assert.throws(() => data.parseHyaDataBinding(cycle), error => error.code === 'E_DATA_BINDING_GRAPH');
  const enumValue = dataBindingFixture(); enumValue.instances.find(instance => instance.id === 'root-local').values.status = 9;
  assert.throws(() => data.parseHyaDataBinding(enumValue), error => error.code === 'E_DATA_BINDING_TYPE');
  assert.throws(() => data.parseHyaDataBinding(dataBindingFixture(), { limits: { maxListItems: 1 } }), error => error.code === 'E_DATA_BINDING_LIMIT');
  const deepPath = dataBindingFixture(); deepPath.bindings[0].source.path = ['score', 'a', 'b', 'c']; assert.throws(() => data.parseHyaDataBinding(deepPath, { limits: { maxPathDepth: 3 } }), error => error.code === 'E_DATA_BINDING_LIMIT');
  const singular = interactionFixture(); singular.targets[2].transform = [1, 0, 0, 0, 0, 0];
  assert.throws(() => interaction.parseHyaInteraction(singular), error => error.code === 'E_INTERACTION_NUMBER');
  const reference = interactionFixture(); reference.listeners[0].target = 'missing';
  assert.throws(() => interaction.parseHyaInteraction(reference), error => error.code === 'E_INTERACTION_REFERENCE');
  const semanticCycle = semanticsFixture(); semanticCycle.nodes[0].parent = 'semantic-button';
  assert.throws(() => semantics.parseHyaSemantics(semanticCycle), error => error.code === 'E_SEMANTICS_GRAPH');
  const badHeading = semanticsFixture(); badHeading.nodes[2].headingLevel = 7;
  assert.throws(() => semantics.parseHyaSemantics(badHeading), error => error.code === 'E_SEMANTICS_NUMBER');
});

test('frozen data interaction accessibility census identities are exact and every entry has one neutral solution family', async () => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), census = JSON.parse(await readFile(path.join(workspace, 'docs/for-ai/rive-hya/runtime-census.json'), 'utf8')), contract = interaction.G07_CENSUS_CONTRACT;
  const objects = census.objects.filter(entry => entry.goal === contract.goal), properties = census.properties.filter(entry => entry.goal === contract.goal);
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(census.compatibilityTupleId, 'rive-7.3-webgl2-2.40.0'); assert.equal(objects.length, contract.objectCount); assert.equal(properties.length, contract.propertyCount);
  assert.equal(digest(objects.map(entry => `${entry.typeKey}:${entry.name}`)), contract.objectIdentitySha256);
  assert.equal(digest(properties.map(entry => `${entry.key}:${entry.owner}.${entry.name}`)), contract.propertyIdentitySha256);
  assert.ok([...objects, ...properties].every(entry => entry.family === contract.family && entry.fixtureOwner === contract.goal && entry.diagnostic && entry.diagnostic !== 'UNCLASSIFIED'));
  assert.equal(contract.solutions.length, 12); assert.equal(new Set(contract.solutions).size, contract.solutions.length);
});

test('playback contracts and runtime contain no source-format branch or class vocabulary', async () => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), roots = ['animation-spec/src/data-binding', 'animation-spec/src/interaction', 'animation-spec/src/semantics', 'extensions/src/animation/interaction'];
  const files = (await Promise.all(roots.map(root => walk(path.join(workspace, root))))).flat().filter(file => file.endsWith('.ts'));
  for (const file of files) assert.doesNotMatch(await readFile(file, 'utf8'), /rive/i, file);
});

async function walk(directory) { const { readdir } = await import('node:fs/promises'); const entries = await readdir(directory, { withFileTypes: true }), result = []; for (const entry of entries) { const file = path.join(directory, entry.name); if (entry.isDirectory()) result.push(...await walk(file)); else result.push(file); } return result; }
