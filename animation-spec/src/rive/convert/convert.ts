import type { ConvertRiveToHyaInput, ConvertRiveToHyaOptions, RiveConversionLimits, RiveConversionProgress, RiveConversionReport, RiveConversionResult } from './types.js';
import { RIVE_CONVERSION_HARD_LIMITS } from './types.js';
import { adaptRiveNeutralEvaluation } from './adapter.js';
import { sampleBakedTracks } from './adaptive-sampler.js';
import { compileRiveNeutralPlan } from './compiler.js';
import { assembleRivePackage, prepareRiveAssets } from './package.js';
import { asConversionError, conversionFail, throwIfAborted } from './diagnostics.js';
import { sha256, stableJsonBytes } from './stable.js';

export async function convertRiveToHya(input: ConvertRiveToHyaInput, options: ConvertRiveToHyaOptions = {}): Promise<RiveConversionResult> {
  const signal = options.signal ?? new AbortController().signal;
  const limits = resolveLimits(options.limits);
  const mode = options.mode ?? 'strict';
  if (mode !== 'normal' && mode !== 'strict') conversionFail('E_RIVE_CONVERT_FORMAT', 'Conversion mode must be normal or strict.', '$.options.mode');
  const progress = (phase: RiveConversionProgress['phase'], completed: number, total: number): void => {
    throwIfAborted(signal);
    try { options.onProgress?.(Object.freeze({ phase, completed, total })); }
    catch (error) { conversionFail('E_RIVE_CONVERT_INTERNAL', 'Progress callback failed.', '$.options.onProgress', undefined, error); }
  };
  let sinkStarted = false;
  try {
    throwIfAborted(signal);
    progress('adapting', 0, 1);
    const neutralIrSha256 = await sha256(input.imported.irBytes);
    throwIfAborted(signal);
    const adapted = adaptRiveNeutralEvaluation(input, neutralIrSha256, limits, options.approvedExternalOrigins ?? []);
    progress('adapting', 1, 1);

    progress('sampling', 0, adapted.evaluation.bakedTracks.length);
    const bakedTracks = await sampleBakedTracks(adapted.evaluation.bakedTracks, options.evaluator, limits, signal);
    progress('sampling', adapted.evaluation.bakedTracks.length, adapted.evaluation.bakedTracks.length);

    const preparedAssets = await prepareRiveAssets(adapted, signal);
    throwIfAborted(signal);
    progress('compiling', 0, 1);
    const compiled = compileRiveNeutralPlan(adapted, bakedTracks, preparedAssets);
    progress('compiling', 1, 1);

    progress('packaging', 0, 1);
    const inputIdentity = Object.freeze({ rivSha256: input.imported.report.input.sha256, neutralIrSha256 });
    const assembled = await assembleRivePackage(compiled.files, preparedAssets, adapted, inputIdentity, limits, signal);
    const packageSha256 = await sha256(assembled.packageBytes), hyaSha256 = await sha256(compiled.hyaBytes);
    throwIfAborted(signal);
    const report: RiveConversionReport = Object.freeze({
      schema: 'haiyue-rive-hya-conversion-report', version: 1, mode, tuple: adapted.evaluation.tuple, input: inputIdentity,
      output: Object.freeze({ packageSha256, byteLength: assembled.packageBytes.byteLength, hyaSha256 }),
      featureLedger: adapted.featureLedger,
      coverage: Object.freeze({ objects: adapted.objectCount, properties: adapted.propertyCount, uncoveredObjects: 0, uncoveredProperties: 0 }),
      classification: adapted.evaluation.classification,
      diagnostics: Object.freeze([]),
    });
    const reportBytes = stableJsonBytes(report);
    progress('packaging', 1, 1);

    progress('complete', 1, 1);
    if (options.sink) {
      sinkStarted = true;
      try {
        await options.sink.stage('animation.hyapkg', assembled.packageBytes, signal); throwIfAborted(signal);
        await options.sink.stage('manifest.json', assembled.manifestBytes, signal); throwIfAborted(signal);
        await options.sink.stage('conversion-report.json', reportBytes, signal); throwIfAborted(signal);
        await options.sink.commit(signal);
        sinkStarted = false;
      } catch (error) {
        if (asConversionError(error, '$.options.sink').code === 'E_RIVE_CONVERT_ABORTED') throw error;
        conversionFail('E_RIVE_CONVERT_ATOMIC_COMMIT', 'Atomic conversion output failed before commit completed.', '$.options.sink', undefined, error);
      }
    }
    return Object.freeze({
      hyaBytes: compiled.hyaBytes,
      packageBytes: assembled.packageBytes,
      manifest: assembled.manifest,
      manifestBytes: assembled.manifestBytes,
      report,
      reportBytes,
    });
  } catch (error) {
    if (sinkStarted && options.sink) {
      try { await options.sink.abort(error); }
      catch (abortError) { throw asConversionError(abortError, '$.options.sink.abort'); }
    }
    throw asConversionError(error, '$.convertRiveToHya');
  }
}

function resolveLimits(overrides: Partial<RiveConversionLimits> | undefined): RiveConversionLimits {
  const result = { ...RIVE_CONVERSION_HARD_LIMITS };
  if (!overrides) return Object.freeze(result);
  for (const key of Object.keys(overrides)) if (!(key in result)) conversionFail('E_RIVE_CONVERT_FORMAT', `Unknown conversion limit "${key}".`, `$.options.limits.${key}`);
  for (const key of Object.keys(result) as (keyof RiveConversionLimits)[]) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0 || value > RIVE_CONVERSION_HARD_LIMITS[key]) {
      conversionFail('E_RIVE_CONVERT_LIMIT', `${key} override must be an integer in [0, ${RIVE_CONVERSION_HARD_LIMITS[key]}].`, `$.options.limits.${key}`);
    }
    result[key] = value;
  }
  return Object.freeze(result);
}
