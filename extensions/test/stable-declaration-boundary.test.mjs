import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const capabilities = JSON.parse(readFileSync(new URL('../../config/public-api-capability-budgets.json', import.meta.url), 'utf8'));
const stableEntrypoints = capabilities.packages[manifest.name].groups
  .filter(group => group.stability === 'stable')
  .flatMap(group => Object.keys(group.entrypoints));

test('stable extension declarations do not depend on engine experimental entrypoints', () => {
  assert.ok(stableEntrypoints.length > 0);
  for (const entry of stableEntrypoints) {
    const target = manifest.exports[entry]?.types;
    assert.equal(typeof target, 'string', `${entry} must expose stable declarations`);
    const visited = new Set();
    const pending = [resolve(import.meta.dirname, '..', target)];
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
