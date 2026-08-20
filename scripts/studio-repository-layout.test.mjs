import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  STUDIO_REPOSITORIES,
  requireStudioRepository,
  resolveStudioRepositoryPath,
} from './studio-repository-layout.mjs';

test('Studio repository identities resolve from the migrated sibling layout', () => {
  for (const name of ['Engine', 'Editor', 'Games', 'UI']) {
    assert.equal(requireStudioRepository(name), STUDIO_REPOSITORIES[name]);
  }
});

test('Studio repository paths remain confined to the selected repository root', () => {
  assert.equal(
    resolveStudioRepositoryPath('Editor', 'editor', 'src', 'player.ts'),
    resolve(STUDIO_REPOSITORIES.Editor.root, 'editor', 'src', 'player.ts'),
  );
  assert.equal(
    resolveStudioRepositoryPath('Games', 'games', 'manifest.json'),
    resolve(STUDIO_REPOSITORIES.Games.root, 'games', 'manifest.json'),
  );
  assert.throws(
    () => resolveStudioRepositoryPath('Games', '..', 'Engine', 'package.json'),
    /path escapes its root/,
  );
});

test('unknown Studio repository names fail explicitly', () => {
  assert.throws(() => requireStudioRepository('Unknown'), /Unknown HaiYueStudio repository/);
});
