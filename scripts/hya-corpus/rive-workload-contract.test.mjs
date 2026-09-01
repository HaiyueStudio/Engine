import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateRiveWorkloadPlan,
  validateRiveWorkloadScenario,
} from './rive-workload-contract.mjs';
import { createRiveFullWorkloadScenario } from './rive-workload-scenario-builder.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const plan = JSON.parse(readFileSync(resolve(root, 'animation-spec/corpus/rive/rive-g11-workload-plan.json'), 'utf8'));
const HASH = 'a'.repeat(64);

function validScenario() {
  return createRiveFullWorkloadScenario(plan, {
    id: 'fixture-full-scenario', assetId: 'fixture', rivSha256: HASH,
    selection: { artboard: 'Main', animation: 'Idle', stateMachine: 'Machine' },
    initialData: {}, initialResources: [], probe: {
      dataMutation: { operation: 'set', path: 'hud.health', value: 75 },
      pointer: { x: 32, y: 48, deltaX: 1, deltaY: 0, pointerId: 1, buttons: 1 },
      keyboard: { code: 'Enter', key: 'Enter' }, gamepad: { index: 0, axes: [0, 0], buttons: [1] },
      focusTarget: 'primary-control', semanticTarget: 'primary-control',
      resource: { resourceId: 'hero', missingResourceId: 'missing', expectedSha256: HASH, invalidSha256: 'b'.repeat(64), appliedRevision: 'hero-r2', missingRevision: 'missing-r1', integrityRevision: 'hero-bad' },
    },
  });
}

test('checked-in Rive workload plan freezes the full device, action, lifecycle and metric population', () => {
  const result = validateRiveWorkloadPlan(plan);
  assert.equal(result.status, 'passed', result.violations.join('\n'));
});

test('full scenario binds every observable channel to an ordered action stream', () => {
  const result = validateRiveWorkloadScenario(validScenario(), plan, { expectedAssetId: 'fixture', expectedRivSha256: HASH });
  assert.equal(result.status, 'passed', result.violations.join('\n'));
});

test('a static official artboard records an explicit null animation selection', () => {
  const scenario = validScenario();
  scenario.selection.animation = null;
  const result = validateRiveWorkloadScenario(scenario, plan, { expectedAssetId: 'fixture', expectedRivSha256: HASH });
  assert.equal(result.status, 'passed', result.violations.join('\n'));
});

test('Eight Planets workload observes hover before any pointer button is pressed', () => {
  const scenario = JSON.parse(readFileSync(resolve(root, 'animation-spec/corpus/rive/workloads/official-eight-planets-grid.json'), 'utf8'));
  const enter = scenario.actions.find(action => action.id === 'action-pointer-enter');
  const down = scenario.actions.find(action => action.id === 'action-pointer-down');
  assert.deepEqual({ phase: enter?.payload.phase, buttons: enter?.payload.buttons }, { phase: 'move', buttons: 0 });
  assert.ok(enter.atMicros < down.atMicros);
  assert.ok(enter.expectedChannels.includes('stateMachineState'));
  assert.ok(enter.expectedChannels.includes('pixels'));
});

test('scenario cannot hide a missing input channel or lifecycle path', () => {
  const scenario = validScenario();
  scenario.actions = scenario.actions.filter(action => action.kind !== 'gamepad');
  scenario.lifecyclePaths = scenario.lifecyclePaths.filter(value => value !== 'device-loss');
  const result = validateRiveWorkloadScenario(scenario, plan);
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('missing action kind gamepad')));
  assert.ok(result.violations.some(value => value.includes('lifecycle paths')));
});

test('scenario timestamps must use the frozen integer-microsecond clock', () => {
  const scenario = validScenario();
  scenario.clockStepsMicros[4] = scenario.clockStepsMicros[3];
  const result = validateRiveWorkloadScenario(scenario, plan);
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('strictly increasing')));
});

test('scenario cannot claim action coverage with empty or ambiguous payloads', () => {
  const scenario = validScenario();
  scenario.actions.find(action => action.kind === 'pointer').payload = {};
  scenario.actions.find(action => action.kind === 'resource-replacement').payload.replacementSha256 = 'b'.repeat(64);
  const result = validateRiveWorkloadScenario(scenario, plan);
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('payload fields')));
  assert.ok(result.violations.some(value => value.includes('applied hashes must match')));
  assert.ok(result.violations.some(value => value.includes('pointer phase coverage')));
});
