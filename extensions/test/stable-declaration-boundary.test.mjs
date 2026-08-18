import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const stableDeclarations = [
  '../dist/animation.d.ts',
  '../dist/animation3d.d.ts',
  '../dist/canvas-text.d.ts',
  '../dist/gltf.d.ts',
  '../dist/gltf-animation3d.d.ts',
  '../dist/grid.d.ts',
  '../dist/hya-state-machine.d.ts',
  '../dist/spine.d.ts',
  '../dist/tilemap.d.ts',
  '../dist/tween.d.ts',
];

test('stable extension declarations do not depend on engine experimental entrypoints', () => {
  for (const entry of stableDeclarations) {
    const visited = new Set();
    const pending = [resolve(import.meta.dirname, entry)];
    while (pending.length > 0) {
      const file = pending.pop();
      if (!file || visited.has(file)) continue;
      visited.add(file);
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /@haiyue\/engine\/experimental(?:['"/]|$)/, file);
      for (const match of source.matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/g)) {
        const specifier = match[1];
        const declaration = resolveDeclaration(dirname(file), specifier);
        if (declaration) pending.push(declaration);
      }
    }
  }
});

function resolveDeclaration(directory, specifier) {
  const base = resolve(directory, specifier);
  const candidates = specifier.endsWith('.js')
    ? [`${base.slice(0, -3)}.d.ts`]
    : [`${base}.d.ts`, resolve(base, 'index.d.ts')];
  return candidates.find(existsSync) ?? null;
}
