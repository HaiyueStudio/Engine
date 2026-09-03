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
  crossOriginIsolation = true,
}) {
  const chrome = process.env.CHROME_PATH ?? defaultChromePath();
  if (!existsSync(chrome)) throw new Error(`Chrome/WebGPU gate requires Chrome. Set CHROME_PATH (looked for ${chrome}).`);
  const fixtureServer = await startHttpFixtureServer(root, { mounts, crossOriginIsolation });
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

export async function startHttpFixtureServer(root, { mounts = [], crossOriginIsolation = true } = {}) {
  const httpEvidence = createHttpEvidence();
  const server = createStaticServer(root, httpEvidence, mounts, crossOriginIsolation);
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

function createStaticServer(root, httpEvidence, mounts, crossOriginIsolation) {
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
        ...(crossOriginIsolation ? {
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
        } : {}),
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
    // Evidence captures exercise real audio scheduling, but a headless gate
    // must never emit sound through the user's desktop output device.
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
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
  const compareSelectors = Array.isArray(options.compareSelectors) && options.compareSelectors.length === 2
    ? options.compareSelectors
    : null;
  const compareInsetTop = Math.max(0, options.compareInsetTop ?? 0);
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
    const result = {
      sampleWidth: canvas.width,
      sampleHeight: canvas.height,
      signature,
      meanRgb: sums.map(value => Number((value / count).toFixed(3))),
      darkRatio: Number((dark / count).toFixed(4)),
      brightRatio: Number((bright / count).toFixed(4)),
    };
    const compareSelectors = ${JSON.stringify(compareSelectors)};
    if (compareSelectors) {
      const insetTop = ${compareInsetTop};
      const rects = compareSelectors.map(selector => {
        const node = document.querySelector(selector);
        if (!node) throw new Error('Visual comparison selector is missing: ' + selector);
        const rect = node.getBoundingClientRect();
        // Preserve fractional CSS origins for split panes. Independently
        // flooring each half-width panel introduces an artificial half-pixel
        // translation before the two surfaces are compared.
        return { x: rect.left, y: rect.top + insetTop, width: Math.floor(rect.width), height: Math.floor(rect.height - insetTop) };
      });
      const width = Math.max(1, Math.min(rects[0].width, rects[1].width));
      const height = Math.max(1, Math.min(rects[0].height, rects[1].height));
      const readRegion = rect => {
        const target = document.createElement('canvas'); target.width = width; target.height = height;
        const targetContext = target.getContext('2d', { willReadFrequently: true });
        targetContext.drawImage(image, rect.x, rect.y, width, height, 0, 0, width, height);
        return targetContext.getImageData(0, 0, width, height).data;
      };
      const left = readRegion(rects[0]);
      const right = readRegion(rects[1]);
      let maxChannelError = 0;
      let maxErrorLocation = null;
      let absoluteError = 0;
      let mismatchPixelCount = 0;
      for (let offset = 0; offset < left.length; offset += 4) {
        let pixelError = 0;
        for (let channel = 0; channel < 3; channel++) {
          const error = Math.abs(left[offset + channel] - right[offset + channel]);
          if (error > maxChannelError) {
            maxChannelError = error;
            const pixelIndex = offset / 4;
            maxErrorLocation = {
              x: pixelIndex % width,
              y: Math.floor(pixelIndex / width),
              channel,
              left: left[offset + channel],
              right: right[offset + channel],
            };
          }
          pixelError = Math.max(pixelError, error);
          absoluteError += error;
        }
        if (pixelError > 8) mismatchPixelCount++;
      }
      const pixelCount = width * height;
      const spatialComparison = (source, target) => {
        let maximumError = 0;
        let absoluteError = 0;
        let mismatchPixelCount = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const sourceOffset = (y * width + x) * 4;
          let bestMaximum = Infinity;
          let bestAbsolute = Infinity;
          for (let candidateY = Math.max(0, y - 1); candidateY <= Math.min(height - 1, y + 1); candidateY++) {
            for (let candidateX = Math.max(0, x - 1); candidateX <= Math.min(width - 1, x + 1); candidateX++) {
              const targetOffset = (candidateY * width + candidateX) * 4;
              let candidateMaximum = 0;
              let candidateAbsolute = 0;
              for (let channel = 0; channel < 3; channel++) {
                const error = Math.abs(source[sourceOffset + channel] - target[targetOffset + channel]);
                candidateMaximum = Math.max(candidateMaximum, error);
                candidateAbsolute += error;
              }
              if (candidateMaximum < bestMaximum || (candidateMaximum === bestMaximum && candidateAbsolute < bestAbsolute)) {
                bestMaximum = candidateMaximum;
                bestAbsolute = candidateAbsolute;
              }
            }
          }
          maximumError = Math.max(maximumError, bestMaximum);
          absoluteError += bestAbsolute;
          if (bestMaximum > 8) mismatchPixelCount++;
        }
        return { maximumError, absoluteError, mismatchPixelCount };
      };
      const forwardSpatial = spatialComparison(left, right);
      const reverseSpatial = spatialComparison(right, left);
      const localVariation = (pixels, x, y) => {
        const centerOffset = (y * width + x) * 4;
        let variation = 0;
        for (let candidateY = Math.max(0, y - 1); candidateY <= Math.min(height - 1, y + 1); candidateY++) {
          for (let candidateX = Math.max(0, x - 1); candidateX <= Math.min(width - 1, x + 1); candidateX++) {
            const offset = (candidateY * width + candidateX) * 4;
            for (let channel = 0; channel < 3; channel++) variation = Math.max(variation, Math.abs(pixels[centerOffset + channel] - pixels[offset + channel]));
          }
        }
        return variation;
      };
      let interiorPixelCount = 0;
      let interiorMaximumError = 0;
      let interiorAbsoluteError = 0;
      let interiorMismatchPixelCount = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (localVariation(left, x, y) > 8 || localVariation(right, x, y) > 8) continue;
        interiorPixelCount++;
        const offset = (y * width + x) * 4;
        let pixelError = 0;
        for (let channel = 0; channel < 3; channel++) {
          const error = Math.abs(left[offset + channel] - right[offset + channel]);
          pixelError = Math.max(pixelError, error);
          interiorMaximumError = Math.max(interiorMaximumError, error);
          interiorAbsoluteError += error;
        }
        if (pixelError > 8) interiorMismatchPixelCount++;
      }
      const neighborhood = (pixels, center) => {
        if (!center) return [];
        const values = [];
        for (let y = Math.max(0, center.y - 1); y <= Math.min(height - 1, center.y + 1); y++) {
          for (let x = Math.max(0, center.x - 1); x <= Math.min(width - 1, center.x + 1); x++) {
            const offset = (y * width + x) * 4;
            values.push({ x, y, rgba: Array.from(pixels.slice(offset, offset + 4)) });
          }
        }
        return values;
      };
      result.regionParity = {
        selectors: compareSelectors,
        sourceRects: rects,
        insetTop,
        width,
        height,
        maxChannelError,
        maxErrorLocation,
        maxErrorNeighborhood: {
          left: neighborhood(left, maxErrorLocation),
          right: neighborhood(right, maxErrorLocation),
        },
        meanAbsoluteError: Number((absoluteError / (pixelCount * 3)).toFixed(6)),
        mismatchPixelCount,
        mismatchRatio: Number((mismatchPixelCount / pixelCount).toFixed(6)),
        onePixelSpatialTolerance: {
          maxChannelError: Math.max(forwardSpatial.maximumError, reverseSpatial.maximumError),
          meanAbsoluteError: Number(((forwardSpatial.absoluteError + reverseSpatial.absoluteError) / (pixelCount * 6)).toFixed(6)),
          mismatchPixelCount: forwardSpatial.mismatchPixelCount + reverseSpatial.mismatchPixelCount,
          mismatchRatio: Number(((forwardSpatial.mismatchPixelCount + reverseSpatial.mismatchPixelCount) / (pixelCount * 2)).toFixed(6)),
        },
        stableInterior: {
          pixelCount: interiorPixelCount,
          coverageRatio: Number((interiorPixelCount / pixelCount).toFixed(6)),
          maxChannelError: interiorMaximumError,
          meanAbsoluteError: Number((interiorAbsoluteError / Math.max(1, interiorPixelCount * 3)).toFixed(6)),
          mismatchPixelCount: interiorMismatchPixelCount,
          mismatchRatio: Number((interiorMismatchPixelCount / Math.max(1, interiorPixelCount)).toFixed(6)),
        },
      };
    }
    return result;
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
    case '.css': return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.wasm': return 'application/wasm';
    case '.wgsl': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}
