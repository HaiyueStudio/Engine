// Diagnostic attribution only. The release gate measures installed npm tarballs.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(root);
const results = [];
const inputs = new Map();
for (const id of ['audio-mixer-only', 'multiplayer-input-only', 'font-builder-only', 'gui-font',
  'extensions-interaction', 'extensions-controls', 'extensions-animation', 'extensions-hya-state-machine']) {
  const modes = id === 'extensions-animation' || id === 'extensions-hya-state-machine'
    ? ['dist', 'source', 'source-without-font-parser'] : ['dist'];
  for (const mode of modes) {
    const bundle = await rollup({
      input: `scripts/fixtures/engine-consumers/${id}.mjs`,
      plugins: [{
        name: 'diagnostic-attribution',
        resolveId(source) {
          if (mode === 'source-without-font-parser' && source === 'opentype.js') return '\0font-parser-ablation';
          if (mode !== 'dist' && source.startsWith('@haiyue/extensions/')) {
            return resolve(root, `extensions/src/${source.slice('@haiyue/extensions/'.length)}.ts`);
          }
        },
        load(moduleId) {
          if (moduleId.endsWith('.wgsl')) return `export default ${JSON.stringify(readFileSync(moduleId, 'utf8'))};`;
          if (moduleId === '\0font-parser-ablation') {
            return 'export function parse(){throw new Error("diagnostic only: no font parser")}';
          }
        },
        transform(code, moduleId) {
          if (moduleId.startsWith(root + '/')) {
            inputs.set(moduleId.slice(root.length + 1), createHash('sha256').update(code).digest('hex'));
          }
          if (moduleId.endsWith('.ts')) {
            return ts.transpileModule(code, { compilerOptions: {
              target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
            }}).outputText;
          }
        },
      }, nodeResolve({ browser: true, extensions: ['.mjs', '.js', '.json', '.ts'] }), commonjs()],
      onwarn(warning) { if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message); },
    });
    try {
      const generated = await bundle.generate({ format: 'es', inlineDynamicImports: true, sourcemap: false });
      const chunks = generated.output.filter(item => item.type === 'chunk');
      const code = chunks.map(chunk => chunk.code).join('\n');
      const modules = chunks.flatMap(chunk => Object.entries(chunk.modules).map(([moduleId, item]) => ({
        id: moduleId.replace(root + '/', ''), renderedLength: item.renderedLength,
      }))).sort((a, b) => b.renderedLength - a.renderedLength);
      results.push({ id, mode, rawBytes: Buffer.byteLength(code), gzipBytes: gzipSync(code, { level: 9 }).byteLength, modules });
      console.log(`${id} (${mode}): ${results.at(-1).gzipBytes}B gzip`);
    } finally { await bundle.close(); }
  }
}
const output = resolve(root, 'artifacts/release/0.2.0-capability-cost.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  measurement: 'Diagnostic workspace builds; Rollup ES, inlineDynamicImports, gzip level 9. Source ablation bundles cannot run and are never release artifacts. Only paired source measurements attribute font-parser cost.',
  toolVersions: Object.fromEntries(['rollup', 'typescript'].map(name => [name,
    JSON.parse(readFileSync(resolve(root, `node_modules/${name}/package.json`), 'utf8')).version])),
  inputs: Object.fromEntries([...inputs].sort()), results,
}, null, 2) + '\n');
console.log(output);
