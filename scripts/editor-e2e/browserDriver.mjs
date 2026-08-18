import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { defaultWebGpuAngleBackend } from '../webgpu-gate/chrome-runner.mjs';

export function defaultChromePath() {
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return '/usr/bin/google-chrome';
}

export async function runEditorBrowserScenario({
  root,
  route,
  downloadDirectory,
  failureScreenshotPath,
  timeoutMs = 90_000,
  scenario,
}) {
  const chrome = process.env.CHROME_PATH ?? defaultChromePath();
  if (!existsSync(chrome)) {
    throw new Error(`Editor browser E2E requires Chrome. Set CHROME_PATH (looked for ${chrome}).`);
  }

  const server = createStaticServer(root);
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const profile = mkdtempSync(resolve(tmpdir(), 'haiyue-editor-e2e-profile-'));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate the editor E2E server port.');
  const url = `http://127.0.0.1:${address.port}/${route.replace(/^\/+/, '')}`;
  const angleBackend = process.env.WEBGPU_ANGLE_BACKEND ?? defaultWebGpuAngleBackend();
  const child = spawn(chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--enable-unsafe-webgpu',
    `--use-angle=${angleBackend}`,
    '--window-size=1440,1000',
    '--force-device-scale-factor=1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    const endpoint = await waitFor(
      () => /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1],
      20_000,
      'Chrome DevTools endpoint',
    );
    const listUrl = `http://${new URL(endpoint).host}/json/list`;
    const page = await waitFor(async () => {
      const targets = await fetch(listUrl).then(response => response.json()).catch(() => []);
      return targets.find(target => target.type === 'page' && target.url === 'about:blank');
    }, 20_000, 'blank Chrome page');
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    const browserErrors = [];
    cdp.on('Runtime.exceptionThrown', event => {
      browserErrors.push(event.exceptionDetails?.exception?.description
        ?? event.exceptionDetails?.text
        ?? 'Unknown page exception');
    });
    cdp.on('Runtime.consoleAPICalled', event => {
      if (event.type !== 'error') return;
      const message = (event.args ?? []).map(argument => (
        argument.description ?? argument.value ?? argument.type ?? 'unknown console value'
      )).join(' ');
      browserErrors.push(`console.error: ${message}`);
    });

    try {
      await cdp.call('Page.enable');
      await cdp.call('Runtime.enable');
      await cdp.call('Performance.enable');
      await cdp.call('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDirectory,
        eventsEnabled: true,
      });
      await cdp.call('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          for (const picker of ['showSaveFilePicker', 'showOpenFilePicker']) {
            try {
              Object.defineProperty(window, picker, {
                configurable: true,
                value: undefined,
              });
            } catch {}
          }
        `,
      });
      await cdp.call('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
            const add = EventTarget.prototype.addEventListener;
            const remove = EventTarget.prototype.removeEventListener;
            const listeners = [];
            let activeListenerCount = 0;
            const keyFor = (type, listener, options) => {
              const capture = typeof options === 'boolean' ? options : options?.capture === true;
              return { type, listener, capture };
            };
            EventTarget.prototype.addEventListener = function(type, listener, options) {
              if (this === window && listener) {
                const key = keyFor(type, listener, options);
                if (!listeners.some(entry => entry.type === key.type
                  && entry.listener === key.listener
                  && entry.capture === key.capture)) {
                  listeners.push(key);
                  activeListenerCount++;
                }
              }
              return add.call(this, type, listener, options);
            };
            EventTarget.prototype.removeEventListener = function(type, listener, options) {
              if (this === window && listener) {
                const key = keyFor(type, listener, options);
                const index = listeners.findIndex(entry => entry.type === key.type
                  && entry.listener === key.listener
                  && entry.capture === key.capture);
                if (index >= 0) {
                  listeners.splice(index, 1);
                  activeListenerCount--;
                }
              }
              return remove.call(this, type, listener, options);
            };
            Object.defineProperty(window, '__editorE2EListenerCount', {
              configurable: true,
              value: () => activeListenerCount,
            });
          })();
        `,
      });
      await cdp.call('Page.navigate', { url });

      const driver = createBrowserDriver(cdp, timeoutMs, browserErrors);
      await driver.waitFor(() => driver.evaluate(`
        (() => {
          const tree = document.querySelector('#hierarchy-tree');
          const row = tree?.shadowRoot?.querySelector('.row');
          const canvas = document.querySelector('#viewport');
          return Boolean(
            customElements.get('ge-tree')
            && row
            && canvas instanceof HTMLCanvasElement
            && canvas.width > 0
            && canvas.height > 0
          );
        })()
      `), 'editor application readiness');

      return await scenario({
        ...driver,
        url,
        chrome,
        angleBackend,
        getBrowserErrors: () => browserErrors.slice(),
      });
    } catch (error) {
      if (failureScreenshotPath) {
        try {
          const screenshot = await cdp.call('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false,
          });
          mkdirSync(dirname(failureScreenshotPath), { recursive: true });
          writeFileSync(failureScreenshotPath, Buffer.from(screenshot.result.data, 'base64'));
        } catch {}
      }
      const detail = browserErrors.length > 0
        ? `\nBrowser exceptions:\n- ${browserErrors.join('\n- ')}`
        : '';
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}\nChrome stderr:\n${stderr}`);
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
    await closeServer(server);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.warn(`[editor-e2e] Could not remove temporary Chrome profile: ${error.message}`);
    }
  }
}

function createBrowserDriver(cdp, defaultTimeoutMs, browserErrors) {
  const evaluate = async expression => {
    const response = await cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.result?.exceptionDetails) {
      throw new Error(
        response.result.exceptionDetails.exception?.description
        ?? response.result.exceptionDetails.text
        ?? 'Browser evaluation failed.',
      );
    }
    return response.result?.result?.value;
  };

  const waitForDriver = (read, label, timeoutMs = defaultTimeoutMs) =>
    waitFor(read, timeoutMs, label);

  const getElementCenter = expression => evaluate(`
    (() => {
      const element = (${expression});
      if (!(element instanceof Element)) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    })()
  `);

  const click = async (expression, options = {}) => {
    const center = await waitForDriver(
      () => getElementCenter(expression),
      options.label ?? `click target ${expression}`,
      options.timeoutMs,
    );
    const button = options.button ?? 'left';
    const modifiers = modifierBits(options.modifiers);
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: center.x,
      y: center.y,
      button,
      clickCount: 1,
      modifiers,
    });
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: center.x,
      y: center.y,
      button,
      clickCount: 1,
      modifiers,
    });
  };

  const replaceText = async (expression, value) => {
    await click(expression, { label: `text input ${expression}` });
    const selected = await evaluate(`
      (() => {
        const input = (${expression});
        if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
        input.select();
        return document.activeElement === input;
      })()
    `);
    if (!selected) throw new Error(`Could not select the current value of ${expression}.`);
    if (value.length === 0) {
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
    } else {
      await cdp.call('Input.insertText', { text: value });
    }
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
    });
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
    });
  };

  const assertNoBrowserErrors = () => {
    if (browserErrors.length > 0) {
      throw new Error(`Editor raised uncaught browser exceptions:\n- ${browserErrors.join('\n- ')}`);
    }
  };

  const setFileInputFiles = async (selector, files) => {
    const documentNode = await cdp.call('DOM.getDocument', { depth: -1, pierce: true });
    const selected = await cdp.call('DOM.querySelector', {
      nodeId: documentNode.result.root.nodeId,
      selector,
    });
    if (!selected.result.nodeId) throw new Error(`Could not find file input ${selector}.`);
    await cdp.call('DOM.setFileInputFiles', {
      nodeId: selected.result.nodeId,
      files,
    });
    await evaluate(`
      (() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!(input instanceof HTMLInputElement)) return false;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
  };

  const drag = async (sourceExpression, targetExpression, options = {}) => {
    const source = await waitForDriver(
      () => getElementCenter(sourceExpression),
      options.label ?? 'drag source',
      options.timeoutMs,
    );
    const target = await waitForDriver(
      () => getElementCenter(targetExpression),
      options.label ?? 'drag target',
      options.timeoutMs,
    );
    await cdp.call('Input.setInterceptDrags', { enabled: true });
    let stopListening = () => {};
    try {
      const dragDataPromise = new Promise((resolveDragData, rejectDragData) => {
        const timeout = setTimeout(
          () => rejectDragData(new Error(`Timed out starting ${options.label ?? 'hierarchy drag'}.`)),
          options.timeoutMs ?? 10_000,
        );
        stopListening = cdp.on('Input.dragIntercepted', event => {
          clearTimeout(timeout);
          stopListening();
          resolveDragData(event.data);
        });
      });
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: source.x,
        y: source.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      const steps = options.steps ?? 8;
      for (let index = 1; index <= steps; index++) {
        const progress = index / steps;
        await cdp.call('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: source.x + (target.x - source.x) * progress,
          y: source.y + (target.y - source.y) * progress,
          button: 'left',
          buttons: 1,
        });
      }
      const dragData = await dragDataPromise;
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await cdp.call('Input.dispatchDragEvent', {
          type,
          x: target.x,
          y: target.y,
          data: dragData,
        });
      }
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: target.x,
        y: target.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
    } finally {
      stopListening();
      await cdp.call('Input.setInterceptDrags', { enabled: false }).catch(() => {});
    }
  };

  const wheel = async (expression, deltaY) => {
    const center = await waitForDriver(
      () => getElementCenter(expression),
      `scroll target ${expression}`,
    );
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: center.x,
      y: center.y,
      deltaX: 0,
      deltaY,
    });
  };

  const pressKey = async (key, options = {}) => {
    const code = options.code ?? key;
    const modifiers = modifierBits(options.modifiers);
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      modifiers,
    });
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      modifiers,
    });
  };

  const nextPaint = () => evaluate(`
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))))
  `);

  const getPerformanceMetrics = async () => {
    const response = await cdp.call('Performance.getMetrics');
    return Object.fromEntries(
      (response.result.metrics ?? []).map(metric => [metric.name, metric.value]),
    );
  };

  return {
    cdp,
    evaluate,
    waitFor: waitForDriver,
    click,
    replaceText,
    setFileInputFiles,
    drag,
    wheel,
    pressKey,
    nextPaint,
    getPerformanceMetrics,
    assertNoBrowserErrors,
  };
}

function modifierBits(modifiers = []) {
  let bits = 0;
  for (const modifier of modifiers ?? []) {
    if (modifier === 'Alt') bits |= 1;
    else if (modifier === 'Control') bits |= 2;
    else if (modifier === 'Meta') bits |= 4;
    else if (modifier === 'Shift') bits |= 8;
  }
  return bits;
}

function createStaticServer(root) {
  const normalizedRoot = resolve(root);
  return createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const requested = resolve(normalizedRoot, `.${pathname}`);
      if (requested !== normalizedRoot && !requested.startsWith(`${normalizedRoot}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const path = statSync(requested).isDirectory() ? resolve(requested, 'index.html') : requested;
      response.writeHead(200, {
        'content-type': contentType(path),
        'cache-control': 'no-store',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      response.end(readFileSync(path));
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
}

function connectCdp(url) {
  return new Promise((resolveConnect, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 0;
    socket.addEventListener(
      'error',
      () => reject(new Error(`Could not connect to Chrome DevTools at ${url}.`)),
      { once: true },
    );
    socket.addEventListener('open', () => resolveConnect({
      call(method, params = {}) {
        return new Promise((resolveCall, rejectCall) => {
          const id = ++nextId;
          pending.set(id, { resolveCall, rejectCall });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      on(method, listener) {
        const methodListeners = listeners.get(method) ?? new Set();
        methodListeners.add(listener);
        listeners.set(method, methodListeners);
        return () => methodListeners.delete(listener);
      },
      close() {
        socket.close();
      },
    }), { once: true });
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.rejectCall(new Error(message.error.message));
        else request.resolveCall(message);
        return;
      }
      for (const listener of listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
  });
}

async function waitFor(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}.${detail}`);
}

function closeServer(server) {
  const closed = new Promise(resolveClose => server.close(resolveClose));
  server.closeAllConnections();
  return closed;
}

function contentType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json':
    case '.map': return 'application/json; charset=utf-8';
    case '.wasm': return 'application/wasm';
    case '.wgsl': return 'text/plain; charset=utf-8';
    case '.png': return 'image/png';
    case '.svg': return 'image/svg+xml';
    case '.css': return 'text/css; charset=utf-8';
    default: return 'application/octet-stream';
  }
}
