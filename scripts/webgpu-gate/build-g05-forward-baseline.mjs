import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { sha256 } from './deferred-fixture-policy.mjs';
import { buildDeferredFixture } from './deferred-fixture-builder.mjs';
import { validateG05ContinuousConfig } from './deferred-g05-continuous-policy.mjs';

/** Source blobs are immutable; current build configuration and the bridge live outside the snapshot. */
export async function buildG05ForwardBaseline({ root, directory, config }) {
  validateG05ContinuousConfig(config);
  const revision = config.forwardBaselineRevision, source = resolve(directory, 'source'), output = resolve(directory, 'runtime');
  await mkdir(source, { recursive: true }); await mkdir(output, { recursive: true });
  const paths = ['engine/src', 'scripts/benchmark'];
  const tree = new Map(execFileSync('git', ['ls-tree', '-r', revision, '--', ...paths], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n').map(line => {
    const [metadata, path] = line.split('\t');
    if (!/^100(644|755) blob [a-f0-9]{40}$/.test(metadata)) throw Error('Baseline requires regular Git blobs');
    return [path, metadata.split(' ')[2]];
  }));
  const archive = resolve(directory, 'source.tar');
  execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, revision, ...paths], { cwd: root });
  execFileSync('tar', ['-xf', archive, '-C', source], { windowsHide: true });
  async function inspectSource() {
    const names = (await readdir(source, { recursive: true, withFileTypes: true })).filter(e => e.isFile())
      .map(e => relative(source, resolve(e.parentPath, e.name)).replaceAll('\\', '/')).sort();
    if (JSON.stringify(names) !== JSON.stringify([...tree.keys()].sort())) throw Error('Baseline snapshot has missing/extra files');
    return Promise.all(names.map(async path => {
      const bytes = await readFile(resolve(source, path));
      const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (blob !== tree.get(path)) throw Error(`Baseline blob changed: ${path}`);
      return { path, blob, sha256: sha256(bytes) };
    }));
  }
  const files = await inspectSource();
  const configDirectory = resolve(directory, 'scripts/webgpu-gate'); await mkdir(configDirectory, { recursive: true });
  const compiler = JSON.parse(await readFile(resolve(root, 'scripts/webgpu-gate/deferred-fixture.tsconfig.json')));
  compiler.extends = resolve(root, 'tsconfig.base.json').replaceAll('\\', '/');
  compiler.compilerOptions.rootDir = '../../source/engine/src'; compiler.compilerOptions.outDir = '../../runtime';
  compiler.compilerOptions.paths = { 'box2d.ts/dist/box2d.umd.js': ['../../source/engine/src/types/box2d-umd.d.ts'] };
  compiler.include = ['../../source/engine/src/**/*'];
  await writeFile(resolve(configDirectory, 'deferred-fixture.tsconfig.json'), JSON.stringify(compiler, null, 2));
  const bridge = "export { createRealRendererBenchmarkScenario, createRealRendererGpuTimestampProbe, runRealRendererBenchmarkFrame, destroyRealRendererBenchmarkScenario, resetRealRendererBenchmarkMetrics, captureRealRendererBenchmarkMetrics, warmRealRendererBenchmarkPipelines } from '../source/scripts/benchmark/real-renderer-scenario.mjs';\n" +
    "export { BILLIARDS_3D_SCENE_BYTE_LENGTH, BILLIARDS_3D_SCENE_PATH, BILLIARDS_3D_SCENE_SHA256, parseBilliards3DSceneDocument } from '../source/scripts/benchmark/billiards-3d-real-renderer-content.mjs';\n";
  const entry = resolve(output, 'bridge.mjs'); await writeFile(entry, bridge);
  const builderPaths = ['scripts/webgpu-gate/build-g05-forward-baseline.mjs', 'scripts/webgpu-gate/deferred-fixture-builder.mjs', 'scripts/webgpu-gate/deferred-fixture-policy.mjs', 'scripts/webgpu-gate/deferred-fixture.tsconfig.json', 'tsconfig.base.json', 'config/rollup.shared.js', 'scripts/rollup-plugin-wgsl.js', 'package-lock.json'];
  const builderFiles = await Promise.all(builderPaths.map(async path => ({ path, sha256: sha256(await readFile(resolve(root, path))) })));
  const outputs = await buildDeferredFixture({ sourceRoot: directory, outputDirectory: output, entry });
  if (JSON.stringify(files) !== JSON.stringify(await inspectSource())) throw Error('Baseline source changed during build');
  for (const file of builderFiles) if (sha256(await readFile(resolve(root, file.path))) !== file.sha256) throw Error('Baseline builder changed');
  const provenance = { schemaVersion: 1, revision, dirty: false, generatedAt: new Date().toISOString(),
    scope: 'Frozen G01 source rebuilt on Windows with common current build tools; not a recapture of historical macOS timing.',
    archiveSha256: sha256(await readFile(archive)), files, sourceSha256: sha256(JSON.stringify(files)), builderFiles,
    compiler, bridgeSha256: sha256(bridge), outputs };
  await writeFile(resolve(directory, 'provenance.json'), JSON.stringify(provenance, null, 2));
  return { directory: output, provenance };
}
