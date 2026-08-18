import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import JSZip from 'jszip';
import { runEditorBrowserScenario } from './browserDriver.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const editorEntry = resolve(root, 'editor/index.html');
const editorBundle = resolve(root, 'editor/dist/editor.js');
const artifactPath = resolve(
  root,
  process.env.EDITOR_E2E_OUTPUT ?? 'artifacts/editor-e2e/create-save-export-play.json',
);
const failureScreenshotPath = resolve(
  root,
  process.env.EDITOR_E2E_SCREENSHOT ?? 'artifacts/editor-e2e/create-save-export-play-failure.png',
);
const downloadDirectory = mkdtempSync(resolve(tmpdir(), 'haiyue-editor-e2e-downloads-'));
const entityName = 'Browser E2E Entity';
const clippingPlanes = [
  { normal: [0, 2, 0], constant: -1 },
  { normal: [0, 0, -3], constant: 1.5 },
];
const startedAt = Date.now();

for (const required of [editorEntry, editorBundle]) {
  if (!existsSync(required)) {
    throw new Error(`Editor E2E requires ${relative(root, required)}; build the editor first.`);
  }
}
if (existsSync(failureScreenshotPath)) unlinkSync(failureScreenshotPath);

try {
  const result = await runEditorBrowserScenario({
    root,
    route: 'editor/index.html',
    downloadDirectory,
    failureScreenshotPath,
    timeoutMs: 90_000,
    async scenario(driver) {
      const initialEntityCount = await driver.evaluate(`
        (() => {
          const count = nodes => nodes.reduce(
            (total, node) => total + 1 + count(node.children ?? []),
            0,
          );
          return count(document.querySelector('#hierarchy-tree')?.data ?? []);
        })()
      `);

      await driver.click(
        'document.querySelector("#hierarchy-tree")?.shadowRoot?.querySelector(".row.selected")'
          + ' ?? document.querySelector("#hierarchy-tree")?.shadowRoot?.querySelector(".row")',
        { button: 'right', label: 'selected hierarchy row context menu' },
      );
      await driver.waitFor(
        () => driver.evaluate('document.querySelector("#entity-context-menu")?.hasAttribute("open")'),
        'entity context menu',
      );
      await driver.click(`
        [...(document.querySelector('#entity-context-menu')?.shadowRoot?.querySelectorAll('button') ?? [])]
          .find(button => button.textContent?.trim() === '添加实体')
      `, { label: 'Add Entity context menu action' });
      await driver.waitFor(
        () => driver.evaluate(`
          (() => {
            const tree = document.querySelector('#hierarchy-tree');
            const count = nodes => nodes.reduce(
              (total, node) => total + 1 + count(node.children ?? []),
              0,
            );
            return count(tree?.data ?? []) === ${initialEntityCount + 1}
              && tree?.selectedIds?.length === 1
              && Boolean(document.querySelector('#entity-name-input')?.value);
          })()
        `),
        'new entity selection',
      );
      const createdDefaultName = await driver.evaluate(
        'document.querySelector("#entity-name-input")?.value',
      );

      await driver.replaceText('document.querySelector("#entity-name-input")', entityName);
      await driver.waitFor(
        () => driver.evaluate(`
          (() => {
            const visit = nodes => nodes.some(node =>
              node.label === ${JSON.stringify(entityName)} || visit(node.children ?? []));
            const tree = document.querySelector('#hierarchy-tree');
            return visit(tree?.data ?? [])
              && document.querySelector('#save-button')?.hasAttribute('data-dirty');
          })()
        `),
        'renamed dirty entity',
      );

      const componentAdded = await driver.evaluate(`
        (() => {
          const dropdown = document.querySelector('#add-component-dropdown');
          if (!dropdown) return false;
          dropdown.dispatchEvent(new CustomEvent('item-select', {
            bubbles: true,
            composed: true,
            detail: { value: 'ClippingPlanes' },
          }));
          return true;
        })()
      `);
      if (!componentAdded) throw new Error('Could not dispatch the ClippingPlanes Add Component action.');
      await driver.waitFor(
        () => driver.evaluate(`
          document.querySelector('#generic-component-title')?.textContent === 'ClippingPlanes'
            && document.querySelector('#generic-component-fields [data-field="planes"]') instanceof HTMLTextAreaElement
        `),
        'ClippingPlanes Inspector',
      );
      await driver.evaluate(`
        (() => {
          const input = document.querySelector('#generic-component-fields [data-field="planes"]');
          if (!(input instanceof HTMLTextAreaElement)) return false;
          input.value = ${JSON.stringify(JSON.stringify(clippingPlanes))};
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()
      `);
      await driver.waitFor(
        () => driver.evaluate(`
          (() => {
            const input = document.querySelector('#generic-component-fields [data-field="planes"]');
            if (!(input instanceof HTMLTextAreaElement)) return false;
            try {
              const value = JSON.parse(input.value);
              return value.length === 2
                && value[0]?.normal?.[1] === 1
                && value[0]?.constant === -0.5
                && value[1]?.normal?.[2] === -1
                && value[1]?.constant === 0.5;
            } catch {
              return false;
            }
          })()
        `),
        'normalized ClippingPlanes Inspector value',
      );

      const saveStartedAt = Date.now();
      await driver.click('document.querySelector("#save-button")', { label: 'Save scene button' });
      const savedScenePath = await waitForDownload(downloadDirectory, '.json', 'saved scene JSON');
      const savedScene = JSON.parse(readFileSync(savedScenePath, 'utf8'));
      assertSceneContainsEntity(savedScene, entityName, 'saved editor scene');
      assertSceneContainsClippingPlanes(savedScene, entityName, 'saved editor scene');
      await driver.waitFor(
        () => driver.evaluate('!document.querySelector("#save-button")?.hasAttribute("data-dirty")'),
        'saved document state',
      );

      const exportStartedAt = Date.now();
      await driver.click(
        'document.querySelector("#export-project-button")',
        { label: 'Export Project button' },
      );
      const exportedProjectPath = await waitForDownload(
        downloadDirectory,
        '.zip',
        'exported runtime project ZIP',
      );
      const exportedProject = await inspectRuntimeProjectZip(exportedProjectPath, entityName);
      await driver.waitFor(
        () => driver.evaluate('!document.querySelector("#export-project-button")?.hasAttribute("disabled")'),
        're-enabled Export Project button',
      );

      const playStartedAt = Date.now();
      await driver.click('document.querySelector("#play-button")', { label: 'Play button' });
      const playState = await driver.waitFor(
        () => driver.evaluate(`
          (() => {
            const overlay = document.querySelector('#play-overlay');
            const frame = document.querySelector('#play-frame');
            const output = document.querySelector('#play-output');
            const inspector = document.querySelector('#play-runtime-inspector');
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
                inspectorText: inspector?.textContent ?? '',
                canvas: { width: frameCanvas.width, height: frameCanvas.height },
              };
            }
            return null;
          })()
        `),
        'player started lifecycle',
      );
      await driver.waitFor(
        () => driver.evaluate(`
          document.querySelector('#play-runtime-inspector')?.textContent?.includes(${JSON.stringify(entityName)})
            && document.querySelector('#play-runtime-inspector')?.textContent?.includes('ClippingPlanes')
        `),
        'created entity and ClippingPlanes in runtime inspector',
      );
      playState.inspectorContainsCreatedEntity = true;
      playState.inspectorContainsClippingPlanes = true;

      driver.assertNoBrowserErrors();
      return {
        schemaVersion: 1,
        scenario: 'editor-create-save-export-play',
        status: 'passed',
        entityName,
        editor: {
          initialEntityCount,
          createdDefaultName,
          finalEntityCount: await driver.evaluate(`
            (() => {
              const count = nodes => nodes.reduce(
                (total, node) => total + 1 + count(node.children ?? []),
                0,
              );
              return count(document.querySelector('#hierarchy-tree')?.data ?? []);
            })()
          `),
        },
        save: {
          fileName: savedScenePath.split('/').pop(),
          bytes: statSync(savedScenePath).size,
          durationMs: Date.now() - saveStartedAt,
          containsCreatedEntity: true,
          containsClippingPlanes: true,
        },
        export: {
          fileName: exportedProjectPath.split('/').pop(),
          bytes: statSync(exportedProjectPath).size,
          durationMs: Date.now() - exportStartedAt,
          ...exportedProject,
        },
        play: {
          durationMs: Date.now() - playStartedAt,
          ...playState,
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
    `[editor-e2e] passed create → save → export → play in ${result.durationMs}ms; `
    + `scene=${result.save.bytes}B, project=${result.export.bytes}B, `
    + `player=${result.play.canvas.width}x${result.play.canvas.height}.`,
  );
  console.log(`[editor-e2e] Wrote ${relative(root, artifactPath)}.`);
} catch (error) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  const failure = {
    schemaVersion: 1,
    scenario: 'editor-create-save-export-play',
    status: 'failed',
    entityName,
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

function assertSceneContainsEntity(scene, expectedName, label) {
  const visit = entities => entities.some(entity =>
    entity?.name === expectedName || visit(Array.isArray(entity?.children) ? entity.children : []));
  if (!scene || !Array.isArray(scene.entities) || !visit(scene.entities)) {
    throw new Error(`${label} does not contain the created entity "${expectedName}".`);
  }
}

function findSceneEntity(scene, expectedName) {
  const visit = entities => {
    for (const entity of entities ?? []) {
      if (entity?.name === expectedName) return entity;
      const child = visit(Array.isArray(entity?.children) ? entity.children : []);
      if (child) return child;
    }
    return null;
  };
  return visit(Array.isArray(scene?.entities) ? scene.entities : []);
}

function assertSceneContainsClippingPlanes(scene, expectedName, label) {
  const entity = findSceneEntity(scene, expectedName);
  const clipping = entity?.components?.find(component => component?.type === 'ClippingPlanes');
  if (!clipping || clipping.planes?.length !== 2) {
    throw new Error(`${label} does not retain two ClippingPlanes entries on "${expectedName}".`);
  }
  const [first, second] = clipping.planes;
  if (first.normal?.[1] !== 1 || first.constant !== -0.5
    || second.normal?.[2] !== -1 || second.constant !== 0.5) {
    throw new Error(`${label} contains unexpected normalized ClippingPlanes values.`);
  }
}

async function inspectRuntimeProjectZip(path, expectedEntityName) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const fileNames = Object.keys(zip.files).filter(name => !zip.files[name].dir).sort();
  const scenePath = fileNames.find(name => name.endsWith('/src/scene.runtime.json'));
  const packagePath = fileNames.find(name => name.endsWith('/package.json'));
  const indexPath = fileNames.find(name => name.endsWith('/index.html'));
  if (!scenePath || !packagePath || !indexPath) {
    throw new Error(
      `Runtime project ZIP is missing required files. Found: ${fileNames.join(', ')}`,
    );
  }
  const runtimeScene = JSON.parse(await zip.file(scenePath).async('string'));
  assertSceneContainsEntity(runtimeScene, expectedEntityName, 'exported runtime scene');
  assertSceneContainsClippingPlanes(runtimeScene, expectedEntityName, 'exported runtime scene');
  const packageJson = JSON.parse(await zip.file(packagePath).async('string'));
  if (typeof packageJson.scripts?.dev !== 'string' || typeof packageJson.scripts?.build !== 'string') {
    throw new Error('Runtime project package.json is missing runnable dev/build scripts.');
  }
  return {
    fileCount: fileNames.length,
    scenePath,
    containsCreatedEntity: true,
    containsClippingPlanes: true,
    hasRunnablePackage: true,
  };
}
