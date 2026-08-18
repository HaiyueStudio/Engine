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
  },
  external: haiyueExternal({ packages: ['polygon-clipping'], includeMatrix: false }),
  output: libraryOutput(),
  plugins: [cleanOutputDirectory(), ...haiyuePlugins({ commonjsInterop: false })],
};
