const VARIANT_EVIDENCE_FIELDS = Object.freeze([
  Object.freeze({ report: 'specializationVariantCount', contract: 'reachableSpecializationVariants' }),
  Object.freeze({ report: 'maximumSpecializationVariantBudget', contract: 'maximumSpecializationVariants' }),
  Object.freeze({ report: 'pilotFamilyVariantCount', contract: 'reachablePilotFamilyVariants' }),
  Object.freeze({ report: 'maximumPilotFamilyVariantBudget', contract: 'maximumPilotFamilyVariants' }),
]);

export function validateShaderLanguageStage3VariantEvidence(result, pilotPolicy) {
  const failures = [];
  for (const field of VARIANT_EVIDENCE_FIELDS) {
    const actual = result?.[field.report];
    const expected = pilotPolicy?.[field.contract];
    if (!Number.isInteger(expected) || expected < 1) {
      failures.push(`stage3 contract ${field.contract} must be a positive integer, got ${String(expected)}`);
      continue;
    }
    if (!Number.isInteger(actual) || actual < 1) {
      failures.push(`${field.report} must be a positive integer, got ${String(actual)}`);
      continue;
    }
    if (actual !== expected) failures.push(`${field.report}=${actual}, expected ${expected}`);
  }
  return Object.freeze(failures);
}
