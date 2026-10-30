import terser from '@rollup/plugin-terser';
import { haiyuePlugins } from '../config/rollup.shared.js';

export default {
  input: 'src/gltf-worker-runtime.ts',
  output: {
    file: 'dist/gltf-worker-runtime.js',
    format: 'es',
    sourcemap: true,
    inlineDynamicImports: true,
  },
  plugins: [...haiyuePlugins({ declaration: false }), terser({maxWorkers:1,compress:false,mangle:true,keep_classnames:true,keep_fnames:true,format:{comments:"some"}})],
};
