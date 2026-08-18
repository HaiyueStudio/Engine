import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');

export async function checkShaderMigrationManifest() {
  const manifestPath = resolve(root, 'shader-language/migration-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const failures = [];
  if (manifest.schemaVersion !== 1 || manifest.stage !== 14) failures.push('manifest identity must be schemaVersion=1, stage=14');

  const declared = [];
  const generated = [];
  for (const family of manifest.sourceFamilies ?? []) {
    if (!family.id || !['generated', 'pending', 'retained-escape-hatch'].includes(family.status)) {
      failures.push(`invalid source family ${family.id ?? '<missing>'}`);
    }
    if (family.status === 'generated' && !family.generator) failures.push(`generated family ${family.id} has no generator`);
    for (const path of family.sources ?? []) {
      declared.push(path);
      if (family.status === 'generated') generated.push(path);
    }
  }
  const duplicates = declared.filter((path, index) => declared.indexOf(path) !== index);
  if (duplicates.length > 0) failures.push(`duplicate shader declarations: ${[...new Set(duplicates)].join(', ')}`);

  const inventory = [
    ...(await walkWgsl(resolve(root, 'engine/src/shaders'))),
    ...(await walkWgsl(resolve(root, 'extensions/src/shaders'))),
  ].map(path => repositoryPath(path)).sort();
  const expected = [...declared].sort();
  for (const path of inventory.filter(path => !expected.includes(path))) failures.push(`unclassified WGSL source ${path}`);
  for (const path of expected.filter(path => !inventory.includes(path))) failures.push(`manifest references missing WGSL source ${path}`);
  if (generated.length === 0 || generated.some(path => !path.endsWith('.generated.wgsl'))) {
    failures.push('generated shader families must contain only .generated.wgsl artifacts');
  }

  for (const site of [...(manifest.inlineShaderSites ?? []), ...(manifest.escapeHatches ?? [])]) {
    const absolute = resolve(root, site.path ?? '');
    if (!insideRoot(absolute) || !existsSync(absolute)) failures.push(`missing or unsafe shader site ${site.path}`);
  }
  if (!(manifest.escapeHatches ?? []).some(site => site.id === 'custom-pass' && site.disposition === 'retain-raw-wgsl')) {
    failures.push('CustomPass raw-WGSL boundary is not explicitly retained');
  }
  if (!(manifest.escapeHatches ?? []).some(site => site.id === 'compute-kernel' && site.disposition === 'retain-raw-wgsl')) {
    failures.push('ComputeKernel raw-WGSL boundary is not explicitly retained');
  }
  if (failures.length > 0) throw new Error(`Shader migration manifest failed:\n- ${failures.join('\n- ')}`);
  return Object.freeze({
    wgslSourceCount: inventory.length,
    generatedSourceCount: generated.length,
    handwrittenSourceCount: inventory.length - generated.length,
    inlineShaderSiteCount: manifest.inlineShaderSites.length,
    escapeHatchCount: manifest.escapeHatches.length,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkShaderMigrationManifest();
  console.log(`[shader-language:migration-manifest] ${result.wgslSourceCount} WGSL sources classified (${result.generatedSourceCount} generated, ${result.handwrittenSourceCount} handwritten), ${result.inlineShaderSiteCount} inline sites, ${result.escapeHatchCount} escape hatches.`);
}

async function walkWgsl(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walkWgsl(absolute));
    else if (entry.isFile() && entry.name.endsWith('.wgsl')) result.push(absolute);
  }
  return result;
}

function repositoryPath(path) {
  return relative(root, path).split(sep).join('/');
}

function insideRoot(path) {
  const value = relative(root, path);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`));
}
