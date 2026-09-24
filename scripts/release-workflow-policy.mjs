const ACTION_NAME = '(?:checkout|setup-node|upload-artifact|configure-pages|upload-pages-artifact|deploy-pages)';
const PINNED_ACTION = new RegExp(`uses:\\s+actions\\/${ACTION_NAME}@[0-9a-f]{40}(?:\\s+#\\s+v\\d+)?`, 'gu');

export function validateReleaseWorkflows(workflows) {
  const errors = [];
  for (const [name, source] of Object.entries(workflows)) {
    if (!/permissions:\s*\n\s*contents:\s*read/gu.test(source)) errors.push(`${name} must declare contents: read`);
    const writePermissions = source.split('\n')
      .map(line => line.trim())
      .filter(line => /^(?:[\w-]+:\s*write|write-all)$/u.test(line));
    if (['deploy-pages.yml', 'deploy-pages-ci.yml'].includes(name)) {
      const unexpected = writePermissions.filter(line => !['pages: write', 'id-token: write'].includes(line));
      if (unexpected.length > 0) errors.push(`${name} grants unexpected write permission: ${unexpected.join(', ')}`);
    } else if (writePermissions.length > 0) {
      errors.push(`${name} grants write permission`);
    }
    if (/\$\{\{\s*secrets\./gu.test(source)) errors.push(`${name} consumes a secret outside a protected publish workflow`);
    if (/\b(?:npm\s+publish|git\s+tag|git\s+push|gh\s+release|baseline:update)\b/gu.test(source)) {
      errors.push(`${name} contains a forbidden publish, tag, push, or baseline-update command`);
    }
    const actionLines = source.split('\n').filter(line => new RegExp(`uses:\\s+actions\\/${ACTION_NAME}@`, 'u').test(line));
    for (const line of actionLines) {
      if (!PINNED_ACTION.test(line.trim())) errors.push(`${name} has an action that is not pinned to a full commit SHA: ${line.trim()}`);
      PINNED_ACTION.lastIndex = 0;
    }
    if (!/node-version-file:\s*(?:[\w.-]+\/)*\.node-version/gu.test(source)) errors.push(`${name} must use .node-version`);
    if (!/run:\s*npm ci\b/gu.test(source)) errors.push(`${name} must install from package-lock.json with npm ci`);
  }

  validateFast(workflows['ci-fast.yml'] ?? '', errors);
  validateSlow(workflows['ci-slow.yml'] ?? '', errors);
  validateRelease(workflows['ci-release-rehearsal.yml'] ?? '', errors);
  validateDevice(workflows['ci-device-performance.yml'] ?? '', errors);
  validatePages(workflows['deploy-pages.yml'] ?? '', errors);
  if (workflows['deploy-pages-ci.yml']) validatePreviewPages(workflows['deploy-pages-ci.yml'], errors);
  return errors;
}

function validateFast(source, errors) {
  requireMatch(source, /pull_request:/u, 'ci-fast must run on pull requests', errors);
  requireMatch(source, /push:\s*\n\s*branches:\s*\[master\]/u, 'ci-fast must run on master pushes', errors);
  requireMatch(source, /npm run check:engine:fast/u, 'ci-fast must run check:engine:fast', errors);
  requireMatch(source, /release-ci-bootstrap\.mjs[\s\S]*npm run check:engine:fast/u, 'ci-fast must build workspace foundations before check:engine:fast', errors);
}

function validateSlow(source, errors) {
  requireMatch(source, /pull_request:/u, 'ci-slow must run on pull requests', errors);
  requireMatch(source, /push:\s*\n\s*branches:\s*\[master\]/u, 'ci-slow must run on master pushes', errors);
  requireMatch(source, /schedule:\s*\n\s*- cron:/u, 'ci-slow must have a nightly schedule', errors);
  requireMatch(source, /content_tier:[\s\S]*options:[\s\S]*- smoke[\s\S]*- full/u, 'ci-slow dispatch must expose smoke and full only', errors);
  requireMatch(source, /github\.event_name == 'schedule' && 'full'/u, 'ci-slow schedule must select full', errors);
  requireMatch(source, /check:engine:slow -- --content-tier="\$\{CONTENT_TIER\}"/u, 'ci-slow must pass its selected content tier', errors);
  if (/options:[\s\S]*- manual/u.test(source)) errors.push('ci-slow must never expose the manual manifest tier');
}

function validateRelease(source, errors) {
  requireMatch(source, /push:\s*\n\s*tags:\s*\n\s*- ['"]v\*['"]/u, 'release rehearsal must run for version tags', errors);
  requireMatch(source, /workflow_dispatch:/u, 'release rehearsal must support explicit dispatch', errors);
  requireMatch(source, /release-ci-bootstrap\.mjs/u, 'release rehearsal must build Engine foundations before full checks', errors);
  requireMatch(source, /check:engine:slow -- --content-tier=full/u, 'release rehearsal must run the full content tier', errors);
  requireMatch(source, /release-rehearsal\.mjs --worker/u, 'release workflow must run the no-publish worker', errors);
  requireMatch(source, /release-rehearsal\.mjs --worker[\s\S]*release-rehearsal-policy\.mjs --bundle artifacts\/release\/rehearsal/u, 'release workflow must independently validate the assembled rehearsal bundle', errors);
  requireMatch(source, /Upload rehearsal, provenance, SBOM and raw evidence/u, 'release workflow must upload rehearsal evidence', errors);
}

function validateDevice(source, errors) {
  requireMatch(source, /runs-on:\s*\[self-hosted, haiyue-performance\]/u, 'performance job must use a native self-hosted runner without a fixed GPU profile', errors);
  requireMatch(source, /WEBGPU_REQUIRE_NATIVE:\s*"1"/u, 'performance job must require native WebGPU', errors);
  requireMatch(source, /npm run performance:compare:test/u, 'performance job must validate the comparison policy', errors);
  requireMatch(source, /npm run performance:compare:formal/u, 'performance job must run the formal five-engine workload', errors);
  requireMatch(source, /artifacts\/performance-comparison\/formal\.json/u, 'performance job must upload the formal comparison artifact', errors);
  requireMatch(source, /if:\s*always\(\)[\s\S]*upload-artifact/u, 'performance job must upload raw evidence even when validation fails', errors);
  if (/device-profile|WEBGPU_DEVICE_PROFILE|windows-integrated|windows-discrete|apple-integrated/u.test(source)) {
    errors.push('performance job must not require a named hardware profile');
  }
}

function validatePages(source, errors) {
  requireMatch(source, /workflow_dispatch:/u, 'Pages deploy must support manual dispatch', errors);
  if (/^\s*push:/mu.test(source)) errors.push('Manual Pages deploy must leave push routing to deploy-pages-ci');
  requireMatch(source, /ref:\s*master\s*\n/u, 'Manual Pages deploy must checkout master', errors);
  if (/release_tag|TAG_SHA|verification\.verified/u.test(source)) errors.push('Master Pages deployment must not require a release tag');
  validatePagesBuildAndDeploy(source, 'Pages deploy', errors);
}

function validatePagesBuildAndDeploy(source, label, errors) {
  requireMatch(source, /group:\s*github-pages\s*\n\s*cancel-in-progress:\s*false/u, `${label} must share the serialized github-pages deployment group`, errors);
  requireMatch(source, /persist-credentials:\s*false/u, `${label} checkout must not persist credentials`, errors);
  requireMatch(source, /node scripts\/release-ci-bootstrap\.mjs --pages-examples/u, `${label} must build workspace foundations`, errors);
  requireMatch(source, /npm run build:examples[\s\S]*npm run examples:catalog:check/u, `${label} must build and validate the examples catalog`, errors);
  requireMatch(source, /node scripts\/assemble-pages-release\.mjs/u, `${label} must assemble the checked-out source`, errors);
  requireMatch(source, /PAGES_OUTPUT_ROOT:\s*\$\{\{\s*github\.workspace\s*\}\}\/artifacts\/pages-release/u, `${label} must use the repository Pages output`, errors);
  requireMatch(source, /actions\/configure-pages@[0-9a-f]{40}/u, `${label} must configure Pages with a pinned action`, errors);
  requireMatch(source, /actions\/upload-pages-artifact@[0-9a-f]{40}/u, `${label} must upload with a pinned action`, errors);
  const deploy = source.split(/\n  deploy:\s*\n/u);
  if (deploy.length !== 2 || /(?:pages|id-token):\s*write/u.test(deploy[0])) errors.push(`${label} write permissions must stay in deploy job`);
  requireMatch(deploy[1] ?? '', /pages:\s*write/u, `${label} requires Pages write capability`, errors);
  requireMatch(deploy[1] ?? '', /id-token:\s*write/u, `${label} requires OIDC for deployment`, errors);
  requireMatch(deploy[1] ?? '', /environment:\s*\n\s*name: github-pages/u, `${label} requires its protected environment`, errors);
  requireMatch(deploy[1] ?? '', /needs: build/u, `${label} deploy must depend on its build`, errors);
  requireMatch(deploy[1] ?? '', /actions\/deploy-pages@[0-9a-f]{40}/u, `${label} must use pinned official deployment`, errors);
}

function requireMatch(source, pattern, message, errors) {
  if (!pattern.test(source)) errors.push(message);
}

// Automatic pushes and manual dispatch deploy the same master examples site.
function validatePreviewPages(source, errors) {
  requireMatch(source, /push:\s*\n\s*branches:\s*\n\s*- master/u, 'Pages CI must keep its explicit master routing', errors);
  requireMatch(source, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/u, 'Pages CI must checkout the exact pushed commit', errors);
  validatePagesBuildAndDeploy(source, 'Pages CI', errors);
}
