import { RiveImportError } from './error.js';
import type { RiveImportDiagnosticCode, RiveImportDiagnosticContext } from './types.js';

export class RivBinaryReader {
  private offsetValue = 0;
  private readonly view: DataView;

  constructor(
    private readonly bytes: Uint8Array,
    private context: RiveImportDiagnosticContext,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get offset(): number { return this.offsetValue; }
  get reachedEnd(): boolean { return this.offsetValue === this.bytes.byteLength; }
  get remaining(): number { return this.bytes.byteLength - this.offsetValue; }

  setContext(context: RiveImportDiagnosticContext): void { this.context = context; }

  readByte(path: string): number {
    this.require(1, path);
    return this.bytes[this.offsetValue++]!;
  }

  readUint32(path: string): number {
    this.require(4, path);
    const value = this.view.getUint32(this.offsetValue, true);
    this.offsetValue += 4;
    return value;
  }

  readFloat32(path: string): number {
    this.require(4, path);
    const value = this.view.getFloat32(this.offsetValue, true);
    this.offsetValue += 4;
    if (!Number.isFinite(value)) this.fail('E_RIVE_TOC_INVALID', 'Non-finite numeric payload.', path);
    return value;
  }

  readVarUint(path: string, maxValue = 0xffff_ffff): number {
    let value = 0n;
    for (let byteIndex = 0; byteIndex < 10; byteIndex++) {
      if (this.reachedEnd) this.fail('E_RIVE_TRUNCATED', 'Truncated varuint payload.', path);
      const byte = this.readByte(path);
      if (byteIndex === 9 && byte > 1) this.fail('E_RIVE_VARINT_OVERFLOW', 'Varuint exceeds 64 bits.', path);
      value |= BigInt(byte & 0x7f) << BigInt(byteIndex * 7);
      if ((byte & 0x80) === 0) {
        if (value > BigInt(maxValue)) this.fail('E_RIVE_VARINT_OVERFLOW', 'Varuint exceeds the field range.', path);
        return Number(value);
      }
    }
    return this.fail('E_RIVE_VARINT_OVERFLOW', 'Varuint exceeds 10 bytes.', path);
  }

  readLengthPrefixedBytes(path: string, maxBytes: number): Uint8Array {
    const length = this.readVarUint(`${path}.length`, Number.MAX_SAFE_INTEGER);
    if (length > maxBytes) this.limit(path, length, maxBytes, 'payloadBytes');
    this.require(length, path);
    const start = this.offsetValue;
    this.offsetValue += length;
    return this.bytes.subarray(start, start + length);
  }

  readString(path: string, maxBytes: number): Readonly<{ value: string; byteLength: number }> {
    const raw = this.readLengthPrefixedBytes(path, maxBytes);
    try {
      return Object.freeze({ value: new TextDecoder('utf-8', { fatal: true }).decode(raw), byteLength: raw.byteLength });
    } catch (cause) {
      throw new RiveImportError('E_RIVE_TRUNCATED', 'String payload is not valid UTF-8.', path, this.context, { cause });
    }
  }

  private require(length: number, path: string): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      this.fail('E_RIVE_TRUNCATED', 'Binary payload ends before the declared field.', path);
    }
  }

  private limit(path: string, observed: number, limit: number, budget: string): never {
    throw new RiveImportError('E_RIVE_LIMIT_EXCEEDED', `Rive import exceeded ${budget}.`, path, {
      ...this.context,
      observed,
      limit,
      budget,
    });
  }

  private fail(code: RiveImportDiagnosticCode, message: string, path: string): never {
    throw new RiveImportError(code, message, path, this.context);
  }
}
