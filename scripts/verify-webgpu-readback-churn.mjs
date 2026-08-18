import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChromePath, defaultWebGpuAngleBackend, runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { validateReadbackChurnResult } from './webgpu-gate/readback-churn-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = process.argv.includes('--long') ? 'long' : 'short';
const frameArgument = process.argv.find(argument => argument.startsWith('--frames='));
const frames = frameArgument ? Number.parseInt(frameArgument.slice('--frames='.length), 10) : undefined;
const output = resolve(root, process.env.WEBGPU_GATE_OUTPUT ?? `artifacts/webgpu/readback-churn-${profile}.json`);

if (!existsSync(resolve(root, 'engine/dist/experimental.js'))) {
  throw new Error('Chrome/WebGPU gate requires engine/dist. Run npm run build:engine first.');
}
if (profile === 'long' && frames !== undefined && frames < 1_000 && process.env.WEBGPU_GATE_ALLOW_SHORT_LONG !== '1') {
  throw new Error('The long gate requires at least 1000 frames. Set WEBGPU_GATE_ALLOW_SHORT_LONG=1 only for local runner development.');
}

const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/readback-churn-fixture.html',
  query: { profile, ...(frames !== undefined ? { frames } : {}) },
  timeoutMs: profile === 'long' ? 180_000 : 45_000,
});
const validationErrors = validateReadbackChurnResult(result, { profile });
const artifact = {
  ...result,
  gate: {
    status: validationErrors.length === 0 ? 'passed' : 'failed',
    checkedAt: new Date().toISOString(),
    chromePath: process.env.CHROME_PATH ?? defaultChromePath(),
    angleBackend: process.env.WEBGPU_ANGLE_BACKEND ?? defaultWebGpuAngleBackend(),
    validationErrors,
  },
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
if (validationErrors.length > 0) {
  throw new Error(`Chrome/WebGPU ${profile} gate failed:\n- ${validationErrors.join('\n- ')}\nArtifact: ${relative(root, output)}`);
}
const { readback, churn, durationMs } = result;
console.log(
  `[webgpu-gate] ${profile} passed: ${result.config.frames} frames in ${(durationMs / 1000).toFixed(1)}s, `
  + `readback=${readback.delivered}/${readback.accepted} delivered (${(readback.skipRate * 100).toFixed(1)}% skipped), `
  + `latency P95=${readback.latencyFrames.p95}f, churn=${churn.cycles}, resources=${churn.resourcesCreated}, residual=0.`,
);
console.log(`[webgpu-gate] Wrote ${relative(root, output)}.`);
