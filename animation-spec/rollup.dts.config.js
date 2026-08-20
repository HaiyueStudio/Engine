import { dts } from 'rollup-plugin-dts';

const entries = ['index', 'lottie', 'native3d', 'deformable2d', 'cubism', 'live2d'];
const input = Object.fromEntries(entries.map(entry => [entry, `dist/${entry}.d.ts`]));
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
