import { auditProductionReport } from './webgpu-gate/framegraph-production-artifact.mjs';
import { productionEvidenceInputs } from './webgpu-gate/framegraph-evidence-inputs.mjs';
import {requireFrameGraphPresentation,readFrameGraphPresentation} from './webgpu-gate/framegraph-presentation.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cpus, hostname, release } from 'node:os';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { buildDeferredFixture } from './webgpu-gate/deferred-fixture-builder.mjs';
import { sha256 } from './webgpu-gate/deferred-fixture-policy.mjs';
import { frameGraphBrowserPath } from './webgpu-gate/framegraph-qualification.mjs';
import { validateProductionConfig, productionPlan, productionDiagnosticPlan, assessProductionCapture, validateProductionScreenshot } from './webgpu-gate/framegraph-production-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), args = process.argv.slice(2);
const base = resolve(root, 'artifacts/engine-0.2.1/g09');
const configPath = resolve(root, 'config/framegraph-production-021.json');
const configBytes = await readFile(configPath), config = validateProductionConfig(JSON.parse(configBytes));
if (args.length !== 1 || !['--plan','--smoke','--stress-diagnostic','--run'].includes(args[0]) && !args[0].startsWith('--audit=')) throw Error('Use --plan, --smoke, --stress-diagnostic, --run, or --audit=<report>');
const bounded = (directory, name) => {
  const path = resolve(directory, name), local = relative(directory, path);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || /^[A-Za-z]:/.test(local)) throw Error('Evidence path escapes directory');
  return path;
};
const audit = (report, directory) => auditProductionReport(report, name => readFile(bounded(directory, name)));
if (args[0].startsWith('--audit=')) {
  const path = bounded(base, relative(base, resolve(root, args[0].slice(8))));
  const result = await audit(JSON.parse(await readFile(path)), resolve(path, '..'));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'passed' ? 0 : 1);
}
const plan = productionPlan(config);
if (args[0] === '--plan') { console.log(JSON.stringify({ config, captures: plan.length, plan }, null, 2)); process.exit(0); }
const smoke = args[0] === '--smoke', diagnostic = args[0] === '--stress-diagnostic', unqualified = smoke || diagnostic, generatedAt = new Date().toISOString();
const directory = resolve(base, `production-${diagnostic ? 'stress-diagnostic' : smoke ? 'smoke' : 'local'}-${generatedAt.replaceAll(':','-')}`);
await mkdir(directory, { recursive: true });
const json = async (name, value) => { const bytes = JSON.stringify(value, null, 2) + '\n'; await writeFile(resolve(directory, name), bytes); return { file: name, sha256: sha256(bytes) }; };
const host = { hostname: hostname(), os: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length };
if (process.platform !== config.device.platform) throw Error('Registered Windows device required');
const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
host.hardware = JSON.parse(execFileSync(ps, ['-NoProfile','-Command',
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; [pscustomobject]@{ gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate); power=(powercfg /getactivescheme | Out-String) } | ConvertTo-Json -Depth 5 -Compress'], { encoding: 'utf8', windowsHide: true }));
if (!host.cpu.includes(config.device.cpu.split(' ').at(-1))) throw Error('CPU differs from registered profile');
if (!host.hardware.gpu.some(g => g.Name === config.device.gpu && g.CurrentRefreshRate === config.device.refreshHz)) throw Error('GPU/display differs from registered profile');
const inputs = () => productionEvidenceInputs(root);
const sourceBefore = await inputs();
console.log(`[production] building source-bound runtime: ${directory}`);
const runtimeDirectory = resolve(directory, 'runtime');
const build = await buildDeferredFixture({ sourceRoot: root, outputDirectory: runtimeDirectory, entry: resolve(root,'scripts/webgpu-gate/framegraph-production-fixture.mjs') });
if (sourceBefore !== await inputs()) throw Error('Source changed during build');
const report = { schemaVersion: 1, generatedAt, tier: diagnostic ? 'diagnostic' : smoke ? 'smoke' : 'production-local', status: 'running', config,
  configSha256: sha256(JSON.stringify(config)), inputs: sourceBefore, build, buildSha256: sha256(JSON.stringify(build)), host,
  revision: execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  dirty: !!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),
  plan: diagnostic ? productionDiagnosticPlan(config) : smoke ? config.workloads.map(w => ({ round: 1, caseId: w.id, browserId: config.browser[0] })) : plan, entries: [] };
report.registration = await json('registration.json', { registeredAt: new Date().toISOString(), configSha256: report.configSha256,
  config, inputs: report.inputs, buildSha256: report.buildSha256, plan: report.plan, host, tier: report.tier,
  revision: report.revision, dirty: report.dirty });
await json('report.json', report);
process.env.WEBGPU_REQUIRE_NATIVE = '1';
const evaluate = async (cdp, expression, awaitPromise = false) => {
  const response = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (response.result?.exceptionDetails) throw Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text);
  return response.result?.result?.value;
};
const cpuSnapshot = () => cpus().reduce((a, c) => { a.idle += c.times.idle; a.total += Object.values(c.times).reduce((x,y)=>x+y,0); return a; }, { idle:0,total:0 });
for (const [i, job] of report.plan.entries()) {
  const spec = config.workloads.find(w => w.id === job.caseId), entry = { job, status: 'running' }; report.entries.push(entry);
  const prefix = `${String(i).padStart(3,'0')}-${job.caseId}-${job.browserId}-r${job.round}`;
  const cpu = []; let previous = cpuSnapshot();
  const monitor = setInterval(() => { const current = cpuSnapshot(), total = current.total-previous.total; cpu.push({ at: new Date().toISOString(), busyPercent: total ? 100*(1-(current.idle-previous.idle)/total) : 0 }); previous = current; },1000);
  try {
    let png;
    const raw = await runChromeWebGpuFixture({ root, browserPath: frameGraphBrowserPath(job.browserId),
      fixture: 'scripts/webgpu-gate/framegraph-production-fixture.html', timeoutMs: 120000,
      presentation: { mode:'visible', width:1320, height:960 }, acceptedStatuses: ['captured','failed'],
      mounts: [{ prefix:'/production-runtime', directory:runtimeDirectory }],
      interact: async cdp => {
        const deadline = Date.now()+120000;
        while (!await evaluate(cdp, '!!window.__productionProbe')) { if(Date.now()>deadline) throw Error('Production runtime did not initialize'); await new Promise(r=>setTimeout(r,200)); }
        await requireFrameGraphPresentation(cdp);
        const captureConfig = unqualified ? { ...config, durationSeconds:diagnostic ? 10 : 3, warmupBoundary:{ ...config.warmupBoundary, seconds:diagnostic ? 10 : 2 } } : config;
        await evaluate(cdp, `window.__productionProbe.start(${JSON.stringify(captureConfig)},${JSON.stringify(spec)})`);
        let invisibleTicks=0;
        while (!await evaluate(cdp, 'window.__productionProbe.done')) {
          const state=await readFrameGraphPresentation(cdp);
          invisibleTicks=state?.visible==='visible'&&state.focused===true?0:invisibleTicks+1;
          if(Date.now()>deadline||invisibleTicks>=3) {
            const partial=await evaluate(cdp,'window.__productionProbe.snapshot()');
            entry.timeoutSnapshot=await json(`${prefix}-timeout.json`,partial);
            entry.timeoutPhase=partial?.phase??'unknown';
            const image=await cdp.call('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
            const bytes=Buffer.from(image.result.data,'base64'),name=`${prefix}-timeout.png`;await writeFile(resolve(directory,name),bytes);
            entry.timeoutScreenshot={file:name,sha256:sha256(bytes)};
            const error=Error(`Production capture ${invisibleTicks>=3?'lost presentation':'watchdog expired'} in ${entry.timeoutPhase}; partial frames retained`);
            if(invisibleTicks>=3)error.code='G09_PRESENTATION_UNAVAILABLE';throw error;
          }
          await new Promise(r=>setTimeout(r,1000));
        }
        const image = await cdp.call('Page.captureScreenshot', { format:'png', fromSurface:true, captureBeyondViewport:false });
        png = Buffer.from(image.result.data,'base64');
        await evaluate(cdp, 'window.__productionProbe.finish()', true);
      } });
    raw.hostCpu = cpu;
    entry.raw = await json(`${prefix}.json`, raw);
    const screenshot = `${prefix}.png`; await writeFile(resolve(directory,screenshot),png); entry.screenshot = { file:screenshot, sha256:sha256(png) };
    entry.screenshot.validation = validateProductionScreenshot(png);
    if (unqualified) { if(raw.status !== 'captured' || raw.errors.length || raw.cleanup.resources !== 0) throw Error(`Preflight failed: ${JSON.stringify({error:raw.error,errors:raw.errors,cleanup:raw.cleanup})}`); entry.status = 'captured-unqualified'; }
    else { entry.assessment = assessProductionCapture(raw,config,job); entry.status = entry.assessment.status; }
  } catch(error) { entry.status = 'invalid'; entry.error = error.stack; entry.browserFailure = error.browserFailure; entry.presentationUnavailable=error.code==='G09_PRESENTATION_UNAVAILABLE';entry.presentation=error.presentation; }
  finally { clearInterval(monitor); entry.hostCpu = cpu; await json('report.json',report); }
  console.log(`[production] ${i+1}/${report.plan.length} ${prefix}: ${entry.status}${entry.error ? `: ${entry.error.split('\n')[0]}` : ''}`);
  if(entry.presentationUnavailable){report.interruption='Visible sampling stopped; remaining registered jobs were not attempted.';break;}
}
report.finishedAt = new Date().toISOString();
report.inputsAfter = await inputs();
if (sourceBefore !== report.inputsAfter) { report.status='invalid'; report.error='Inputs changed during capture'; }
else if (unqualified) report.status = report.entries.every(e=>e.status==='captured-unqualified') ? diagnostic ? 'diagnostic-complete' : 'smoke-complete' : 'invalid';
else { try { report.audit = await audit(report,directory); report.status=report.audit.status; } catch(error) { report.status='invalid'; report.error=error.stack; } }
await json('report.json',report);
console.log(`[production] ${report.status}: ${directory}`);
if (['invalid','failed','inconclusive'].includes(report.status)) process.exitCode=1;
