import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseWorkflows } from './release-workflow-policy.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));

test('checked-in workflows preserve release routing and least-privilege policy', () => {
  const workflowRoot = resolve(root, '.github/workflows');
  const workflows = Object.fromEntries(readdirSync(workflowRoot)
    .filter(name => name.endsWith('.yml'))
    .map(name => [name, readFileSync(resolve(workflowRoot, name), 'utf8')]));
  assert.deepEqual(validateReleaseWorkflows(workflows), []);
  const bootstrap = readFileSync(resolve(root, 'scripts/release-ci-bootstrap.mjs'), 'utf8');
  assert.match(bootstrap, /shader-language[\s\S]*engine[\s\S]*animation-spec[\s\S]*extensions[\s\S]*ui/);
  assert.match(bootstrap, /verify-webgpu-lighting-scaling-fixture\.mjs/);
  assert.match(bootstrap, /WEBGPU_RECORD_PERFORMANCE_EVIDENCE:\s*'0'/);
  assert.match(workflows['ci-release-rehearsal.yml'], /release-rehearsal-policy\.mjs --bundle artifacts\/release\/rehearsal/);
  assert.match(workflows['ci-device-performance.yml'], /runs-on: \[self-hosted, haiyue-performance\]/);
  assert.match(workflows['ci-device-performance.yml'], /performance:compare:formal/);
  assert.match(workflows['deploy-pages.yml'], /workflow_dispatch:/);
  assert.match(workflows['deploy-pages.yml'], /ref: \$\{\{ inputs\.release_tag \}\}/);
  assert.match(workflows['deploy-pages.yml'], /node automation\/scripts\/assemble-pages-release\.mjs/);
  assert.match(workflows['deploy-pages.yml'], /PAGES_SOURCE_ROOT: \$\{\{ github\.workspace \}\}\/release/);
});

test('policy rejects floating actions, secrets and automatic publish commands', () => {
  const errors = validateReleaseWorkflows({
    'bad.yml': `permissions:\n  contents: write\nsteps:\n  - uses: actions/checkout@v6\n  - run: npm publish\n    env:\n      TOKEN: \${{ secrets.NPM_TOKEN }}\n`,
  });
  assert.ok(errors.some(error => error.includes('grants write permission')));
  assert.ok(errors.some(error => error.includes('consumes a secret')));
  assert.ok(errors.some(error => error.includes('not pinned')));
  assert.ok(errors.some(error => error.includes('forbidden publish')));
});

test('policy rejects an automatic or over-privileged Pages deployment', () => {
  const errors = validateReleaseWorkflows({
    'deploy-pages.yml': `on:\n  push:\npermissions:\n  contents: write\n  pages: write\n  id-token: write\nsteps:\n  - uses: actions/deploy-pages@v4\n`,
  });
  assert.ok(errors.some(error => error.includes('unexpected write permission')));
  assert.ok(errors.some(error => error.includes('must not run automatically')));
  assert.ok(errors.some(error => error.includes('not pinned')));
});
