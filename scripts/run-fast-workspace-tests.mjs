import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MANDATORY_FAST_TEST_TARGETS } from './fast-gate-workspace-policy.mjs';
import { requireStudioRepository } from './studio-repository-layout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const target of MANDATORY_FAST_TEST_TARGETS) {
  console.log(`\n[fast-gate] testing ${target.repository}:${target.id}`);
  const invocation = npmInvocation(target.npmArgs);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: requireStudioRepository(target.repository).root,
    stdio: 'inherit',
    env: process.env,
    shell: invocation.shell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function npmInvocation(args) {
  const override = process.env.FAST_GATE_NPM_COMMAND;
  if (override) {
    return extname(override) === '.mjs'
      ? { command: process.execPath, args: [override, ...args], shell: false }
      : { command: override, args, shell: process.platform === 'win32' && /\.cmd$/iu.test(override) };
  }
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args], shell: false };
  }
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    shell: process.platform === 'win32',
  };
}
