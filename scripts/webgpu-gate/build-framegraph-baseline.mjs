import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './deferred-fixture-policy.mjs';
import { buildDeferredFixture } from './deferred-fixture-builder.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
if (process.argv.length !== 2) throw Error('A0 always uses the registered dependency baseline; no revision override');
const fixed = JSON.parse(await readFile(resolve(root, 'review/engine-0.2.1/g09/dependency-baseline.json')));
const directory = resolve(root, 'artifacts/engine-0.2.1/g09');
const sourceRoot = resolve(directory, 'a0-source'), outputDirectory = resolve(directory, 'a0-built');
await mkdir(sourceRoot, { recursive: true }); await mkdir(outputDirectory, { recursive: true });
const archive = resolve(directory, 'a0-source.tar');
const paths = ['engine/src', 'scripts/benchmark', 'scripts/webgpu-gate/deferred-reference-runtime.mjs', 'scripts/webgpu-gate/deferred-fixture.tsconfig.json', 'tsconfig.base.json'];
const tree = new Map(execFileSync('git', ['ls-tree', '-r', fixed.revision, '--', ...paths], { cwd: root, encoding: 'utf8' }).trim().split('\n').map(line => {
  const [metadata, path] = line.split('\t');
  if (!metadata.startsWith('100644 blob ') && !metadata.startsWith('100755 blob ')) throw Error('A0 requires regular Git blobs');
  return [path, metadata.split(' ')[2]];
}));
const names = [...tree.keys()];
execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, fixed.revision, ...paths], { cwd: root });
execFileSync('tar', ['-xf', archive, '-C', sourceRoot]);
async function sourceFiles() {
  const actual = (await readdir(sourceRoot, { recursive: true, withFileTypes: true })).filter(e => e.isFile()).map(e => relative(sourceRoot, resolve(e.parentPath, e.name)).replaceAll('\\', '/')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(names.toSorted())) throw Error('Unexpected files in fixed A0 archive');
  const files = [];
  for (const path of actual) {
    const bytes = await readFile(resolve(sourceRoot, path));
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blob !== tree.get(path)) throw Error(`A0 source differs from registered revision: ${path}`);
    files.push({ path, sha256: sha256(bytes) });
  }
  return files;
}
const files = await sourceFiles();
const bridge = "export * from '../a0-source/scripts/webgpu-gate/deferred-reference-runtime.mjs';\nexport { GaussianBlurPass } from '../a0-source/engine/src/postprocess/GaussianBlurPass.ts';\nexport { captureRealRendererBenchmarkMetrics, warmRealRendererBenchmarkPipelines } from '../a0-source/scripts/benchmark/real-renderer-scenario.mjs';\n";
const fullBridge = bridge + "export { BILLIARDS_3D_SCENE_BYTE_LENGTH, BILLIARDS_3D_SCENE_PATH, BILLIARDS_3D_SCENE_SHA256, parseBilliards3DSceneDocument } from '../a0-source/scripts/benchmark/billiards-3d-real-renderer-content.mjs';\n";
const entry = resolve(outputDirectory, 'bridge.mjs'); await writeFile(entry, fullBridge);
const builderPaths = ['scripts/webgpu-gate/build-framegraph-baseline.mjs', 'scripts/webgpu-gate/deferred-fixture-builder.mjs', 'scripts/webgpu-gate/deferred-fixture-policy.mjs', 'config/rollup.shared.js', 'scripts/rollup-plugin-wgsl.js', 'package-lock.json'];
const builderFiles = await Promise.all(builderPaths.map(async path => ({ path, sha256: sha256(await readFile(resolve(root, path))) })));
const outputs = await buildDeferredFixture({ sourceRoot, outputDirectory, entry });
if (JSON.stringify(files) !== JSON.stringify(await sourceFiles())) throw Error('A0 source changed during build');
for (const f of builderFiles) if (sha256(await readFile(resolve(root, f.path))) !== f.sha256) throw Error('A0 builder changed during build');
await writeFile(resolve(outputDirectory, 'provenance.json'), JSON.stringify({ schemaVersion: 2, revision: fixed.revision, generatedAt: new Date().toISOString(),
  scope: 'Fixed pre-G09 production source, identical build machinery; bridge exposes existing GaussianBlurPass and benchmark capture/warmup/validated-scene-parser helpers',
  archiveSha256: sha256(await readFile(archive)), sourceSha256: sha256(JSON.stringify(files)), files, builderFiles, bridgeSha256: sha256(fullBridge), outputs }, null, 2) + '\n');
console.log(`[framegraph-baseline] ${fixed.revision}, ${files.length} source files: ${outputDirectory}`);
