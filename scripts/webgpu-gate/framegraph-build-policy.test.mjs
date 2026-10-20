import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256 } from './deferred-fixture-policy.mjs';
import { assertDiagnosticBuildInputs, verifyDiagnosticOutputs } from './framegraph-build-policy.mjs';
const base = resolve(import.meta.dirname, '../../artifacts/engine-0.2.1/g09');
test('changed source hash or input population rejects the build without relaxing its binding', () => {
    const runtime = { sha256: 'a'.repeat(64), fileCount: 623 }, build = { schemaVersion: 1, inputs: runtime };
    assert.doesNotThrow(() => assertDiagnosticBuildInputs(runtime, build));
    assert.throws(() => assertDiagnosticBuildInputs({ ...runtime, sha256: 'b'.repeat(64) }, build), /G09_BUILD_STALE/u);
    assert.throws(() => assertDiagnosticBuildInputs({ ...runtime, fileCount: 622 }, build), /G09_BUILD_STALE/u);
    assert.throws(() => assertDiagnosticBuildInputs(runtime, { ...build, schemaVersion: 2 }), /G09_BUILD_STALE/u);
});
test('both A0 and B4 reject changed, missing, duplicate, empty or escaped runtime outputs', async () => {
    await fs.mkdir(base, { recursive: true });
    const directory = await fs.mkdtemp(resolve(base, 'build-output-policy-probe-'));
    await fs.writeFile(resolve(directory, 'fixture.js'), 'original');
    const output = { file: 'fixture.js', sha256: sha256('original') };
    for (const variant of ['A0', 'B4']) {
        await verifyDiagnosticOutputs(directory, { outputs: [output] }, variant);
        await assert.rejects(() => verifyDiagnosticOutputs(directory, { outputs: [{ ...output, sha256: sha256('changed') }] }, variant), /OUTPUT_CHANGED/u);
        await assert.rejects(() => verifyDiagnosticOutputs(directory, { outputs: [{ ...output, file: 'missing.js' }] }, variant), /ENOENT/u);
        for (const outputs of [[], [output, output], [{ ...output, file: '../fixture.js' }], [{ ...output, file: '..\\fixture.js' }]]) {
            await assert.rejects(() => verifyDiagnosticOutputs(directory, { outputs }, variant), /BUILD_INVALID/u);
        }
    }
});
