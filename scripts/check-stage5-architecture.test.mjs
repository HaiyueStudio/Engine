import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SHARED_SCENE_FRAME_UNIFORM_CALL } from './scene-frame-source-policy.mjs';

test('shared frame architecture accepts named and inline shared fog but rejects private snapshots', () => {
  for (const fog of ['sceneEnvironment.fog', 'getSceneRenderEnvironment(frameData, world).fog']) {
    assert.match(`getSceneFrameUniformSnapshot(cameraFrame, ${fog})`, SHARED_SCENE_FRAME_UNIFORM_CALL);
  }
  for (const source of [
    'getSceneFrameUniformSnapshot(cameraFrame, privateFog)',
    'getSceneFrameUniformSnapshot(privateCamera, sceneEnvironment.fog)',
    'getSceneFrameUniformSnapshot(cameraFrame, getPrivateEnvironment(frameData, world).fog)',
    'getSceneFrameUniformSnapshot(cameraFrame, getSceneRenderEnvironment(otherFrame, world).fog)',
  ]) assert.doesNotMatch(source, SHARED_SCENE_FRAME_UNIFORM_CALL);
});

test('stage5 gate follows the shared renderer pipeline-key owner', async () => {
  const source = await readFile(new URL('./check-stage5-architecture.mjs', import.meta.url), 'utf8');
  assert.match(source, /ParameterizedRendererCore\.ts/);
  assert.match(source, /ParameterizedRendererCore pipeline keys omit the shader feature set/);
  assert.match(source, /\(\?:rendererCore\|_rendererCore\).*pipelineKey/);
  assert.doesNotMatch(source, /requireMatch\(renderer, \/encodeShaderPipelineKey/);
});
