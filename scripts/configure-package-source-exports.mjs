import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = {
  engine: {
    '.': 'src/index.ts', './core': 'src/core.ts', './assets': 'src/assets.ts',
    './diagnostics': 'src/diagnostics.ts', './extension-authoring': 'src/extension-authoring.ts',
    './ecs': 'src/ecs.ts', './components': 'src/components.ts', './geometry': 'src/geometry.ts',
    './material': 'src/material.ts', './experimental': 'src/experimental.ts',
    './experimental/assets': 'src/experimental/assets.ts', './experimental/async': 'src/experimental/async.ts',
    './experimental/ktx2-worker-runtime': 'src/experimental/ktx2-worker-runtime.ts',
    './experimental/diagnostics': 'src/experimental/diagnostics.ts',
    './experimental/gpu-driven': 'src/experimental/gpu-driven.ts',
    './experimental/renderer': 'src/experimental/renderer.ts', './systems': 'src/systems.ts',
    './physics': 'src/physics.ts', './physics/components': 'src/physics-components.ts',
    './physics/backend': 'src/physics/backend.ts', './postprocess': 'src/postprocess.ts',
    './gui': 'src/gui.ts', './compute': 'src/compute.ts', './scene': 'src/scene.ts',
    './input': 'src/input.ts', './controls': 'src/controls.ts', './tween': 'src/tween.ts',
    './rtt': 'src/rtt.ts', './font': 'src/font.ts', './color': 'src/color.ts',
    './lighting': 'src/lighting.ts', './math': 'src/math.ts', './serialization': 'src/serialization.ts',
    './navigation': 'src/navigation.ts',
  },
  'animation-spec': { '.': 'src/index.ts', './lottie': 'src/lottie.ts', './native3d': 'src/native3d.ts' },
  extensions: {
    '.': 'src/index.ts', './gltf': 'src/gltf.ts', './experimental/gltf-worker': 'src/experimental-gltf-worker.ts',
    './experimental/spine-worker': 'src/experimental-spine-worker.ts', './spine': 'src/spine.ts',
    './tilemap': 'src/tilemap.ts', './canvas-text': 'src/canvas-text.ts', './tween': 'src/tween.ts',
    './grid': 'src/grid.ts', './animation': 'src/animation.ts',
    './hya-state-machine': 'src/hya-state-machine.ts', './animation3d': 'src/animation3d.ts',
    './gltf-animation3d': 'src/gltf-animation3d.ts',
  },
  'shader-language': { '.': 'src/index.ts', './material-graph': 'src/material-graph.ts' },
};

for (const [workspace, sourceEntries] of Object.entries(packages)) {
  const path = resolve(root, workspace, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  for (const [subpath, source] of Object.entries(sourceEntries)) {
    const current = manifest.exports?.[subpath];
    if (!current || typeof current !== 'object') throw new Error(`${workspace} is missing export ${subpath}`);
    manifest.exports[subpath] = { source: `./${source}`, ...current };
  }
  manifest.files = [...new Set([...(manifest.files ?? []), 'src/**/*'])];
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log('[source-exports] Engine package source conditions configured.');
