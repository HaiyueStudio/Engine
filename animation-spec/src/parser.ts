import { AnimationFormatError } from './errors';
import { tryDecodeAnimationBinary } from './binary';
import type { AnimationParseOptions, AnimationSource, ParsedAnimation } from './types';
import { parseAnimationValue, resolveAnimationParseLimits } from './validation';

const DEFAULT_PARSE_OPTIONS: AnimationParseOptions = Object.freeze({});
const UTF8_DECODER = new TextDecoder();
const UTF8_ENCODER = new TextEncoder();

export function parseAnimation(source: AnimationSource, options: AnimationParseOptions = DEFAULT_PARSE_OPTIONS): ParsedAnimation {
  if (source instanceof ArrayBuffer) {
    const binary = tryDecodeAnimationBinary(source, options);
    if (binary) return binary;
    const limits = resolveAnimationParseLimits(options);
    if (source.byteLength > limits.maxInputBytes) {
      throw new AnimationFormatError('E_ANIMATION_LIMIT_EXCEEDED', `Input exceeds ${limits.maxInputBytes} bytes.`, '$');
    }
    return parseJsonText(UTF8_DECODER.decode(source), options);
  }
  if (typeof source === 'string') return parseJsonText(source, options);
  return parseAnimationValue(source, options, 'json');
}

function parseJsonText(source: string, options: AnimationParseOptions): ParsedAnimation {
  const limits = resolveAnimationParseLimits(options);
  const bytes = UTF8_ENCODER.encode(source).byteLength;
  if (bytes > limits.maxInputBytes) {
    throw new AnimationFormatError('E_ANIMATION_LIMIT_EXCEEDED', `Input exceeds ${limits.maxInputBytes} bytes.`, '$');
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new AnimationFormatError(
      'E_ANIMATION_INVALID_FORMAT',
      `Animation JSON cannot be decoded: ${error instanceof Error ? error.message : String(error)}.`,
      '$',
    );
  }
  return parseAnimationValue(value, options, 'json');
}
