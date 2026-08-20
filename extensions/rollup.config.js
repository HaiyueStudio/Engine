import {
  cleanOutputDirectory,
  haiyueExternal,
  haiyuePlugins,
  libraryOutput,
} from '../config/rollup.shared.js';

export default {
  input: {
    index: 'src/index.ts',
    gltf: 'src/gltf.ts',
    spine: 'src/spine.ts',
    tilemap: 'src/tilemap.ts',
    'canvas-text': 'src/canvas-text.ts',
    tween: 'src/tween.ts',
    grid: 'src/grid.ts',
    animation: 'src/animation.ts',
    'deformable-animation': 'src/deformable-animation.ts',
    'hya-state-machine': 'src/hya-state-machine.ts',
    animation3d: 'src/animation3d.ts',
    'gltf-animation3d': 'src/gltf-animation3d.ts',
    'experimental-gltf-worker': 'src/experimental-gltf-worker.ts',
    'experimental-spine-worker': 'src/experimental-spine-worker.ts',
    'ray-tracing': 'src/ray-tracing.ts',
    benchmark: 'src/benchmark.ts',
    'internal/2d-ui-shader-artifact': 'src/shaders/generated/2d-ui-artifact.generated.ts',
  },
  output: libraryOutput(),
  external: haiyueExternal({ packages: ['@haiyue/engine', '@haiyue/animation-spec'] }),
  plugins: [cleanOutputDirectory(), ...haiyuePlugins({ commonjsInterop: false })],
};
