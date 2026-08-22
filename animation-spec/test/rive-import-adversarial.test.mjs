import assert from 'node:assert/strict';
import test from 'node:test';

import { RiveImportError, importFrozenRiv } from '../dist-test/conversion/rive-ir/index.js';

const vu = value => { let n = BigInt(value); const out = []; do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; out.push(b); } while (n); return out; };
const text = value => [...new TextEncoder().encode(value)];
const str = value => [...vu(text(value).length), ...text(value)];
const blob = bytes => [...vu(bytes.length), ...bytes];
const u32 = value => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value, true); return [...b]; };
const field = (key, payload) => [...vu(key), ...payload];
const object = (key, fields = []) => [...vu(key), ...fields.flat(), 0];
const riv = (objects = [], major = 7, minor = 3, toc = []) => {
  const out = [...text('RIVE'), ...vu(major), ...vu(minor), 0, ...toc.flatMap(item => vu(item.key)), 0];
  for (let i = 0; i < toc.length; i += 4) {
    let packed = 0;
    for (let slot = 0; slot < 4 && i + slot < toc.length; slot++) packed |= toc[i + slot].type << (slot * 2);
    out.push(...u32(packed));
  }
  return new Uint8Array([...out, ...objects.flat()]);
};

const code = expected => error => {
  assert.ok(error instanceof RiveImportError, error?.stack);
  assert.equal(error.code, expected);
  assert.equal(error.domain, 'animation-import');
  assert.ok(error.path.startsWith('$'));
  return true;
};

test('rejects incompatible major and every non-frozen minor before objects', async () => {
  await assert.rejects(importFrozenRiv(riv([], 8, 3)), code('E_RIVE_FORMAT_MAJOR_UNSUPPORTED'));
  await assert.rejects(importFrozenRiv(riv([], 7, 4)), code('E_RIVE_FORMAT_MINOR_UNSUPPORTED'));
  await assert.rejects(importFrozenRiv(riv([], 7, 2)), code('E_RIVE_FORMAT_MINOR_UNSUPPORTED'));
});

test('rejects malformed fingerprint, truncation, varint overflow, and ToC conflict/duplicates', async () => {
  await assert.rejects(importFrozenRiv(new Uint8Array(text('NOPE'))), code('E_RIVE_INVALID_FINGERPRINT'));
  await assert.rejects(importFrozenRiv(new Uint8Array([...text('RIVE'), ...Array(10).fill(0x80)])), code('E_RIVE_VARINT_OVERFLOW'));
  await assert.rejects(importFrozenRiv(riv([object(1, [field(4, [...vu(5), 65, 66])])])), code('E_RIVE_TRUNCATED'));
  await assert.rejects(importFrozenRiv(riv([], 7, 3, [{ key: 4, type: 0 }])), code('E_RIVE_TOC_INVALID'));
  await assert.rejects(importFrozenRiv(riv([], 7, 3, [{ key: 4, type: 1 }, { key: 4, type: 1 }])), code('E_RIVE_TOC_INVALID'));
});

test('random unknown object ids and property ids can never become no-ops', async () => {
  for (const key of [65535, 65001, 64007, 63011]) {
    await assert.rejects(importFrozenRiv(riv([object(key)])), code('E_RIVE_UNKNOWN_OBJECT'));
    await assert.rejects(importFrozenRiv(riv([object(1, [field(key, [])])])), code('E_RIVE_UNKNOWN_PROPERTY'));
  }
  await assert.rejects(importFrozenRiv(riv([], 7, 3, [{ key: 65535, type: 0 }])), code('E_RIVE_UNKNOWN_PROPERTY'));
  await assert.rejects(importFrozenRiv(riv([object(1, [field(70, [])])])), code('E_RIVE_UNSUPPORTED_PROPERTY'));
});

test('reference range, hierarchy cycles, and depth bombs are exact failures', async () => {
  await assert.rejects(importFrozenRiv(riv([object(1), object(2, [field(5, vu(99))])])), code('E_RIVE_REFERENCE_INVALID'));
  await assert.rejects(importFrozenRiv(riv([
    object(1), object(2, [field(5, vu(2))]), object(2, [field(5, vu(1))]),
  ])), code('E_RIVE_REFERENCE_CYCLE'));
  const chain = [object(1)];
  for (let index = 1; index < 8; index++) chain.push(object(2, [field(5, vu(index - 1))]));
  await assert.rejects(importFrozenRiv(riv(chain), { limits: { referenceDepth: 3 } }), code('E_RIVE_LIMIT_EXCEEDED'));
});

test('object/property/list budgets fire before the next materialization', async () => {
  await assert.rejects(importFrozenRiv(riv([object(1), object(2)]), { limits: { objects: 1 } }), code('E_RIVE_LIMIT_EXCEEDED'));
  await assert.rejects(importFrozenRiv(riv([object(1, [field(4, str('a')), field(7, u32(0))])]), { limits: { propertyAssignments: 1 } }), code('E_RIVE_LIMIT_EXCEEDED'));
  await assert.rejects(importFrozenRiv(riv([object(643, [field(920, blob([0, 0, 0, 0]))])]), { limits: { listItems: 3 } }), code('E_RIVE_LIMIT_EXCEEDED'));
  await assert.rejects(importFrozenRiv(riv([object(1), object(92), object(92)]), { limits: { artboardInstances: 1 } }), code('E_RIVE_LIMIT_EXCEEDED'));
  await assert.rejects(importFrozenRiv(riv([object(1)]), { limits: { decodedWorkingSetBytes: 64 } }), code('E_RIVE_LIMIT_EXCEEDED'));
});

test('truncation fuzz corpus produces only success or structured RiveImportError', async () => {
  const seed = riv([object(1, [field(4, str('fuzz'))]), object(2, [field(5, vu(0))])]);
  for (let length = 0; length <= seed.length; length++) {
    try {
      await importFrozenRiv(seed.slice(0, length));
    } catch (error) {
      assert.ok(error instanceof RiveImportError, `length=${length}: ${error?.stack}`);
    }
  }
  let state = 0x12345678;
  for (let sample = 0; sample < 64; sample++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const mutated = seed.slice();
    mutated[state % mutated.length] ^= (state >>> 8) & 0xff;
    try { await importFrozenRiv(mutated); } catch (error) { assert.ok(error instanceof RiveImportError); }
  }
});
