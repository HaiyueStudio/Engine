const ALLOWED_GAMES = new Set(['billiards-3d', 'gravity-maze']);
const resultNode = document.querySelector('#result');
const frame = document.querySelector('#product');

void capture().catch(error => publish('failed', {
  schemaVersion: 1,
  error: error instanceof Error ? error.message : String(error),
}));

async function capture() {
  const game = new URLSearchParams(location.search).get('game');
  if (!ALLOWED_GAMES.has(game)) throw new Error(`Unsupported ray admission game: ${game ?? '<missing>'}.`);
  frame.src = `/Games/games/${game}/index.html`;
  await new Promise((resolveLoad, rejectLoad) => {
    frame.addEventListener('load', resolveLoad, { once: true });
    frame.addEventListener('error', () => rejectLoad(new Error(`Could not load ${game}.`)), { once: true });
  });
  const product = frame.contentDocument;
  if (!product) throw new Error(`Could not access the ${game} product document.`);
  const canvas = await waitFor(() => {
    const candidate = product.querySelector('canvas');
    return candidate?.tagName === 'CANVAS' && candidate.width > 0 && candidate.height > 0
      ? candidate
      : null;
  }, 30_000, `${game} render canvas`);
  await waitFor(() => product.body.dataset.renderStatus !== 'failed', 5_000, `${game} render status`);
  await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  await new Promise(resolveWait => setTimeout(resolveWait, 1_000));

  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('Native WebGPU adapter is unavailable.');
  const info = adapter.info ?? {};
  publish('passed', {
    schemaVersion: 1,
    game,
    title: product.title,
    canvas: { width: canvas.width, height: canvas.height },
    bodyDataset: { ...product.body.dataset },
    adapter: {
      vendor: info.vendor ?? '',
      architecture: info.architecture ?? '',
      device: info.device ?? '',
      description: info.description ?? '',
    },
    sourcePath: `/Games/games/${game}/index.html`,
  });
}

function publish(status, value) {
  resultNode.dataset.status = status;
  resultNode.textContent = JSON.stringify(value);
}

async function waitFor(read, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
