import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('redirected HYA viewer loads the shared engine before its animation bundle', async () => {
  const html = await readFile(new URL('../viewer/index.html', import.meta.url), 'utf8');
  const sources = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  const engine = '../../examples/shared/engine.js';
  const animation = '../../examples/hya-samples/bundle.js';
  assert.equal(sources.filter(source => source === engine).length, 1);
  assert.ok(sources.includes(animation));
  assert.ok(sources.indexOf(engine) < sources.indexOf(animation));
  const sharedScript = html.match(/<script\b[^>]*src="\.\.\/\.\.\/examples\/shared\/engine\.js"[^>]*>/)?.[0];
  assert.ok(sharedScript);
  assert.doesNotMatch(sharedScript, /\b(?:async|defer)\b|\btype="module"/);
});
