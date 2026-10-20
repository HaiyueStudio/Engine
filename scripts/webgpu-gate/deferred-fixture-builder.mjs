import { rollup } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import { haiyuePlugins } from '../../config/rollup.shared.js';
import { resolve } from 'node:path';
import { sha256, resolveDeferredFixtureSource } from './deferred-fixture-policy.mjs';

/** Both fixed A0 and current B4 use identical build machinery, without patching runtime sources. */
export async function buildDeferredFixture({ sourceRoot, outputDirectory, entry = resolve(sourceRoot, 'scripts/webgpu-gate/deferred-reference-runtime.mjs') }) {
  const bundle = await rollup({ input: entry, external: id => id.startsWith('node:'), plugins: [{
    name: 'private-engine-fixture-source', resolveId(id, importer) { return resolveDeferredFixtureSource(id, importer); },
  }, ...haiyuePlugins({ typescriptPlugin: typescript({
    tsconfig: resolve(sourceRoot, 'scripts/webgpu-gate/deferred-fixture.tsconfig.json'), outDir: outputDirectory, declaration: false,
  }) })] });
  try {
    const result = await bundle.write({ dir: outputDirectory, format: 'es', sourcemap: true, entryFileNames: 'fixture.js', chunkFileNames: 'fixture-[name]-[hash].js' });
    return result.output.filter(item => item.type === 'chunk').map(item => ({ file: item.fileName, sha256: sha256(item.code) }));
  } finally { await bundle.close(); }
}
