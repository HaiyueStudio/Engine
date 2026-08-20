import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

export function defaultChromePath() {
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return '/usr/bin/google-chrome';
}

export function defaultWebGpuAngleBackend(platform = process.platform) {
  if (platform === 'darwin') return 'metal';
  if (platform === 'win32') return 'd3d11';
  return 'vulkan';
}

export async function runChromeWebGpuFixture({
  root,
  fixture,
  query = {},
  timeoutMs = 60_000,
  allocationSampling = null,
  acceptedStatuses = ['passed'],
  visualCapture = null,
  navigateAwayAfterResult = false,
  mounts = [],
}) {
  const chrome = process.env.CHROME_PATH ?? defaultChromePath();
  if (!existsSync(chrome)) throw new Error(`Chrome/WebGPU gate requires Chrome. Set CHROME_PATH (looked for ${chrome}).`);
  const fixtureServer = await startHttpFixtureServer(root, { mounts });
  try {
    const parameters = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    const url = `${fixtureServer.origin}/${fixture}?${parameters}`;
    const result = await runChrome(
      chrome,
      url,
      timeoutMs,
      allocationSampling,
      acceptedStatuses,
      visualCapture,
      navigateAwayAfterResult,
    );
    result.httpProvenance = fixtureServer.provenance();
    return result;
  } finally {
    await fixtureServer.close();
  }
}

export async function startHttpFixtureServer(root, { mounts = [] } = {}) {
  const httpEvidence = createHttpEvidence();
  const server = createStaticServer(root, httpEvidence, mounts);
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate Chrome/WebGPU gate server port.');
  }
  let closed = false;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    provenance: () => summarizeHttpEvidence(httpEvidence),
    async close() {
      if (closed) return;
      closed = true;
      const didClose = new Promise(resolveClose => server.close(resolveClose));
      server.closeAllConnections();
      await didClose;
    },
  };
}

function createStaticServer(root, httpEvidence, mounts) {
  const normalizedRoot = resolve(root);
  const normalizedMounts = [
    { prefix: '', directory: normalizedRoot },
    ...mounts.map(normalizeMount),
  ].sort((left, right) => right.prefix.length - left.prefix.length);
  return createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const mount = normalizedMounts.find(candidate => (
        candidate.prefix === ''
        || pathname === candidate.prefix
        || pathname.startsWith(`${candidate.prefix}/`)
      ));
      const relativePath = mount.prefix === '' ? pathname : pathname.slice(mount.prefix.length);
      const requested = resolve(mount.directory, `.${relativePath}`);
      if (requested !== mount.directory && !requested.startsWith(`${mount.directory}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const path = statSync(requested).isDirectory() ? resolve(requested, 'index.html') : requested;
      const contents = readFileSync(path);
      const relativeSource = relative(mount.directory, path).split(sep).join('/');
      const sourcePath = mount.prefix
        ? `${mount.prefix.slice(1)}/${relativeSource}`
        : relativeSource;
      recordHttpEvidence(httpEvidence, sourcePath, contents);
      response.writeHead(200, {
        'content-type': contentType(path),
        'cache-control': 'no-store',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      response.end(contents);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
}

function normalizeMount(mount) {
  const prefix = String(mount?.prefix ?? '').replace(/\/$/u, '');
  if (!prefix.startsWith('/') || prefix === '' || prefix.includes('..')) {
    throw new Error(`Chrome fixture mount prefix must be an absolute URL segment: ${prefix}.`);
  }
  const directory = resolve(String(mount?.directory ?? ''));
  if (!statSync(directory).isDirectory()) {
    throw new Error(`Chrome fixture mount is not a directory: ${directory}.`);
  }
  return { prefix, directory };
}

async function runChrome(
  binary,
  url,
  timeoutMs,
  allocationSampling,
  acceptedStatuses,
  visualCapture,
  navigateAwayAfterResult,
) {
  const angleBackend = process.env.WEBGPU_ANGLE_BACKEND ?? defaultWebGpuAngleBackend();
  if (process.env.WEBGPU_REQUIRE_NATIVE === '1' && isSoftwareBackend(angleBackend)) {
    throw new Error(`Required browser evidence cannot use software WebGPU backend ${angleBackend}.`);
  }
  const profile = mkdtempSync(resolve(tmpdir(), 'haiyue-webgpu-gate-'));
  const child = spawn(binary, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--enable-unsafe-webgpu',
    `--use-angle=${angleBackend}`,
    '--remote-debugging-port=0',
    ...(visualCapture ? [
      `--window-size=${visualCapture.viewportWidth ?? 960},${visualCapture.viewportHeight ?? 540}`,
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
    ] : []),
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  let stderr = '';
  let completedResult = null;
  let primaryError = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const endpoint = await waitFor(() => /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1], 20_000, 'Chrome DevTools endpoint');
    const listUrl = `http://${new URL(endpoint).host}/json/list`;
    const page = await waitFor(async () => {
      const targets = await fetch(listUrl).then(response => response.json()).catch(() => []);
      return targets.find(target => target.type === 'page' && target.url === 'about:blank');
    }, 20_000, 'Chrome/WebGPU fixture page');
    const cdp = await connectCdp(page.webSocketDebuggerUrl, Math.min(timeoutMs, 30_000));
    try {
      const browserErrors = [];
      cdp.on('Runtime.exceptionThrown', event => {
        browserErrors.push({
          kind: 'exception',
          message: event.exceptionDetails?.exception?.description
            ?? event.exceptionDetails?.text
            ?? 'Unknown page exception',
        });
      });
      cdp.on('Runtime.consoleAPICalled', event => {
        if (event.type !== 'error') return;
        browserErrors.push({
          kind: 'console.error',
          message: (event.args ?? []).map(argument => (
            argument.description ?? argument.value ?? argument.type ?? 'unknown console value'
          )).join(' '),
        });
      });
      await cdp.call('Runtime.enable');
      await cdp.call('Page.enable');
      const version = await cdp.call('Browser.getVersion');
      if (visualCapture) {
        await cdp.call('Emulation.setDeviceMetricsOverride', {
          width: visualCapture.viewportWidth ?? 960,
          height: visualCapture.viewportHeight ?? 540,
          deviceScaleFactor: 1,
          mobile: false,
        });
      }
      if (allocationSampling) {
        await cdp.call('HeapProfiler.enable');
        await cdp.call('HeapProfiler.startSampling', {
          samplingInterval: allocationSampling.samplingInterval ?? 32768,
          includeObjectsCollectedByMajorGC: allocationSampling.includeObjectsCollectedByMajorGC ?? true,
          includeObjectsCollectedByMinorGC: allocationSampling.includeObjectsCollectedByMinorGC ?? true,
        });
      }
      await cdp.call('Page.navigate', { url });
      let lastProgress = '';
      const fixtureResult = await waitFor(async () => {
        let response;
        try {
          response = await cdp.call('Runtime.evaluate', {
            expression: `(() => { const node = document.querySelector('#result'); return { status: node?.dataset.status || '', text: node?.textContent || '', progress: document.querySelector('#progress')?.textContent || '' }; })()`,
            returnByValue: true,
          });
        } catch (error) {
          if (error instanceof Error && error.message.includes('Cannot find default execution context')) return null;
          throw error;
        }
        const value = response.result?.result?.value ?? null;
        lastProgress = value?.progress ?? lastProgress;
        return value?.status ? value : null;
      }, timeoutMs, 'Chrome/WebGPU fixture result', () => lastProgress);
      if (!acceptedStatuses.includes(fixtureResult.status)) {
        throw new Error(`Chrome/WebGPU fixture failed: ${fixtureResult.text}\n${stderr}`);
      }
      const result = JSON.parse(fixtureResult.text);
      const identityResponse = await cdp.call('Runtime.evaluate', {
        expression: `({ userAgent: navigator.userAgent, platform: navigator.platform, href: location.href })`,
        returnByValue: true,
      });
      result.browserEvidence = {
        product: version.result?.product ?? 'unknown',
        userAgent: identityResponse.result?.result?.value?.userAgent ?? 'unknown',
        platform: identityResponse.result?.result?.value?.platform ?? 'unknown',
        url: identityResponse.result?.result?.value?.href ?? url,
        angleBackend,
        nativeBackend: !isSoftwareBackend(angleBackend),
      };
      if (allocationSampling) {
        const response = await cdp.call('HeapProfiler.stopSampling');
        result.allocationSampling = summarizeAllocationProfile(
          response.result?.profile,
          allocationSampling.samplingInterval ?? 32768,
        );
      }
      if (visualCapture) result.visualCapture = await captureVisual(cdp, visualCapture);
      if (navigateAwayAfterResult) {
        const triggerExpression = typeof navigateAwayAfterResult === 'object'
          ? navigateAwayAfterResult.triggerExpression
          : null;
        if (triggerExpression) {
          const trigger = await cdp.call('Runtime.evaluate', {
            expression: triggerExpression,
            returnByValue: true,
          });
          if (trigger.result?.exceptionDetails) {
            throw new Error(`Chrome/WebGPU navigation trigger failed: ${trigger.result.exceptionDetails.text}`);
          }
        }
        await cdp.call('Page.navigate', { url: 'about:blank' });
        await waitFor(async () => {
          try {
            const response = await cdp.call('Runtime.evaluate', {
              expression: 'location.href',
              returnByValue: true,
            });
            return response.result?.result?.value === 'about:blank';
          } catch {
            return false;
          }
        }, 10_000, 'post-fixture navigation');
        await new Promise(resolveWait => setTimeout(resolveWait, 250));
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
      result.browserDiagnostics = {
        consoleErrorCount: browserErrors.filter(error => error.kind === 'console.error').length,
        exceptionCount: browserErrors.filter(error => error.kind === 'exception').length,
        unclassifiedFailureCount: browserErrors.length,
      };
      if (browserErrors.length > 0) {
        throw new Error(
          `Chrome/WebGPU fixture raised unclassified browser errors:\n`
          + browserErrors.map(error => `[${error.kind}] ${error.message}`).join('\n'),
        );
      }
      completedResult = result;
      return result;
    } finally {
      await cdp.call('Browser.close').catch(() => {});
      cdp.close();
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (child.exitCode === null) {
      await waitForChildExit(child, 5_000);
    }
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await waitForChildExit(child, 5_000);
    }
    // Chrome helpers can outlive the browser process briefly and keep the
    // inherited pipes referenced even after Browser.close has completed.
    // The result and stderr diagnostics have already been consumed here, so
    // release those handles to let one-shot fixture processes terminate.
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    try {
      const cleanup = await removeChromeProfile(profile);
      if (completedResult) completedResult.browserDiagnostics.profileCleanup = cleanup;
    } catch (error) {
      const cleanupError = new Error(
        `Chrome/WebGPU fixture left a temporary profile residual: ${error.message}`,
        { cause: error },
      );
      if (primaryError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'Chrome/WebGPU fixture and temporary profile cleanup both failed.',
        );
      }
      throw cleanupError;
    }
  }
}

export async function removeChromeProfile(profile, {
  remove = rmSync,
  maxAttempts = 100,
  retryDelayMs = 100,
} = {}) {
  const startedAt = Date.now();
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      remove(profile, { recursive: true, force: true });
      return {
        status: 'passed',
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      lastError = error;
      if (!isRetryableProfileCleanupError(error) || attempt === maxAttempts) break;
      await new Promise(resolveWait => setTimeout(resolveWait, retryDelayMs));
    }
  }
  const error = new Error(
    `Could not remove temporary Chrome profile after ${maxAttempts} attempts: ${lastError?.message ?? 'unknown error'}`,
    { cause: lastError },
  );
  error.code = lastError?.code ?? 'CHROME_PROFILE_CLEANUP_FAILED';
  throw error;
}

function isRetryableProfileCleanupError(error) {
  return ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code);
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolveExit(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function createHttpEvidence() {
  return { requestCount: 0, files: new Map() };
}

function recordHttpEvidence(evidence, sourcePath, contents) {
  evidence.requestCount++;
  const existing = evidence.files.get(sourcePath);
  if (existing) {
    existing.requestCount++;
    return;
  }
  evidence.files.set(sourcePath, {
    sourcePath,
    byteLength: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
    requestCount: 1,
  });
}

function summarizeHttpEvidence(evidence) {
  return {
    transport: 'http',
    requestCount: evidence.requestCount,
    uniqueFileCount: evidence.files.size,
    files: [...evidence.files.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
  };
}

function isSoftwareBackend(value) {
  return /swiftshader|software|warp/iu.test(String(value));
}

async function captureVisual(cdp, options) {
  const screenshot = await cdp.call('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const pngBase64 = screenshot.result?.data;
  if (!pngBase64) throw new Error('Chrome returned an empty visual-regression screenshot.');
  const sampleWidth = options.sampleWidth ?? 24;
  const sampleHeight = options.sampleHeight ?? 14;
  const expression = `(async () => {
    const image = new Image();
    image.src = ${JSON.stringify(`data:image/png;base64,${pngBase64}`)};
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = ${sampleWidth};
    canvas.height = ${sampleHeight};
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const signature = [];
    let dark = 0;
    let bright = 0;
    const sums = [0, 0, 0];
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      const luma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      if (luma < 32) dark++;
      if (luma > 220) bright++;
      for (let channel = 0; channel < 3; channel++) {
        sums[channel] += rgb[channel];
        signature.push(Math.round(rgb[channel] / 17) * 17);
      }
    }
    const count = canvas.width * canvas.height;
    return {
      sampleWidth: canvas.width,
      sampleHeight: canvas.height,
      signature,
      meanRgb: sums.map(value => Number((value / count).toFixed(3))),
      darkRatio: Number((dark / count).toFixed(4)),
      brightRatio: Number((bright / count).toFixed(4)),
    };
  })()`;
  const fingerprint = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = fingerprint.result?.result?.value;
  if (!value?.signature?.length) throw new Error('Could not derive a screenshot visual fingerprint.');
  return { ...value, pngBase64 };
}

function summarizeAllocationProfile(profile, samplingInterval) {
  const frames = new Map();
  const visit = node => {
    frames.set(node.id, node.callFrame);
    for (const child of node.children ?? []) visit(child);
  };
  if (profile?.head) visit(profile.head);
  const byFrame = new Map();
  let sampledBytes = 0;
  for (const sample of profile?.samples ?? []) {
    sampledBytes += sample.size ?? 0;
    const frame = frames.get(sample.nodeId) ?? {};
    const key = `${frame.url ?? ''}:${frame.lineNumber ?? 0}:${frame.functionName || '(anonymous)'}`;
    const entry = byFrame.get(key) ?? {
      functionName: frame.functionName || '(anonymous)', url: frame.url || '',
      lineNumber: (frame.lineNumber ?? -1) + 1, sampledBytes: 0, samples: 0,
    };
    entry.sampledBytes += sample.size ?? 0;
    entry.samples++;
    byFrame.set(key, entry);
  }
  return {
    kind: 'chrome-v8-allocation-sampling',
    samplingInterval,
    sampledBytes,
    sampleCount: profile?.samples?.length ?? 0,
    top: [...byFrame.values()].sort((a, b) => b.sampledBytes - a.sampledBytes).slice(0, 20),
  };
}

async function waitFor(read, timeoutMs, label, describe = () => '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  const detail = describe();
  throw new Error(`Timed out waiting for ${label}${detail ? ` (${detail})` : ''}.`);
}

function connectCdp(url, defaultCallTimeoutMs) {
  return new Promise((resolveConnect, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 0;
    socket.addEventListener('error', () => reject(new Error(`Could not connect to Chrome DevTools at ${url}.`)), { once: true });
    socket.addEventListener('open', () => resolveConnect({
      call(method, params = {}, callTimeoutMs = defaultCallTimeoutMs) {
        return new Promise((resolveCall, rejectCall) => {
          const id = ++nextId;
          const timeout = setTimeout(() => {
            pending.delete(id);
            rejectCall(new Error(`Chrome DevTools call timed out after ${callTimeoutMs}ms: ${method}`));
          }, callTimeoutMs);
          pending.set(id, { resolveCall, rejectCall, timeout });
          try {
            socket.send(JSON.stringify({ id, method, params }));
          } catch (error) {
            pending.delete(id);
            clearTimeout(timeout);
            rejectCall(error);
          }
        });
      },
      on(method, listener) {
        const methods = listeners.get(method) ?? [];
        methods.push(listener);
        listeners.set(method, methods);
      },
      close() { socket.close(); },
    }), { once: true });
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        clearTimeout(request.timeout);
        if (message.error) request.rejectCall(new Error(message.error.message));
        else request.resolveCall(message);
        return;
      }
      for (const listener of listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
    socket.addEventListener('close', () => {
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.rejectCall(new Error('Chrome DevTools connection closed before the call completed.'));
      }
      pending.clear();
    });
  });
}

function contentType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.wasm': return 'application/wasm';
    case '.wgsl': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}
