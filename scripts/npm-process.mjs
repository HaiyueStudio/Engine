import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function npmCommand() {
  return process.execPath;
}

export function npmArgs(args, environment = process.env) {
  return [resolveNpmCli(environment), ...args];
}

function resolveNpmCli(environment) {
  const candidates = [
    environment.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].filter(Boolean);
  const cli = candidates.find(candidate => existsSync(candidate));
  if (!cli) {
    throw new Error(
      `Unable to locate npm-cli.js for Node ${process.execPath}. Run this command through npm or install npm beside Node.`,
    );
  }
  return cli;
}
