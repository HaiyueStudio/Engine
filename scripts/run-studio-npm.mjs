import { spawnSync } from 'node:child_process';

import { npmArgs, npmCommand } from './npm-process.mjs';
import { requireStudioRepository } from './studio-repository-layout.mjs';

const [repositoryName, ...args] = process.argv.slice(2);
if (!repositoryName || args.length === 0) {
  throw new Error('Usage: node scripts/run-studio-npm.mjs <Engine|Editor|Games|UI> <npm arguments...>.');
}
const repository = requireStudioRepository(repositoryName);
console.log(`[studio:${repositoryName}] npm ${args.join(' ')}`);
const result = spawnSync(npmCommand(), npmArgs(args), { cwd: repository.root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
