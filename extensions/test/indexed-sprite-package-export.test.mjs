import assert from 'node:assert/strict';
import test from 'node:test';

import * as extensionsRoot from '@haiyue/extensions';
import {
  DEFAULT_INDEXED_SPRITE_ATLAS_LIMITS,
  IndexedSpriteRenderer,
  prepareIndexedSpriteAtlas,
} from '@haiyue/extensions/experimental/indexed-sprite';

test('indexed sprite capability is focused and does not widen the extensions root', () => {
  assert.deepEqual(Object.keys(extensionsRoot), ['RenderSystem2DBase']);
  assert.equal(typeof IndexedSpriteRenderer, 'function');
  assert.equal(typeof prepareIndexedSpriteAtlas, 'function');
  assert.equal(DEFAULT_INDEXED_SPRITE_ATLAS_LIMITS.maxTextureDimension2D, 8192);
});
