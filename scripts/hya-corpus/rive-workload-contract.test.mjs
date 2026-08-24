import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  riveWorkloadActionKinds,
  riveWorkloadLifecyclePaths,
  riveWorkloadTraceChannels,
  validateRiveWorkloadPlan,
  validateRiveWorkloadScenario,
} from './rive-workload-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const plan = JSON.parse(readFileSync(resolve(root, 'animation-spec/corpus/rive/rive-g11-workload-plan.json'), 'utf8'));
const HASH = 'a'.repeat(64);

function validScenario() {
  const steps = Array.from({ length: 17 }, (_, index) => index * 125_000);
  const channels = riveWorkloadTraceChannels();
  const actions = riveWorkloadActionKinds().map((kind, index) => ({
    id: `action-${index}`,
    kind,
    atMicros: steps[index],
    payload: {},
    expectedChannels: index === 0 ? channels : [channels[index % channels.length]],
  }));
  return {
    schemaVersion: 1,
    kind: 'haiyue-rive-workload-scenario',
    id: 'fixture-full-scenario',
    assetId: 'fixture',
    rivSha256: HASH,
    compatibilityTupleId: 'rive-7.3-webgl2-2.40.0',
    selection: { artboard: 'Main', animation: 'Idle', stateMachine: 'Machine' },
    initialData: {},
    initialResources: [],
    clockStepsMicros: steps,
    actions,
    lifecyclePaths: riveWorkloadLifecyclePaths(),
    replayCount: 2,
  };
}

test('checked-in Rive workload plan freezes the full device, action, lifecycle and metric population', () => {
  const result = validateRiveWorkloadPlan(plan);
  assert.equal(result.status, 'passed', result.violations.join('\n'));
});

test('full scenario binds every observable channel to an ordered action stream', () => {
  const result = validateRiveWorkloadScenario(validScenario(), plan, { expectedAssetId: 'fixture', expectedRivSha256: HASH });
  assert.equal(result.status, 'passed', result.violations.join('\n'));
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
