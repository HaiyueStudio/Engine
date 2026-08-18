import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { runEditorBrowserScenario } from './browserDriver.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const editorEntry = resolve(root, 'editor/index.html');
const editorBundle = resolve(root, 'editor/dist/editor.js');
const corpusRoot = resolve(root, 'scripts/webgpu-gate/assets/gltf-corpus');
const corpusManifestPath = resolve(corpusRoot, 'manifest.json');
const artifactPath = resolve(
  root,
  process.env.EDITOR_GLTF_E2E_OUTPUT
    ?? 'artifacts/editor-e2e/gltf-import-save-export-play.json',
);
const failureScreenshotPath = resolve(
  root,
  process.env.EDITOR_GLTF_E2E_SCREENSHOT
    ?? 'artifacts/editor-e2e/gltf-import-save-export-play-failure.png',
);
const downloadDirectory = mkdtempSync(resolve(tmpdir(), 'haiyue-editor-gltf-e2e-downloads-'));
const startedAt = Date.now();

for (const required of [editorEntry, editorBundle, corpusManifestPath]) {
  if (!existsSync(required)) {
    throw new Error(`Editor glTF E2E requires ${relative(root, required)}.`);
  }
}
if (existsSync(failureScreenshotPath)) unlinkSync(failureScreenshotPath);

const fixture = validateFixture();

try {
  const result = await runEditorBrowserScenario({
    root,
    route: 'editor/index.html',
    downloadDirectory,
    failureScreenshotPath,
    timeoutMs: 90_000,
    async scenario(driver) {
      const initialEntityCount = await readEditorEntityCount(driver);
      const initialListenerCount = await driver.evaluate('window.__editorE2EListenerCount?.() ?? -1');

      await driver.click(`
        [...(document.querySelector('#resource-tabs')?.shadowRoot?.querySelectorAll('button') ?? [])]
          .find(button => ['Models', '模型'].includes(button.textContent?.trim() ?? ''))
      `, { label: 'Models resource tab' });
      await driver.waitFor(
        () => driver.evaluate(`
          document.querySelector('#resource-tabs')?.value === 'model'
            && Boolean(document.querySelector('#model-resources input[type="file"]:not([webkitdirectory])'))
        `),
        'model resource importer',
      );

      const importStartedAt = Date.now();
      await driver.setFileInputFiles(
        '#model-resources input[type="file"]:not([webkitdirectory])',
        [fixture.path],
      );
      const importedResource = await driver.waitFor(
        () => driver.evaluate(`
          (() => {
            const card = document.querySelector('#model-resources [data-model-id]');
            const title = document.querySelector('#resource-detail-title')?.textContent?.trim() ?? '';
            const detail = document.querySelector('#resource-detail-grid')?.textContent ?? '';
            const operationText = document.querySelector('#asset-operation-center')?.textContent ?? '';
            if (!card || title !== ${JSON.stringify(fixture.name)}) return null;
            return {
              id: Number(card.dataset.modelId),
              name: card.querySelector('.resource-name')?.textContent?.trim() ?? '',
              detail,
              hasPreview: Boolean(card.querySelector('img')),
              operationCompleted: operationText.includes('completed'),
              operationFailed: operationText.includes('failed') || operationText.includes('cancelled'),
            };
          })()
        `),
        'decoded glTF model resource',
      );
      if (importedResource.name !== fixture.name) {
        throw new Error(`Imported model name mismatch: ${importedResource.name}.`);
      }
      if (!importedResource.hasPreview) {
        throw new Error('Real glTF import completed without a decoded model preview.');
      }
      if (!importedResource.operationCompleted || importedResource.operationFailed) {
        throw new Error('Real glTF import did not reach a clean completed workflow state.');
      }

      await driver.click(
        `document.querySelector('#model-resources [data-model-id="${importedResource.id}"]')`,
        { label: 'Imported glTF model resource card' },
      );
      await driver.pressKey(' ', { code: 'Space' });
      const instantiatedEntity = await driver.waitFor(
        () => driver.evaluate(`
          (() => {
            const visit = nodes => nodes.some(node =>
              node.label === ${JSON.stringify(fixture.name)} || visit(node.children ?? []));
            const tree = document.querySelector('#hierarchy-tree');
            if (visit(tree?.data ?? [])
              && tree?.selectedIds?.length === 1
              && document.querySelector('#save-button')?.hasAttribute('data-dirty')) {
              return {
                componentTypes: (document.querySelector('#selected-components')?.options ?? [])
                  .map(option => option.value),
                availableComponentTypes: (document.querySelector('#add-component-dropdown')?.items ?? [])
                  .map(item => item.value),
              };
            }
            return null;
          })()
        `),
        'instantiated glTF scene entity',
      );
      if (!instantiatedEntity.componentTypes.includes('GltfModelComponent')) {
        throw new Error(
          'Instantiated model entity lost GltfModelComponent before save. '
          + `Entity components: ${instantiatedEntity.componentTypes.join(', ')}; `
          + `available: ${instantiatedEntity.availableComponentTypes.join(', ')}.`,
        );
      }

      const saveStartedAt = Date.now();
      await driver.click('document.querySelector("#save-button")', { label: 'Save glTF scene' });
      const savedScenePath = await waitForDownload(downloadDirectory, '.json', 'saved glTF scene');
      const savedScene = JSON.parse(readFileSync(savedScenePath, 'utf8'));
      const savedEvidence = inspectSavedScene(savedScene, fixture);
      await driver.waitFor(
        () => driver.evaluate('!document.querySelector("#save-button")?.hasAttribute("data-dirty")'),
        'saved glTF document state',
      );

      const exportStartedAt = Date.now();
      await driver.click(
        'document.querySelector("#export-project-button")',
        { label: 'Export glTF runtime project' },
      );
      const exportedProjectPath = await waitForDownload(
        downloadDirectory,
        '.zip',
        'exported glTF runtime project',
      );
      const exportedEvidence = await inspectRuntimeProjectZip(exportedProjectPath, fixture);
      await driver.waitFor(
        () => driver.evaluate('!document.querySelector("#export-project-button")?.hasAttribute("disabled")'),
        're-enabled glTF project export',
      );

      const prePlayListenerCount = await driver.evaluate('window.__editorE2EListenerCount?.() ?? -1');
      const playStartedAt = Date.now();
      await driver.click('document.querySelector("#play-button")', { label: 'Play imported glTF scene' });
      const playState = await driver.waitFor(
        () => driver.evaluate(`
          (() => {
            const overlay = document.querySelector('#play-overlay');
            const frame = document.querySelector('#play-frame');
            const output = document.querySelector('#play-output');
            const lifecycleStarted = [...(output?.querySelectorAll('.play-output-line.lifecycle') ?? [])]
              .some(line => line.textContent?.includes('started'));
            const runtimeError = output?.querySelector('.play-output-line.error')?.textContent ?? '';
            const frameCanvas = frame?.contentDocument?.querySelector('#player-canvas');
            if (
              overlay?.hidden === false
              && lifecycleStarted
              && frameCanvas?.tagName === 'CANVAS'
              && !runtimeError
            ) {
              return {
                lifecycleStarted,
                runtimeError,
                canvas: { width: frameCanvas.width, height: frameCanvas.height },
              };
            }
            return null;
          })()
        `),
        'glTF player lifecycle',
      );

      let loadedEntityCount;
      try {
        loadedEntityCount = await driver.waitFor(
          () => driver.evaluate(`
            (() => {
              const metrics = [...document.querySelectorAll('#play-performance .play-debug-metric')];
              const metric = metrics.find(item => item.querySelector('small')?.textContent === 'Entities');
              const count = Number(metric?.querySelector('strong')?.textContent ?? '0');
              return count > ${savedEvidence.serializedEntityCount} ? count : null;
            })()
          `),
          'runtime glTF child entities',
          20_000,
        );
      } catch (error) {
        const diagnostic = await driver.evaluate(`
          (() => ({
            log: document.querySelector('#play-output')?.textContent?.trim() ?? '',
            inspector: document.querySelector('#play-runtime-inspector')?.textContent?.trim() ?? '',
            frameMessage: document.querySelector('#play-frame')?.contentDocument
              ?.querySelector('#message')?.textContent?.trim() ?? '',
          }))()
        `);
        throw new Error(`${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(diagnostic)}`);
      }
      playState.entityCount = loadedEntityCount;
      playState.serializedEntityCount = savedEvidence.serializedEntityCount;
      playState.loadedEntityDelta = loadedEntityCount - savedEvidence.serializedEntityCount;
      const runtimeWarnings = await driver.evaluate(`
        [...document.querySelectorAll('#play-output .play-output-line.warn')]
          .map(line => line.textContent?.trim() ?? '')
      `);
      if (runtimeWarnings.length > 0) {
        throw new Error(`glTF player emitted runtime warnings: ${runtimeWarnings.join(' | ')}`);
      }
      playState.loadedWithoutWarnings = true;

      await driver.click(
        'document.querySelector("#play-close-button")',
        { label: 'Close glTF player' },
      );
      const closedState = await driver.waitFor(
        () => driver.evaluate(`
          (() => {
            const overlay = document.querySelector('#play-overlay');
            const frame = document.querySelector('#play-frame');
            const listenerCount = window.__editorE2EListenerCount?.() ?? -1;
            if (overlay?.hidden && frame?.srcdoc === '' && listenerCount === ${prePlayListenerCount}) {
              return { listenerCount, overlayHidden: true, frameCleared: true };
            }
            return null;
          })()
        `),
        'disposed glTF play session',
      );

      driver.assertNoBrowserErrors();
      return {
        schemaVersion: 1,
        scenario: 'editor-gltf-import-save-export-play',
        status: 'passed',
        fixture: {
          corpus: fixture.corpus,
          tier: fixture.tier,
          name: fixture.name,
          displayName: fixture.displayName,
          relativePath: relative(root, fixture.path),
          bytes: fixture.bytes,
          sha256: fixture.sha256,
          features: fixture.features,
          expected: fixture.expected,
        },
        editor: {
          initialEntityCount,
          initialListenerCount,
          importedResource,
          finalEntityCount: await readEditorEntityCount(driver),
        },
        import: {
          durationMs: Date.now() - importStartedAt,
          decodedPreview: importedResource.hasPreview,
        },
        save: {
          fileName: savedScenePath.split('/').pop(),
          bytes: statSync(savedScenePath).size,
          durationMs: Date.now() - saveStartedAt,
          ...savedEvidence,
        },
        export: {
          fileName: exportedProjectPath.split('/').pop(),
          bytes: statSync(exportedProjectPath).size,
          durationMs: Date.now() - exportStartedAt,
          ...exportedEvidence,
        },
        play: {
          durationMs: Date.now() - playStartedAt,
          ...playState,
          close: closedState,
        },
        environment: {
          url: driver.url,
          chromePath: driver.chrome,
          angleBackend: driver.angleBackend,
        },
        durationMs: Date.now() - startedAt,
      };
    },
  });

  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `[editor-gltf-e2e] passed import -> save -> export -> play in ${result.durationMs}ms; `
    + `fixture=${result.fixture.bytes}B, runtimeEntities=${result.play.entityCount}.`,
  );
  console.log(`[editor-gltf-e2e] Wrote ${relative(root, artifactPath)}.`);
} catch (error) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  const failure = {
    schemaVersion: 1,
    scenario: 'editor-gltf-import-save-export-play',
    status: 'failed',
    fixture: {
      relativePath: relative(root, fixture.path),
      bytes: fixture.bytes,
      sha256: fixture.sha256,
    },
    durationMs: Date.now() - startedAt,
    error: error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: 'Error', message: String(error) },
  };
  writeFileSync(artifactPath, `${JSON.stringify(failure, null, 2)}\n`);
  throw error;
} finally {
  rmSync(downloadDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function validateFixture() {
  const manifest = JSON.parse(readFileSync(corpusManifestPath, 'utf8'));
  const tier = manifest.tiers?.find(item => item.id === 'small');
  if (!tier) throw new Error('glTF corpus manifest is missing the small production tier.');
  const file = tier.files?.find(item => item.path === tier.entry);
  if (!file) throw new Error(`glTF corpus manifest is missing provenance for ${tier.entry}.`);
  const path = resolve(corpusRoot, tier.entry);
  const contents = readFileSync(path);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  if (contents.byteLength !== file.bytes) {
    throw new Error(`glTF fixture byte length mismatch: ${contents.byteLength} !== ${file.bytes}.`);
  }
  if (sha256 !== file.sha256) {
    throw new Error(`glTF fixture SHA-256 mismatch: ${sha256} !== ${file.sha256}.`);
  }
  return {
    corpus: manifest.name,
    tier: tier.id,
    name: basename(tier.entry, extname(tier.entry)),
    displayName: tier.name,
    path,
    bytes: file.bytes,
    sha256,
    features: tier.features,
    expected: tier.expected,
  };
}

function inspectSavedScene(scene, fixtureInfo) {
  const models = scene?.resources?.models;
  if (!Array.isArray(models) || models.length !== 1) {
    throw new Error(`Saved editor scene must contain exactly one model resource; found ${models?.length ?? 0}.`);
  }
  const model = models[0];
  if (model.name !== fixtureInfo.name || model.fileName !== 'AnimatedMorphCube.glb') {
    throw new Error('Saved model resource lost its real fixture identity.');
  }
  if (model.fileSize !== fixtureInfo.bytes || typeof model.src !== 'string' || !model.src.startsWith('data:')) {
    throw new Error('Saved model resource lost its embedded GLB payload or byte length.');
  }
  const encoded = model.src.slice(model.src.indexOf(',') + 1);
  if (Buffer.from(encoded, 'base64').byteLength !== fixtureInfo.bytes) {
    throw new Error('Saved model resource embedded payload has the wrong byte length.');
  }
  if (model.previewError !== undefined) {
    throw new Error(`Saved model resource reports preview failure: ${model.previewError}`);
  }
  for (const [key, expected] of Object.entries(fixtureInfo.expected)) {
    if (key === 'skinCount' || key === 'morphTargetCount') continue;
    if (model.assetStats?.[key] !== expected) {
      throw new Error(`Saved model assetStats.${key}=${model.assetStats?.[key]}; expected ${expected}.`);
    }
  }
  const entity = findEntityWithComponent(scene.entities, 'GltfModelComponent');
  if (!entity || entity.name !== fixtureInfo.name) {
    throw new Error(
      'Saved editor scene is missing the instantiated GltfModelComponent entity. '
      + `Found: ${JSON.stringify(describeEntities(scene.entities))}`,
    );
  }
  const component = entity.components.find(item => item.type === 'GltfModelComponent');
  if (component.src !== model.src || component.autoLoad !== true || component.clearPrevious !== true) {
    throw new Error('Saved GltfModelComponent does not reference the imported model with auto-load enabled.');
  }
  return {
    modelResourceCount: models.length,
    embeddedSourceBytes: fixtureInfo.bytes,
    modelEntityName: entity.name,
    componentType: component.type,
    assetStats: model.assetStats,
    serializedEntityCount: countEntities(scene.entities),
  };
}

async function inspectRuntimeProjectZip(path, fixtureInfo) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const fileNames = Object.keys(zip.files).filter(name => !zip.files[name].dir).sort();
  const scenePath = fileNames.find(name => name.endsWith('/src/scene.runtime.json'));
  const manifestPath = fileNames.find(name => name.endsWith('/public/export-manifest.json'));
  const deserializerPath = fileNames.find(name => name.endsWith('/src/runtime-deserialization.ts'));
  const playerPath = fileNames.find(name => name.endsWith('/src/runtime-player.ts'));
  if (!scenePath || !manifestPath || !deserializerPath || !playerPath) {
    throw new Error(`glTF runtime project is missing required files. Found: ${fileNames.join(', ')}`);
  }
  const runtimeScene = JSON.parse(await zip.file(scenePath).async('string'));
  const entity = findEntityWithComponent(runtimeScene.entities, 'GltfModelComponent');
  const component = entity?.components.find(item => item.type === 'GltfModelComponent');
  if (!entity || !component || entity.name !== fixtureInfo.name || !component.src?.startsWith('data:')) {
    throw new Error('Exported runtime scene lost the imported glTF model component or payload.');
  }
  const manifest = JSON.parse(await zip.file(manifestPath).async('string'));
  const runtimeImport = manifest.dependencies?.runtimeImports?.find(
    item => item.from === '@haiyue/extensions/gltf',
  );
  if (!runtimeImport?.names?.includes('GltfModelComponent')
    || !runtimeImport.names.includes('GltfModelSystem')) {
    throw new Error('Export manifest is missing the glTF component/system runtime dependency.');
  }
  const deserializer = await zip.file(deserializerPath).async('string');
  const player = await zip.file(playerPath).async('string');
  if (!deserializer.includes("from '@haiyue/extensions/gltf'")
    || !deserializer.includes('case "GltfModelComponent"')) {
    throw new Error('Exported runtime deserializer is missing the glTF contribution.');
  }
  if (!player.includes('new GltfModelSystem')) {
    throw new Error('Exported runtime player is missing GltfModelSystem installation.');
  }
  return {
    fileCount: fileNames.length,
    scenePath,
    manifestPath,
    containsGltfEntity: true,
    componentImport: '@haiyue/extensions/gltf',
    installsGltfModelSystem: true,
  };
}

function findEntityWithComponent(entities, componentType) {
  for (const entity of entities ?? []) {
    if (entity?.components?.some(component => component.type === componentType)) return entity;
    const nested = findEntityWithComponent(entity?.children, componentType);
    if (nested) return nested;
  }
  return null;
}

function countEntities(entities) {
  return (entities ?? []).reduce((total, entity) => total + 1 + countEntities(entity.children), 0);
}

function describeEntities(entities) {
  return (entities ?? []).flatMap(entity => [{
    name: entity?.name,
    components: (entity?.components ?? []).map(component => component?.type),
  }, ...describeEntities(entity?.children)]);
}

async function readEditorEntityCount(driver) {
  return driver.evaluate(`
    (() => {
      const count = nodes => nodes.reduce(
        (total, node) => total + 1 + count(node.children ?? []),
        0,
      );
      return count(document.querySelector('#hierarchy-tree')?.data ?? []);
    })()
  `);
}

async function waitForDownload(directory, extension, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastCandidate = null;
  let lastSize = -1;
  while (Date.now() < deadline) {
    const candidates = readdirSync(directory)
      .filter(name => extname(name).toLowerCase() === extension && !name.endsWith('.crdownload'))
      .map(name => resolve(directory, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    const candidate = candidates[0] ?? null;
    if (candidate) {
      const size = statSync(candidate).size;
      if (candidate === lastCandidate && size > 0 && size === lastSize) return candidate;
      lastCandidate = candidate;
      lastSize = size;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${label} in ${directory}.`);
}
