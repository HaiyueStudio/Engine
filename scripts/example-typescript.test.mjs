import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { rollup } from 'rollup';
import nodeResolve from '@rollup/plugin-node-resolve';
import { checkExampleTypes, exampleTypeScript } from '../examples/scripts/example-typescript.mjs';

test('preflight rejects semantic errors even in an unreachable example', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'example-typecheck-'));
  try {
    writeFileSync(resolve(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [], skipLibCheck: true }, include: ['*.ts'] }));
    writeFileSync(resolve(root, 'main.ts'), 'export const value: number = 1;');
    writeFileSync(resolve(root, 'unused.ts'), 'export const wrong: number = "bad";');
    assert.throws(() => checkExampleTypes(resolve(root, 'tsconfig.json')), /not assignable to type 'number'/);
    writeFileSync(resolve(root, 'unused.ts'), 'export const wrong: number = 2;');
    assert.equal(checkExampleTypes(resolve(root, 'tsconfig.json')), 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bundle transform visits reachable TypeScript only and retains runtime enums and source maps', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'example-transpile-'));
  let bundle;
  try {
    writeFileSync(resolve(root, 'main.ts'), 'import { Flags } from "./flags"; export const value: number = Flags.Visible;');
    writeFileSync(resolve(root, 'flags.ts'), 'export const enum Flags { Visible = 4 }');
    writeFileSync(resolve(root, 'unreachable.ts'), 'invalid syntax !!!');
    const plugin = exampleTypeScript();
    const visited = [];
    const transform = plugin.transform;
    plugin.transform = function (code, id) { visited.push(id); return transform.call(this, code, id); };
    bundle = await rollup({ input: resolve(root, 'main.ts'), plugins: [nodeResolve({ extensions: ['.js', '.ts'] }), plugin] });
    const { output } = await bundle.generate({ format: 'es', sourcemap: true });
    const module = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`);
    assert.equal(module.value, 4);
    assert.equal(visited.length, 2);
    assert.ok(visited.every(id => !id.endsWith('unreachable.ts')));
    assert.ok(output[0].map.sources.some(id => id.endsWith('flags.ts')));
  } finally { await bundle?.close(); rmSync(root, { recursive: true, force: true }); }
});
