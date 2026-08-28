import { execFileSync } from 'node:child_process';

export function captureRepositoryIdentity(root, options = {}) {
  const execute = options.execFileSync ?? execFileSync;
  const git = args => execute('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const revision = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  return { revision, status, dirty: status.length > 0 };
}

export function formalRepositoryIdentityViolations(start, end = start, options = {}) {
  const label = options.label ?? 'Repository';
  const violations = [];
  if (start.dirty || end.dirty) violations.push(`${label} worktree is dirty`);
  if (start.revision !== end.revision) violations.push(`${label} revision changed during the run (${start.revision} -> ${end.revision})`);
  if (start.status !== end.status) violations.push(`${label} worktree changed during the run`);
  return violations;
}

export function assertFormalRepositoryIdentity(start, end = start, options = {}) {
  const violations = formalRepositoryIdentityViolations(start, end, options);
  if (violations.length > 0) throw new Error(`Formal evidence repository identity check failed:\n- ${violations.join('\n- ')}`);
}
