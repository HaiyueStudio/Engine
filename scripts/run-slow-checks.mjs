import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createContentTargetPlan,
  loadContentManifests,
  resolveContentTier,
} from './content-gate-policy.mjs';
import { npmArgs, npmCommand } from './npm-process.mjs';
import { requireStudioRepository } from './studio-repository-layout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentTier = resolveContentTier(process.argv.slice(2));
const contentPlan = createContentTargetPlan(contentTier, loadContentManifests(root));
console.log(
  `[check:slow] content-tier=${contentPlan.tier}; targets=${contentPlan.targets.length}; `
  + `smoke=${contentPlan.selectedCounts.smoke}; full=${contentPlan.selectedCounts.full}; manual=0.`,
);
console.log(`[check:slow] content targets: ${contentPlan.targets.join(', ')}`);
const exampleTargets = contentPlan.targets.filter(target => target.startsWith('example:'));
const gameTargets = contentPlan.targets.filter(target => target.startsWith('game:'));
const checks = [
  check('Engine', ['run', 'verify:render']),
  check('Engine', ['run', contentTier === 'full'
    ? 'verify:ambient-occlusion:performance'
    : 'verify:ambient-occlusion:performance:smoke']),
  check('Engine', ['run', 'verify:shader-language-stage14']),
  check('Editor', ['run', 'test:e2e', '-w', './editor']),
  check('Engine', ['run', 'verify:editor-large-scene:built']),
  check('Editor', ['run', 'build:test', '-w', './editor']),
  check('Engine', ['run', 'verify:editor-memory']),
  ...(exampleTargets.length ? [check('Engine', ['run', 'build:target', '--', ...exampleTargets])] : []),
  ...(gameTargets.length ? [check('Games', ['run', 'build:target', '--', ...gameTargets])] : []),
  check('Engine', ['run', 'benchmark']),
];

for (const entry of checks) {
  console.log(`\n[check:slow] ${entry.repository}: npm ${entry.args.join(' ')}`);
  const result = spawnSync(npmCommand(), npmArgs(entry.args), {
    cwd: requireStudioRepository(entry.repository).root,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`[check:slow] All slow checks passed for content-tier=${contentPlan.tier}.`);

function check(repository, args) {
  return Object.freeze({ repository, args: Object.freeze(args) });
}
