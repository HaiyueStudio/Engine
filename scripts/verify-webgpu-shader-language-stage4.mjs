import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/shader-language-stage4-fixture.html',
  timeoutMs: 90_000,
});
const failures = [];
if (result.schemaVersion !== 1 || result.suite !== 'shader-language-stage4-deformation-pilot' || result.status !== 'passed') {
  failures.push('invalid result identity');
}
if (result.fixture?.path !== '/extensions/test/fixtures/gltf/animation-characterization.gltf'
  || !(result.fixture.httpBytes > 0)) failures.push(`invalid real glTF provenance: ${JSON.stringify(result.fixture)}`);
if (!/^[a-f0-9]{64}$/.test(result.canonicalHash ?? '')
  || !/^[a-f0-9]{64}$/.test(result.deformationModuleHash ?? '')) failures.push('missing canonical hashes');
if (!/^[a-f0-9]{64}$/.test(result.fixture?.sha256 ?? '')) failures.push('missing real fixture SHA-256');
if (result.passCount !== 5) failures.push(`passCount=${result.passCount}`);
if (result.compilationErrorCount !== 0) failures.push(`compilationErrorCount=${result.compilationErrorCount}`);
if (result.validationErrorCount !== 0) failures.push(`validationErrorCount=${result.validationErrorCount}`);
if (result.unclassifiedFailureCount !== 0) failures.push(`unclassifiedFailureCount=${result.unclassifiedFailureCount}`);
for (const pass of result.passes ?? []) {
  if (pass.deformationModuleHash !== result.deformationModuleHash) {
    failures.push(`${pass.pass} uses a private deformation module`);
  }
  if (pass.pass === 'forward' ? !pass.hasSurfaceLighting : pass.hasSurfaceLighting) {
    failures.push(`${pass.pass} surface-lighting DCE classification is wrong`);
  }
}
if (!result.animation?.usesAnimation3DMixer || !result.animation?.usesAnimation3DPoseBuffer
  || !result.animation?.gpuMorph || !result.animation?.skinning || !result.animation?.positionsRemainBase) {
  failures.push(`invalid Animation3D provenance: ${JSON.stringify(result.animation)}`);
}
if (!['cubic-spline', 'linear', 'step'].every(mode => result.animation?.interpolation?.includes(mode))) {
  failures.push(`interpolation=${JSON.stringify(result.animation?.interpolation)}`);
}
for (const phase of result.phases ?? []) {
  if (phase.silhouetteMismatchPixels !== 0) failures.push(`${phase.name} silhouetteMismatchPixels=${phase.silhouetteMismatchPixels}`);
  for (const pass of ['forward', 'depth', 'shadow', 'motion-vector', 'outline-selection']) {
    if (!(phase.pixels?.[pass]?.visiblePixelCount > 0)) failures.push(`${phase.name}/${pass} has no visible pixels`);
  }
}
if ((result.phases ?? []).length !== 3) failures.push(`phase count=${result.phases?.length}`);
if (!(result.phases?.[1]?.pixels?.['motion-vector']?.maximumNeutralChannelDelta > 2)
  || !(result.phases?.[2]?.pixels?.['motion-vector']?.maximumNeutralChannelDelta > 2)) {
  failures.push('mid/end motion vectors are not measurably non-neutral');
}
for (const reset of [result.lifecycle?.firstFrame, result.lifecycle?.seek, result.lifecycle?.teleport]) {
  if (!(reset?.maximumNeutralChannelDelta <= 1)) failures.push(`motion reset spike: ${JSON.stringify(reset)}`);
}
if (!result.lifecycle?.multiViewIsolated) failures.push('multi-view history is not isolated');
if (result.lifecycle?.historyResidualAfterDispose !== 0) failures.push(`historyResidualAfterDispose=${result.lifecycle?.historyResidualAfterDispose}`);
if (result.resources?.ownerResidualAfterDestroy !== 0) failures.push(`ownerResidualAfterDestroy=${result.resources?.ownerResidualAfterDestroy}`);
if (result.work?.animationPassCount !== 15 || result.work?.animationDrawCount !== 15) {
  failures.push(`unexpected pass/draw count: ${JSON.stringify(result.work)}`);
}
if (result.work?.animationUploadCallCount !== 6 || result.work?.multiPassDuplicateUploads !== 0) {
  failures.push(`unexpected upload count: ${JSON.stringify(result.work)}`);
}
if (failures.length > 0) throw new Error(`Shader language stage 4 WebGPU gate failed:\n- ${failures.join('\n- ')}`);
console.log(
  `[shader-language:stage4:webgpu] passed: deformation=${result.deformationModuleHash.slice(0, 12)}, `
  + `passes/draws/uploads=${result.work.animationPassCount}/${result.work.animationDrawCount}/${result.work.animationUploadCallCount}, `
  + `mid/end velocity=${result.phases[1].pixels['motion-vector'].maximumNeutralChannelDelta}/${result.phases[2].pixels['motion-vector'].maximumNeutralChannelDelta}.`,
);
