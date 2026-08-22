import { dataBindingFail } from './diagnostics.js';

export interface DataBindingLimits {
  readonly maxEnums: number; readonly maxEnumValues: number; readonly maxModels: number; readonly maxProperties: number;
  readonly maxInstances: number; readonly maxListItems: number; readonly maxBindings: number; readonly maxConverters: number;
  readonly maxOperations: number; readonly maxPathDepth: number; readonly maxStringBytes: number; readonly maxTotalTextBytes: number;
}

export const DEFAULT_DATA_BINDING_LIMITS: DataBindingLimits = Object.freeze({
  maxEnums: 100_000, maxEnumValues: 1_000_000, maxModels: 100_000, maxProperties: 1_000_000,
  maxInstances: 250_000, maxListItems: 100_000, maxBindings: 1_000_000, maxConverters: 100_000,
  maxOperations: 1_000_000, maxPathDepth: 128, maxStringBytes: 4 * 1024 * 1024, maxTotalTextBytes: 32 * 1024 * 1024,
});

export function resolveDataBindingLimits(overrides: Partial<DataBindingLimits> = {}): DataBindingLimits {
  const limits = { ...DEFAULT_DATA_BINDING_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) dataBindingFail('E_DATA_BINDING_LIMIT', `$.limits.${name}`, 'limit must be a positive safe integer');
  return Object.freeze(limits);
}
