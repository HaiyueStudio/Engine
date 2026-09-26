import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { emitLineVariantExpression } from '../scripts/shader-source-variant.mjs';
import { compileProductionMaterialLightingFamilyV1 } from '../dist/index.js';

test('source variants preserve exact bytes, escapes, Unicode and unchanged lines', () => {
  for (const [base, variant] of [
    ['', ''], ['same\n', 'same\n'], ['first\nmid\nlast', 'changed\nmid\nend'],
    ['// 😀\nfalse\nkeep\n', '// 中文\ntrue\nkeep\n'],
    ['a\nb\nc\n', '"quoted"\\\nb\n${literal}\n'],
  ]) assert.equal(runInNewContext(emitLineVariantExpression('source', base, variant), { source: base }), variant);
  assert.throws(() => emitLineVariantExpression('x();', 'a', 'b'), /identifier/);
  assert.throws(() => emitLineVariantExpression('source', 'a\nb', 'one'), /line count/);
});

test('assembled PBR variants equal complete compiler output including provenance', async () => {
  const source = await readFile(new URL('../builtin-material-lighting-family.json', import.meta.url), 'utf8');
  const compiled = compileProductionMaterialLightingFamilyV1(source, {
    sourcePath: 'shader-language/builtin-material-lighting-family.json',
    sourceSha256: createHash('sha256').update(source).digest('hex'),
  });
  for (const id of ['pbr-clearcoat', 'pbr-transmission', 'pbr-transmission-clearcoat']) {
    const expected = compiled.passes[id].code;
    const expression = emitLineVariantExpression('base', compiled.passes.pbr.code, expected);
    assert.equal(runInNewContext(expression, { base: compiled.passes.pbr.code }), expected, id);
    assert.ok(expression.length < expected.length / 10, 'variant assembly must reuse the common source');
  }
});


test('compact metadata preserves quoted keys, prototype keys and nested values', async () => {
  const { compactArtifactLiteral } = await import('../scripts/compact-artifact-literal.mjs');
  const value = JSON.parse('{"__proto__":{"safe":true},"a-b":[null,false,3,"quote\\""],"normal":{"$key":1}}');
  const actual = runInNewContext(`(${compactArtifactLiteral(value)})`);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), value);
  assert.equal(Object.prototype.hasOwnProperty.call(actual, '__proto__'), true);
  for (const invalid of [undefined, NaN, Infinity, () => {}, new Date()]) {
    assert.throws(() => compactArtifactLiteral(invalid), /JSON-compatible/);
  }
});
