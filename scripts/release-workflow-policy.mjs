const ACTION_NAME = '(?:checkout|setup-node|upload-artifact|configure-pages|upload-pages-artifact|deploy-pages)';
const PINNED_ACTION = new RegExp(`uses:\\s+actions\\/${ACTION_NAME}@[0-9a-f]{40}(?:\\s+#\\s+v\\d+)?`, 'gu');

export function validateReleaseWorkflows(workflows) {
  const errors = [];
  for (const [name, source] of Object.entries(workflows)) {
    if (!/permissions:\s*\n\s*contents:\s*read/gu.test(source)) errors.push(`${name} must declare contents: read`);
    const writePermissions = source.split('\n')
      .map(line => line.trim())
      .filter(line => /^(?:[\w-]+:\s*write|write-all)$/u.test(line));
    if (name === 'deploy-pages.yml') {
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
  return errors;
}

function validateFast(source, errors) {
  requireMatch(source, /pull_request:/u, 'ci-fast must run on pull requests', errors);
  requireMatch(source, /push:\s*\n\s*branches:\s*\[main\]/u, 'ci-fast must run on main pushes', errors);
  requireMatch(source, /npm run check:fast/u, 'ci-fast must run check:fast', errors);
  requireMatch(source, /release-ci-bootstrap\.mjs[\s\S]*npm run check:fast/u, 'ci-fast must build workspace foundations before check:fast', errors);
}

function validateSlow(source, errors) {
  requireMatch(source, /pull_request:/u, 'ci-slow must run on pull requests', errors);
  requireMatch(source, /push:\s*\n\s*branches:\s*\[main\]/u, 'ci-slow must run on main pushes', errors);
  requireMatch(source, /schedule:\s*\n\s*- cron:/u, 'ci-slow must have a nightly schedule', errors);
  requireMatch(source, /content_tier:[\s\S]*options:[\s\S]*- smoke[\s\S]*- full/u, 'ci-slow dispatch must expose smoke and full only', errors);
  requireMatch(source, /github\.event_name == 'schedule' && 'full'/u, 'ci-slow schedule must select full', errors);
  requireMatch(source, /check:slow -- --content-tier="\$\{CONTENT_TIER\}"/u, 'ci-slow must pass its selected content tier', errors);
  if (/options:[\s\S]*- manual/u.test(source)) errors.push('ci-slow must never expose the manual manifest tier');
}

function validateRelease(source, errors) {
  requireMatch(source, /push:\s*\n\s*tags:\s*\n\s*- ['"]v\*['"]/u, 'release rehearsal must run for version tags', errors);
  requireMatch(source, /workflow_dispatch:/u, 'release rehearsal must support explicit dispatch', errors);
  requireMatch(source, /release-ci-bootstrap\.mjs[\s\S]*npm run check:fast/u, 'release rehearsal must build workspace foundations before check:fast', errors);
  requireMatch(source, /npm run check:fast/u, 'release rehearsal must run the fast gate', errors);
  requireMatch(source, /check:slow -- --content-tier=full/u, 'release rehearsal must run the full content tier', errors);
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
  requireMatch(source, /workflow_dispatch:[\s\S]*release_tag:[\s\S]*required:\s*true/u, 'Pages deploy must require an explicit release tag', errors);
  if (/^\s*push:/mu.test(source)) errors.push('Pages deploy must not run automatically from an unreviewed push');
  requireMatch(source, /contents:\s*read/u, 'Pages deploy must keep source read-only', errors);
  requireMatch(source, /pages:\s*write/u, 'Pages deploy requires only the Pages write capability', errors);
  requireMatch(source, /id-token:\s*write/u, 'Pages deploy requires OIDC for the official deploy action', errors);
  requireMatch(source, /ref:\s*\$\{\{\s*inputs\.release_tag\s*\}\}/u, 'Pages deploy must checkout the requested immutable release tag', errors);
  requireMatch(source, /persist-credentials:\s*false/u, 'Pages deploy checkout must not persist credentials', errors);
  requireMatch(source, /git rev-parse "\$\{RELEASE_TAG\}\^\{tag\}"/u, 'Pages deploy must reject lightweight tags', errors);
  requireMatch(source, /git\/tags\/\$\{TAG_SHA\}[\s\S]*verification\.verified/u, 'Pages deploy must require GitHub-verified tag signatures', errors);
  requireMatch(source, /release-ci-bootstrap\.mjs/u, 'Pages deploy must build workspace foundations', errors);
  requireMatch(source, /node automation\/scripts\/assemble-pages-release\.mjs/u, 'Pages deploy must use the governed site assembler from the tooling checkout', errors);
  requireMatch(source, /PAGES_SOURCE_ROOT:\s*\$\{\{\s*github\.workspace\s*\}\}\/release/u, 'Pages assembler must consume only the release-tag checkout', errors);
  requireMatch(source, /actions\/configure-pages@[0-9a-f]{40}/u, 'Pages deploy must configure Pages with a pinned action', errors);
  requireMatch(source, /actions\/upload-pages-artifact@[0-9a-f]{40}/u, 'Pages deploy must upload with a pinned action', errors);
  requireMatch(source, /actions\/deploy-pages@[0-9a-f]{40}/u, 'Pages deploy must deploy with a pinned action', errors);
  requireMatch(source, /name:\s*github-pages/u, 'Pages deploy must use the protected github-pages environment', errors);
}

function requireMatch(source, pattern, message, errors) {
  if (!pattern.test(source)) errors.push(message);
}
