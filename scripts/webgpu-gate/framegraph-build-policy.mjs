import fs from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { deferredRuntimeFingerprint, sha256 } from './deferred-fixture-policy.mjs';
export function assertDiagnosticBuildInputs(runtime, build) {
    if (build.schemaVersion !== 1 || runtime.sha256 !== build.inputs?.sha256 || runtime.fileCount !== build.inputs?.fileCount) {
        throw Error('G09_BUILD_STALE: Current B4 build is stale. Rebuild and verify the diagnostic fixture before retrying; no automatic rebuild or sampling.');
    }
}
export async function verifyDiagnosticOutputs(directory, manifest, variant) {
    if (!Array.isArray(manifest.outputs) || manifest.outputs.length === 0)
        throw Error(`G09_BUILD_INVALID: ${variant} output manifest is empty`);
    const names = new Set();
    for (const output of manifest.outputs) {
        if (typeof output.file !== 'string' || isAbsolute(output.file) || /[\\/]/u.test(output.file) || !output.file.endsWith('.js') || names.has(output.file) || !/^[a-f0-9]{64}$/u.test(output.sha256))
            throw Error(`G09_BUILD_INVALID: ${variant} output manifest is invalid`);
        names.add(output.file);
        if (sha256(await fs.readFile(resolve(directory, output.file))) !== output.sha256)
            throw Error(`G09_BUILD_OUTPUT_CHANGED: ${variant}/${output.file}`);
    }
    return manifest.outputs;
}
export async function checkDiagnosticBuild(root, base = resolve(root, 'artifacts/engine-0.2.1/g09')) {
    const read = async (file) => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
    const runtime = await deferredRuntimeFingerprint(root), build = await read(resolve(base, 'fixture-build.json'));
    assertDiagnosticBuildInputs(runtime, build);
    const a0 = await read(resolve(base, 'a0-built/provenance.json'));
    if (a0.schemaVersion !== 2 || a0.revision !== '21105a2a94e1b811b4c9b03fbca3c6187e1fa771')
        throw Error('G09_BUILD_INVALID: fixed A0 provenance changed');
    await verifyDiagnosticOutputs(base, build, 'B4');
    await verifyDiagnosticOutputs(resolve(base, 'a0-built'), a0, 'A0');
    if (runtime.sha256 !== (await deferredRuntimeFingerprint(root)).sha256)
        throw Error('G09_BUILD_CHANGED_DURING_CHECK: runtime sources changed');
    return { schemaVersion: 1, ready: true, checkedAt: new Date().toISOString(), runtime, b4ManifestSha256: sha256(await fs.readFile(resolve(base, 'fixture-build.json'))), a0ManifestSha256: sha256(await fs.readFile(resolve(base, 'a0-built/provenance.json'))), b4Outputs: build.outputs, a0Outputs: a0.outputs, settingsChanged: false, samplingStarted: false };
}
