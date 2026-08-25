import { validateRiveWorkloadScenario } from './rive-workload-contract.mjs';

/**
 * Builds the frozen full G11 action stream from asset-specific probe identities.
 * The caller must bind real data/resource/semantic targets; this helper has no
 * synthetic defaults that could accidentally enter formal evidence.
 */
export function createRiveFullWorkloadScenario(plan, options) {
  const probe = options?.probe;
  if (!probe || typeof probe !== 'object') throw new TypeError('A concrete asset probe is required.');
  const steps = Array.from({ length: 17 }, (_, index) => index * 125_000);
  const allChannels = [...plan.requiredTraceChannels];
  const modifiers = Object.freeze({ alt: false, ctrl: false, meta: false, shift: false });
  const pointer = probe.pointer;
  const gamepad = probe.gamepad;
  const resource = probe.resource;
  const actions = [
    action('initialize', 'initialize', 0, { viewportId: plan.viewportMatrix[0]?.id, reducedMotion: false }, allChannels),
    ...plan.viewportMatrix.slice(1).map((viewport, index) => action(`resize-${viewport.id}`, 'resize', 1 + index, { viewportId: viewport.id }, ['resizeAndDpr'])),
    action('seek', 'seek', 3, { timeMicros: steps[12] }, ['pixels', 'geometryAndDrawOrder', 'stateMachineState', 'events', 'audioSchedule']),
    action('data', 'data-mutation', 4, { ...probe.dataMutation }, ['dataValues']),
    ...plan.actionCoverage.pointerPhases.map((phase, index) => action(`pointer-${phase}`, 'pointer', 5 + index, {
      phase, x: pointer.x + index * pointer.deltaX, y: pointer.y + index * pointer.deltaY,
      pointerId: pointer.pointerId, buttons: phase === 'down' || phase === 'move' ? pointer.buttons : 0,
    }, ['pointerKeyboardGamepadFocus'])),
    ...plan.actionCoverage.keyboardPhases.map((phase, index) => action(`keyboard-${phase}`, 'keyboard', 9 + index, {
      phase, code: probe.keyboard.code, key: probe.keyboard.key, repeat: false, modifiers,
    }, ['pointerKeyboardGamepadFocus'])),
    ...plan.actionCoverage.gamepadOperations.map((operation, index) => action(`gamepad-${operation}`, 'gamepad', 11 + index, {
      operation, index: gamepad.index, axes: [...gamepad.axes], buttons: operation === 'sample' ? [...gamepad.buttons] : gamepad.buttons.map(() => 0),
    }, ['pointerKeyboardGamepadFocus'])),
    ...plan.actionCoverage.focusOperations.map(operation => action(`focus-${operation}`, 'focus', 14,
      operation === 'request' ? { operation, target: probe.focusTarget } : { operation }, ['pointerKeyboardGamepadFocus'])),
    action('resource-applied', 'resource-replacement', 14, {
      resourceId: resource.resourceId, outcome: 'applied', expectedSha256: resource.expectedSha256,
      replacementSha256: resource.expectedSha256, revision: resource.appliedRevision,
    }, ['resourceReplacement']),
    action('resource-missing', 'resource-replacement', 15, {
      resourceId: resource.missingResourceId, outcome: 'missing', expectedSha256: resource.expectedSha256,
      replacementSha256: null, revision: resource.missingRevision,
    }, ['resourceReplacement']),
    action('resource-integrity', 'resource-replacement', 15, {
      resourceId: resource.resourceId, outcome: 'integrity-failure', expectedSha256: resource.expectedSha256,
      replacementSha256: resource.invalidSha256, revision: resource.integrityRevision,
    }, ['resourceReplacement']),
    ...plan.actionCoverage.semanticActions.map(name => action(`semantic-${name}`, 'semantic-action', 15, {
      target: probe.semanticTarget, action: name,
    }, ['semanticTreeAndActions'])),
    action('reduced-motion', 'reduced-motion', 16, { enabled: true }, ['semanticTreeAndActions']),
  ];
  const scenario = {
    schemaVersion: 1,
    kind: 'haiyue-rive-workload-scenario',
    id: options.id,
    assetId: options.assetId,
    rivSha256: options.rivSha256,
    compatibilityTupleId: plan.compatibilityTupleId,
    selection: { ...options.selection },
    initialData: structuredClone(options.initialData ?? {}),
    initialResources: structuredClone(options.initialResources ?? []),
    clockStepsMicros: steps,
    actions,
    lifecyclePaths: [...plan.requiredLifecyclePaths],
    replayCount: plan.clock.replayCount,
  };
  const validation = validateRiveWorkloadScenario(scenario, plan, { expectedAssetId: options.assetId, expectedRivSha256: options.rivSha256 });
  if (validation.status !== 'passed') throw new Error(`Cannot build Rive workload scenario:\n${validation.violations.join('\n')}`);
  return scenario;

  function action(id, kind, step, payload, expectedChannels) {
    return { id: `action-${id}`, kind, atMicros: steps[step], payload, expectedChannels };
  }
}
