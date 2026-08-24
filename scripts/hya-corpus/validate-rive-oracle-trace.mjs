import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRiveOracleTrace } from './rive-oracle-trace-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const formal = process.argv.includes('--formal');
const traceArgument = process.argv.find(value => value.startsWith('--trace='));
if (!traceArgument) throw new Error('Usage: node scripts/hya-corpus/validate-rive-oracle-trace.mjs --trace=<artifact.json> [--formal]');
const tracePath = resolve(root, traceArgument.slice('--trace='.length));
const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
const validation = validateRiveOracleTrace(trace, {
  formal,
  expectedRevision: formal
    ? execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    : null,
});
if (validation.status !== 'passed') {
  throw new Error(`Rive oracle trace validation failed (${validation.mode}):\n- ${validation.violations.join('\n- ')}`);
}
console.log(`[rive-oracle] ${validation.mode} passed for ${relative(root, tracePath)}.`);
