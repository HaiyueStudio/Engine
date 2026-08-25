#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateG07Candidate } from './deformable2d-g07-candidate-contract.mjs';

const root = resolve(import.meta.dirname, '../..');
const candidatePath = resolve(process.argv[2] ?? 'review/candidates/deformable2d-g07-candidate.json');
const manifest = JSON.parse(readFileSync(resolve(root, 'animation-spec/corpus/deformable2d/fidelity-performance-corpus-manifest.json'), 'utf8'));
const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
validateG07Candidate(candidate, manifest);
console.log(`[deformable2d-g07] validated ${candidate.samples.length} samples; verdict=${candidate.verdict.status}; revision=${candidate.revision}.`);
