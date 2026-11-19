import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export const engineRoot = resolve(import.meta.dirname, '../../..');
export const evidenceRoot = resolve(engineRoot, 'artifacts/engine-0.2.4/g05');
const entries = {
  'g05:session': 'visual-novel/save/VisualNovelSaveSession.js',
  'g05:scene': 'visual-novel/save/scene-presentation.js',
  'g05:stage': 'visual-novel/stage/hya-stage.js',
  'g05:stage-core': 'visual-novel/stage/VisualNovelStage.js',
  'g05:reading': 'visual-novel/ui/GuiReading.js',
};

export async function freshOutput() {
  await mkdir(evidenceRoot, { recursive: true });
  return mkdtemp(join(evidenceRoot, 'unit-'));
}

export async function buildSaveFixture(directory, browser = false) {
  const compiled = join(directory, 'compiled');
  try {
    await promisify(execFile)(process.execPath, [resolve(engineRoot, 'node_modules/typescript/bin/tsc'), '-p',
      fileURLToPath(new URL('tsconfig.json', import.meta.url)), '--outDir', compiled], { cwd: engineRoot, windowsHide: true });
  } catch (error) { throw new Error(error.stdout || error.stderr || error.message, { cause: error }); }
  const name = browser ? 'fixture.mjs' : 'unit-entry.mjs';
  const output = join(directory, 'fixture.mjs');
  const bundle = await rollup({
    input: join(import.meta.dirname, name),
    external: id => !browser && id.startsWith('@haiyue/'),
    plugins: [{
      name: 'g05-compiled-private-entries',
      resolveId(id, parent) {
        if (Object.hasOwn(entries, id)) return join(compiled, entries[id]);
        if (parent === join(compiled, entries['g05:stage']) && id === '../../hya-player.js') return this.resolve('@haiyue/extensions/hya-player', parent);
      },
    }, nodeResolve({ browser, preferBuiltins: !browser, rootDir: engineRoot }), commonjs()],
  });
  try { await bundle.write({ file: output, format: 'es', inlineDynamicImports: true }); }
  finally { await bundle.close(); }
  return output;
}
