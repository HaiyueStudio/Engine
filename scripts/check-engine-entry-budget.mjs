import { readFileSync, statSync } from 'node:fs';
import { validateEngineEntryBudget } from './engine-release-policy.mjs';
const root = new URL('../', import.meta.url);
const matrix = JSON.parse(readFileSync(new URL('config/release-matrix.json', root)));
validateEngineEntryBudget(statSync(new URL('engine/dist/index.js', root)).size, matrix.gates.bundleSize.engineEntryBytes);
console.log('[engine-entry] Release matrix byte budget passed.');
