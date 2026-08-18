import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { runEditorBrowserScenario } from './browserDriver.mjs';
import {
  EDITOR_LARGE_SCENE_BUDGETS,
} from './editorLargeSceneBudgets.mjs';
import { createDeterministicEditorScene } from './largeSceneGenerator.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options = parseArguments(process.argv.slice(2));
const artifactPath = resolve(
  root,
  options.output
    ?? `artifacts/editor-e2e/large-scene-${options.phase}.json`,
);
const baselinePath = resolve(
  root,
  options.baseline
    ?? 'artifacts/editor-e2e/large-scene-before.json',
);
const editorEntry = resolve(root, 'editor/index.html');
const editorBundle = resolve(root, 'editor/dist/editor.js');
const startedAt = Date.now();
const HIERARCHY_DRAG_P95_MS = 50;
const HIERARCHY_DRAG_SAMPLE_COUNT = 40;
const HIERARCHY_DRAG_SETTLE_MS = 50;

for (const required of [editorEntry, editorBundle]) {
  if (!existsSync(required)) {
    throw new Error(`Editor large-scene E2E requires ${relative(root, required)}; build the editor first.`);
  }
}

const result = {
  schemaVersion: 1,
  scenario: 'editor-large-scene-interaction-gate',
  phase: options.phase,
  mode: options.reportOnly
    ? 'report-only'
    : options.enforcePerformance
      ? 'correctness-and-performance-gate'
      : 'correctness-gate',
  performanceBudgetRole: options.enforcePerformance ? 'blocking-diagnostic' : 'diagnostic-only',
  status: 'running',
  createdAt: new Date().toISOString(),
  productBudgets: EDITOR_LARGE_SCENE_BUDGETS,
  counts: {},
  durationMs: 0,
};

try {
  for (const entityCount of options.counts) {
    result.counts[entityCount] = await runEntityCount(entityCount);
  }
  result.domScaling = summarizeDomScaling(result.counts);
  result.comparison = compareWithBaseline(result.counts, baselinePath);
  result.gate = evaluateGate(result);
  result.status = result.gate.enforcedPassed || options.reportOnly ? 'passed' : 'failed';
  result.durationMs = Date.now() - startedAt;
  writeArtifact();
  if (!options.reportOnly && !result.gate.enforcedPassed) {
    const failures = result.gate.passed ? result.gate.performanceFailures : result.gate.failures;
    const kind = result.gate.passed ? 'performance' : 'correctness/lifecycle';
    throw new Error(`Editor large-scene ${kind} gate failed: ${failures.join('; ')}`);
  }
  if (!options.enforcePerformance && !result.gate.performancePassed) {
    console.warn(
      `[editor-e2e] Absolute large-scene budgets recorded as diagnostic-only: `
      + result.gate.performanceFailures.join('; '),
    );
  }
  console.log(
    `[editor-e2e] ${options.phase} ${options.counts.join('/')} entities: `
    + `${result.status}; drag P95=${Object.values(result.counts).map(entry => `${entry.entityCount}:${entry.metrics.hierarchyDrag.p95Ms.toFixed(1)}ms`).join(', ')}.`,
  );
  console.log(`[editor-e2e] Wrote ${relative(root, artifactPath)}.`);
} catch (error) {
  result.status = 'failed';
  result.durationMs = Date.now() - startedAt;
  result.error = serializeError(error);
  writeArtifact();
  throw error;
}

async function runEntityCount(entityCount) {
  const generated = createDeterministicEditorScene(entityCount);
  const scenarioDirectory = mkdtempSync(resolve(tmpdir(), `haiyue-editor-${entityCount}-`));
  const downloadDirectory = resolve(scenarioDirectory, 'downloads');
  const scenePath = resolve(scenarioDirectory, `scale-${entityCount}.json`);
  const failureScreenshotPath = resolve(
    root,
    `artifacts/editor-e2e/large-scene-${options.phase}-${entityCount}-failure.png`,
  );
  mkdirSync(downloadDirectory, { recursive: true });
  writeFileSync(scenePath, generated.json);

  try {
    return await runEditorBrowserScenario({
      root,
      route: 'editor/index.html',
      downloadDirectory,
      failureScreenshotPath,
      timeoutMs: options.timeoutMs,
      async scenario(driver) {
        const interactionSamples = [];
        await driver.evaluate(`
          (() => {
            window.__editorE2ELongTasks = [];
            if (typeof PerformanceObserver === 'undefined'
              || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return false;
            const observer = new PerformanceObserver(list => {
              for (const entry of list.getEntries()) {
                window.__editorE2ELongTasks.push({
                  name: entry.name,
                  startTime: entry.startTime,
                  duration: entry.duration,
                });
              }
            });
            observer.observe({ type: 'longtask', buffered: true });
            window.__editorE2ELongTaskObserver = observer;
            return true;
          })()
        `);

        const loadStartedAt = Date.now();
        await driver.setFileInputFiles('#open-file-input', [scenePath]);
        await driver.waitFor(
          () => driver.evaluate(`
            (() => {
              const count = nodes => {
                let total = 0;
                const stack = [...nodes];
                while (stack.length) {
                  const node = stack.pop();
                  if (!node) continue;
                  total++;
                  stack.push(...(node.children ?? []));
                }
                return total;
              };
              const tree = document.querySelector('#hierarchy-tree');
              return count(tree?.data ?? []) === ${entityCount}
                && tree?.shadowRoot?.querySelectorAll('.row').length > 0;
            })()
          `),
          `${entityCount}-entity scene load`,
        );
        const loadDurationMs = Date.now() - loadStartedAt;
        const openSceneStages = await driver.evaluate(`
          Object.fromEntries(
            performance.getEntriesByType('measure')
              .filter(entry => entry.name.startsWith('editor.open.'))
              .map(entry => [entry.name.slice('editor.open.'.length), entry.duration]),
          )
        `);

        const treeExpression = 'document.querySelector("#hierarchy-tree")';
        const row = index =>
          `document.querySelector('#hierarchy-tree')?.shadowRoot?.querySelectorAll('.row')[${index}]`;
        const measure = async (label, operation, browserStartMark = null) => {
          const start = await driver.evaluate('performance.now()');
          await operation();
          const effectiveStart = browserStartMark
            ? await driver.evaluate(`
              performance.getEntriesByName(${JSON.stringify(browserStartMark)}, 'mark').at(-1)?.startTime
                ?? ${start}
            `)
            : start;
          const painted = await driver.nextPaint();
          const durationMs = painted - effectiveStart;
          interactionSamples.push({ label, durationMs });
          return durationMs;
        };

        await measure('tree.collapse', () => driver.click(
          `${row(0)}?.querySelector('.toggle')`,
          { label: 'first hierarchy group toggle' },
        ));
        await measure('tree.expand', () => driver.click(
          `${row(0)}?.querySelector('.toggle')`,
          { label: 'first hierarchy group toggle' },
        ));

        for (const deltaY of [1200, 1200, -900, 1800, -1200]) {
          await measure('tree.scroll', () => driver.wheel(treeExpression, deltaY));
        }

        const searchOrdinal = entityCount - 1;
        const searchName = `Scale Entity ${String(searchOrdinal).padStart(5, '0')}`;
        await measure('tree.search', () => driver.replaceText(
          'document.querySelector("#entity-search-input")',
          searchName,
        ));
        await driver.waitFor(
          () => driver.evaluate(`
            (() => {
              const tree = document.querySelector('#hierarchy-tree');
              const labels = [];
              const stack = [...(tree?.data ?? [])];
              while (stack.length) {
                const node = stack.pop();
                if (!node) continue;
                labels.push(node.label);
                stack.push(...(node.children ?? []));
              }
              return labels.includes(${JSON.stringify(
                `Scale Entity ${String(searchOrdinal).padStart(5, '0')} · G${String(Math.floor(searchOrdinal / 100)).padStart(3, '0')}C${String((searchOrdinal % 100) - 1).padStart(2, '0')}`,
              )});
            })()
          `),
          'filtered hierarchy result',
        );
        await measure('tree.search-clear', () => driver.replaceText(
          'document.querySelector("#entity-search-input")',
          '',
        ));
        await driver.waitFor(
          () => driver.evaluate(`
            (() => {
              const tree = document.querySelector('#hierarchy-tree');
              let count = 0;
              const stack = [...(tree?.data ?? [])];
              while (stack.length) {
                const node = stack.pop();
                if (!node) continue;
                count++;
                stack.push(...(node.children ?? []));
              }
              return count === ${entityCount};
            })()
          `),
          'full hierarchy after search',
        );
        await driver.evaluate(`
          (() => {
            const tree = document.querySelector('#hierarchy-tree');
            if (!tree) return false;
            tree.scrollTop = 0;
            tree.dispatchEvent(new Event('scroll'));
            return true;
          })()
        `);
        await driver.nextPaint();

        await measure('tree.select', () => driver.click(row(1), { label: 'hierarchy row selection' }));
        for (const index of [2, 3, 4, 5]) {
          await measure('tree.multi-select', () => driver.click(row(index), {
            label: 'hierarchy multi-selection',
            modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
          }));
        }
        const selectedCount = await driver.evaluate(
          'document.querySelector("#hierarchy-tree")?.selectedIds?.length ?? 0',
        );
        if (selectedCount !== 5) {
          throw new Error(`Expected five selected entities before batch Inspector edit; found ${selectedCount}.`);
        }

        await measure('inspector.batch-edit', () => driver.replaceText(
          'document.querySelector("#position-x")',
          '42.5',
        ));
        await driver.waitFor(
          () => driver.evaluate(
            'document.querySelector("#position-x")?.value === "42.5"'
              + ' && document.querySelector("#save-button")?.hasAttribute("data-dirty")',
          ),
          'batch Inspector edit',
        );

        const dragIds = await driver.evaluate(`
          (() => {
            const rows = document.querySelector('#hierarchy-tree')?.shadowRoot?.querySelectorAll('.row');
            return {
              sourceId: rows?.[2]?.dataset.id ?? null,
              targetId: rows?.[6]?.dataset.id ?? null,
            };
          })()
        `);
        if (!dragIds.sourceId || !dragIds.targetId) {
          throw new Error('Could not resolve deterministic hierarchy drag endpoints.');
        }
        await driver.evaluate(`
          for (const entry of performance.getEntriesByType('measure')) {
            if (entry.name.startsWith('editor.hierarchy.')) performance.clearMeasures(entry.name);
          }
        `);
        const beforeDragParentId = await treeParentId(driver, dragIds.sourceId);
        await measure(
          'tree.drag',
          () => driver.drag(row(2), row(6), { label: 'hierarchy entity drag' }),
          'editor.hierarchy.input-start',
        );
        await driver.waitFor(
          async () => (await treeParentId(driver, dragIds.sourceId)) === dragIds.targetId,
          'hierarchy drag completion',
        );
        await settleInteraction(driver);
        const rowById = id =>
          `document.querySelector('#hierarchy-tree')?.shadowRoot?.querySelector('.row[data-id="${id}"]')`;
        const localTargetIds = await driver.evaluate(`
          (() => {
            const root = document.querySelector('#hierarchy-tree')?.data
              ?.find(node => node.id === ${JSON.stringify(String(dragIds.targetId))});
            return (root?.children ?? [])
              .filter(node => node.id !== ${JSON.stringify(String(dragIds.sourceId))})
              .slice(-2)
              .map(node => node.id);
          })()
        `);
        if (localTargetIds.length !== 2) {
          throw new Error('Could not resolve nearby hierarchy drag targets.');
        }
        await driver.evaluate(`
          document.querySelector('#hierarchy-tree')?.reveal(${JSON.stringify(String(dragIds.sourceId))})
        `);
        await driver.nextPaint();
        let expectedTargetId = dragIds.targetId;
        // A P95 based on only eight samples degenerates into the maximum. Forty
        // interactions give the tail enough resolution to distinguish isolated
        // scheduler interruptions from a sustained frame-budget regression.
        for (let dragIndex = 1; dragIndex < HIERARCHY_DRAG_SAMPLE_COUNT; dragIndex++) {
          expectedTargetId = localTargetIds[dragIndex % 2];
          await measure(
            'tree.drag',
            () => driver.drag(rowById(dragIds.sourceId), rowById(expectedTargetId), {
              label: `hierarchy entity drag sample ${dragIndex + 1}`,
            }),
            'editor.hierarchy.input-start',
          );
          await driver.waitFor(
            async () => (await treeParentId(driver, dragIds.sourceId)) === expectedTargetId,
            `hierarchy drag sample ${dragIndex + 1} completion`,
          );
          await settleInteraction(driver);
        }
        const afterDragParentId = await treeParentId(driver, dragIds.sourceId);
        const hierarchyTransaction = await driver.evaluate(`
          Object.fromEntries(
            performance.getEntriesByType('measure')
              .filter(entry => entry.name.startsWith('editor.hierarchy.'))
              .map(entry => [entry.name.slice('editor.hierarchy.'.length), entry.duration]),
          )
        `);

        const serializationStartedAt = Date.now();
        await driver.click('document.querySelector("#save-button")', {
          label: `${entityCount}-entity Save button`,
        });
        const savedPath = await waitForDownload(
          downloadDirectory,
          '.json',
          'saved large scene',
          serializationStartedAt,
          options.timeoutMs,
        );
        const savedScene = JSON.parse(readFileSync(savedPath, 'utf8'));
        const savedEntityCount = countSerializedEntities(savedScene.entities);
        if (savedEntityCount !== entityCount) {
          throw new Error(`Saved scene has ${savedEntityCount} entities; expected ${entityCount}.`);
        }
        const batchEditedEntityCount = countSerializedEntitiesMatching(
          savedScene.entities,
          entity => entity.components?.some(component =>
            component.type === 'CartesianTransform3D'
            && component.position?.[0] === 42.5),
        );
        if (batchEditedEntityCount !== selectedCount) {
          throw new Error(
            `Saved scene persisted ${batchEditedEntityCount} batch edits; expected ${selectedCount}.`,
          );
        }
        const resourceTrackedEntityCount = countSerializedEntitiesMatching(
          savedScene.entities,
          entity => entity.components?.some(component => component.type === 'Mesh3D'),
        );
        if (resourceTrackedEntityCount !== generated.rootCount) {
          throw new Error(
            `Saved scene has ${resourceTrackedEntityCount} Mesh3D resource users; expected ${generated.rootCount}.`,
          );
        }
        const serializationMs = Date.now() - serializationStartedAt;

        const exportStartedAt = Date.now();
        await driver.click('document.querySelector("#export-project-button")', {
          label: `${entityCount}-entity Export Project button`,
        });
        const exportedPath = await waitForDownload(
          downloadDirectory,
          '.zip',
          'exported large project',
          exportStartedAt,
          options.timeoutMs,
        );
        const exportedSceneCount = await countExportedRuntimeEntities(exportedPath);
        if (exportedSceneCount !== entityCount) {
          throw new Error(`Exported runtime scene has ${exportedSceneCount} entities; expected ${entityCount}.`);
        }
        const exportMs = Date.now() - exportStartedAt;

        const listenerCountBeforePlay = await readListenerCount(driver);
        const playStartedAt = Date.now();
        await driver.click('document.querySelector("#play-button")', {
          label: `${entityCount}-entity Play button`,
        });
        await waitForPlayerStarted(driver, entityCount, 1);
        const playStartupMs = Date.now() - playStartedAt;

        const restartStartedAt = Date.now();
        await driver.click('document.querySelector("#play-restart-button")', {
          label: `${entityCount}-entity Restart button`,
        });
        await waitForPlayerStarted(driver, entityCount, 2);
        const restartMs = Date.now() - restartStartedAt;
        const gpuOwnerResidual = await waitForOwnerResidual(driver);

        await driver.click('document.querySelector("#play-close-button")', {
          label: `${entityCount}-entity Stop/close button`,
        });
        await driver.waitFor(
          () => driver.evaluate(`
            (() => {
              const overlay = document.querySelector('#play-overlay');
              const frame = document.querySelector('#play-frame');
              return overlay?.hidden === true
                && frame?.srcdoc === ''
                && !frame?.contentDocument?.querySelector('#player-canvas');
            })()
          `),
          'player stop cleanup',
        );
        await driver.nextPaint();
        const listenerCountAfterStop = await readListenerCount(driver);
        const sceneReferenceResidual = await driver.evaluate(`
          (() => {
            const frame = document.querySelector('#play-frame');
            return frame?.srcdoc || frame?.contentDocument?.querySelector('#player-canvas') ? 1 : 0;
          })()
        `);

        const performanceMetrics = await driver.getPerformanceMetrics();
        const domSnapshot = await inspectDomNodes(driver);
        const longTasks = await driver.evaluate(
          'window.__editorE2ELongTasks?.slice() ?? []',
        );
        await driver.evaluate('window.__editorE2ELongTaskObserver?.disconnect()');
        driver.assertNoBrowserErrors();

        return {
          entityCount,
          generator: {
            sha256: generated.sha256,
            seed: generated.seed,
            branchSize: generated.branchSize,
            rootCount: generated.rootCount,
            bytes: Buffer.byteLength(generated.json),
          },
          workflow: {
            loadDurationMs,
            openSceneStages,
            selectedCount,
            batchEditedEntityCount,
            resourceTrackedEntityCount,
            drag: {
              sourceId: dragIds.sourceId,
              targetId: dragIds.targetId,
              beforeParentId: beforeDragParentId,
              afterParentId: afterDragParentId,
            },
            hierarchyTransaction,
            savedEntityCount,
            exportedSceneCount,
            serializationMs,
            serializationBytes: statSync(savedPath).size,
            exportMs,
            exportBytes: statSync(exportedPath).size,
            playStartupMs,
            restartMs,
          },
          metrics: {
            inputToPaint: summarizeSamples(interactionSamples),
            hierarchyDrag: summarizeSamples(
              interactionSamples.filter(sample => sample.label === 'tree.drag'),
            ),
            interactions: interactionSamples,
            longTasks: summarizeLongTasks(longTasks),
            domNodes: domSnapshot.total,
            domBreakdown: domSnapshot.shadowRoots,
            browserDomNodes: performanceMetrics.Nodes ?? null,
            heapBytes: performanceMetrics.JSHeapUsedSize ?? null,
          },
          lifecycle: {
            listenerResidual: listenerCountAfterStop - listenerCountBeforePlay,
            sceneReferenceResidual,
            gpuOwnerResidual,
          },
          environment: {
            url: driver.url,
            chromePath: driver.chrome,
            angleBackend: driver.angleBackend,
          },
        };
      },
    });
  } finally {
    rmSync(scenarioDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

async function treeParentId(driver, entityId) {
  return driver.evaluate(`
    (() => {
      const targetId = ${JSON.stringify(String(entityId))};
      const stack = (document.querySelector('#hierarchy-tree')?.data ?? [])
        .map(node => ({ node, parentId: null }));
      while (stack.length) {
        const item = stack.pop();
        if (!item) continue;
        if (item.node.id === targetId) return item.parentId;
        for (const child of item.node.children ?? []) {
          stack.push({ node: child, parentId: item.node.id });
        }
      }
      return '__missing__';
    })()
  `);
}

async function waitForPlayerStarted(driver, entityCount, minimumStarts) {
  await driver.waitFor(
    () => driver.evaluate(`
      (() => {
        const overlay = document.querySelector('#play-overlay');
        const output = document.querySelector('#play-output');
        const frame = document.querySelector('#play-frame');
        const starts = [...(output?.querySelectorAll('.play-output-line.lifecycle') ?? [])]
          .filter(line => line.textContent?.includes('started')).length;
        const runtimeError = output?.querySelector('.play-output-line.error')?.textContent ?? '';
        const metrics = document.querySelector('#play-performance')?.textContent ?? '';
        return overlay?.hidden === false
          && starts >= ${minimumStarts}
          && frame?.contentDocument?.querySelector('#player-canvas')
          && metrics.includes('Entities')
          && !runtimeError;
      })()
    `),
    `player start ${minimumStarts} for ${entityCount} entities`,
  );
}

async function waitForOwnerResidual(driver) {
  const encodedResidual = await driver.waitFor(
    () => driver.evaluate(`
      (() => {
        const metrics = [...(document.querySelectorAll('#play-performance .play-debug-metric') ?? [])];
        const row = metrics.find(metric => metric.querySelector('small')?.textContent === 'Owner residuals');
        const value = row?.querySelector('strong')?.textContent ?? '';
        return /^\\d+$/.test(value) ? Number(value) + 1 : 0;
      })()
    `),
    'runtime GPU owner residual metric',
  );
  return encodedResidual - 1;
}

async function readListenerCount(driver) {
  return driver.evaluate(
    'typeof window.__editorE2EListenerCount === "function" ? window.__editorE2EListenerCount() : 0',
  );
}

async function inspectDomNodes(driver) {
  return driver.evaluate(`
    (() => {
      let count = 0;
      const shadowRoots = [];
      const visit = root => {
        const elements = root.querySelectorAll?.('*') ?? [];
        count += elements.length;
        for (const element of elements) {
          if (!element.shadowRoot) continue;
          const shadowNodeCount = element.shadowRoot.querySelectorAll('*').length;
          shadowRoots.push({
            host: element.tagName.toLocaleLowerCase(),
            id: element.id || null,
            nodes: shadowNodeCount,
          });
          visit(element.shadowRoot);
        }
      };
      visit(document);
      shadowRoots.sort((left, right) => right.nodes - left.nodes);
      return { total: count, shadowRoots: shadowRoots.slice(0, 12) };
    })()
  `);
}

function summarizeSamples(samples) {
  const values = samples.map(sample => sample.durationMs).sort((a, b) => a - b);
  return {
    sampleCount: values.length,
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
    maxMs: values[values.length - 1] ?? 0,
  };
}

function settleInteraction(driver) {
  return driver.evaluate(`
    new Promise(resolve => setTimeout(resolve, ${HIERARCHY_DRAG_SETTLE_MS}))
  `);
}

function summarizeLongTasks(entries) {
  const durations = entries.map(entry => entry.duration).sort((a, b) => a - b);
  return {
    count: durations.length,
    totalMs: durations.reduce((sum, value) => sum + value, 0),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations[durations.length - 1] ?? 0,
    entries,
  };
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
  return sortedValues[index] ?? 0;
}

function summarizeDomScaling(counts) {
  const one = counts[1000];
  const ten = counts[10000];
  if (!one || !ten) return null;
  return {
    entityRatio: 10,
    nodeRatio: one.metrics.domNodes > 0
      ? ten.metrics.domNodes / one.metrics.domNodes
      : null,
    sublinear: ten.metrics.domNodes < one.metrics.domNodes * 2,
  };
}

function compareWithBaseline(counts, path) {
  if (!existsSync(path) || resolve(path) === artifactPath) return null;
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  const comparison = {};
  for (const entityCount of options.counts) {
    const before = baseline.counts?.[entityCount]?.metrics?.inputToPaint?.p95Ms;
    const after = counts[entityCount]?.metrics?.inputToPaint?.p95Ms;
    if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) continue;
    comparison[entityCount] = {
      beforeP95Ms: before,
      afterP95Ms: after,
      improvement: (before - after) / before,
    };
  }
  return Object.keys(comparison).length > 0 ? comparison : null;
}

function evaluateGate(report) {
  const failures = [];
  const performanceFailures = [];
  for (const entityCount of options.counts) {
    const entry = report.counts[entityCount];
    const budget = EDITOR_LARGE_SCENE_BUDGETS[entityCount];
    if (!entry || !budget) {
      failures.push(`${entityCount}: missing result or budget`);
      continue;
    }
    const p95 = entry.metrics.inputToPaint.p95Ms;
    const hierarchyDragP95 = entry.metrics.hierarchyDrag.p95Ms;
    if (p95 > budget.interactionP95Ms) {
      performanceFailures.push(`${entityCount}: interaction P95 ${p95.toFixed(1)}ms`);
    }
    if (hierarchyDragP95 > HIERARCHY_DRAG_P95_MS) {
      performanceFailures.push(`${entityCount}: hierarchy drag P95 ${hierarchyDragP95.toFixed(1)}ms`);
    }
    if (entry.metrics.longTasks.count > budget.maxLongTaskCount) {
      performanceFailures.push(`${entityCount}: long task count ${entry.metrics.longTasks.count}`);
    }
    if (entry.metrics.longTasks.maxMs > budget.maxLongTaskMs) {
      performanceFailures.push(`${entityCount}: long task ${entry.metrics.longTasks.maxMs.toFixed(1)}ms`);
    }
    if (entry.metrics.domNodes > budget.domNodes) {
      failures.push(`${entityCount}: DOM nodes ${entry.metrics.domNodes}`);
    }
    if (entry.metrics.heapBytes !== null && entry.metrics.heapBytes > budget.heapBytes) {
      failures.push(`${entityCount}: heap ${entry.metrics.heapBytes}`);
    }
    if (entry.workflow.loadDurationMs > budget.loadMs) {
      performanceFailures.push(`${entityCount}: scene load ${entry.workflow.loadDurationMs}ms`);
    }
    const openStages = entry.workflow.openSceneStages;
    if (!openStages) {
      failures.push(`${entityCount}: missing open-scene stage measures`);
    } else {
      if (openStages['prepare-entities'] > budget.prepareEntitiesMs) {
        performanceFailures.push(`${entityCount}: prepare entities ${openStages['prepare-entities'].toFixed(1)}ms`);
      }
      if (openStages.commit > budget.commitMs) {
        performanceFailures.push(`${entityCount}: open commit ${openStages.commit.toFixed(1)}ms`);
      }
    }
    if (entry.workflow.serializationMs > budget.serializationMs) {
      performanceFailures.push(`${entityCount}: serialization ${entry.workflow.serializationMs}ms`);
    }
    if (entry.workflow.exportMs > budget.exportMs) {
      performanceFailures.push(`${entityCount}: export ${entry.workflow.exportMs}ms`);
    }
    if (entry.workflow.playStartupMs > budget.playStartupMs) {
      performanceFailures.push(`${entityCount}: play startup ${entry.workflow.playStartupMs}ms`);
    }
    if (entry.workflow.restartMs > budget.restartMs) {
      performanceFailures.push(`${entityCount}: play restart ${entry.workflow.restartMs}ms`);
    }
    for (const [name, value] of Object.entries(entry.lifecycle)) {
      if (value !== 0) failures.push(`${entityCount}: ${name}=${value}`);
    }
  }
  if (report.domScaling && !report.domScaling.sublinear) {
    failures.push(`DOM node ratio ${report.domScaling.nodeRatio.toFixed(2)} is not sublinear`);
  }
  const passed = failures.length === 0;
  const performancePassed = performanceFailures.length === 0;
  return {
    passed,
    failures,
    performancePassed,
    performanceFailures,
    enforcedPassed: passed && (!options.enforcePerformance || performancePassed),
  };
}

async function waitForDownload(directory, extension, label, startedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastCandidate = null;
  let lastSize = -1;
  while (Date.now() < deadline) {
    const candidates = readdirSync(directory)
      .filter(name => extname(name).toLowerCase() === extension && !name.endsWith('.crdownload'))
      .map(name => resolve(directory, name))
      .filter(path => statSync(path).mtimeMs >= startedAt - 1000)
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

function countSerializedEntities(entities) {
  let count = 0;
  const stack = [...(entities ?? [])];
  while (stack.length) {
    const entity = stack.pop();
    if (!entity) continue;
    count++;
    stack.push(...(entity.children ?? []));
  }
  return count;
}

function countSerializedEntitiesMatching(entities, predicate) {
  let count = 0;
  const stack = [...(entities ?? [])];
  while (stack.length) {
    const entity = stack.pop();
    if (!entity) continue;
    if (predicate(entity)) count++;
    stack.push(...(entity.children ?? []));
  }
  return count;
}

async function countExportedRuntimeEntities(path) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const scenePath = Object.keys(zip.files).find(name => name.endsWith('/src/scene.runtime.json'));
  if (!scenePath) throw new Error('Exported runtime project is missing src/scene.runtime.json.');
  const scene = JSON.parse(await zip.file(scenePath).async('string'));
  return countSerializedEntities(scene.entities);
}

function parseArguments(argv) {
  const parsed = {
    phase: 'after',
    counts: [1000, 10000],
    output: null,
    baseline: null,
    reportOnly: false,
    enforcePerformance: process.env.EDITOR_ENFORCE_LARGE_SCENE_PERFORMANCE_BUDGETS === '1',
    timeoutMs: 180_000,
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--phase') parsed.phase = argv[++index] ?? parsed.phase;
    else if (value === '--counts') {
      parsed.counts = (argv[++index] ?? '')
        .split(',')
        .map(Number)
        .filter(count => count === 1000 || count === 10000);
    } else if (value === '--output') parsed.output = argv[++index] ?? null;
    else if (value === '--baseline') parsed.baseline = argv[++index] ?? null;
    else if (value === '--report-only') parsed.reportOnly = true;
    else if (value === '--enforce-performance') parsed.enforcePerformance = true;
    else if (value === '--timeout-ms') parsed.timeoutMs = Number(argv[++index]);
  }
  if (parsed.phase !== 'before' && parsed.phase !== 'after') {
    throw new RangeError(`Unsupported phase "${parsed.phase}".`);
  }
  if (parsed.counts.length === 0) throw new RangeError('At least one of 1000 or 10000 entities is required.');
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be positive and finite.');
  }
  return parsed;
}

function serializeError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'Error', message: String(error) };
}

function writeArtifact() {
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`);
}
