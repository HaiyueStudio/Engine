import { fileURLToPath } from 'node:url';
import { wgslBuildIncludes } from './scripts/wgsl-includes.mjs';
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
  plugins: [cleanOutputDirectory(), wgslBuildIncludes({root:fileURLToPath(new URL('./src',import.meta.url)), registryPath:fileURLToPath(new URL('./wgsl-module-registry.json',import.meta.url))}), ...haiyuePlugins()],
};
