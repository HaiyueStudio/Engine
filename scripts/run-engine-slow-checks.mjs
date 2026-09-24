import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { npmArgs, npmCommand } from './npm-process.mjs';
import { createContentTargetPlan, loadContentManifests, resolveContentTier } from './content-gate-policy.mjs';
import { createEngineSlowChecks } from './engine-release-policy.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plan = createContentTargetPlan(resolveContentTier(process.argv.slice(2)), loadContentManifests(root, 'engine'));
console.log(`[engine:slow] tier=${plan.tier}; targets=${plan.targets.length}; manual=0: ${plan.targets.join(', ')}`);
for (const args of createEngineSlowChecks(plan)) {
  console.log(`[engine:slow] npm ${args.join(' ')}`);
  const result = spawnSync(npmCommand(), npmArgs(args), { cwd: root, stdio: 'inherit', env: { ...process.env, HAIYUE_BENCHMARK_SCOPE: 'engine' } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
