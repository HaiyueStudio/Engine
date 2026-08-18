import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const contract = JSON.parse(await readFile(resolve(root, 'shader-language/stage9-contract.json'), 'utf8'));
const paths = {
  engine2d: resolve(root, 'engine/dist/internal/2d-ui-shader-artifact.js'),
  simple3d: resolve(root, 'engine/dist/internal/simple3d-shader-artifact.js'),
  components2d: resolve(root, 'extensions/dist/internal/2d-ui-shader-artifact.js'),
};
const [engine2d, simple3d, components2d] = await Promise.all(Object.values(paths).map(path => readFile(path)));
const evidence = {
  engine2dUiArtifactRawBytes: engine2d.length,
  engine2dUiArtifactGzipBytes: gzipSync(engine2d, { level: 9 }).length,
  simple3dArtifactRawBytes: simple3d.length,
  simple3dArtifactGzipBytes: gzipSync(simple3d, { level: 9 }).length,
  componentsEvidenceArtifactGzipBytes: gzipSync(components2d, { level: 9 }).length,
};
evidence.engineArtifactGzipBytes = evidence.engine2dUiArtifactGzipBytes + evidence.simple3dArtifactGzipBytes;
const failures = [];
for (const [key, value] of Object.entries(evidence)) {
  if (key.startsWith('simple3dArtifact')) {
    if (value > contract.bundle[key]) failures.push(`${key} historical maximum ${contract.bundle[key]}, received ${value}`);
    continue;
  }
  if (key === 'engineArtifactGzipBytes') continue;
  if (contract.bundle[key] !== value) failures.push(`${key} expected ${contract.bundle[key]}, received ${value}`);
}
if (evidence.engineArtifactGzipBytes > contract.bundle.engineArtifactGzipBudgetBytes) {
  failures.push(`engine artifact gzip ${evidence.engineArtifactGzipBytes} exceeds ${contract.bundle.engineArtifactGzipBudgetBytes}`);
}
const publicComponentEntries = ['animation.js', 'spine.js', 'tilemap.js', 'canvas-text.js'];
for (const entry of publicComponentEntries) {
  const source = await readFile(resolve(root, 'extensions/dist', entry), 'utf8');
  if (/internal\/2d-ui-shader-artifact/.test(source)) failures.push(`${entry} loads the reflection evidence artifact`);
}
for (const packageDirectory of ['engine/dist', 'extensions/dist']) {
  for (const path of await javascriptFiles(resolve(root, packageDirectory))) {
    const source = await readFile(path, 'utf8');
    if (/compileBuiltinRenderFamilyV1|haiyue-builtin-render-family/.test(source)) {
      failures.push(`${path} contains the Stage 9 compiler or family parser`);
    }
  }
}
if (failures.length > 0) throw new Error(`Stage 9 shader bundle gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage9:bundle] passed: engine-gzip=${evidence.engineArtifactGzipBytes}/${contract.bundle.engineArtifactGzipBudgetBytes}, components-evidence-gzip=${evidence.componentsEvidenceArtifactGzipBytes}.`);

async function javascriptFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await javascriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) paths.push(path);
  }
  return paths;
}
