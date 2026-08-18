import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const sourcePath = resolve(root, 'shader-language/src/adapter/precompiled-artifact-contract.ts');
const outputPath = resolve(root, 'engine/src/shader/PrecompiledShaderArtifact.generated.ts');

export async function generateRuntimeArtifactContract({ write = false } = {}) {
  const source = await readFile(sourcePath, 'utf8');
  if (/\b(?:const|let|var|function|class|enum|namespace)\b/.test(source)) {
    throw new Error('Artifact contract must remain type-only so it cannot enter the engine runtime closure.');
  }
  const expected = '// Generated from shader-language/src/adapter/precompiled-artifact-contract.ts. Do not edit.\n' + source;
  if (write) {
    await writeFile(outputPath, expected, 'utf8');
  } else {
    let actual = null;
    try { actual = await readFile(outputPath, 'utf8'); } catch { /* reported below */ }
    if (actual !== expected) {
      throw new Error('Stale engine Artifact V2 runtime contract. Run npm run shader-language:generate.');
    }
  }
  return Object.freeze({ id: 'artifact-v2-runtime-contract', outputCount: 1 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write');
  const result = await generateRuntimeArtifactContract({ write });
  console.log(`[shader-language:artifact-contract] ${write ? 'wrote' : 'verified'} ${result.outputCount} generated runtime contract.`);
}
