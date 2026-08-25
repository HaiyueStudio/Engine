import { importFrozenRiv } from '../import/import-frozen-riv.js';
import { convertRiveToHya } from './convert.js';
import { asConversionError, conversionFail, throwIfAborted } from './diagnostics.js';
import { sha256 } from './stable.js';
import type {
  ConvertRivBytesToHyaOptions,
  RiveCapabilityEvaluator,
  RiveConversionResult,
  RiveNeutralCapabilityEvaluation,
} from './types.js';

const HASH = /^[a-f0-9]{64}$/u;

/**
 * Production build-time pipeline. Source bytes and Rive report identities stop
 * at the capability evaluator; only its source-neutral, fully covered output
 * reaches the HYA compiler.
 */
export async function convertRivBytesToHya(
  input: Uint8Array,
  options: ConvertRivBytesToHyaOptions,
): Promise<RiveConversionResult> {
  if (!(input instanceof Uint8Array)) {
    conversionFail('E_RIVE_CONVERT_FORMAT', 'Rive pipeline input must be a Uint8Array.', '$.input');
  }
  if (!options?.capabilityEvaluator) {
    conversionFail('E_RIVE_CONVERT_ORACLE_REQUIRED', 'A revision-pinned capability evaluator is required.', '$.options.capabilityEvaluator');
  }
  const signal = options.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  validateEvaluatorDescriptor(options.capabilityEvaluator);

  const rivBytes = Uint8Array.from(input);
  const imported = await importFrozenRiv(rivBytes, { ...options.importer, signal });
  throwIfAborted(signal);
  const inputIrSha256 = await sha256(imported.irBytes);
  const evaluation = await evaluateCapabilities(options.capabilityEvaluator, {
    rivBytes: Uint8Array.from(rivBytes),
    imported,
    inputIrSha256,
  }, signal);
  throwIfAborted(signal);
  validateEvaluationIdentity(evaluation, options.capabilityEvaluator, inputIrSha256);

  return convertRiveToHya(
    Object.freeze({ imported, evaluation }),
    { ...options.conversion, signal },
  );
}

async function evaluateCapabilities(
  evaluator: RiveCapabilityEvaluator,
  request: Parameters<RiveCapabilityEvaluator['evaluate']>[0],
  signal: AbortSignal,
): Promise<RiveNeutralCapabilityEvaluation> {
  try {
    return await evaluator.evaluate(Object.freeze(request), signal);
  } catch (error) {
    throwIfAborted(signal);
    throw asConversionError(error, '$.options.capabilityEvaluator.evaluate');
  }
}

function validateEvaluatorDescriptor(evaluator: RiveCapabilityEvaluator): void {
  const descriptor = evaluator.descriptor;
  if (!descriptor || typeof evaluator.evaluate !== 'function') {
    conversionFail('E_RIVE_CONVERT_ORACLE_REQUIRED', 'Capability evaluator is incomplete.', '$.options.capabilityEvaluator');
  }
  const keys = ['adapterId', 'adapterRevisionSha256', 'evaluatorId', 'evaluatorRevisionSha256', 'optionsRevision'] as const;
  if (Object.keys(descriptor).length !== keys.length || keys.some(key => !(key in descriptor))) {
    conversionFail('E_RIVE_CONVERT_FORMAT', 'Capability evaluator descriptor fields do not match the frozen contract.', '$.options.capabilityEvaluator.descriptor');
  }
  for (const key of keys) {
    const value = descriptor[key];
    if (typeof value !== 'string' || value.length === 0) {
      conversionFail('E_RIVE_CONVERT_FORMAT', 'Capability evaluator descriptor fields must be non-empty strings.', `$.options.capabilityEvaluator.descriptor.${key}`);
    }
  }
  if (!HASH.test(descriptor.adapterRevisionSha256) || !HASH.test(descriptor.evaluatorRevisionSha256)) {
    conversionFail('E_RIVE_CONVERT_FORMAT', 'Capability evaluator revisions must be lowercase SHA-256.', '$.options.capabilityEvaluator.descriptor');
  }
}

function validateEvaluationIdentity(
  evaluation: RiveNeutralCapabilityEvaluation,
  evaluator: RiveCapabilityEvaluator,
  inputIrSha256: string,
): void {
  if (!evaluation || evaluation.inputIrSha256 !== inputIrSha256) {
    conversionFail('E_RIVE_CONVERT_FORMAT', 'Capability evaluator output is not bound to the imported Neutral IR.', '$.evaluation.inputIrSha256');
  }
  for (const key of ['adapterId', 'adapterRevisionSha256', 'evaluatorId', 'evaluatorRevisionSha256', 'optionsRevision'] as const) {
    if (evaluation.tuple?.[key] !== evaluator.descriptor[key]) {
      conversionFail('E_RIVE_CONVERT_FORMAT', 'Capability evaluator output tuple differs from its descriptor.', `$.evaluation.tuple.${key}`);
    }
  }
}
