import { readFileSync } from 'node:fs';
import { haiyuePlugins, loadContentManifest, selectContentEntries, toGlobalName } from '../config/rollup.shared.js';
import { exampleBuildMetadata } from './scripts/example-build-metadata-plugin.mjs';
import { exampleTypeScript } from './scripts/example-typescript.mjs';
import {
  SHARED_ENGINE_GLOBAL,
  SHARED_ENGINE_INPUT,
  SHARED_ENGINE_OUTPUT,
  SHARED_ENGINE_TARGET,
  isSharedEngineImport,
  sharedEngineEntryPlugin,
  sharedEngineGlobal,
  sharedEngineLocalPackages,
} from './scripts/shared-engine-bundle.mjs';

const manifest = loadContentManifest('examples');
const demos = selectContentEntries(manifest, process.env.EXAMPLE_FILTER);
// Direct Rollup/watch retains its typechecking plugin. The build orchestrator
// opts in only after both complete project checks succeeded.
const checkedTypeScript = () => process.env.EXAMPLE_TYPECHECKED === '1' ? {
  typescriptPlugin: exampleTypeScript(),
  resolveExtensions: ['.mjs', '.js', '.json', '.node', '.ts', '.tsx', '.mts', '.cts'],
} : {};

const sharedEngine = {
  input: SHARED_ENGINE_INPUT,
  output: {
    file: SHARED_ENGINE_OUTPUT,
    format: 'iife',
    name: `${SHARED_ENGINE_GLOBAL}Bundle`,
    sourcemap: true,
    inlineDynamicImports: true,
  },
  plugins: [
    sharedEngineEntryPlugin(),
    ...haiyuePlugins({
      ...checkedTypeScript(),
      tsconfig: './tsconfig.shared-engine.json',
      declaration: false,
      localPackages: sharedEngineLocalPackages,
    }),
    exampleBuildMetadata(SHARED_ENGINE_TARGET),
  ],
};

const sourceViewer = {
  input: 'source-viewer.ts',
  output: {
    file: 'source-viewer/bundle.js',
    format: 'es',
    sourcemap: true,
  },
  plugins: [...haiyuePlugins({ ...checkedTypeScript(), declaration: false }), exampleBuildMetadata('source-viewer')],
};

const exampleBundles = demos.map(entry => ({
  input: entry.entry,
  external: id => id === '@loaders.gl/textures' || isSharedEngineImport(id),
  output: {
    file: `${entry.id}/bundle.js`,
    format: 'iife',
    name: toGlobalName(entry.id, 'Example'),
    sourcemap: true,
    inlineDynamicImports: true,
    globals: id => sharedEngineGlobal(id),
  },
  plugins: [
    ...haiyuePlugins({ ...checkedTypeScript(), declaration: false }),
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

export default process.env.EXAMPLE_SHARED_ONLY === '1'
  ? [sharedEngine]
  : process.env.EXAMPLE_SHELL_ONLY === '1'
    ? [sourceViewer]
    : [
        ...(process.env.EXAMPLE_SKIP_SHARED_ENGINE === '1' ? [] : [sharedEngine]),
        ...(process.env.EXAMPLE_SKIP_SHELL === '1' ? [] : [sourceViewer]),
        ...exampleBundles,
      ];
