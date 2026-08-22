import type { DataBindingLimits } from './limits.js';

export const HYA_DATA_BINDING_EXTENSION_ID = 'org.haiyue.data-binding@1' as const;
export const HYA_DATA_BINDING_FORMAT = 'haiyue-data-binding' as const;
export const HYA_DATA_BINDING_VERSION = 1 as const;

export type DataColor = readonly [number, number, number, number];
export type DataScalar = number | string | boolean | DataColor | null;
export interface DataObject { readonly [key: string]: DataValue }
export type DataValue = DataScalar | readonly DataValue[] | DataObject;
export type DataPropertyKind = 'number' | 'integer' | 'string' | 'boolean' | 'color' | 'trigger' | 'enum' | 'model' | 'list' | 'image' | 'artboard' | 'font' | 'blob';

export interface DataEnumDefinition { readonly id: string; readonly values: readonly Readonly<{ key: string; value: number }>[] }
export interface DataPropertyDefinition {
  readonly id: string; readonly kind: DataPropertyKind; readonly enum?: string; readonly model?: string;
  readonly item?: Readonly<{ kind: Exclude<DataPropertyKind, 'trigger' | 'list'>; enum?: string; model?: string }>;
  readonly defaultValue?: DataValue; readonly nullable?: boolean;
}
export interface DataModelDefinition { readonly id: string; readonly properties: readonly DataPropertyDefinition[]; readonly defaultInstance?: string }
export interface DataModelInstance { readonly id: string; readonly model: string; readonly scope: 'default' | 'global' | 'local'; readonly values: Readonly<Record<string, DataValue>> }

export type DataConverterOperation =
  | Readonly<{ op: 'round'; decimals: number }>
  | Readonly<{ op: 'to-string'; decimals?: number; colorFormat?: 'hex' | 'rgba' }>
  | Readonly<{ op: 'to-number' }>
  | Readonly<{ op: 'boolean-not' }>
  | Readonly<{ op: 'degrees-to-radians' }>
  | Readonly<{ op: 'normalize'; minimum: number; maximum: number }>
  | Readonly<{ op: 'range-map'; input: readonly [number, number]; output: readonly [number, number]; clamp?: boolean }>
  | Readonly<{ op: 'string-pad'; length: number; text: string; side: 'start' | 'end' }>
  | Readonly<{ op: 'string-trim'; side: 'start' | 'end' | 'both' }>
  | Readonly<{ op: 'remove-trailing-zeros' }>
  | Readonly<{ op: 'list-length' }>
  | Readonly<{ op: 'number-to-list'; model: string }>
  | Readonly<{ op: 'to-trigger'; mode: 'change' | 'rising' | 'falling' | 'truthy' }>
  | Readonly<{ op: 'interpolate'; duration: number; easing: readonly [number, number, number, number] }>
  | Readonly<{ op: 'formula'; tokens: readonly Readonly<{ kind: 'value' | 'input' | 'operator' | 'function'; value: string | number }>[] }>
  | Readonly<{ op: 'custom'; protocol: string; port: string; arguments?: DataObject }>;
export interface DataConverterDefinition { readonly id: string; readonly version: 1; readonly operations: readonly DataConverterOperation[] }

export type DataMutationOperation =
  | Readonly<{ op: 'set'; path: readonly (string | number)[]; value: DataValue }>
  | Readonly<{ op: 'copy'; from: readonly (string | number)[]; path: readonly (string | number)[] }>
  | Readonly<{ op: 'trigger'; path: readonly (string | number)[] }>
  | Readonly<{ op: 'list-insert'; path: readonly (string | number)[]; index: number; value: DataValue }>
  | Readonly<{ op: 'list-remove'; path: readonly (string | number)[]; index: number }>
  | Readonly<{ op: 'list-move'; path: readonly (string | number)[]; from: number; to: number }>;
export interface DataPropertyGroupDefinition { readonly id: string; readonly version: 1; readonly operations: readonly DataMutationOperation[] }

export interface DataBindingSource { readonly mode: 'explicit' | 'default' | 'global' | 'auto'; readonly instance?: string; readonly model?: string; readonly path: readonly (string | number)[] }
export interface DataBindingDefinition { readonly id: string; readonly target: string; readonly targetPath: readonly string[]; readonly source: DataBindingSource; readonly converter?: string; readonly direction: 'read' | 'write' | 'two-way' }
export interface StatefulDataComponentDefinition { readonly id: string; readonly stateful: true; readonly model: string; readonly exposedProperties?: readonly string[]; readonly exposedInputs?: readonly string[]; readonly exposedEvents?: readonly string[] }

export interface HyaDataBindingDocument {
  readonly format: typeof HYA_DATA_BINDING_FORMAT; readonly version: typeof HYA_DATA_BINDING_VERSION; readonly extension: typeof HYA_DATA_BINDING_EXTENSION_ID;
  readonly enums: readonly DataEnumDefinition[]; readonly models: readonly DataModelDefinition[]; readonly instances: readonly DataModelInstance[];
  readonly converters: readonly DataConverterDefinition[]; readonly propertyGroups: readonly DataPropertyGroupDefinition[]; readonly bindings: readonly DataBindingDefinition[];
  readonly components: readonly StatefulDataComponentDefinition[];
}
export interface DataBindingParseOptions { readonly limits?: Partial<DataBindingLimits> }
