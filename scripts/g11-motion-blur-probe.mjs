import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? process.cwd());
const output = resolve(process.argv[3] ?? 'motion-blur-trace.json');
const forceSwiftShader = process.argv.includes('--force-swiftshader');
const trace = { kind: 'diagnostic-only', deadlineMs: 35_000, forceSwiftShader, cases: {}, browserErrors: [] };
globalThis.__mbDiagnostic = trace;

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Expected one instrumentation anchor: ' + before);
  return source.replace(before, () => after);
}

globalThis.__mbInstrumentBundle = source => {
  const mark = (phase, extra = '') => "window.__mbProgress.push({ phase: " + JSON.stringify(phase) + ", ms: performance.now()" + extra + " });";
  const pairs = [
    ['await engine$1.init();', "window.__mbProgress = [];\n" + mark('init-start') + '\nawait engine$1.init();\n' + mark('init-done', ', adapter: engine$1.adapter?.info?.architecture, fallback: engine$1.adapter?.info?.isFallbackAdapter')],
    ['const characterModel = await loadMotionBlurCharacter();', mark('asset-start') + '\nconst characterModel = await loadMotionBlurCharacter();\n' + mark('asset-done')],
    ['const warmup = await scene.warmupPipelines();', mark('warmup-start') + '\nconst warmup = await scene.warmupPipelines();\n' + mark('warmup-done')],
    ['engine$1.run();', mark('frames-start') + '\nengine$1.run();'],
    ['if (!validationFinished && ++frames >= (regression ? 24 : 14)) {', 'if (!validationFinished && [1, 6, 12, 18, 24].includes(frames + 1)) {' + mark('frame', ', index: frames + 1') + '}\nif (!validationFinished && ++frames >= (regression ? 24 : 14)) {'],
    ['await engine$1.device.queue.onSubmittedWorkDone();', mark('queue-start') + '\nawait engine$1.device.queue.onSubmittedWorkDone();\n' + mark('queue-done')],
    ['const scopedError = await engine$1.device.popErrorScope();', 'const scopedError = await engine$1.device.popErrorScope();\n' + mark('validation-done')],
  ];
  for (const [before, after] of pairs) source = replaceOnce(source, before, after);
  return source;
};

const bundle = readFileSync(resolve(root, 'examples/motion-blur/bundle.js'), 'utf8');
const instrumented = globalThis.__mbInstrumentBundle(bundle);
globalThis.__mbInstrumentedBundle = instrumented;
const helperUrl = pathToFileURL(resolve(root, 'scripts/webgpu-gate/chrome-runner.mjs')).href;
let script = readFileSync(resolve(root, 'scripts/verify-motion-blur-example.mjs'), 'utf8');
script = replaceOnce(script, "'./webgpu-gate/chrome-runner.mjs'", JSON.stringify(helperUrl));
script = replaceOnce(script, "resolve(fileURLToPath(new URL('..', import.meta.url)))", JSON.stringify(root));
script = replaceOnce(script, 'response.end(readFileSync(path));',
  "response.end(path === resolve(root, 'examples/motion-blur/bundle.js') ? globalThis.__mbInstrumentedBundle : readFileSync(path));");
if (forceSwiftShader) script = replaceOnce(script, "'--remote-debugging-port=0',", "'--use-webgpu-adapter=swiftshader', '--remote-debugging-port=0',");
script = replaceOnce(script, "const cdp = await connectCdp(page.webSocketDebuggerUrl);", "const cdp = await connectCdp(page.webSocketDebuggerUrl);\n    await cdp.call('Runtime.enable');");
script = replaceOnce(script, "      const request = pending.get(message.id);",
  "      if (message.method === 'Runtime.exceptionThrown') globalThis.__mbDiagnostic.browserErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);\n      const request = pending.get(message.id);");
script = replaceOnce(script, "            : null;\n        })()", "            : { status: null, progress: window.__mbProgress, href: location.href, state: document.readyState };\n        })()");
script = replaceOnce(script, "{ status: result.dataset.status, text: result.textContent, error: document.body.dataset.renderError }", "{ status: result.dataset.status, text: result.textContent, error: document.body.dataset.renderError, progress: window.__mbProgress, href: location.href, state: document.readyState }");
script = replaceOnce(script, '      return response.result?.result?.value ?? null;',
  "      const data = response.result?.result?.value;\n      if (data?.href?.includes('case=' + name)) globalThis.__mbDiagnostic.cases[name] = data;\n      return data?.status ? data : null;");
script = replaceOnce(script, "    if (child.exitCode === null) child.kill('SIGTERM');", "    globalThis.__mbDiagnostic.browserStderr = stderr;\n    if (child.exitCode === null) child.kill('SIGTERM');");
try {
  await import('data:text/javascript;base64,' + Buffer.from(script).toString('base64'));
  trace.result = 'passed';
} catch (error) {
  trace.result = 'failed';
  trace.error = error.message;
  process.exitCode = 1;
} finally {
  writeFileSync(output, JSON.stringify(trace, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ result: trace.result, error: trace.error?.split('\n')[0], cases: Object.fromEntries(Object.entries(trace.cases).map(([name, row]) => [name, row.progress])), output }));
}
