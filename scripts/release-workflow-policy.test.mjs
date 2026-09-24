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
  assert.match(bootstrap, /ENGINE_FOUNDATIONS/);
  assert.doesNotMatch(bootstrap, /\['ui'\]/);
  assert.match(bootstrap, /--evidence=diagnostic/);
  assert.match(bootstrap, /verify-webgpu-lighting-scaling-fixture\.mjs/);
  assert.match(bootstrap, /WEBGPU_RECORD_PERFORMANCE_EVIDENCE:\s*'0'/);
  assert.match(workflows['ci-release-rehearsal.yml'], /release-rehearsal-policy\.mjs --bundle artifacts\/release\/rehearsal/);
  assert.match(workflows['ci-device-performance.yml'], /runs-on: \[self-hosted, haiyue-performance\]/);
  assert.match(workflows['ci-device-performance.yml'], /performance:compare:formal/);
  assert.match(workflows['deploy-pages.yml'], /workflow_dispatch:/);
  assert.match(workflows['deploy-pages.yml'], /ref: master/);
  assert.match(workflows['deploy-pages.yml'], /node scripts\/assemble-pages-release\.mjs/);
  assert.doesNotMatch(workflows['deploy-pages.yml'], /release_tag/);
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

test('policy rejects hosted WebGPU workflows without the CI-safe swiftshader backend', () => {
  const errors = validateReleaseWorkflows({
    'ci-fast.yml': `on:\n  pull_request:\n  push:\n    branches: [master]\npermissions:\n  contents: read\njobs:\n  fast:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd\n      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e\n        with:\n          node-version-file: .node-version\n      - run: npm ci\n      - run: node scripts/release-ci-bootstrap.mjs\n      - run: npm run check:engine:fast\n`,
    'ci-slow.yml': `on:\n  pull_request:\n  push:\n    branches: [master]\n  schedule:\n    - cron: '30 18 * * *'\n  workflow_dispatch:\n    inputs:\n      content_tier:\n        options:\n          - smoke\n          - full\npermissions:\n  contents: read\njobs:\n  slow-gate:\n    runs-on: ubuntu-latest\n    env:\n      CONTENT_TIER: \${{ github.event_name == 'schedule' && 'full' || 'smoke' }}\n    steps:\n      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd\n      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e\n        with:\n          node-version-file: .node-version\n      - run: npm ci\n      - run: npm run check:engine:slow -- --content-tier="\${CONTENT_TIER}"\n`,
    'ci-release-rehearsal.yml': `on:\n  push:\n    tags:\n      - 'v*'\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  rehearsal:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd\n      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e\n        with:\n          node-version-file: .node-version\n      - run: npm ci\n      - run: node scripts/release-ci-bootstrap.mjs\n      - run: npm run check:engine:slow -- --content-tier=full\n      - run: node scripts/release-rehearsal.mjs --worker\n      - run: node scripts/release-rehearsal-policy.mjs --bundle artifacts/release/rehearsal\n      - name: Upload rehearsal, provenance, SBOM and raw evidence\n`,
  });
  assert.ok(errors.includes('ci-fast must force swiftshader for hosted headless WebGPU gates'));
  assert.ok(errors.includes('ci-slow must force swiftshader for hosted headless WebGPU gates'));
  assert.ok(errors.includes('release rehearsal must force swiftshader for hosted headless WebGPU gates'));
});

test('policy rejects an automatic or over-privileged Pages deployment', () => {
  const errors = validateReleaseWorkflows({
    'deploy-pages.yml': `on:\n  push:\npermissions:\n  contents: write\n  pages: write\n  id-token: write\nsteps:\n  - uses: actions/deploy-pages@v4\n`,
  });
  assert.ok(errors.some(error => error.includes('unexpected write permission')));
  assert.ok(errors.some(error => error.includes('leave push routing')));
  assert.ok(errors.some(error => error.includes('not pinned')));
});

test('Pages policy rejects wrong source branches and concurrent deployment lanes', () => {
  const manual = readFileSync(resolve(root, '.github/workflows/deploy-pages.yml'), 'utf8');
  const automatic = readFileSync(resolve(root, '.github/workflows/deploy-pages-ci.yml'), 'utf8');
  for (const ref of ['main', '${{ github.ref }}', '${{ inputs.release_tag }}']) {
    const errors = validateReleaseWorkflows({ 'deploy-pages.yml': manual.replace('ref: master', `ref: ${ref}`) });
    assert.ok(errors.includes('Manual Pages deploy must checkout master'), ref);
  }
  const errors = validateReleaseWorkflows({
    'deploy-pages.yml': manual,
    'deploy-pages-ci.yml': automatic
      .replace('group: github-pages', 'group: github-pages-ci')
      .replace('ref: ${{ github.sha }}', 'ref: master'),
  });
  assert.ok(errors.includes('Pages CI must share the serialized github-pages deployment group'));
  assert.ok(errors.includes('Pages CI must checkout the exact pushed commit'));
});

test('both Pages entrypoints reject deployment privileges in the build job', () => {
  for (const name of ['deploy-pages.yml', 'deploy-pages-ci.yml']) {
    const source = readFileSync(resolve(root, '.github/workflows', name), 'utf8');
    const errors = validateReleaseWorkflows({ [name]: source.replace('pages: read', 'pages: write') });
    assert.ok(errors.some(error => error.includes('write permissions must stay in deploy job')), name);
  }
});
