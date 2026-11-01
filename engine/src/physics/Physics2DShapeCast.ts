import { EngineError, EngineErrorCode } from '../core/EngineError';
import type { Physics2DShapeCastDesc } from './Physics2DBackend';
const invalid = () => new EngineError(EngineErrorCode.GameplayInvalidInput, 'Invalid physics shape cast descriptor.', { docsPath: 'errors/E_GAMEPLAY_INVALID_INPUT' });

export function validateShapeCast(desc: Physics2DShapeCastDesc): void {
  if (!desc || !['box', 'circle'].includes(desc.shape) || !desc.origin || !desc.translation
    || ![desc.origin.x, desc.origin.y, desc.translation.x, desc.translation.y, desc.angle ?? 0, desc.durationSeconds ?? 0].every(Number.isFinite)
    || (desc.durationSeconds ?? 0) < 0) throw invalid();
  const dimensions = desc.shape === 'circle' ? [desc.radius] : [desc.width, desc.height];
  if (!dimensions.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) throw invalid();
  for (const bits of [desc.categoryBits, desc.maskBits]) if (bits !== undefined && (!Number.isSafeInteger(bits) || bits < 0 || bits > 0xffff)) throw invalid();
  const limit = desc.maxCandidates ?? 256;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256
    || (desc.includeSensors !== undefined && typeof desc.includeSensors !== 'boolean')
    || (desc.exclude !== undefined && (!Array.isArray(desc.exclude) || !desc.exclude.every(h => Number.isSafeInteger(h) && h > 0)))) throw invalid();
}

