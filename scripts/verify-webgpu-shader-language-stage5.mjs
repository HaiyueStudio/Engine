import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/shader-language-stage5-fixture.html',
  timeoutMs: 90_000,
});
const failures = [];
if (result.schemaVersion !== 1 || result.suite !== 'shader-language-stage5-motion-blur-pilot' || result.status !== 'passed') {
  failures.push('invalid result identity');
}
if (!/^[a-f0-9]{64}$/.test(result.canonicalHash ?? '')
  || !/^[a-f0-9]{64}$/.test(result.typedModuleHash ?? '')
  || !/^[a-f0-9]{64}$/.test(result.graph?.sha256 ?? '')) failures.push('missing canonical provenance');
if (result.compilationErrorCount !== 0) failures.push(`compilationErrorCount=${result.compilationErrorCount}`);
if (result.validationErrorCount !== 0) failures.push(`validationErrorCount=${result.validationErrorCount}`);
if (result.unclassifiedFailureCount !== 0) failures.push(`unclassifiedFailureCount=${result.unclassifiedFailureCount}`);
if (result.eliminatedDepthResource !== 'pass.depth' || result.depthTextureAllocations !== 0) {
  failures.push('depth input was not explicitly DCE');
}
if (result.generation?.compileCalls !== 1 || result.generation?.frameCalls !== 0) {
  failures.push(`shader generation entered the frame path: ${JSON.stringify(result.generation)}`);
}
for (const entry of result.referenceParity ?? []) {
  if (entry.maximumChannelDelta !== 0 || entry.meanAbsoluteChannelDelta !== 0) {
    failures.push(`${entry.case} generated/reference parity=${JSON.stringify(entry)}`);
  }
}
if (result.metrics?.rawVsDisabled?.maximumChannelDelta !== 0) failures.push('disabled/raw path changed pixels');
if (!(result.metrics?.rawVsSlow?.changedPixelRatio > 0.01)) failures.push('slow motion has no blur');
if (!(result.metrics?.rawVsFast?.meanAbsoluteChannelDelta > result.metrics?.rawVsSlow?.meanAbsoluteChannelDelta * 1.1)) {
  failures.push('blur does not increase with velocity');
}
if (!(result.metrics?.centeredVsReconstructed?.changedPixelRatio > 0.001)) {
  failures.push('tile/neighbor reconstruction has no pixel effect');
}
if (!(result.metrics?.rawVsHeatmap?.meanAbsoluteChannelDelta > 5)) failures.push('velocity heatmap is not distinct');
if (result.metrics?.split?.leftMaximumChannelDelta !== 0 || !(result.metrics?.split?.rightMeanAbsoluteChannelDelta > 0.1)) {
  failures.push(`split display is invalid: ${JSON.stringify(result.metrics?.split)}`);
}
if (result.metrics?.deterministicRepeat?.maximumChannelDelta !== 0) failures.push('fixed input reconstruction is unstable');
if (result.work?.centered?.passCount !== 1 || result.work?.centered?.activeIntermediateTextureCount !== 0) {
  failures.push(`centered work increased: ${JSON.stringify(result.work?.centered)}`);
}
if (result.work?.['tile-neighbor-max']?.passCount !== 3
  || result.work?.['tile-neighbor-max']?.activeIntermediateTextureCount !== 2
  || result.work?.['tile-neighbor-max']?.allocatedIntermediateTextureCount !== 2) {
  failures.push(`tile/neighbor work increased: ${JSON.stringify(result.work?.['tile-neighbor-max'])}`);
}
if (result.resources?.ownerResidualAfterDestroy !== 0 || result.resources?.compilerCreatedGpuResources !== 0) {
  failures.push(`resource ownership invalid: ${JSON.stringify(result.resources)}`);
}
if (failures.length > 0) throw new Error(`Shader language stage 5 WebGPU gate failed:\n- ${failures.join('\n- ')}`);
console.log(
  `[shader-language:stage5:webgpu] passed: module=${result.typedModuleHash.slice(0, 12)}, `
  + `slow/fast mean=${result.metrics.rawVsSlow.meanAbsoluteChannelDelta.toFixed(3)}/${result.metrics.rawVsFast.meanAbsoluteChannelDelta.toFixed(3)}, `
  + `reconstruction changed=${(result.metrics.centeredVsReconstructed.changedPixelRatio * 100).toFixed(2)}%.`,
);
