import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'); const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
if (browser === 'edge') { const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'; if (!existsSync(edge)) throw new Error(`Edge unavailable at ${edge}.`); process.env.CHROME_PATH = edge; }
process.env.WEBGPU_REQUIRE_NATIVE = '1'; if (!existsSync(resolve(root, 'engine/dist/experimental.js'))) execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run','build','-w','./engine'], { cwd: root, stdio: 'inherit' });
const buildParent = resolve(root, 'scripts/webgpu-gate'); const build = mkdtempSync(join(buildParent, '.progressive-path-tracing-build-')); if (!build.startsWith(`${buildParent}${sep}`)) throw new Error(`Unsafe build ${build}.`);
try {
  execFileSync(process.execPath, [resolve(root,'node_modules/typescript/bin/tsc'),'--target','ESNext','--module','ESNext','--moduleResolution','bundler','--strict','--noUncheckedIndexedAccess','--exactOptionalPropertyTypes','--skipLibCheck','--types','@webgpu/types','--rootDir',resolve(root,'extensions/src'),'--outDir',build,
    resolve(root,'extensions/src/ray-tracing/sampling/index.ts'),resolve(root,'extensions/src/ray-tracing/denoise/index.ts'),resolve(root,'extensions/src/ray-tracing/renderer/index.ts'),resolve(root,'extensions/src/ray-tracing/material/index.ts'),resolve(root,'extensions/src/ray-tracing/scene/index.ts'),resolve(root,'extensions/src/ray-tracing/acceleration/index.ts')],{cwd:root,stdio:'inherit'});
  const result = await runChromeWebGpuFixture({ root, fixture:'scripts/webgpu-gate/progressive-path-tracing-fixture.html', query:{build:`/${relative(root,build).split(sep).join('/')}`}, timeoutMs:180_000, visualCapture:{viewportWidth:640,viewportHeight:430,sampleWidth:24,sampleHeight:16} });
  const failures=[];
  if(result.schemaVersion!==1||result.suite!=='ray-progressive-sampling-denoise'||result.status!=='passed')failures.push('identity');
  if(!/^[a-f0-9]{64}$/u.test(result.progressiveArtifactHash??'')||!/^[a-f0-9]{64}$/u.test(result.denoiseArtifactHash??''))failures.push('artifact hashes');
  if(!result.deterministicReplay||!result.rawConvergencePassed||!result.edgePreservationPassed||!result.ghostingPassed||!result.moduleUnloadPassed)failures.push('replay/convergence/edge/ghosting/module-unload');
  if(!/^fnv1a32:[a-f0-9]{8}$/u.test(result.rawCandidateHash??'')||!/^fnv1a32:[a-f0-9]{8}$/u.test(result.denoisedCandidateHash??'')||result.rawCandidateHash===result.denoisedCandidateHash)failures.push('raw/denoised candidate identity');
  if(!result.deviceLossClassified||!result.deviceRecoveryPassed||result.sampleCount!==32||result.longRunSamples!==128||result.resetCount<8)failures.push(`lifecycle/reset=${result.sampleCount}/${result.longRunSamples}/${result.resetCount}`);
  if(!(result.timingSamples>0&&result.maxPeakBytes>0&&result.maxLiveResources===10))failures.push(`timing/memory=${result.timingSamples}/${result.maxPeakBytes}/${result.maxLiveResources}`);
  if(result.validationErrorCount!==0||result.uncapturedErrorCount!==0||result.residualCount!==0||result.unclassifiedFailureCount!==0)failures.push('GPU errors/residual');
  if(result.browserEvidence?.nativeBackend!==true||/swiftshader|software|warp/iu.test(result.browserEvidence?.angleBackend??''))failures.push('non-native backend');
  if(!result.visualCapture?.pngBase64||result.visualCapture.darkRatio>=1)failures.push('visual capture');
  if(failures.length)throw new Error(`G06 native WebGPU gate failed:\n- ${failures.join('\n- ')}\n${JSON.stringify({...result,visualCapture:result.visualCapture?{...result.visualCapture,pngBase64:'<omitted>'}:null},null,2)}`);
  console.log(`[ray-progressive:webgpu:${browser}] passed: samples=${result.sampleCount}, resets=${result.resetCount}, candidate=${result.candidateHash}, convergence=${result.earlyError.toFixed(3)}->${result.lateError.toFixed(3)}, peak=${result.maxPeakBytes}B, browser=${result.browserEvidence?.product}, backend=${result.browserEvidence?.angleBackend}.`);
} finally { const resolved=resolve(build); if(!resolved.startsWith(`${buildParent}${sep}`))throw new Error(`Unsafe cleanup ${resolved}.`); rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
