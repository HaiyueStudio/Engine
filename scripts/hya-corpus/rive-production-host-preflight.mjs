import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProductionAdapterEnvironment } from './rive-production-adapter-bridge.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`Rive production hosts require Node.js 22 or later; observed ${process.version}.`);
const config = argument('--config');
const environment = config ? { ...process.env, RIVE_PRODUCTION_HOST_CONFIG_PATH: resolve(config) } : process.env;
const hosts = [];
const violations = [];
for (const kind of ['capability', 'official', 'hya']) {
  try { hosts.push(await verifyProductionAdapterEnvironment(kind, environment)); }
  catch (error) { violations.push(`${kind}: ${bounded(error)}`); }
}
const report = {
  schemaVersion: 1,
  kind: 'haiyue-rive-production-host-preflight',
  status: violations.length === 0 ? 'passed' : 'failed',
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  hosts,
  violations,
};
const output = argument('--out');
if (output) {
  const outputPath = safePath(output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`[rive-production-host] preflight ${report.status}; hosts=${hosts.length}/3; violations=${violations.length}${output ? `; report=${relative(root, safePath(output))}` : ''}.`);
if (violations.length > 0) {
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
}

function argument(name) { return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1); }
function safePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) throw new Error(`Path must be relative POSIX: ${String(value)}`);
  const path = resolve(root, value); if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Path escapes Engine root: ${value}`); return path;
}
function bounded(value) { return String(value instanceof Error ? value.message : value).replace(/[\r\n]+/gu, ' ').slice(0, 1024); }
