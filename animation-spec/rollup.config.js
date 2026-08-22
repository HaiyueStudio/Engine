import terser from '@rollup/plugin-terser';
import {
  cleanOutputDirectory,
  haiyueExternal,
  haiyuePlugins,
  libraryOutput,
} from '../config/rollup.shared.js';

export default {
  input: {
    index: 'src/index.ts',
    lottie: 'src/lottie.ts',
    native3d: 'src/native3d.ts',
    deformable2d: 'src/deformable2d.ts',
    cubism: 'src/cubism.ts',
    live2d: 'src/live2d.ts',
    conversion: 'src/conversion.ts',
    'live2d/clip-baked': 'src/live2d/clip-baked.ts',
  },
  external: haiyueExternal({ packages: ['polygon-clipping'], includeMatrix: false }),
  output: { ...libraryOutput(), compact: true },
  plugins: [
    cleanOutputDirectory(),
    ...haiyuePlugins({ commonjsInterop: false }),
    terser({ format: { comments: false } }),
  ],
};
