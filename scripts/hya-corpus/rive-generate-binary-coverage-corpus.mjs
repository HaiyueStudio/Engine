import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FROZEN_OBJECTS,
  FROZEN_PROPERTIES,
  FROZEN_REGISTRY_IDENTITY,
} from '../../animation-spec/dist-test/rive/import/generated/frozen-registry.js';
import { readFrozenRiv } from '../../animation-spec/dist-test/rive/import/read-riv.js';
import { RIVE_IMPORT_HARD_LIMITS } from '../../animation-spec/dist-test/rive/import/types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = resolve(root, 'animation-spec/corpus/rive/generated-coverage');
const fixturePath = resolve(outputRoot, 'all-binary-keys.riv');
const indexPath = resolve(outputRoot, 'rive-generated-binary-coverage.json');
const serializedProperties = FROZEN_PROPERTIES.filter(value => value.serialized);
const orderedObjects = orderObjects(FROZEN_OBJECTS);
const propertiesByTypeKey = assignProperties(orderedObjects, serializedProperties);
const bytes = riv(orderedObjects.map(value => object(
  value.typeKey,
  (propertiesByTypeKey.get(value.typeKey) ?? []).map(property => field(property.key, encodeValue(property.wireKind))),
)));
const parsed = readFrozenRiv(bytes, RIVE_IMPORT_HARD_LIMITS, {
  tupleId: 'rive-7.3-webgl2-2.40.0',
  inputSha256: hash(bytes),
  profile: 'binary-coverage',
  goal: 'g11-corpus-version-fidelity-performance',
});
const encounteredObjectTypeKeys = uniqueSorted(parsed.objects.map(value => value.source.typeKey));
const encounteredPropertyKeys = uniqueSorted(parsed.objects.flatMap(value => value.properties.map(property => property.source.key)));
const expectedObjectTypeKeys = uniqueSorted(FROZEN_OBJECTS.map(value => value.typeKey));
const expectedPropertyKeys = uniqueSorted(serializedProperties.map(value => value.key));
assertExact(encounteredObjectTypeKeys, expectedObjectTypeKeys, 'object type');
assertExact(encounteredPropertyKeys, expectedPropertyKeys, 'property');

mkdirSync(outputRoot, { recursive: true });
writeFileSync(fixturePath, bytes);
writeFileSync(indexPath, `${JSON.stringify({
  schemaVersion: 1,
  kind: 'haiyue-rive-generated-binary-coverage-corpus',
  generator: 'scripts/hya-corpus/rive-generate-binary-coverage-corpus.mjs@1',
  tupleId: 'rive-7.3-webgl2-2.40.0',
  registryIdentity: FROZEN_REGISTRY_IDENTITY,
  fixture: {
    path: posixRelative(fixturePath),
    sha256: hash(bytes),
    byteLength: bytes.byteLength,
    format: { major: 7, minor: 3 },
    license: { id: 'MIT', owner: 'HaiyueStudio', allowedUse: 'binary-wire-coverage' },
  },
  parser: 'animation-spec/src/rive/import/read-riv.ts:readFrozenRiv',
  coverage: {
    objectKeys: encounteredObjectTypeKeys,
    propertyKeys: encounteredPropertyKeys,
    assetTypeKeys: encounteredObjectTypeKeys.filter(key => [102, 105, 106, 141, 406, 529, 642, 649, 970].includes(key)),
  },
}, null, 2)}\n`);
console.log(`[rive-corpus] generated full binary-key coverage fixture (${encounteredObjectTypeKeys.length} objects, ${encounteredPropertyKeys.length} properties) at ${posixRelative(fixturePath)}.`);

function orderObjects(objects) {
  const artboard = objects.find(value => value.name === 'Artboard');
  if (!artboard) throw new Error('Frozen registry does not contain Artboard.');
  return [
    ...objects.filter(value => value !== artboard && !value.lineage.includes('Component')),
    artboard,
    ...objects.filter(value => value !== artboard && value.lineage.includes('Component')),
  ];
}

function assignProperties(objects, properties) {
  const output = new Map(objects.map(value => [value.typeKey, []]));
  for (const property of properties) {
    const owner = objects.find(value => value.lineage.includes(property.owner));
    if (!owner) throw new Error(`No frozen object can carry serialized property ${property.key} (${property.owner}.${property.name}).`);
    output.get(owner.typeKey).push(property);
  }
  return output;
}

function encodeValue(wireKind) {
  switch (wireKind) {
    case 'uint':
    case 'int': return vu(0);
    case 'bool': return [0];
    case 'string':
    case 'bytes': return vu(0);
    case 'double':
    case 'color': return [0, 0, 0, 0];
    default: throw new Error(`Unsupported frozen wire kind: ${wireKind}`);
  }
}

function vu(value) {
  let remaining = BigInt(value);
  const output = [];
  do {
    let byte = Number(remaining & 127n);
    remaining >>= 7n;
    if (remaining) byte |= 128;
    output.push(byte);
  } while (remaining);
  return output;
}

function text(value) { return [...new TextEncoder().encode(value)]; }
function field(key, payload) { return [...vu(key), ...payload]; }
function object(key, fields = []) { return [...vu(key), ...fields.flat(), 0]; }
function riv(objects) { return new Uint8Array([...text('RIVE'), ...vu(7), ...vu(3), 0, 0, ...objects.flat()]); }
function uniqueSorted(values) { return [...new Set(values)].sort((a, b) => a - b); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function posixRelative(path) { return relative(root, path).split('\\').join('/'); }
function assertExact(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter(value => !actual.includes(value));
    const extra = actual.filter(value => !expected.includes(value));
    throw new Error(`Generated ${label} coverage mismatch; missing=${missing.join(',')}; extra=${extra.join(',')}.`);
  }
}
