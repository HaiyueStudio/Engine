import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = resolve(root, 'animation-spec/corpus/rive/generated-parser');
const cases = createCases();
const records = [];
for (const fixture of cases) {
  const directory = fixture.suite === 'version' ? 'version' : 'security';
  const path = resolve(outputRoot, directory, `${fixture.id}.riv`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fixture.bytes);
  records.push({
    id: fixture.id,
    suite: fixture.suite,
    path: relative(root, path).split('\\').join('/'),
    byteLength: fixture.bytes.byteLength,
    sha256: createHash('sha256').update(fixture.bytes).digest('hex'),
    expected: fixture.expected,
    options: fixture.options ?? {},
  });
}
const indexPath = resolve(outputRoot, 'rive-generated-parser-corpus.json');
writeFileSync(indexPath, `${JSON.stringify({
  schemaVersion: 1,
  kind: 'haiyue-rive-generated-parser-corpus',
  generator: 'scripts/hya-corpus/rive-generate-parser-corpus.mjs@1',
  tupleId: 'rive-7.3-webgl2-2.40.0',
  cases: records,
}, null, 2)}\n`);
console.log(`[rive-corpus] generated ${records.length} deterministic parser/version fixtures under ${relative(root, outputRoot)}.`);

function createCases() {
  return [
    fixture('7.2-reject-outside-denominator', 'version', riv([], 7, 2), 'E_RIVE_FORMAT_MINOR_UNSUPPORTED'),
    fixture('7.3-accept', 'version', riv([], 7, 3), 'accepted'),
    fixture('7.4-reject', 'version', riv([], 7, 4), 'E_RIVE_FORMAT_MINOR_UNSUPPORTED'),
    fixture('8.0-reject', 'version', riv([], 8, 0), 'E_RIVE_FORMAT_MAJOR_UNSUPPORTED'),
    fixture('invalid-fingerprint', 'security', new Uint8Array(text('NOPE')), 'E_RIVE_INVALID_FINGERPRINT'),
    fixture('truncated-header', 'security', new Uint8Array(text('RIVE')), 'E_RIVE_TRUNCATED'),
    fixture('varuint-overflow', 'security', new Uint8Array([...text('RIVE'), ...Array(10).fill(0x80)]), 'E_RIVE_VARINT_OVERFLOW'),
    fixture('toc-unknown-key', 'security', riv([], 7, 3, [{ key: 65535, type: 0 }]), 'E_RIVE_UNKNOWN_PROPERTY'),
    fixture('toc-duplicate-key', 'security', riv([], 7, 3, [{ key: 4, type: 1 }, { key: 4, type: 1 }]), 'E_RIVE_TOC_INVALID'),
    fixture('toc-field-type-conflict', 'security', riv([], 7, 3, [{ key: 4, type: 0 }]), 'E_RIVE_TOC_INVALID'),
    fixture('unknown-object', 'security', riv([object(65535)]), 'E_RIVE_UNKNOWN_OBJECT'),
    fixture('unknown-property', 'security', riv([object(1, [field(65535, [])])]), 'E_RIVE_UNKNOWN_PROPERTY'),
    fixture('unsupported-property', 'security', riv([object(1, [field(70, [])])]), 'E_RIVE_UNSUPPORTED_PROPERTY'),
    fixture('invalid-parent', 'security', riv([object(1), object(2, [field(5, vu(99))])]), 'E_RIVE_REFERENCE_INVALID'),
    fixture('reference-cycle', 'security', riv([
      object(1), object(2, [field(5, vu(2))]), object(2, [field(5, vu(1))]),
    ]), 'E_RIVE_REFERENCE_CYCLE'),
    fixture('reference-depth-bomb', 'security', riv(depthChain(8)), 'E_RIVE_LIMIT_EXCEEDED', { limits: { referenceDepth: 3 } }),
    fixture('object-count-bomb', 'security', riv([object(1), object(2)]), 'E_RIVE_LIMIT_EXCEEDED', { limits: { objects: 1 } }),
    fixture('property-count-bomb', 'security', riv([
      object(1, [field(4, str('a')), field(7, u32(0))]),
    ]), 'E_RIVE_LIMIT_EXCEEDED', { limits: { propertyAssignments: 1 } }),
    fixture('nested-list-expansion', 'security', riv([
      object(643, [field(920, blob([0, 0, 0, 0]))]),
    ]), 'E_RIVE_LIMIT_EXCEEDED', { limits: { listItems: 3 } }),
  ];
}

function fixture(id, suite, bytes, expected, options) {
  return { id, suite, bytes, expected, options };
}

function depthChain(length) {
  const chain = [object(1)];
  for (let index = 1; index < length; index++) chain.push(object(2, [field(5, vu(index - 1))]));
  return chain;
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

function text(value) {
  return [...new TextEncoder().encode(value)];
}

function str(value) {
  const bytes = text(value);
  return [...vu(bytes.length), ...bytes];
}

function blob(bytes) {
  return [...vu(bytes.length), ...bytes];
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return [...bytes];
}

function field(key, payload) {
  return [...vu(key), ...payload];
}

function object(key, fields = []) {
  return [...vu(key), ...fields.flat(), 0];
}

function riv(objects = [], major = 7, minor = 3, toc = []) {
  const output = [...text('RIVE'), ...vu(major), ...vu(minor), 0, ...toc.flatMap(item => vu(item.key)), 0];
  for (let index = 0; index < toc.length; index += 4) {
    let packed = 0;
    for (let slot = 0; slot < 4 && index + slot < toc.length; slot++) packed |= toc[index + slot].type << (slot * 2);
    output.push(...u32(packed));
  }
  return new Uint8Array([...output, ...objects.flat()]);
}
