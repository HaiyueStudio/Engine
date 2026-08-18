import { haiyuePlugins } from '../config/rollup.shared.js';

export default {
  input: 'src/gltf-worker-runtime.ts',
  output: {
    file: 'dist/gltf-worker-runtime.js',
    format: 'es',
    sourcemap: true,
    inlineDynamicImports: true,
  },
  plugins: haiyuePlugins({ declaration: false }),
};
