const DECISIONS = new Set(['hold', 'prototype-approved']);
const CLIPPING_FEATURES = Object.freeze(['caps', 'instanced', 'line', 'planarMirror']);

export function evaluateCapabilityAdmissionPolicy(policy, inputs = {}) {
  validatePolicy(policy);
  const rayTracing = evaluateRayTracing(policy.rayTracing, inputs.rayTracing);
  const clippingExtensions = Object.fromEntries(CLIPPING_FEATURES.map(feature => [
    feature,
    evaluateClippingExtension(
      feature,
      policy.clippingExtensions[feature],
      inputs.clippingExtensions?.[feature],
    ),
  ]));
  const webgl2Fallback = evaluateWebGl2Fallback(policy.webgl2Fallback, inputs.webgl2Fallback);
  const layeredNavMesh = evaluateLayeredNavMesh(policy.layeredNavMesh, inputs.layeredNavMesh);
  const violations = [
    ...decisionMismatch('rayTracing', policy.rayTracing.decision, rayTracing),
    ...decisionMismatch('webgl2Fallback', policy.webgl2Fallback.decision, webgl2Fallback),
    ...decisionMismatch('layeredNavMesh', policy.layeredNavMesh.decision, layeredNavMesh),
    ...CLIPPING_FEATURES.flatMap(feature => decisionMismatch(
      `clippingExtensions.${feature}`,
      policy.clippingExtensions[feature].decision,
      clippingExtensions[feature],
    )),
  ];
  return {
    schemaVersion: 1,
    rayTracing,
    webgl2Fallback,
    layeredNavMesh,
    clippingExtensions,
    violations,
  };
}

function evaluateRayTracing(policy, evidence) {
  const reasons = [];
  if (evidence?.format !== 'haiyue-ray-tracing-product-decision@1') {
    reasons.push('ray-tracing-product-requirement-missing');
  } else {
    requireText(evidence.productRequirementId, 'product-requirement-id-missing', reasons);
    requireSha256(evidence.contentManifestSha256, 'content-manifest-provenance-missing', reasons);
    const cases = Array.isArray(evidence.cases) ? evidence.cases : [];
    const casesByEffect = new Map();
    const requiredEffectIds = new Set(policy.requiredEffectIds);
    for (const productCase of cases) {
      if (!nonEmpty(productCase?.effectId)) continue;
      if (!requiredEffectIds.has(productCase.effectId)) {
        reasons.push(`unexpected-effect-case:${productCase.effectId}`);
        continue;
      }
      if (casesByEffect.has(productCase.effectId)) {
        reasons.push(`duplicate-effect-case:${productCase.effectId}`);
        continue;
      }
      casesByEffect.set(productCase.effectId, productCase);
    }
    for (const effectId of policy.requiredEffectIds) {
      const productCase = casesByEffect.get(effectId);
      if (!productCase) {
        reasons.push(`required-effect-case-missing:${effectId}`);
        continue;
      }
      validateRayTracingCase(effectId, policy, productCase, reasons);
    }
    classifyFailures(evidence, reasons);
  }
  return decisionResult(evidence, reasons);
}

function validateRayTracingCase(effectId, policy, productCase, reasons) {
  requireText(productCase.sourceProduct, `source-product-missing:${effectId}`, reasons);
  requireCommitSha(productCase.sourceRevision?.commitSha, `source-commit-missing:${effectId}`, reasons);
  if (productCase.sourceRevision?.dirty !== false) reasons.push(`source-revision-not-clean:${effectId}`);
  requireText(productCase.fixedSceneId, `fixed-scene-missing:${effectId}`, reasons);
  requireText(productCase.fixedCameraReplayId, `fixed-camera-replay-missing:${effectId}`, reasons);
  requireSha256(productCase.sceneSha256, `scene-provenance-missing:${effectId}`, reasons);
  requireSha256(productCase.baselineImageSha256, `baseline-image-missing:${effectId}`, reasons);
  requireSha256(productCase.referenceImageSha256, `reference-image-missing:${effectId}`, reasons);
  if (productCase.baselineImageSha256 === productCase.referenceImageSha256) {
    reasons.push(`reference-does-not-demonstrate-deficit:${effectId}`);
  }
  if (!policy.acceptedReferenceKinds.includes(productCase.referenceKind)) {
    reasons.push(`unsupported-reference-kind:${effectId}`);
  }
  if (productCase.baselineDeficit?.currentPathFailed !== true) {
    reasons.push(`current-render-path-deficit-not-proven:${effectId}`);
  }
  if (!policy.acceptedDeficitKinds[effectId].includes(productCase.baselineDeficit?.kind)) {
    reasons.push(`unsupported-deficit-kind:${effectId}`);
  }
  if (uniqueStrings(productCase.deviceClasses).length < policy.minimumDeviceClassCount) {
    reasons.push(`insufficient-device-classes:${effectId}`);
  }
  requireText(productCase.capture?.browser, `capture-browser-missing:${effectId}`, reasons);
  requireText(productCase.capture?.browserVersion, `capture-browser-version-missing:${effectId}`, reasons);
  requireText(productCase.capture?.backend, `capture-backend-missing:${effectId}`, reasons);
  requireText(productCase.capture?.adapterName, `capture-adapter-missing:${effectId}`, reasons);
  if (productCase.capture?.softwareAdapter !== false) reasons.push(`real-hardware-adapter-not-proven:${effectId}`);
}

function evaluateWebGl2Fallback(policy, evidence) {
  const reasons = [];
  if (evidence?.format !== 'haiyue-webgl2-product-decision@1') {
    reasons.push('product-coverage-requirement-missing');
  } else {
    requireText(evidence.productRequirementId, 'product-requirement-id-missing', reasons);
    requireText(evidence.sourceProduct, 'source-product-missing', reasons);
    if (evidence.baselineDeficit?.webGpuOnlyBlocksRelease !== true) {
      reasons.push('webgpu-only-release-deficit-not-proven');
    }
    const telemetryDemand = evidence.demand?.telemetryWindowDays >= policy.minimumTelemetryWindowDays
      && evidence.demand?.measuredSessions >= policy.minimumMeasuredSessions
      && evidence.demand?.webGpuUnavailableSessionRatio >= policy.minimumUnavailableSessionRatio;
    const mandatedDemand = uniqueStrings(evidence.demand?.mandatedTargetIds).length > 0;
    if (!telemetryDemand && !mandatedDemand) reasons.push('target-coverage-demand-not-proven');
    if (uniqueStrings(evidence.representativeSceneIds).length < policy.minimumRepresentativeSceneCount) {
      reasons.push('insufficient-representative-scenes');
    }
    if (uniqueStrings(evidence.fixedReplayIds).length < policy.minimumRepresentativeSceneCount) {
      reasons.push('fixed-replays-missing');
    }
    if (uniqueStrings(evidence.deviceClasses).length < policy.minimumDeviceClassCount) {
      reasons.push('insufficient-device-classes');
    }
    const parityAreas = new Set(uniqueStrings(evidence.requiredParityAreas));
    if (policy.requiredParityAreas.some(area => !parityAreas.has(area))) {
      reasons.push('minimum-parity-scope-missing');
    }
    requireSha256(evidence.contentManifestSha256, 'content-manifest-provenance-missing', reasons);
    classifyFailures(evidence, reasons);
  }
  return decisionResult(evidence, reasons);
}

function evaluateLayeredNavMesh(policy, evidence) {
  const reasons = [];
  if (evidence?.format !== 'haiyue-layered-navmesh-product-decision@1') {
    reasons.push('layered-navigation-requirement-missing');
  } else {
    requireText(evidence.contentRequirementId, 'content-requirement-id-missing', reasons);
    requireText(evidence.sourceGame, 'source-game-missing', reasons);
    requireText(evidence.fixedRouteReplayId, 'fixed-route-replay-missing', reasons);
    requireSha256(evidence.sceneSha256, 'scene-provenance-missing', reasons);
    if (!policy.acceptedTopologyKinds.includes(evidence.topologyKind)) {
      reasons.push('overlapping-topology-not-proven');
    }
    if (evidence.maximumSurfaceCountAtSameXZ < policy.minimumOverlappingSurfaceCount) {
      reasons.push('overlapping-surface-count-too-low');
    }
    if (evidence.heightfieldBaseline?.unsupportedRouteObserved !== true) {
      reasons.push('heightfield-deficit-not-proven');
    }
    if (uniqueStrings(evidence.deviceClasses).length < policy.minimumDeviceClassCount) {
      reasons.push('insufficient-device-classes');
    }
    classifyFailures(evidence, reasons);
  }
  return decisionResult(evidence, reasons);
}

function evaluateClippingExtension(feature, policy, evidence) {
  const reasons = [];
  if (evidence?.format !== 'haiyue-clipping-extension-decision@1' || evidence?.feature !== feature) {
    reasons.push('clipping-product-requirement-missing');
  } else {
    requireText(evidence.contentRequirementId, 'content-requirement-id-missing', reasons);
    requireText(evidence.sourceProject, 'source-project-missing', reasons);
    requireText(evidence.fixedCameraReplayId, 'fixed-camera-replay-missing', reasons);
    requireSha256(evidence.sceneSha256, 'scene-provenance-missing', reasons);
    requireSha256(evidence.referenceImageSha256, 'reference-image-missing', reasons);
    if (!policy.acceptedUseCases.includes(evidence.useCase)) reasons.push('real-use-case-not-proven');
    if (evidence.baselineDeficit?.currentPathFailed !== true) {
      reasons.push('current-clipping-path-deficit-not-proven');
    }
    if (!(evidence[policy.workloadMetric] >= policy.minimumWorkload)) {
      reasons.push(`${policy.workloadMetric}-below-minimum`);
    }
    if (uniqueStrings(evidence.deviceClasses).length < policy.minimumDeviceClassCount) {
      reasons.push('insufficient-device-classes');
    }
    classifyFailures(evidence, reasons);
  }
  return decisionResult(evidence, reasons);
}

function decisionResult(evidence, reasons) {
  return {
    status: reasons.length === 0 ? 'eligible-for-prototype' : 'hold',
    evidencePresent: evidence != null,
    reasons,
  };
}

function decisionMismatch(capability, configured, evaluated) {
  if (configured === 'hold' && evaluated.status === 'hold') return [];
  if (configured === 'prototype-approved' && evaluated.status === 'eligible-for-prototype') return [];
  return [`${capability} decision ${configured} does not match evaluated status ${evaluated.status}.`];
}

function validatePolicy(policy) {
  if (!policy || policy.schemaVersion !== 1) {
    throw new Error('Capability admission policy must use schemaVersion 1.');
  }
  validateEntry('webgl2Fallback', policy.webgl2Fallback);
  validateEntry('layeredNavMesh', policy.layeredNavMesh);
  for (const feature of CLIPPING_FEATURES) {
    const entry = policy.clippingExtensions?.[feature];
    validateEntry(`clippingExtensions.${feature}`, entry);
    if (!nonEmpty(entry.workloadMetric) || !(entry.minimumWorkload > 0)) {
      throw new Error(`clippingExtensions.${feature} must declare a positive workload threshold.`);
    }
    if (uniqueStrings(entry.acceptedUseCases).length === 0) {
      throw new Error(`clippingExtensions.${feature} must declare accepted use cases.`);
    }
  }
  validateEntry('rayTracing', policy.rayTracing);
  if (!(policy.rayTracing.minimumDeviceClassCount > 0)) {
    throw new Error('rayTracing must declare a positive device-class threshold.');
  }
  const requiredEffectIds = uniqueStrings(policy.rayTracing.requiredEffectIds);
  if (requiredEffectIds.length === 0
      || !Array.isArray(policy.rayTracing.requiredEffectIds)
      || requiredEffectIds.length !== policy.rayTracing.requiredEffectIds.length) {
    throw new Error('rayTracing requiredEffectIds must be unique non-empty strings.');
  }
  if (uniqueStrings(policy.rayTracing.acceptedReferenceKinds).length === 0) {
    throw new Error('rayTracing must declare accepted reference kinds.');
  }
  for (const effectId of requiredEffectIds) {
    if (uniqueStrings(policy.rayTracing.acceptedDeficitKinds?.[effectId]).length === 0) {
      throw new Error(`rayTracing ${effectId} must declare accepted deficit kinds.`);
    }
  }
}

function validateEntry(name, entry) {
  if (!entry || !DECISIONS.has(entry.decision)) {
    throw new Error(`${name} must declare hold or prototype-approved.`);
  }
  if (!nonEmpty(entry.evidencePath)) throw new Error(`${name} must declare an evidencePath.`);
}

function classifyFailures(evidence, reasons) {
  if (evidence.unclassifiedFailureCount !== 0) reasons.push('unclassified-failures-remain');
}

function requireText(value, reason, reasons) {
  if (!nonEmpty(value)) reasons.push(reason);
}

function requireSha256(value, reason, reasons) {
  if (!/^sha256:[a-f\d]{64}$/i.test(value ?? '')) reasons.push(reason);
}

function requireCommitSha(value, reason, reasons) {
  if (!/^[a-f\d]{40}$/i.test(value ?? '')) reasons.push(reason);
}

function uniqueStrings(value) {
  return [...new Set(Array.isArray(value) ? value.filter(nonEmpty) : [])];
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
