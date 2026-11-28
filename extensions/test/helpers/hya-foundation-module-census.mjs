import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';

// G10 recorded this empty namespace beside its deprecated, still-supported file
// entry. Keep the frozen classification, but bind it to trackable source bytes.
const historicalAliases = Object.freeze({cubism: 'cubism.ts'});

export function assertFoundationModuleCensus(sourceDirectory, foundationModules) {
  const entries = readdirSync(sourceDirectory, {withFileTypes: true});
  for (const [alias, target] of Object.entries(historicalAliases)) {
    assert.ok(Object.hasOwn(foundationModules, alias), `Missing frozen module alias: ${alias}`);
    assert.ok(Object.hasOwn(foundationModules, target), `Missing frozen alias target: ${target}`);
    assert.deepEqual(foundationModules[alias], foundationModules[target], `Module alias ownership differs: ${alias}`);
    assert.ok(entries.some(entry => entry.name === target && entry.isFile()), `Module alias requires its source entry: ${target}`);
  }
  const actual = entries.filter(entry => !entry.isDirectory() || containsFile(resolve(sourceDirectory, entry.name))).map(entry => entry.name);
  const populated = new Set(actual);
  const expected = new Set(Object.keys(foundationModules).map(name => Object.hasOwn(historicalAliases, name) && !populated.has(name) ? historicalAliases[name] : name));
  assert.deepEqual([...expected].sort(), actual.sort(), 'Every populated foundation module must have exactly one frozen source classification.');
}

function containsFile(directory) {
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      // Symlinks are tracked leaves; never traverse them outside the source tree.
      if (!entry.isDirectory()) return true;
      pending.push(resolve(current, entry.name));
    }
  }
  return false;
}
