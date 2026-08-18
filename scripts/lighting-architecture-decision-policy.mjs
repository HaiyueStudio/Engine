export function evaluateLightingArchitectureDecision(policy, inputs) {
  validatePolicy(policy);
  const forwardPlus = evaluateForwardPlus(policy.forwardPlus, inputs.lightingScaling, inputs.forwardPlusEvidence);
  const csm = evaluateCsm(policy.csm, inputs.csmEvidence);
  return {
    schemaVersion: 1,
    forwardPlus,
    csm,
    violations: [
      ...decisionMismatch('forwardPlus', policy.forwardPlus.decision, forwardPlus),
      ...decisionMismatch('csm', policy.csm.decision, csm),
    ],
  };
}

function evaluateForwardPlus(policy, scaling, evidence) {
  const overflow = scaling?.metrics?.evidence?.lightOverflow;
  const provenance = scaling?.metrics?.evidence?.sceneProvenance;
  const capObserved = overflow?.status === 'available'
    && overflow.value?.rendererTotalLightCapacity === policy.currentTotalLightCapacity
    && overflow.value?.overflowTotalLightCount > 0;
  const reasons = [];
  const productReasons = [];
  if (!capObserved) reasons.push('current-8-light-cap-not-observed');
  if (provenance?.status !== 'available' || provenance.value?.matchesExpectedSource !== true) {
    reasons.push('real-scene-provenance-missing');
  }
  if (evidence?.format !== 'haiyue-lighting-product-decision@1') {
    reasons.push('product-content-requirement-missing');
  } else {
    if (!nonEmpty(evidence.contentRequirementId)) reasons.push('content-requirement-id-missing');
    if (evidence.sourceGame !== provenance?.value?.sourceGame) reasons.push('content-source-does-not-match-fixture');
    if (evidence.requiredVisibleLightCount <= policy.currentTotalLightCapacity) {
      reasons.push('required-visible-light-count-does-not-exceed-cap');
    }
    if (!nonEmpty(evidence.fixedCameraReplayId) || !nonEmpty(evidence.referencePixelHash)) {
      reasons.push('same-picture-reference-missing');
    }
    if (uniqueStrings(evidence.deviceClasses).length < policy.minimumDeviceClassCount) {
      reasons.push('insufficient-device-classes');
    }
    if (evidence.samePictureBaseline?.status !== 'available') {
      reasons.push('same-picture-baseline-missing');
    }
    if (evidence.candidateComparison?.status !== 'available') {
      productReasons.push('candidate-comparison-missing');
    } else {
      if (!(evidence.candidateComparison.gpuP95ImprovementRatio > 0)) {
        productReasons.push('gpu-p95-benefit-not-proven');
      }
      if (evidence.candidateComparison.smallSceneGpuP95RegressionRatio
        > policy.maximumSmallSceneGpuP95RegressionRatio) {
        productReasons.push('small-scene-regression-too-large');
      }
      if (evidence.candidateComparison.candidateOverflowCount !== 0) {
        productReasons.push('candidate-light-overflow-remains');
      }
    }
    if (evidence.unclassifiedFailureCount !== 0) {
      reasons.push('unclassified-failures-remain');
      productReasons.push('unclassified-failures-remain');
    }
  }
  const status = reasons.length === 0 ? 'eligible-for-prototype' : 'hold';
  return {
    status,
    productStatus: status === 'eligible-for-prototype' && productReasons.length === 0
      ? 'eligible-for-product'
      : 'hold',
    capObserved,
    reasons,
    productReasons,
  };
}

function evaluateCsm(policy, evidence) {
  const reasons = [];
  if (evidence?.format !== 'haiyue-csm-product-decision@1') {
    reasons.push('outdoor-content-requirement-missing');
  } else {
    if (!nonEmpty(evidence.contentRequirementId) || !nonEmpty(evidence.sourceGame)) {
      reasons.push('content-requirement-id-missing');
    }
    if (!nonEmpty(evidence.fixedCameraReplayId) || !nonEmpty(evidence.nearFarReferenceId)) {
      reasons.push('near-far-reference-missing');
    }
    if (evidence.requiredShadowDistanceMeters < policy.minimumRequiredShadowDistanceMeters) {
      reasons.push('long-range-shadow-requirement-not-proven');
    }
    if (evidence.baselineDeficit?.nearQualityFailed !== true
      && evidence.baselineDeficit?.farCoverageFailed !== true) {
      reasons.push('single-shadow-map-deficit-not-proven');
    }
    if (uniqueStrings(evidence.deviceClasses).length < policy.minimumDeviceClassCount) {
      reasons.push('insufficient-device-classes');
    }
    if (evidence.unclassifiedFailureCount !== 0) reasons.push('unclassified-failures-remain');
  }
  return {
    status: reasons.length === 0 ? 'eligible-for-prototype' : 'hold',
    reasons,
  };
}

function decisionMismatch(capability, configured, evaluated) {
  if (configured === 'hold' && evaluated.status === 'hold') return [];
  if (configured === 'prototype-approved' && evaluated.status === 'eligible-for-prototype') return [];
  if (configured === 'product-approved' && evaluated.productStatus === 'eligible-for-product') return [];
  return [
    `${capability} decision ${configured} does not match prototype ${evaluated.status}`
    + `${evaluated.productStatus ? ` / product ${evaluated.productStatus}` : ''}.`,
  ];
}

function validatePolicy(policy) {
  if (!policy || policy.schemaVersion !== 1) throw new Error('Lighting architecture policy must use schemaVersion 1.');
  if (!['hold', 'prototype-approved', 'product-approved'].includes(policy.forwardPlus?.decision)) {
    throw new Error('forwardPlus must declare hold, prototype-approved, or product-approved.');
  }
  if (!['hold', 'prototype-approved'].includes(policy.csm?.decision)) {
    throw new Error('csm must declare hold or prototype-approved.');
  }
}

function uniqueStrings(value) {
  return [...new Set(Array.isArray(value) ? value.filter(nonEmpty) : [])];
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
