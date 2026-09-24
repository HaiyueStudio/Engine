import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContentTargetPlan, loadContentManifests } from './content-gate-policy.mjs';
import { releaseCatalogBuildTimeout } from './release-duration-policy.mjs';

export const ENGINE_FOUNDATIONS = Object.freeze(['shader-language', 'engine', 'animation-spec', 'extensions']);
export const ENGINE_REHEARSAL_LABELS = Object.freeze([
  'production dependency, license and credential audit',
  'build clean-checkout workspace dependency foundations',
  'fast release prerequisite gate',
  'deterministic public packages',
  'engine entry budget',
  'build full Engine examples catalog',
]);
export function validateEngineRehearsalManifest(manifest) {
  const expected = ['engine', 'animation-spec', 'extensions', 'shader-language'].map(workspace => ({
    id: `${workspace}-npm`, kind: 'npm-package', workspace, packageName: `@haiyue/${workspace}`,
  }));
  expected.push({ id: 'examples-static-catalog', kind: 'static-catalog', workspace: 'examples' });
  if (manifest?.artifacts?.length !== expected.length || expected.some(contract => {
    const matches = manifest.artifacts.filter(item => item.id === contract.id);
    return matches.length !== 1 || Object.entries(contract).some(([key, value]) => matches[0][key] !== value)
      || matches[0].version !== manifest.releaseVersion;
  })) throw new Error('Engine rehearsal requires exactly four local npm packages and the examples catalog at the release version.');
}
export function createEngineRehearsalPlan(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'review/api/release-manifest.json')));
  validateEngineRehearsalManifest(manifest);
  const content = createContentTargetPlan('full', loadContentManifests(root, 'engine'));
  const commands = [
    ['node', ['scripts/release-supply-chain.mjs', '--output', 'artifacts/release/rehearsal/supply-chain'], 600_000],
    ['node', ['scripts/release-ci-bootstrap.mjs'], 1_200_000],
    ['npm', ['run', 'check:engine:fast'], 1_800_000],
    ['node', ['scripts/verify-engine-package.mjs', '--release'], 2_400_000],
    ['node', ['scripts/check-engine-entry-budget.mjs'], 60_000],
    ['npm', ['run', 'build:examples'], releaseCatalogBuildTimeout(content.targets.length)],
  ].map(([executable, args, timeoutMs], index) => ({
    label: ENGINE_REHEARSAL_LABELS[index], executable, args, timeoutMs,
    ...(index === 5 ? { environment: { EXAMPLE_FILTER: content.targets.map(id => id.slice('example:'.length)).join(','), EXAMPLE_SKIP_SOURCE_VIEWER: '0', EXAMPLE_SHELL_ONLY: '0' } } : {}),
  }));
  return { scope: 'engine', releaseVersion: manifest.releaseVersion, artifactIds: manifest.artifacts.map(item => item.id), content, commands };
}
