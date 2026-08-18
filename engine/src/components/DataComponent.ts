import { ComponentWithData, UniqueCheckType } from '../ecs/Component';
import { deepClone } from '../utils/deepClone';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export class DataComponent extends ComponentWithData<JsonObject> {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('DataComponent');
  static editor = {
    fields: {
      value: { type: 'json', label: 'JSON', rows: 10 },
    },
  };

  constructor(data: JsonObject = {}) {
    super(deepClone(data), 'DataComponent');
  }

  get value(): JsonObject {
    return this.data;
  }

  set value(data: JsonObject) {
    this.data = deepClone(data);
  }

  get<T = JsonValue>(key: string, fallback?: T): T | JsonValue | undefined {
    return this.value[key] ?? fallback;
  }

  set(key: string, value: JsonValue): this {
    this.value[key] = value;
    return this;
  }

  merge(data: JsonObject): this {
    Object.assign(this.value, deepClone(data));
    return this;
  }

  override clone(): DataComponent {
    return new DataComponent(this.value);
  }
}
