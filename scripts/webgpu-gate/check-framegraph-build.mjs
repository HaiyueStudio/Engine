import { resolve } from 'node:path';
import { checkDiagnosticBuild } from './framegraph-build-policy.mjs';
const root = resolve(import.meta.dirname, '../..');
try {
    if (process.argv.length !== 2)
        throw Error('Build preflight accepts no arguments');
    // Trust only this known repository for this child process, preserving inherited Git options.
    const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
    if (!Number.isSafeInteger(count) || count < 0)
        throw Error('Invalid inherited Git configuration count');
    process.env[`GIT_CONFIG_KEY_${count}`] = 'safe.directory';
    process.env[`GIT_CONFIG_VALUE_${count}`] = root;
    process.env.GIT_CONFIG_COUNT = String(count + 1);
    console.log(JSON.stringify(await checkDiagnosticBuild(root)));
}
catch (error) {
    console.log(JSON.stringify({ schemaVersion: 1, ready: false, error: error.message, settingsChanged: false, samplingStarted: false }));
    process.exitCode = 1;
}
