const scenarioId = process.argv[2];
const parameters = JSON.parse(process.argv[3] ?? '{}');
if (typeof global.gc !== 'function') throw new Error('Editor memory scenarios require Node --expose-gc.');

const editor = await import('../editor/dist-test/testing.js');
const scenario = await runScenario(scenarioId, parameters, editor);
process.stdout.write(`${JSON.stringify(scenario)}\n`);

async function runScenario(id, scenarioParameters, runtime) {
  forceGc();
  const baseline = memorySnapshot();
  const result = id === 'entities-50k'
    ? runEntityScenario(scenarioParameters, runtime)
    : id === 'long-edit'
      ? runLongEditScenario(scenarioParameters, runtime)
      : id === 'resource-replacement'
        ? runResourceReplacementScenario(scenarioParameters, runtime)
        : null;
  if (!result) throw new Error(`Unknown editor memory scenario: ${id}`);
  forceGc();
  const peak = memorySnapshot();
  result.release();
  forceGc();
  const cleanup = memorySnapshot();
  return {
    id,
    parameters: scenarioParameters,
    observed: result.observed,
    metrics: {
      heapDeltaBytes: positiveDelta(peak.heapUsed, baseline.heapUsed),
      arrayBufferDeltaBytes: positiveDelta(peak.arrayBuffers, baseline.arrayBuffers),
      rssDeltaBytes: positiveDelta(peak.rss, baseline.rss),
      cleanupHeapResidualBytes: positiveDelta(cleanup.heapUsed, baseline.heapUsed),
      cleanupArrayBufferResidualBytes: positiveDelta(cleanup.arrayBuffers, baseline.arrayBuffers),
    },
  };
}

function runEntityScenario(parameters, { Entity, World }) {
  let world = new World('MemoryBudget50k');
  for (let index = 0; index < parameters.entityCount; index++) {
    world.addEntity(new Entity(`Entity ${index}`));
  }
  const observed = { entityCount: world.entities.size };
  return {
    observed,
    release() {
      world.destroy();
      world = null;
    },
  };
}

function runLongEditScenario(parameters, { CommandBus }) {
  let state = 0;
  let commandBus = new CommandBus(() => {});
  for (let index = 0; index < parameters.operationCount; index++) {
    const payload = new Uint8Array(parameters.payloadBytes);
    payload[0] = index & 255;
    commandBus.execute({
      label: `Edit ${index}`,
      execute: () => { state = index + payload[0]; },
      undo: () => { state = index - 1; },
    });
  }
  let retainedUndoCommands = 0;
  while (commandBus.canUndo) {
    commandBus.undo();
    retainedUndoCommands++;
  }
  while (commandBus.canRedo) commandBus.redo();
  return {
    observed: { retainedUndoCommands, finalState: state },
    release() {
      commandBus = null;
    },
  };
}

function runResourceReplacementScenario(parameters, { ResourcePool }) {
  let resourcePool = new ResourcePool({
    getResourceName: (_resource, fallback) => fallback,
    getPrefabId: () => null,
  });
  const suffix = 'x'.repeat(parameters.payloadCharacters);
  let latest = '';
  for (let index = 0; index < parameters.replacementCount; index++) {
    latest = `memory://model/${index}/${suffix}`;
    resourcePool.registerModel(latest, { id: 1, name: 'Replaceable model' });
  }
  const retained = resourcePool.models.get(1);
  return {
    observed: {
      retainedModels: resourcePool.models.size,
      latestResourceRetained: retained?.src === latest,
    },
    release() {
      resourcePool = null;
      latest = '';
    },
  };
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    heapUsed: memory.heapUsed,
    arrayBuffers: memory.arrayBuffers,
    rss: memory.rss,
  };
}

function forceGc() {
  for (let index = 0; index < 4; index++) global.gc();
}

function positiveDelta(value, baseline) {
  return Math.max(0, value - baseline);
}
