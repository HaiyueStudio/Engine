import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANDATORY_FAST_TEST_WORKSPACES } from './fast-gate-workspace-policy.mjs';

const EXPECTED_WORKSPACES = [
  './engine',
  './animation-spec',
  './extensions',
  './ui',
  './games',
  './editor',
  './AnimationEditor',
  './voxelEditor',
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runner = resolve(root, 'scripts/run-fast-workspace-tests.mjs');

test('fast gate executes every mandatory workspace test through the production runner', () => {
  assert.deepEqual(MANDATORY_FAST_TEST_WORKSPACES, EXPECTED_WORKSPACES);
  const result = runPolicyFixture();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, EXPECTED_WORKSPACES.map(workspace => (
    ['test', '-w', workspace]
  )));
});

test('fast gate stops immediately and preserves a mandatory workspace failure', () => {
  const result = runPolicyFixture('./animation-spec');
  assert.equal(result.status, 7);
  assert.deepEqual(result.calls, [
    ['test', '-w', './engine'],
    ['test', '-w', './animation-spec'],
  ]);
});

test('check:fast invokes the behavioral workspace runner', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    packageJson.scripts['test:workspaces:fast'],
    'node scripts/run-fast-workspace-tests.mjs',
  );
  assert.match(packageJson.scripts['check:fast'], /npm run test:workspaces:fast/);
  assert.doesNotMatch(packageJson.scripts['check:fast'], /npm test -w \.\/(?:animation-spec|voxelEditor)/);
});

function runPolicyFixture(failingWorkspace = '') {
  const directory = mkdtempSync(join(tmpdir(), 'haiyue-fast-gate-policy-'));
  const executable = join(directory, 'fake-npm.mjs');
  const log = join(directory, 'calls.jsonl');
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAST_GATE_POLICY_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.at(-1) === process.env.FAST_GATE_FAIL_WORKSPACE) process.exit(7);
`);
  chmodSync(executable, 0o755);
  try {
    const result = spawnSync(process.execPath, [runner], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FAST_GATE_NPM_COMMAND: executable,
        FAST_GATE_POLICY_LOG: log,
        FAST_GATE_FAIL_WORKSPACE: failingWorkspace,
      },
    });
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
