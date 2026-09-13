import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { collectReferenceDocs } from './export-reference-docs.mjs';

test('reference export is deterministic and includes public guides only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'engine-reference-docs-'));
  try {
    for (const directory of ['docs/api/errors', 'docs/engine-guide', 'docs/for-ai']) await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, 'docs/api/errors/error.md'), '# Error\n[Engine](../../../engine/package.json)\n[Editor](../../../../Editor/readme.md)\n');
    await writeFile(path.join(root, 'docs/engine-guide/input.md'), '# Input\n\n```ts\nconst x = 1;\n```\n');
    await writeFile(path.join(root, 'docs/for-ai/private.md'), '# Internal\n');
    const first = await collectReferenceDocs(root), second = await collectReferenceDocs(root);
    assert.deepEqual(first, second);
    assert.match(first.entries[0].text, /engine-reference:\/engine\/package.json/);
    assert.match(first.entries[0].text, /studio-reference:\/Editor\/readme.md/);
    assert.match(first.entries[0].sourceDigest, /^sha256:/);
    assert.deepEqual(first.entries.map(entry => entry.path), ['docs/api/errors/error.md', 'docs/engine-guide/input.md']);
    await writeFile(path.join(root, 'docs/engine-guide/input.md'), '# Changed\n');
    assert.notEqual((await collectReferenceDocs(root)).contentDigest, first.contentDigest);
  } finally { await rm(root, { recursive: true, force: true }); }
});
