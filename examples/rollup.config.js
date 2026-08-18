import { readFileSync } from 'node:fs';
import { haiyuePlugins, loadContentManifest, selectContentEntries, toGlobalName } from '../config/rollup.shared.js';
import { exampleBuildMetadata } from './scripts/example-build-metadata-plugin.mjs';

const manifest = loadContentManifest('examples');
const demos = selectContentEntries(manifest, process.env.EXAMPLE_FILTER);

const sourceViewer = {
  input: 'source-viewer.ts',
  output: {
    file: 'source-viewer/bundle.js',
    format: 'es',
    sourcemap: true,
  },
  plugins: [...haiyuePlugins({ declaration: false }), exampleBuildMetadata('source-viewer')],
};

const exampleBundles = demos.map(entry => ({
  input: entry.entry,
  external: ['@loaders.gl/textures'],
  output: {
    file: `${entry.id}/bundle.js`,
    format: 'iife',
    name: toGlobalName(entry.id, 'Example'),
    sourcemap: true,
    inlineDynamicImports: true,
  },
  plugins: [
    ...haiyuePlugins({ declaration: false }),
    exampleBuildMetadata(entry.id),
    pdfWorkerAsset(entry.id),
  ],
}));

function pdfWorkerAsset(entryId) {
  return {
    name: 'page-turn-book-pdf-worker',
    generateBundle() {
      if (entryId !== 'page-turn-book') return;
      this.emitFile({
        type: 'asset',
        fileName: 'pdf.worker.min.mjs',
        source: readFileSync(new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)),
      });
    },
  };
}

export default process.env.EXAMPLE_SHELL_ONLY === '1'
  ? [sourceViewer]
  : process.env.EXAMPLE_SKIP_SHELL === '1'
    ? exampleBundles
    : [sourceViewer, ...exampleBundles];
