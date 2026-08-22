import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmArgs, npmCommand } from './npm-process.mjs';

const toolingRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pagesExamples = process.argv.includes('--pages-examples');
const root = pagesExamples
  ? resolve(process.env.PAGES_SOURCE_ROOT ?? toolingRoot)
  : toolingRoot;
const allBuilds = [
  ['shader-language'],
  ['engine'],
  ['animation-spec'],
  ['extensions'],
  ['ui'],
];
const builds = pagesExamples ? allBuilds.slice(0, 4) : allBuilds;

for (const [workspace] of builds) {
  console.log(`[release-ci-bootstrap] build workspace=${workspace}`);
  run(npmCommand(), npmArgs(['run', 'build', '-w', `./${workspace}`]));
}
if (!pagesExamples) {
  console.log('[release-ci-bootstrap] generate lighting scaling diagnostic required by fast policy tests; formal-evidence=false');
  run(process.execPath, [
    'scripts/verify-webgpu-lighting-scaling-fixture.mjs',
    '--lights=128',
    '--overlap=high',
    '--dynamic=1',
    '--views=4',
    '--resolution=720p',
    '--warmup=4',
    '--samples=8',
    '--gpu-samples=2',
  ]);
}
console.log(`[release-ci-bootstrap] passed; workspaces=${builds.map(([workspace]) => workspace).join(',')}.`);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, WEBGPU_RECORD_PERFORMANCE_EVIDENCE: '0' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
