import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRollupOnce } from '../../scripts/shared-rollup-runner.mjs';
import {
  computeExampleSourceFingerprint,
  verifyExampleBuildFreshness,
} from './example-build-fingerprint.mjs';
import {
  SHARED_ENGINE_OUTPUT,
  SHARED_ENGINE_TARGET,
} from './shared-engine-bundle.mjs';

const examplesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(readFileSync(resolve(examplesDir, 'manifest.json'), 'utf8'));
const allDemos = manifest.entries.map(entry => entry.id);
const filter = process.env.EXAMPLE_FILTER;
const shellOnly = process.env.EXAMPLE_SHELL_ONLY === '1';
const skipSourceViewer = process.env.EXAMPLE_SKIP_SOURCE_VIEWER === '1';
const requestedDemos = parseFilter(filter);
const demos = requestedDemos.length > 0
  ? allDemos.filter(name => requestedDemos.includes(name))
  : allDemos;

const missingDemos = requestedDemos.filter(name => !allDemos.includes(name));
if (missingDemos.length > 0) {
  console.error(`Unknown example${missingDemos.length === 1 ? '' : 's'} "${missingDemos.join(', ')}".`);
  process.exit(1);
}

const sourceFingerprint = await computeExampleSourceFingerprint();

if (!shellOnly) {
  await buildTarget('shared Engine bundle', {
    EXAMPLE_FILTER: '',
    EXAMPLE_SHARED_ONLY: '1',
  }, SHARED_ENGINE_OUTPUT);
}

if (!skipSourceViewer) {
  await buildTarget('index source viewer', {
    EXAMPLE_FILTER: '',
    EXAMPLE_SHELL_ONLY: '1',
  }, 'source-viewer/bundle.js');
}

if (!shellOnly) {
  for (const demo of demos) await buildDemo(demo);
}

const targets = [
  ...(shellOnly ? [] : [SHARED_ENGINE_TARGET]),
  ...(skipSourceViewer ? [] : ['source-viewer']),
  ...(shellOnly ? [] : demos),
];
const freshness = await verifyExampleBuildFreshness({
  targets,
  fingerprint: sourceFingerprint,
});
console.log(
  `[examples:build] ${freshness.targetCount} fresh targets at ${freshness.sourceFingerprint.slice(0, 12)}.`,
);

async function buildDemo(demo) {
  await buildTarget(`example ${demo}`, {
    EXAMPLE_FILTER: demo,
    EXAMPLE_SKIP_SHELL: '1',
    EXAMPLE_SKIP_SHARED_ENGINE: '1',
  }, `${demo}/bundle.js`);
}

async function buildTarget(label, environment, expectedOutput) {
  console.log(`\n> rollup ${label}`);
  try {
    await runRollupOnce({
      cwd: examplesDir,
      config: 'rollup.config.js',
      expectedOutputs: [expectedOutput],
      label,
      timeoutMs: environmentDuration('EXAMPLE_BUILD_TIMEOUT_MS', 60_000),
      exitGraceMs: environmentDuration('EXAMPLE_EXIT_GRACE_MS', 1_500, true),
      terminateGraceMs: environmentDuration('EXAMPLE_TERM_GRACE_MS', 1_000),
      killGraceMs: environmentDuration('EXAMPLE_KILL_GRACE_MS', 1_000),
      environment: {
        EXAMPLE_SOURCE_FINGERPRINT: sourceFingerprint.hash,
        EXAMPLE_SOURCE_INPUT_COUNT: String(sourceFingerprint.inputCount),
        ...environment,
      },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    throw error;
  }
}

function parseFilter(value) {
  if (!value) return [];
  return [...new Set(value.split(',').map(name => name.trim()).filter(Boolean))];
}

function environmentDuration(name, fallback, allowZero = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'zero or a positive integer' : 'a positive integer'}.`);
  }
  return value;
}
