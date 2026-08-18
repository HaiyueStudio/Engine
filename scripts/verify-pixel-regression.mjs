import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productFixture = process.argv.includes('--product');
const fixturePath = resolve(root, productFixture ? 'scripts/render-regression/pbr-product-fixture.html' : 'scripts/render-regression/fixture.html');
const baselinePath = resolve(root, productFixture ? 'review/baselines/render-pixels-stage9-pbr.json' : 'review/baselines/render-pixels-stage7.json');
const chrome = process.env.CHROME_PATH ?? defaultChromePath();

if (!existsSync(chrome)) {
  if (process.env.RENDER_REGRESSION_ALLOW_SKIP === '1') {
    console.warn(`[render-pixels] Chrome not found at ${chrome}; explicitly skipped.`);
    process.exit(0);
  }
  throw new Error(`Fixed render regression requires Chrome. Set CHROME_PATH (looked for ${chrome}).`);
}

const html = readFileSync(fixturePath);
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(html);
});
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});

try {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate pixel regression server port.');
  const browserResult = await runChromeFixture(chrome, `http://127.0.0.1:${address.port}/`);
  const { status } = browserResult;
  const current = JSON.parse(browserResult.text);
  if (status !== 'passed') throw new Error(`Pixel fixture failed: ${current.error ?? 'unknown error'}`);
  if (process.env.UPDATE_RENDER_BASELINE === '1') {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`[render-pixels] Updated ${baselinePath}.`);
    process.exit(0);
  }
  if (!existsSync(baselinePath)) throw new Error('Pixel baseline is missing. Run with UPDATE_RENDER_BASELINE=1 after reviewing the fixture output.');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const scalarKeys = productFixture
    ? ['fixture', 'width', 'height', 'hash', 'spherePixels', 'shadowPixels']
    : ['fixture', 'width', 'height', 'hash', 'backgroundPixels', 'trianglePixels'];
  for (const key of scalarKeys) {
    if (current[key] !== baseline[key]) throw new Error(`Pixel regression at ${key}: expected ${baseline[key]}, received ${current[key]}.`);
  }
  for (const key of productFixture ? ['dielectric', 'metal', 'shadow', 'corner'] : ['center', 'corner']) {
    if (JSON.stringify(current[key]) !== JSON.stringify(baseline[key])) throw new Error(`Pixel regression at ${key}.`);
  }
  const coverage = productFixture ? `spheres=${current.spherePixels}, shadow=${current.shadowPixels}` : `triangle=${current.trianglePixels}`;
  console.log(`[render-pixels] ${current.fixture} passed: hash=${current.hash}, ${coverage}, adapter=${current.adapter.description || current.adapter.device || 'unknown'}.`);
} finally {
  await new Promise(resolveClose => server.close(resolveClose));
}

async function runChromeFixture(binary, url) {
  const userDataDir = mkdtempSync(resolve(tmpdir(), 'haiyue-render-regression-'));
  const child = spawn(binary, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--enable-unsafe-webgpu',
      `--use-angle=${defaultWebGpuAngleBackend()}`,
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const browserWebSocket = await waitForValue(() => /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1], 15_000, 'Chrome DevTools endpoint');
    const endpoint = new URL(browserWebSocket);
    const listUrl = `http://${endpoint.host}/json/list`;
    const page = await waitForValue(async () => {
      const targets = await fetch(listUrl).then(response => response.json()).catch(() => []);
      return targets.find(target => target.type === 'page' && target.url === url);
    }, 15_000, 'pixel fixture page');
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    try {
      return await waitForValue(async () => {
        const response = await cdp.call('Runtime.evaluate', {
          expression: `(() => { const node = document.querySelector('#result'); return node?.dataset.status ? { status: node.dataset.status, text: node.textContent } : null; })()`,
          returnByValue: true,
        });
        return response.result?.result?.value ?? null;
      }, 20_000, 'WebGPU readback');
    } finally {
      await cdp.call('Browser.close').catch(() => {});
      cdp.close();
    }
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise(resolveExit => child.once('exit', resolveExit)),
        new Promise(resolveTimeout => setTimeout(resolveTimeout, 2_000)),
      ]);
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.warn(`[render-pixels] Could not remove temporary Chrome profile: ${error.message}`);
    }
  }
}

function defaultChromePath() {
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return '/usr/bin/google-chrome';
}

function defaultWebGpuAngleBackend() {
  if (process.platform === 'darwin') return 'metal';
  if (process.platform === 'win32') return 'd3d11';
  return 'vulkan';
}

async function waitForValue(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function connectCdp(url) {
  return new Promise((resolveConnect, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener('error', () => reject(new Error(`Could not connect to Chrome DevTools at ${url}.`)), { once: true });
    socket.addEventListener('open', () => resolveConnect({
      call(method, params = {}) {
        return new Promise((resolveCall, rejectCall) => {
          const id = ++nextId;
          pending.set(id, { resolveCall, rejectCall });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { socket.close(); },
    }), { once: true });
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.rejectCall(new Error(message.error.message));
      else request.resolveCall(message);
    });
  });
}
