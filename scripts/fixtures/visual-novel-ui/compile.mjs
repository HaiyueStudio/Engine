import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const engineRoot = resolve(import.meta.dirname, '../../..');
export const evidenceRoot = resolve(engineRoot, 'artifacts/engine-0.2.4/g04');
const exec = promisify(execFile);

export async function compileReadingFixture(directory) {
  await mkdir(evidenceRoot, { recursive: true });
  const output = directory ?? await mkdtemp(resolve(evidenceRoot, 'compiled-'));
  try {
    await exec(process.execPath, [resolve(engineRoot, 'node_modules/typescript/bin/tsc'), '-p',
      fileURLToPath(new URL('tsconfig.json', import.meta.url)), '--outDir', output], { cwd: engineRoot, windowsHide: true });
  } catch (error) { throw new Error(error.stdout || error.stderr || error.message, { cause: error }); }
  return output;
}
