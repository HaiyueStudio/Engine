import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createContentTargetPlan, loadContentManifests } from './content-gate-policy.mjs';

export function stageEngineExamples(root, destination, targets) {
  const kind = 'examples';
  const expected = createContentTargetPlan('full', loadContentManifests(root, 'engine')).targets;
  if (JSON.stringify([...targets].sort()) !== JSON.stringify([...expected].sort())) throw new Error('Catalog targets must match the full Engine manifest tier.');
  const sourceRoot = resolve(root, kind);
  for (const path of ['examples/index.html', 'examples/catalog.js', 'examples/source-viewer/bundle.js']) {
    if (!existsSync(resolve(root, path))) throw new Error(`Catalog prerequisite is missing: ${path}`);
  }
  const manifest = JSON.parse(readFileSync(resolve(sourceRoot, 'manifest.json'), 'utf8'));
  manifest.entries = manifest.entries.filter(entry => targets.includes(`example:${entry.id}`));
  const directories = new Set(manifest.entries.map(entry => dirname(entry.entry)));
  mkdirSync(resolve(destination, kind), { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.isFile()) cpSync(resolve(sourceRoot, entry.name), resolve(destination, kind, entry.name));
  }
  writeFileSync(resolve(destination, kind, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  cpSync(resolve(sourceRoot, 'source-viewer'), resolve(destination, kind, 'source-viewer'), { recursive: true });
  if (kind === 'examples') {
    const sharedSource = resolve(sourceRoot, 'shared');
    const sharedTarget = resolve(destination, kind, 'shared');
    cpSync(sharedSource, sharedTarget, { recursive: true });
    if (!existsSync(resolve(sharedTarget, 'engine.js'))) {
      throw new Error('examples catalog is missing built shared/engine.js.');
    }
  }
  for (const directory of [...directories].sort()) {
    const source = resolve(sourceRoot, directory);
    const target = resolve(destination, kind, directory);
    cpSync(source, target, { recursive: true });
    for (const required of (directory === 'hya-samples' ? ['index.html'] : ['index.html', 'bundle.js'])) {
      if (!existsSync(resolve(target, required))) throw new Error(`${kind}:${directory} is missing built ${required}.`);
    }
  }
  for (const asset of new Set(manifest.entries.flatMap(entry => entry.assets ?? []))) {
    const source = resolve(sourceRoot, asset);
    assertInside(root, source);
    if (!existsSync(source)) throw new Error(`${kind} catalog asset is missing: ${asset}.`);
    const target = resolve(destination, relative(root, source));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  for (const path of ['engine/dist', 'extensions/dist/gltf-worker-runtime.js',
    'extensions/test/fixtures/gltf', 'scripts/webgpu-gate/assets/gltf-corpus/medium-rigged-figure-draco',
    'node_modules/draco3dgltf/draco_decoder_gltf_nodejs.js', 'node_modules/draco3dgltf/draco_decoder_gltf.wasm',
    'animation-spec/samples']) {
    const target = resolve(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(root, path), target, { recursive: true });
  }
  cpSync(resolve(root, 'animation-spec/viewer'), resolve(destination, 'animation-spec'), { recursive: true });
  return readdirSync(destination, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({ source: resolve(destination, entry.name), prefix: entry.name }));
}


function assertInside(root, path) {
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || relativePath.startsWith('/')) throw new Error('Catalog asset escapes repository');
}
