import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createContentTargetPlan,
  loadContentManifests,
  resolveContentTier,
} from './content-gate-policy.mjs';
import { npmArgs, npmCommand } from './npm-process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentTier = resolveContentTier(process.argv.slice(2));
const contentPlan = createContentTargetPlan(contentTier, loadContentManifests(root));
console.log(
  `[check:slow] content-tier=${contentPlan.tier}; targets=${contentPlan.targets.length}; `
  + `smoke=${contentPlan.selectedCounts.smoke}; full=${contentPlan.selectedCounts.full}; manual=0.`,
);
console.log(`[check:slow] content targets: ${contentPlan.targets.join(', ')}`);
const checks = [
  ['run', 'verify:render'],
  ['run', contentTier === 'full'
    ? 'verify:ambient-occlusion:performance'
    : 'verify:ambient-occlusion:performance:smoke'],
  ['run', 'verify:shader-language-stage14'],
  ['run', 'verify:editor-e2e'],
  ['run', 'verify:editor-large-scene:built'],
  ['run', 'verify:editor-memory'],
  ['run', 'build:target', '--', ...contentPlan.targets],
  ['run', 'benchmark'],
];

for (const args of checks) {
  console.log(`\n[check:slow] npm ${args.join(' ')}`);
  const result = spawnSync(npmCommand(), npmArgs(args), {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`[check:slow] All slow checks passed for content-tier=${contentPlan.tier}.`);
