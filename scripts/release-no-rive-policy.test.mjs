import assert from 'node:assert/strict';
import test from 'node:test';
import { validateNoRiveRelease } from './release-no-rive-policy.mjs';

const clean = () => ({ files: ['engine/src/gpu-driven.ts'], packages: {}, lock: {}, examples: { entries: [{ id: 'gpu-driven', entry: 'gpu-driven/main.ts' }] }, runtimeSources: {} });
test('source-neutral HYA and GPU-driven code are allowed', () => {
  const input = clean();
  input.runtimeSources['animation-spec/src/types.ts'] = '// Source-neutral contracts derived from Rive and Lottie research';
  assert.deepEqual(validateNoRiveRelease(input), []);
});
test('rejects an importer, binary fixture, dependency, lock entry, example and runtime sampler independently', () => {
  for (const update of [
    input => input.files.push('animation-spec/src/rive/import.ts'),
    input => input.files.push('examples/assets/sample.riv'),
    input => { input.packages['package.json'] = { devDependencies: { '@rive-app/webgl2': '2.40.0' } }; },
    input => { input.packages['package.json'] = { scripts: { 'rive:convert': 'node convert.mjs' } }; },
    input => { input.packages['package.json'] = { exports: { './rive': './dist/rive.js' } }; },
    input => { input.lock.packages = { 'node_modules/@rive-app/webgl2': {} }; },
    input => input.examples.entries.push({ id: 'rive-hya-compare', entry: 'rive-hya-compare/main.ts' }),
    input => { input.runtimeSources['extensions/dist/chunk.js'] = 'function fs_main_rive_text() {}'; },
  ]) {
    const input = clean();
    update(input);
    assert.ok(validateNoRiveRelease(input).length > 0);
  }
});
