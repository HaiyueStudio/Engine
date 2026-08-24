import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const indexPath = resolve(root, 'animation-spec/corpus/rive/generated-parser/rive-generated-parser-corpus.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
if (index.schemaVersion !== 1 || index.kind !== 'haiyue-rive-generated-parser-corpus') throw new Error('Generated Rive parser corpus index is invalid.');
const modulePath = resolve(root, 'animation-spec/dist-test/conversion/rive-ir/index.js');
let rive;
try {
  rive = await import(pathToFileURL(modulePath).href);
} catch (error) {
  throw new Error('Build animation-spec test output before verifying the generated Rive parser corpus.', { cause: error });
}
const failures = [];
for (const fixture of index.cases) {
  const bytes = readFileSync(resolve(root, fixture.path));
  if (bytes.byteLength !== fixture.byteLength) failures.push(`${fixture.id}: byte length mismatch`);
  if (createHash('sha256').update(bytes).digest('hex') !== fixture.sha256) failures.push(`${fixture.id}: SHA-256 mismatch`);
  try {
    await rive.importFrozenRiv(new Uint8Array(bytes), fixture.options);
    if (fixture.expected !== 'accepted') failures.push(`${fixture.id}: expected ${fixture.expected}, observed success`);
  } catch (error) {
    if (fixture.expected === 'accepted') failures.push(`${fixture.id}: expected success, observed ${String(error?.code ?? error)}`);
    else if (!(error instanceof rive.RiveImportError) || error.code !== fixture.expected) {
      failures.push(`${fixture.id}: expected ${fixture.expected}, observed ${String(error?.code ?? error)}`);
    }
  }
}
if (failures.length > 0) throw new Error(`Generated Rive parser corpus failed:\n- ${failures.join('\n- ')}`);
console.log(`[rive-corpus] ${index.cases.length} generated parser/version fixtures passed with exact diagnostics.`);
