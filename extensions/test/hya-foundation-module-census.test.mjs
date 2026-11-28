import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, resolve} from 'node:path';
import {assertFoundationModuleCensus} from './helpers/hya-foundation-module-census.mjs';

function fixture(t) {
  const parent = resolve(tmpdir()), directory = mkdtempSync(resolve(parent, 'haiyue-hya-foundation-'));
  t.after(() => {
    assert.equal(dirname(directory), parent);
    assert.ok(basename(directory).startsWith('haiyue-hya-foundation-'));
    rmSync(directory, {recursive: true, force: true});
  });
  const modules = {'cubism': ['licensed-clip-baked'], 'cubism.ts': ['licensed-clip-baked'], 'parser.ts': ['core-container'], 'composition': ['composition-format']};
  writeFileSync(resolve(directory, 'cubism.ts'), "export * from './live2d/index';\n");
  writeFileSync(resolve(directory, 'parser.ts'), 'export {};\n');
  mkdirSync(resolve(directory, 'composition'));
  writeFileSync(resolve(directory, 'composition/index.ts'), 'export {};\n');
  return {directory, modules, check: () => assertFoundationModuleCensus(directory, modules)};
}

test('foundation census works in a clean source archive and with local empty-directory residue', t => {
  const f = fixture(t);
  f.check(); // Git checkout: the old cubism directory is absent.
  mkdirSync(resolve(f.directory, 'cubism'));
  mkdirSync(resolve(f.directory, 'unused/nested'), {recursive: true});
  f.check(); // Local checkout: empty directories carry no source classification.
  rmdirSync(resolve(f.directory, 'cubism'));
  f.check();
});

test('foundation census still rejects unclassified source files and nested module implementations', t => {
  const f = fixture(t);
  writeFileSync(resolve(f.directory, 'unclassified.ts'), 'export {};\n');
  assert.throws(f.check, /Every populated foundation module/u);
  unlinkSync(resolve(f.directory, 'unclassified.ts'));
  mkdirSync(resolve(f.directory, 'unclassified/nested'), {recursive: true});
  writeFileSync(resolve(f.directory, 'unclassified/nested/index.ts'), 'export {};\n');
  assert.throws(f.check, /Every populated foundation module/u);
});

test('foundation census still rejects missing classified file and directory implementations', t => {
  const f = fixture(t);
  unlinkSync(resolve(f.directory, 'parser.ts'));
  assert.throws(f.check, /Every populated foundation module/u);
  writeFileSync(resolve(f.directory, 'parser.ts'), 'export {};\n');
  unlinkSync(resolve(f.directory, 'composition/index.ts'));
  assert.throws(f.check, /Every populated foundation module/u);
});

test('historical aliases require real source and identical ownership while retaining classified directory support', t => {
  const f = fixture(t);
  mkdirSync(resolve(f.directory, 'cubism'));
  unlinkSync(resolve(f.directory, 'cubism.ts'));
  assert.throws(f.check, /Module alias requires its source entry/u);
  writeFileSync(resolve(f.directory, 'cubism.ts'), 'export {};\n');
  f.modules.cubism = ['unrelated-capability'];
  assert.throws(f.check, /Module alias ownership differs/u);
  f.modules.cubism = ['licensed-clip-baked'];
  writeFileSync(resolve(f.directory, 'cubism/index.ts'), 'export {};\n');
  f.check(); // A populated namespace remains classified by its original key.
});
