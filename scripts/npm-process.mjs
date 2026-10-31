import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, delimiter } from 'node:path';

export function npmCommand() {
  return process.execPath;
}

export function npmArgs(args, environment = process.env) {
  return [resolveNpmCli(environment), ...args];
}

export function resolveNpmCli(environment = process.env, {execPath = process.execPath, exists = existsSync, realpath = realpathSync, pathDelimiter = delimiter, paths = {dirname,resolve}} = {}) {
  const executableDirectory = paths.dirname(execPath);
  const candidates = [
    environment.npm_execpath,
    paths.resolve(executableDirectory, 'node_modules/npm/bin/npm-cli.js'),
    paths.resolve(executableDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
    paths.resolve(executableDirectory, '../share/nodejs/npm/bin/npm-cli.js'),
    ...(environment.PATH ?? '').split(pathDelimiter).filter(Boolean).map(directory => {
      const entry = paths.resolve(directory, 'npm');
      try { return exists(entry) ? realpath(entry) : null; } catch { return null; }
    }),
  ].filter(Boolean);
  const cli = candidates.find(candidate => /(?:^|[/\\])npm-cli\.js$/u.test(candidate) && exists(candidate));
  if (!cli) {
    throw new Error(
      `Unable to locate npm-cli.js for Node ${execPath}. Run this command through npm or install npm beside Node.`,
    );
  }
  return cli;
}

/** Both supported platforms resolve the system tar executable through PATH. */
export function tarCommand() { return 'tar'; }
