import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep, extname } from 'node:path';
import { parseArgs } from 'node:util';

const repository = resolve(import.meta.dirname, '..');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest(algorithm === 'sha256' ? 'hex' : 'base64');
const fileHash = async path => digest(await readFile(path));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const contained = (root, path) => {
  const offset = relative(root, path);
  return offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset);
};
const run = (program, args, cwd) => execFileSync(program, args, { cwd, stdio: 'inherit', windowsHide: true });
const node = (args, cwd = repository) => run(process.execPath, args, cwd);
const { positionals: [command], values } = parseArgs({
  allowPositionals: true,
  options: {
    artifact: { type: 'string' }, packages: { type: 'string' }, template: { type: 'string' },
    host: { type: 'string' }, report: { type: 'string' }, cache: { type: 'string' }, offline: { type: 'boolean' },
    diagnostic: { type: 'boolean' }, scenario: { type: 'string' },
  },
});
const destination = resolve(values.artifact ?? import.meta.dirname);

async function inventory(root, folder = '') {
  const files = {};
  for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
    const name = folder ? folder + '/' + entry.name : entry.name;
    if (entry.isDirectory()) Object.assign(files, await inventory(root, name));
    else {
      assert(entry.isFile(), 'Unexpected link in the device files: ' + name);
      files[name] = await fileHash(join(root, name));
    }
  }
  return files;
}

function checkDevice(data, manifest, host) {
  assert(data && typeof data === 'object', 'Missing device record.');
  const audit = Array.isArray(data.audit) ? data.audit : [];
  const gains = Array.isArray(data.gainChanges) ? data.gainChanges : [];
  const choices = audit.filter(row => row.type === 'node' && row.node === 'arrival/fork');
  const save = audit.find(row => row.type === 'save' && row.trusted === true && row.node === 'arrival/fork');
  const restored = audit.find(row => ['load-settled','continue-settled'].includes(row.type) && row.node === 'arrival/fork' && row.time > (save?.time ?? Infinity));
  const first = audit.find(row => row.type === 'node' && /ending\/(?:lantern|tide)-end/u.test(row.node));
  const second = audit.find(row => row.type === 'node' && /ending\/(?:lantern|tide)-end/u.test(row.node) && row.node !== first?.node);
  const voice = audit.find(row => row.type === 'voice' && row.trusted === true);
  const duck = gains.find(row => row.time >= (voice?.time ?? Infinity) && Math.abs(row.value - .2088) < 1e-6);
  const returned = gains.find(row => row.time > (duck?.time ?? Infinity) && Math.abs(row.value - .58) < 1e-6);
  const checks = {
    candidate: data.revision === manifest.revision && data.bundleSha256 === manifest.files['bundle.js'] && data.host === host,
    platform: typeof data.userAgent === 'string' && /Chrome\//u.test(data.userAgent) && !/HeadlessChrome/u.test(data.userAgent) &&
      (host === 'windows' ? /Windows NT/u : /Macintosh/u).test(data.userAgent),
    adapter: !!data.adapter?.vendor && data.adapter?.fallback === false &&
      !/swiftshader|software|llvmpipe|lavapipe|warp/iu.test(JSON.stringify(data.adapter)),
    keyboardMouse: data.trustedPointer >= 2 && data.trustedKey >= 2 && audit.some(row => row.type === 'new' && row.trusted),
    reading: ['arrival/watch','pier/story'].every(node => audit.some(row => row.type === 'node' && row.node === node)),
    bothEndingsAfterRestore: !!(save && first && restored && second && save.time < first.time && first.time < restored.time &&
      restored.time < second.time && choices.length >= 2),
    listening: !!(voice && duck && returned),
    foreground: data.foregroundReturned === true,
    operator: ['read','save','audio','foreground'].every(key => data.verifiedByOperator?.[key] === true),
    errors: Array.isArray(data.errors) && data.errors.length === 0 && Array.isArray(data.gpuErrors) && data.gpuErrors.length === 0,
  };
  const failures = Object.keys(checks).filter(key => !checks[key]);
  return { status: failures.length ? 'failed' : 'passed', checks, failures };
}

async function prepare() {
  assert(values.packages && values.template, 'Prepare requires --packages and --template.');
  const evidenceRoot = resolve(repository, 'artifacts/engine-0.2.4/g07');
  assert(contained(evidenceRoot, destination) && destination !== evidenceRoot, 'Device data must use a new G07 artifact directory.');
  const template = resolve(values.template);
  const source = await json(join(repository, 'review/engine-0.2.4/g06-checks.json'));
  assert.equal(await fileHash(template), source.template.sha256, 'Frozen G06 author tool archive differs.');
  const reportPath = resolve(values.packages);
  const report = await json(reportPath);
  if (!values.diagnostic) {
    assert.equal(report.gate?.status, 'passed', 'Device evidence requires a passing package gate.');
    assert.equal(report.sourceState?.workingTreeDirty, false, 'Device evidence requires a clean checkout.');
  }
  assert.match(report.sourceState.revision, /^[0-9a-f]{40}$/u);
  const versions = (await json(join(repository, 'review/api/release-manifest.json'))).packageVersions;
  assert.deepEqual(Object.fromEntries(report.packages.map(row => [row.name, row.version])), versions);
  await mkdir(evidenceRoot, { recursive: true });
  await mkdir(destination);
  const consumer = join(destination, 'consumer');
  await mkdir(consumer);
  run('tar', ['-xf', template, '-C', consumer, 'tools/author.mjs', 'LICENSE'], repository);
  const example = join(repository, 'examples/visual-novel');
  for (const name of ['index.html','style.css','main.mjs','project','tools/build.mjs','tools/serve.mjs']) {
    await cp(join(example, name), join(consumer, name), { recursive: true,
      filter: path => path !== join(example, 'project/compiled.json') });
  }
  await mkdir(join(consumer, 'vendor'));
  const published = {};
  const dependencies = {};
  for (const entry of report.packages) {
    const archive = resolve(repository, entry.artifact);
    const filename = 'haiyue-' + entry.name.split('/')[1] + '-' + entry.version + '.tgz';
    assert.equal(await fileHash(archive), entry.sha256, entry.name);
    await cp(archive, join(consumer, 'vendor', filename));
    dependencies[entry.name] = 'file:vendor/' + filename;
    published[entry.name] = { version: entry.version, sha256: entry.sha256, integrity: 'sha512-' + digest(await readFile(archive), 'sha512') };
  }
  const { npmArgs, npmCommand } = await import('./npm-process.mjs');
  const devDependencies = {};
  for (const name of ['rollup','@rollup/plugin-node-resolve','@rollup/plugin-commonjs','typescript']) {
    devDependencies[name] = (await json(join(repository, 'node_modules', name, 'package.json'))).version;
  }
  await save(join(consumer, 'package.json'), { name: 'last-lantern-qualification', version: '1.0.0', private: true,
    type: 'module', scripts: { build: 'node tools/build.mjs', start: 'node tools/serve.mjs' }, dependencies, devDependencies });
  const cache = values.cache ? ['--cache', resolve(values.cache)] : [];
  const offline = values.offline ? ['--offline'] : [];
  run(npmCommand(), npmArgs(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...cache, ...offline]), consumer);
  const lock = await json(join(consumer, 'package-lock.json'));
  for (const [name, entry] of Object.entries(published)) {
    const installed = 'node_modules/' + name;
    assert.equal(lock.packages[installed].integrity, entry.integrity, name);
    assert.equal(realpathSync(join(consumer, installed)), join(consumer, installed), 'Installed package unexpectedly resolves to a workspace.');
  }
  node(['tools/build.mjs'], consumer);
  await cp(join(import.meta.dirname, 'fixtures/visual-novel-acceptance/public-contract.mjs'), join(consumer, 'public-contract.mjs'));
  node(['public-contract.mjs'], consumer);
  const physical = join(destination, 'device-kit');
  await cp(join(consumer, 'dist'), join(physical, 'dist'), { recursive: true });
  await cp(join(import.meta.dirname, 'fixtures/visual-novel-acceptance/physical.mjs'), join(physical, 'dist/physical.mjs'));
  await cp(import.meta.filename, join(physical, 'acceptance.mjs'));
  const markup = await readFile(join(physical, 'dist/index.html'), 'utf8');
  assert(markup.includes('src="./bundle.js"'));
  await writeFile(join(physical, 'dist/index.html'), markup.replace('src="./bundle.js"', 'src="./physical.mjs"'));
  const manifest = { schemaVersion: 1, diagnostic: !!values.diagnostic, revision: report.sourceState.revision, packageReportSha256: await fileHash(reportPath),
    packages: published, files: await inventory(join(physical, 'dist')) };
  await save(join(physical, 'manifest.json'), manifest);
  await writeFile(join(physical, 'README.md'), '# G07 真实设备验收\n\nWindows 解包后双击 `START-WINDOWS.cmd`。Mac 在解包目录运行下列命令。\n\n`node acceptance.mjs device --host mac`\n\n按 Chrome 页面底部清单操作。保存后回传终端显示的结果 JSON。\n');
  await writeFile(join(physical, 'START-WINDOWS.cmd'), [
    '@echo off', 'setlocal EnableExtensions DisableDelayedExpansion',
    'node "%~dp0acceptance.mjs" device --host windows', 'set "g07_exit=%errorlevel%"',
    'echo G07 device exit code: %g07_exit%', 'pause', 'exit /b %g07_exit%', '',
  ].join('\r\n'));
  run('tar', ['-czf', join(destination, 'visual-novel-device-kit.tar.gz'), '-C', physical,
    'dist','manifest.json','acceptance.mjs','README.md','START-WINDOWS.cmd'], repository);
  console.log(JSON.stringify({ status: manifest.diagnostic ? 'diagnostic-kit' : 'device-kit-ready', revision: manifest.revision, artifact: physical }));
}

async function device() {
  const host = values.host;
  assert.equal(host, process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : undefined, 'Use the physical host named by --host.');
  assert(host, 'Windows or macOS required.');
  const dir = join(destination, 'dist');
  const manifest = await json(join(destination, 'manifest.json'));
  assert.equal(manifest.diagnostic, false, 'This kit is for diagnostics only.');
  assert.deepEqual(await inventory(dir), manifest.files, 'Device kit bytes changed.');
  const config = { revision: manifest.revision, bundleSha256: manifest.files['bundle.js'], nonce: randomUUID(), host };
  const results = join(destination, 'device-results');
  await mkdir(results, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), 'haiyue-vn-device-'));
  const complete = Promise.withResolvers();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wav': 'audio/wav' };
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'POST' && path === '/__vn-device') {
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 512_000) throw Error('Device record too large.'); }
        const raw = JSON.parse(body);
        assert.equal(raw.nonce, config.nonce, 'Wrong physical run challenge.');
        const verdict = checkDevice(raw, manifest, host);
        const evidence = join(results, `${host}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
        await save(evidence, { ...verdict, raw });
        console.log('Evidence: ' + evidence);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(verdict), () => {
          if (verdict.status === 'passed') setTimeout(() => complete.resolve(evidence), 700);
        });
        return;
      }
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      if (path === '/device-config.json') {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(config)); return;
      }
      const name = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
      if (!Object.hasOwn(manifest.files, name)) { response.writeHead(404).end(); return; }
      const file = resolve(dir, name);
      assert(contained(dir, file));
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' });
      createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'failed', failures: [error.message] }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const paths = host === 'windows' ? ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'] : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  const chrome = process.env.CHROME_PATH ?? paths.find(existsSync);
  const address = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    assert(chrome && existsSync(chrome), 'Set CHROME_PATH to the installed Chrome executable.');
    browser = spawn(chrome, ['--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
      '--enable-unsafe-webgpu', '--new-window', address], { stdio: 'ignore' });
    browser.once('error', error => complete.reject(error));
    browser.once('exit', () => complete.reject(Error('Chrome closed before a complete record was saved.')));
    console.log(`G07 ${host} ${manifest.revision} ${address}`);
    const result = await complete.promise;
    console.log('FINAL STATUS: passed\nEvidence: ' + result);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (browser?.exitCode === null) browser.kill();
  }
}

async function performanceRun() {
  const definitionPath = join(repository, 'config/visual-novel-024-contract.json');
  const definition = await json(definitionPath);
  const plan = definition.measurement.g07Production;
  const manifest = await json(join(destination, 'manifest.json'));
  assert.deepEqual(await inventory(join(destination, 'dist')), manifest.files, 'Device kit bytes changed.');
  if (!values.diagnostic) {
    assert.equal(process.platform, 'win32', 'This native workflow uses the registered Windows runner.');
    assert.equal(manifest.diagnostic, false, 'Diagnostics cannot qualify performance.');
    assert(!values.scenario, 'Formal capture requires every frozen scenario.');
    const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(git(['rev-parse','HEAD']), manifest.revision);
    assert.equal(git(['status','--porcelain']), '', 'Performance capture requires clean candidate source.');
    const { windowsWorkflowHost } = await import('./release-workflow.mjs');
    const host = windowsWorkflowHost(repository);
    assert.equal(host.administrator, true, 'Start the formal launcher as administrator.');
    assert.deepEqual(host.blockers, [], 'Close the background applications shown by the formal preflight.');
  }
  const { runChromeWebGpuFixture } = await import('./webgpu-gate/chrome-runner.mjs');
  const runs = join(destination, 'performance');
  await mkdir(runs, { recursive: true });
  const output = await mkdtemp(join(runs, values.diagnostic ? 'diagnostic-' : 'formal-'));
  const scenarios = values.scenario ? [values.scenario] : plan.scenarios;
  assert(scenarios.every(id => plan.scenarios.includes(id)), 'Unknown performance scenario.');
  const markup = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0} iframe{border:0;width:1280px;height:720px;display:block} pre{display:none}</style>
    <iframe title="G07 production"></iframe><pre id="progress"></pre><pre id="result"></pre>
    <script type="module" src="./performance.mjs"></script>`;
  const rows = [];
  console.log('Performance evidence: ' + output);
  try {
    for (const id of scenarios) {
      const root = join(output, id);
      await cp(join(destination, 'dist'), root, { recursive: true, filter: source => !source.endsWith('physical.mjs') });
      await cp(join(import.meta.dirname, 'fixtures/visual-novel-acceptance/performance.mjs'), join(root, 'performance.mjs'));
      await cp(join(import.meta.dirname, 'fixtures/visual-novel-acceptance/gpu-device.mjs'), join(root, 'gpu-device.mjs'));
      await cp(join(import.meta.dirname, 'benchmark/real-renderer-gpu-timestamp.mjs'), join(root, 'real-renderer-gpu-timestamp.mjs'));
      await writeFile(join(root, 'performance.html'), markup);
      const index = join(root, 'index.html');
      await writeFile(index, (await readFile(index, 'utf8')).replace('src="./physical.mjs"', 'src="./gpu-device.mjs"'));
      if (id === 'static-dialogue' || id === 'continuous-background') {
        const projectFile = join(root, 'project/compiled.json');
        const project = await json(projectFile);
        project.definition.presets['rain-night'] = project.definition.presets['rain-night'].filter(slot => slot.id === 'background');
        for (const cue of project.definition.cues['arrival/open-stage'].flat()) {
          if (cue.op === 'show') cue.slots = cue.slots.filter(slot => slot.id === 'background');
        }
        if (id === 'static-dialogue') {
          const harbor = join(root, 'project/assets/harbor.hya.json');
          const source = await json(harbor);
          source.parts = source.parts.filter(part => part.id === 'core');
          source.targets = [];
          await writeFile(harbor, JSON.stringify(source));
        }
        await writeFile(projectFile, JSON.stringify(project));
      }
      const inputs = await inventory(root);
      for (let processIndex = 1; processIndex <= (values.diagnostic ? 1 : plan.coldProcesses); processIndex++) {
        console.log(`G07 ${id} ${processIndex}/${values.diagnostic ? 1 : plan.coldProcesses}`);
        const payload = await runChromeWebGpuFixture({ root, fixture: 'performance.html', query: { scenario: id },
          timeoutMs: 150_000,
          ...(!values.diagnostic ? { presentation: { mode: 'visible', width: 1330, height: 810 } } : {}) });
        assert.equal(payload.browserEvidence.nativeBackend, true, 'Performance requires native WebGPU.');
        const file = join(output, `${id}-${processIndex}.json`);
        await save(file, { schemaVersion: 1, revision: manifest.revision, inputs, ...payload });
        const p95 = field => {
          const ordered = [...field].sort((a, b) => a - b);
          return ordered.length ? ordered[Math.ceil(ordered.length * .95) - 1] : null;
        };
        rows.push({ id, processIndex, path: relative(output, file), sha256: await fileHash(file), cold: payload.cold,
          frameIntervalP95: p95(payload.rows.map(row => row.intervalMs)),
          cpuEngineP95: p95(payload.rows.map(row => Object.values(row.cpuMs).reduce((a,b) => a+b,0))),
          gpuP95: p95(payload.gpuFrames.map(row => row.totalMs)), retainedPeak: Math.max(...payload.rows.map(row => row.retainedColorBytes)),
          workingPeak: Math.max(...payload.rows.map(row => row.workingColorBytes)),
          retiringPeak: Math.max(...payload.rows.map(row => row.retiringColorBytes)) });
      }
    }
    await save(join(output, 'result.json'), { status: values.diagnostic ? 'diagnostic-complete' : 'passed', revision: manifest.revision, rows });
    console.log('FINAL STATUS: ' + (values.diagnostic ? 'diagnostic-complete' : 'passed') + '\nEvidence: ' + output);
  } catch (error) {
    await save(join(output, 'result.json'), { status: 'failed', revision: manifest.revision, rows, error: error.stack ?? String(error) });
    throw error;
  }
}

if (command === 'prepare') await prepare();
else if (command === 'device') await device();
else if (command === 'performance') await performanceRun();
else if (command === 'verify-device') {
  assert(values.report && ['windows','mac'].includes(values.host), 'Specify the physical host and its return JSON.');
  const manifest = await json(join(destination, 'manifest.json'));
  assert.equal(manifest.diagnostic, false, 'Diagnostics cannot qualify a device.');
  const report = await json(resolve(values.report));
  const result = checkDevice(report.raw, manifest, values.host);
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'passed' ? 0 : 1;
} else throw Error('Use prepare, device, performance, or verify-device. See the device kit README.');
