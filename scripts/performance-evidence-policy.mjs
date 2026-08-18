export const PERFORMANCE_EVIDENCE_MODES = Object.freeze({
  candidate: 'candidate',
  formal: 'formal',
  diagnostic: 'diagnostic',
});

export function resolvePerformanceEvidenceMode(mode, environment = process.env) {
  const requested = environment.WEBGPU_PERFORMANCE_EVIDENCE_MODE;
  if (requested !== undefined && !Object.values(PERFORMANCE_EVIDENCE_MODES).includes(requested)) {
    throw new Error(
      `WEBGPU_PERFORMANCE_EVIDENCE_MODE must be candidate, formal, or diagnostic; received ${requested}.`,
    );
  }
  if (requested === PERFORMANCE_EVIDENCE_MODES.formal && mode !== 'full') {
    throw new Error('Formal WebGPU performance evidence requires the full workload.');
  }
  if (requested) return requested;
  if (environment.WEBGPU_RECORD_PERFORMANCE_EVIDENCE === '1') {
    throw new Error(
      'WEBGPU_RECORD_PERFORMANCE_EVIDENCE no longer promotes formal evidence; '
      + 'set WEBGPU_PERFORMANCE_EVIDENCE_MODE=formal explicitly on the registered full runner.',
    );
  }
  return PERFORMANCE_EVIDENCE_MODES.diagnostic;
}

export function shouldWriteFormalPerformanceEvidence(mode, environment = process.env) {
  return resolvePerformanceEvidenceMode(mode, environment) === PERFORMANCE_EVIDENCE_MODES.formal;
}
