import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/renderer/MotionVectorRenderer.ts', import.meta.url), 'utf8');

test('motion history is isolated by view and invalidated by frame, camera and scene revision', () => {
  assert.match(source, /private readonly _views = new Map<string, MotionViewState>/);
  assert.match(source, /state\.lastFrameId \+ 1 === options\.frameId/);
  assert.match(source, /state\.cameraId === options\.cameraId/);
  assert.match(source, /state\.historyRevision === options\.historyRevision/);
  assert.match(source, /if \(!state\.continuous\) state\.previousViewProjection\.set\(state\.currentViewProjection\)/);
});

test('first frame, seek, teleport and geometry replacement reset every deformation history input', () => {
  assert.match(source, /entityContinuous \? entity\.previousModel : worldMatrix/);
  assert.match(source, /entityContinuous \? entity\.previousMorphWeights\[index\]! : current/);
  assert.match(source, /continuous && entity\.previousSkinMatrices\.length === skinning\.jointMatrices\.length/);
  assert.match(source, /entity\.geometryId === geometry\.id/);
});

test('history buffers and stale views have explicit retirement paths', () => {
  assert.match(source, /this\._sweepStaleViews\(/);
  assert.match(source, /this\._retireEntity\(entity, context\)/);
  assert.match(source, /this\._views\.clear\(\)/);
  assert.match(source, /entity\.currentSkinBuffer\?\.destroy\(\)/);
  assert.match(source, /entity\.previousSkinBuffer\?\.destroy\(\)/);
});
