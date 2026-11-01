import {planarFixtureProtocol,validatePlanarProgress} from './release-workflow-planar-policy.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import {
  comparePlanarReflectionPixelBaseline,
  createPlanarReflectionPixelBaseline,
} from './planar-reflection-pixel-baseline.mjs';
import {
  createPerformanceEvidence,
  createPerformanceSourceFingerprint,
  assessDevicePerformance,
  loadPerformanceBudgetConfig,
  performanceEvidencePath,
  shouldEnforceDevicePerformanceBudgets,
} from './webgpu-performance-budget.mjs';
import { shouldWriteFormalPerformanceEvidence } from './performance-evidence-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args=process.argv.slice(2),long=args.includes('--long');
if(long)args.splice(args.indexOf('--long'),1);
const take=flag=>{const i=args.indexOf(flag);if(i<0)return;const value=args[i+1];if(!value||value.startsWith('--'))throw Error('Missing '+flag);args.splice(i,2);return value;};
const diagnosticOutput=take('--diagnostic-output'),protocolOnly=args.includes('--protocol');
if(protocolOnly)args.splice(args.indexOf('--protocol'),1);
if(args.length)throw Error('Unknown planar arguments: '+args.join(' '));
const protocol=planarFixtureProtocol({mode:long?'full':'smoke',warmup:Math.max(3,Number(process.env.PLANAR_REFLECTION_WARMUP??3)),samples:Number(process.env.PLANAR_REFLECTION_SAMPLES??40)});
if(protocolOnly){console.log(JSON.stringify(protocol,null,2));process.exit(0);}
if(diagnosticOutput&&process.env.UPDATE_PLANAR_REFLECTION_BASELINE==='1')throw Error('Diagnostic output cannot update pixel baselines');
const baselinePath = resolve(root, 'review/baselines/render-pixels-planar-reflection.json');
const artifactPath = resolve(root, diagnosticOutput??'artifacts/webgpu/planar-reflection.json');
if(diagnosticOutput&&!relative(root,artifactPath).replaceAll('\\','/').startsWith('artifacts/'))throw Error('Diagnostic output must stay inside repository artifacts');
const performanceConfig = loadPerformanceBudgetConfig(root);
const mode = long ? 'full' : 'smoke';
const benchmarkRoot = process.env.WEBGPU_BENCHMARK_ROOT ? resolve(process.env.WEBGPU_BENCHMARK_ROOT) : root;
const sourceFingerprint = createPerformanceSourceFingerprint(root, benchmarkRoot);
const progress=[];
let result;
console.log('[planar-protocol] '+JSON.stringify(protocol));
try {
  result=await runChromeWebGpuFixture({root:benchmarkRoot,fixture:'scripts/webgpu-gate/planar-reflection-fixture.html',
    query:{mode,warmup:protocol.warmup,samples:protocol.samples},timeoutMs:protocol.resultWaitTimeoutMs,
    interact:async cdp=>{cdp.on('Runtime.consoleAPICalled',event=>{
      const text=event.args?.[0]?.value;if(typeof text!=='string'||!text.startsWith('PLANAR_PROGRESS '))return;
      try {const value=validatePlanarProgress(JSON.parse(text.slice(16)));if(progress.length<1024)progress.push(value);console.log('[planar-progress] '+JSON.stringify(value));}
      catch(error){console.warn('[planar-progress-invalid] '+error.message);}
    });},
  });
} catch(error){
  const failure={schemaVersion:1,status:'failed',qualification:false,protocol,progress,lastProgress:progress.at(-1),sourceFingerprint,browserFailure:error.browserFailure,error:String(error.stack??error)};
  const path=artifactPath.replace(/\.json$/,'')+'-failed-'+Date.now()+'.json';mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(failure,null,2)+'\n',{flag:'wx'});
  console.error('[planar-failure] '+path);throw error;
}
result.executionDiagnostics={protocol,progress};
if(diagnosticOutput){result.qualification=false;result.evidenceRole='diagnostic-only';}
if (createPerformanceSourceFingerprint(root, benchmarkRoot) !== sourceFingerprint) {
  throw new Error('Performance executable inputs changed while the planar-reflection fixture was running; discard this evidence and retry.');
}
const { selected, performanceBudget } = assessDevicePerformance(
    performanceConfig,
    { nodePlatform: process.platform, adapter: result.adapter },
    result.suite, mode, result,
  );
const enforcePerformanceBudget = shouldEnforceDevicePerformanceBudgets();
result.performanceBudget = performanceBudget;
result.gate.performanceBudgetStatus = performanceBudget.status;
result.gate.performanceBudgetRole = enforcePerformanceBudget ? 'blocking-diagnostic-run' : 'diagnostic-only';
const evidencePath = resolve(root, performanceEvidencePath(selected.id, result.suite));
let pixelBaselineFailure = null;

if (process.env.UPDATE_PLANAR_REFLECTION_BASELINE === '1') {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(createPlanarReflectionPixelBaseline(result), null, 2)}\n`);
  result.gate.pixelBaselineStatus = 'updated';
  console.log(`[planar-reflection] Updated ${relative(root, baselinePath)}.`);
} else {
  if (!existsSync(baselinePath)) {
    pixelBaselineFailure = 'Planar-reflection pixel baseline is missing. Run with UPDATE_PLANAR_REFLECTION_BASELINE=1 after reviewing the fixture output.';
  } else {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const comparison = comparePlanarReflectionPixelBaseline(result, baseline);
    result.pixelBaselineComparison = comparison;
    if (comparison.status !== 'passed') {
      pixelBaselineFailure = `Planar-reflection pixel regression:\n${comparison.violations.join('\n')}`;
    }
    if (comparison.hashMismatches.length > 0) {
      console.warn(`[planar-reflection] ${comparison.hashMismatches.length} GPU hash mismatch(es) retained as diagnostics; numeric/semantic pixel gates decide the result.`);
    }
  }
  result.gate.pixelBaselineStatus = pixelBaselineFailure ? 'failed' : 'passed';
}

result.gate.status = !pixelBaselineFailure && (!enforcePerformanceBudget || performanceBudget.status === 'passed') ? 'passed' : 'failed';
result.evidence = createPerformanceEvidence(root, selected, performanceBudget, result, sourceFingerprint);
mkdirSync(dirname(artifactPath), { recursive: true });
writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`,{flag:diagnosticOutput?'wx':'w'});
if (!diagnosticOutput && shouldWriteFormalPerformanceEvidence(mode)) {
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
}

if (pixelBaselineFailure) throw new Error(pixelBaselineFailure);

if (performanceBudget.status === 'not-enrolled') console.warn(`[performance] ${performanceBudget.reason}`);
if (performanceBudget.status === 'failed') {
  const detail = performanceBudget.violations
    .map(item => `${item.caseId ?? item.rule}: ${item.reason}${Number.isFinite(item.p95Ms) ? ` (${item.p95Ms.toFixed(2)}ms > ${item.maxP95Ms}ms)` : ''}`)
    .join('\n');
  if (enforcePerformanceBudget) {
    throw new Error(`Planar-reflection performance budget failed for ${selected.id}:\n${detail}`);
  }
  console.warn(`[planar-reflection] Diagnostic device budget exceeded for ${selected.id}:\n${detail}`);
}

console.log(`[planar-reflection] ${result.benchmarkResults.length} real WebGPU cases and ${Object.keys(result.pixelCases).length} pixel gates passed.`);
console.log(
  `[planar-reflection] ${performanceBudget.checks.length} P95 checks `
  + `${performanceBudget.status === 'passed' ? 'passed' : 'recorded as diagnostic-only'} for ${selected.id}.`,
);
console.log(`[planar-reflection] Wrote ${relative(root, artifactPath)}.`);
