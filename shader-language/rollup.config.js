import {
  cleanOutputDirectory,
  haiyueExternal,
  haiyuePlugins,
  libraryOutput,
} from '../config/rollup.shared.js';

export default {
  input: {
    index: 'src/index.ts',
    'material-graph': 'src/material-graph.ts',
  },
  output: libraryOutput(),
  external: haiyueExternal(),
  plugins: [cleanOutputDirectory(), ...haiyuePlugins()],
};
