import { dts } from 'rollup-plugin-dts';

const input = {
  index: 'dist/index.d.ts',
  lottie: 'dist/lottie.d.ts',
  native3d: 'dist/native3d.d.ts',
  deformable2d: 'dist/deformable2d.d.ts',
  cubism: 'dist/cubism.d.ts',
  live2d: 'dist/live2d.d.ts',
  conversion: 'dist/conversion.d.ts',
  'live2d/clip-baked': 'dist/live2d/clip-baked.d.ts',
};
const entries = Object.keys(input);
const entryIds = new Set(Object.values(input).map(path => path.replaceAll('\\', '/')));

export default {
  input,
  output: {
    dir: 'dist-declarations',
    format: 'es',
    entryFileNames: '[name].d.ts',
    chunkFileNames: 'shared.d.ts',
    manualChunks(id) {
      const normalized = id.replaceAll('\\', '/');
      return entryIds.has(normalized) || entries.some(entry => normalized.endsWith(`/dist/${entry}.d.ts`))
        ? undefined
        : 'shared';
    },
  },
  plugins: [dts({ respectExternal: true })],
};
