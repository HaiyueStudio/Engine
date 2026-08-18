import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('physics backend entry keeps Rapier adapter and WASM outside its static closure', async () => {
  const source = await readFile(new URL('../dist/physics/backend.js', import.meta.url), 'utf8');

  assert.match(source, /await import\(['"]\.\.\/chunks\/RapierPhysics3DBackend-[^'"]+\.js['"]\)/);
  assert.doesNotMatch(source, /from ['"][^'"]*RapierPhysics3DBackend/);
  assert.doesNotMatch(source, /@dimforge\/rapier3d-compat/);
  assert.doesNotMatch(source, /rapier-[A-Za-z0-9_-]+\.js/);
});
