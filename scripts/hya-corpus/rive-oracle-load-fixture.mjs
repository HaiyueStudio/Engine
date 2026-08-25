const resultNode = document.querySelector('#result');
const progressNode = document.querySelector('#progress');
const canvas = document.querySelector('#canvas');

try {
  if (!globalThis.rive?.RuntimeLoader) throw new Error('Frozen oracle UMD did not expose rive.RuntimeLoader.');
  globalThis.rive.RuntimeLoader.setWasmUrl('/oracle/rive.wasm');
  globalThis.rive.RuntimeLoader.setWasmFallbackUrl(null);
  const runtime = await globalThis.rive.RuntimeLoader.awaitInstance();
  const paths = new URLSearchParams(location.search).get('assets')?.split('|').filter(Boolean) ?? [];
  if (paths.length === 0) throw new Error('No diagnostic Rive assets were supplied.');
  const renderer = runtime.makeRenderer(canvas, true);
  const results = [];
  let liveOwners = 1;
  for (const [index, path] of paths.entries()) {
    progressNode.textContent = `${index + 1}/${paths.length} ${path}`;
    const started = performance.now();
    let file = null;
    let record;
    try {
      const response = await fetch(`/source/${path}`, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const loadStarted = performance.now();
      file = await runtime.load(bytes, undefined, false);
      const loadedAt = performance.now();
      liveOwners++;
      const artboards = [];
      for (let artboardIndex = 0; artboardIndex < file.artboardCount(); artboardIndex++) {
        const artboard = file.artboardByIndex(artboardIndex);
        liveOwners++;
        try {
          const animations = [];
          for (let animationIndex = 0; animationIndex < artboard.animationCount(); animationIndex++) {
            animations.push(artboard.animationByIndex(animationIndex).name);
          }
          const stateMachines = [];
          for (let machineIndex = 0; machineIndex < artboard.stateMachineCount(); machineIndex++) {
            const definition = artboard.stateMachineByIndex(machineIndex);
            const instance = new runtime.StateMachineInstance(definition, artboard);
            liveOwners++;
            try {
              instance.advanceAndApply(0);
              const inputs = [];
              for (let inputIndex = 0; inputIndex < instance.inputCount(); inputIndex++) {
                const input = instance.input(inputIndex);
                inputs.push({
                  name: input.name,
                  type: input.type === runtime.SMIInput.bool ? 'boolean'
                    : input.type === runtime.SMIInput.number ? 'number'
                      : input.type === runtime.SMIInput.trigger ? 'trigger' : 'unknown',
                  ...(input.value === undefined ? {} : { value: input.value }),
                });
              }
              stateMachines.push({
                name: definition.name,
                inputCount: inputs.length,
                inputs,
                changedStates: collect(instance.stateChangedCount(), item => instance.stateChangedNameByIndex(item)),
                events: collect(instance.reportedEventCount(), item => instance.reportedEventAt(item)?.name ?? null),
              });
            } finally {
              instance.delete();
              liveOwners--;
            }
          }
          artboard.advance(0);
          renderer.clear();
          renderer.save();
          try {
            renderer.align(runtime.Fit.contain, runtime.Alignment.center, {
              minX: 0, minY: 0, maxX: canvas.width, maxY: canvas.height,
            }, artboard.bounds);
            artboard.draw(renderer);
          } finally {
            renderer.restore();
          }
          renderer.flush();
          const pixels = await captureCanvas(canvas);
          artboards.push({
            name: artboard.name,
            bounds: artboard.bounds,
            animationCount: animations.length,
            animations,
            stateMachineCount: stateMachines.length,
            stateMachines,
            pixels,
          });
        } finally {
          renderer.bindContext?.();
          artboard.delete();
          liveOwners--;
        }
      }
      record = {
        path,
        status: 'loaded',
        byteLength: bytes.byteLength,
        fetchAndLoadMs: loadedAt - started,
        loadMs: loadedAt - loadStarted,
        totalMs: performance.now() - started,
        artboards,
      };
    } catch (error) {
      record = {
        path,
        status: 'rejected',
        error: String(error instanceof Error ? error.message : error).slice(0, 512),
        elapsedMs: performance.now() - started,
      };
    } finally {
      if (file) {
        renderer.bindContext?.();
        file.unref();
        liveOwners--;
      }
    }
    results.push(record);
  }
  renderer.delete();
  liveOwners--;
  const report = {
    status: 'passed',
    oracle: '@rive-app/webgl2@2.40.0',
    resultCount: results.length,
    loadedCount: results.filter(value => value.status === 'loaded').length,
    rejectedCount: results.filter(value => value.status === 'rejected').length,
    ownerResidual: liveOwners,
    results,
  };
  if (liveOwners !== 0) throw new Error(`Frozen oracle owner residual is ${liveOwners}.`);
  resultNode.dataset.status = 'passed';
  resultNode.textContent = JSON.stringify(report);
} catch (error) {
  resultNode.dataset.status = 'failed';
  resultNode.textContent = JSON.stringify({ status: 'failed', error: String(error?.stack ?? error) });
}

function collect(count, read) {
  const output = [];
  for (let index = 0; index < count; index++) output.push(read(index));
  return output;
}

async function captureCanvas(target) {
  const blob = await new Promise((resolve, reject) => target.toBlob(value => value ? resolve(value) : reject(new Error('Canvas capture failed.')), 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    byteLength: bytes.byteLength,
    sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''),
  };
}
