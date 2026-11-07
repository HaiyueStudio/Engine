import assert from 'node:assert/strict';
import test from 'node:test';
import { chromeCanvasArguments } from './chrome-runner.mjs';

test('Linux SwiftShader canvas capture explicitly selects the verified ANGLE interop path', () => {
  assert.deepEqual(chromeCanvasArguments('swiftshader', 'linux'), [
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist',
    '--use-webgpu-adapter=opengles', '--disable-skia-graphite',
  ]);
});

test('native canvas capture retains each platform backend', () => {
  assert.deepEqual(chromeCanvasArguments('d3d11', 'win32'), []);
  assert.deepEqual(chromeCanvasArguments('metal', 'darwin'), []);
  assert.deepEqual(chromeCanvasArguments('vulkan', 'linux'), []);
  assert.deepEqual(chromeCanvasArguments('swiftshader', 'win32'), []);
});
