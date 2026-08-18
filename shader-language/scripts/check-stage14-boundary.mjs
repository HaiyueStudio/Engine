import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const failures = [];
const engineManifest = JSON.parse(await readFile(resolve(root, 'engine/package.json'), 'utf8'));
const dependencies = { ...engineManifest.dependencies, ...engineManifest.devDependencies };
if (dependencies['@haiyue/shader-language'] !== undefined) failures.push('engine must not depend on the private shader compiler');

const forbidden = ['compileShaderIrProgramToGlslEs300', 'webgl2-glsl-es300', '#version 300 es', '@haiyue/shader-language'];
for (const path of await walk(resolve(root, 'engine/src'))) {
  if (!/\.(?:ts|js|mjs)$/.test(path)) continue;
  const source = await readFile(path, 'utf8');
  for (const marker of forbidden) if (source.includes(marker)) failures.push(`engine runtime contains stage14 compiler marker ${marker}: ${path}`);
}
const compilerIndex = await readFile(resolve(root, 'shader-language/dist/index.js'), 'utf8');
if (!compilerIndex.includes('compileShaderIrProgramToGlslEs300')) failures.push('private compiler build does not export the GLSL ES 3.00 backend');
const manifest = JSON.parse(await readFile(resolve(root, 'shader-language/migration-manifest.json'), 'utf8'));
if (manifest.stage !== 14) failures.push(`migration manifest stage must be 14, got ${manifest.stage}`);
if (failures.length) throw new Error(`Shader language stage 14 boundary failed:\n- ${failures.join('\n- ')}`);
console.log('[shader-language:stage14:boundary] passed: private compiler only; engine renderer remains WebGPU-only.');

async function walk(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) result.push(...await walk(child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}
