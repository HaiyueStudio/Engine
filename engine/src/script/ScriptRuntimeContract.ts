import type { Component } from '../ecs/Component';
import type { Entity } from '../ecs/Entity';
import type { System } from '../ecs/System';
import { KeyboardComponent } from '../components/KeyboardComponent';
import type { JsonObject } from '../components/DataComponent';
import type { ScriptExecutionScope, ScriptDisposer } from './ScriptExecutionScope';

export const SCRIPT_CAPABILITIES = ['read', 'scene', 'asset', 'input', 'physics', 'debug'] as const;
export type ScriptCapabilityName = typeof SCRIPT_CAPABILITIES[number];

export interface ScriptRuntimeReadApi {
  data(entity?: Entity | number | string | null): JsonObject | null;
  find(nameOrId: string | number): Entity | null;
  findAll(name?: string): Entity[];
  findByComponent(componentType: string | (new (...args: never[]) => Component)): Entity[];
  getSystem(system: string | (new (...args: never[]) => System)): System | null;
  readonly globals?: unknown;
  readonly components: Readonly<Record<string, unknown>>;
  readonly canvas: Readonly<Record<string, unknown>>;
  readonly pointer: Readonly<Record<string, unknown>>;
  readonly engine: Readonly<Record<string, unknown>>;
}

export interface ScriptRuntimeSceneApi {
  createEntity(name?: string, parent?: Entity | null): Entity;
  destroy(entity: Entity | number | string): void;
  removeEntity(entity: Entity | number | string): void;
  spawnPrefab(nameOrId: string | number, options?: Record<string, unknown>): Entity | null;
  addSystem(system: unknown, renderOptions?: Record<string, unknown> | false | null): unknown;
  addComponent(entity: Entity, component: Component): Entity;
  setText(entity: Entity | number | string, text: string): boolean;
}

export interface ScriptRuntimeAssetApi {
  findPrefab(nameOrId: string | number): unknown | null;
  readonly prefabs?: ReadonlyMap<number, unknown>;
  load?(url: string, options?: Record<string, unknown>): Promise<unknown>;
}

export interface ScriptRuntimeDebugApi {
  readonly console: Console;
  readonly performance: Performance | undefined;
  addDisposer(disposer: ScriptDisposer): ScriptDisposer;
  listen(
    target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): ScriptDisposer;
  setTimeout(callback: () => void, delayMs?: number): ScriptDisposer;
  setInterval(callback: () => void, delayMs?: number): ScriptDisposer;
}

export interface ScriptRuntimeInputApi {
  isPressed(action: string): boolean;
  wasPressed(action: string): boolean;
  wasReleased(action: string): boolean;
  isKeyPressed(code: string): boolean;
  wasKeyPressed(code: string): boolean;
  wasKeyReleased(code: string): boolean;
  value(action: string): number;
  action(action: string): Readonly<{ action: string; value: number; pressed: boolean; down: boolean; up: boolean }>;
  pointer(pointerId?: number): Readonly<{ pointerId: number; x: number; y: number; deltaX: number; deltaY: number; buttons: readonly number[]; wheelX: number; wheelY: number; dragging: boolean }>;
  events(): readonly unknown[];
  interactions(): readonly unknown[];
  snapshot(): unknown;
}

export interface ScriptRuntimeApi {
  readonly read?: ScriptRuntimeReadApi;
  readonly scene?: ScriptRuntimeSceneApi;
  readonly asset?: ScriptRuntimeAssetApi;
  readonly input?: ScriptRuntimeInputApi;
  readonly physics?: Readonly<Record<string, unknown>>;
  readonly debug?: ScriptRuntimeDebugApi;
}

export interface ScriptRuntimeContractEntry {
  readonly name: ScriptCapabilityName;
  readonly defaultEnabled: boolean;
  readonly declarationType: string;
  readonly completionPaths: readonly string[];
}

/** Runtime filtering, editor hints and generated declarations all consume this object. */
export const SCRIPT_RUNTIME_CONTRACT: readonly ScriptRuntimeContractEntry[] = Object.freeze([
  { name: 'read', defaultEnabled: true, declarationType: 'HaiyueScriptReadApi', completionPaths: ['api.read.data', 'api.read.find', 'api.read.findAll', 'api.read.findByComponent', 'api.read.components', 'api.read.canvas'] },
  { name: 'scene', defaultEnabled: false, declarationType: 'HaiyueScriptSceneApi', completionPaths: ['api.scene.createEntity', 'api.scene.destroy', 'api.scene.spawnPrefab', 'api.scene.addComponent', 'api.scene.setText'] },
  { name: 'asset', defaultEnabled: false, declarationType: 'HaiyueScriptAssetApi', completionPaths: ['api.asset.findPrefab', 'api.asset.load'] },
  { name: 'input', defaultEnabled: true, declarationType: 'HaiyueScriptInputApi', completionPaths: ['api.input.isPressed', 'api.input.wasPressed', 'api.input.wasReleased', 'api.input.value', 'api.input.action', 'api.input.pointer', 'api.input.events', 'api.input.interactions', 'api.input.snapshot'] },
  {
    name: 'physics',
    defaultEnabled: false,
    declarationType: 'Readonly<Record<string, unknown>>',
    completionPaths: [
      'api.physics.body',
      'api.physics.hitTest',
      'api.physics.applyForce',
      'api.physics.applyImpulse',
      'api.physics.getMass',
      'api.physics.getVelocity',
      'api.physics.setVelocity',
      'api.physics.setAngularVelocity',
      'api.physics.teleport',
      'api.physics.stop',
    ],
  },
  { name: 'debug', defaultEnabled: true, declarationType: 'HaiyueScriptDebugApi', completionPaths: ['api.debug.console', 'api.debug.listen', 'api.debug.setTimeout', 'api.debug.setInterval', 'api.debug.addDisposer'] },
]);

export const DEFAULT_SCRIPT_CAPABILITIES: readonly ScriptCapabilityName[] = Object.freeze(
  SCRIPT_RUNTIME_CONTRACT.filter(entry => entry.defaultEnabled).map(entry => entry.name),
);

export const SCRIPT_RUNTIME_COMPLETION_PATHS: readonly string[] = Object.freeze(
  SCRIPT_RUNTIME_CONTRACT.flatMap(entry => entry.completionPaths),
);

const EMPTY_POINTER = Object.freeze({ pointerId: 1, x: 0, y: 0, deltaX: 0, deltaY: 0, buttons: Object.freeze([]) as readonly number[], wheelX: 0, wheelY: 0, dragging: false });
export const DEFAULT_SCRIPT_INPUT_API: ScriptRuntimeInputApi = Object.freeze({
  isPressed: (action: string) => KeyboardComponent.isPressed(action),
  wasPressed: (action: string) => KeyboardComponent.wasPressed(action),
  wasReleased: (action: string) => KeyboardComponent.wasReleased(action),
  isKeyPressed: (code: string) => KeyboardComponent.isKeyPressed(code),
  wasKeyPressed: (code: string) => KeyboardComponent.wasKeyPressed(code),
  wasKeyReleased: (code: string) => KeyboardComponent.wasKeyReleased(code),
  value: (action: string) => KeyboardComponent.isPressed(action) ? 1 : 0,
  action: (action: string) => Object.freeze({ action, value: KeyboardComponent.isPressed(action) ? 1 : 0, pressed: KeyboardComponent.isPressed(action), down: KeyboardComponent.wasPressed(action), up: KeyboardComponent.wasReleased(action) }),
  pointer: (pointerId = 1) => pointerId === 1 ? EMPTY_POINTER : Object.freeze({ ...EMPTY_POINTER, pointerId }),
  events: () => Object.freeze([]),
  interactions: () => Object.freeze([]),
  snapshot: () => KeyboardComponent.snapshot(),
});

export function filterScriptRuntimeApi(
  api: ScriptRuntimeApi,
  capabilities: ReadonlySet<ScriptCapabilityName>,
): ScriptRuntimeApi {
  const filtered: ScriptRuntimeApi = {};
  for (const entry of SCRIPT_RUNTIME_CONTRACT) {
    if (!capabilities.has(entry.name)) continue;
    const value = api[entry.name];
    if (value !== undefined) (filtered as Record<string, unknown>)[entry.name] = value;
  }
  return Object.freeze(filtered);
}

export function createScriptDebugApi(scope: ScriptExecutionScope, scopedConsole: Console): ScriptRuntimeDebugApi {
  const api: ScriptRuntimeDebugApi = {
    console: scopedConsole,
    performance: typeof performance === 'undefined' ? undefined : performance,
    addDisposer: (disposer: ScriptDisposer) => scope.add(disposer),
    listen: (
      target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => scope.listen(target, type, listener, options),
    setTimeout: (callback: () => void, delayMs?: number) => scope.setTimeout(callback, delayMs),
    setInterval: (callback: () => void, delayMs?: number) => scope.setInterval(callback, delayMs),
  };
  return Object.freeze(api);
}

export function generateScriptRuntimeDeclarations(
  capabilities: readonly ScriptCapabilityName[] = DEFAULT_SCRIPT_CAPABILITIES,
): string {
  const enabled = new Set(capabilities);
  const capabilityFields = SCRIPT_RUNTIME_CONTRACT
    .filter(entry => enabled.has(entry.name))
    .map(entry => `  readonly ${entry.name}: ${entry.declarationType};`)
    .join('\n');
  return `// Generated from @haiyue/engine SCRIPT_RUNTIME_CONTRACT. Do not hand edit.
import type { Component, Entity, System } from '@haiyue/engine';

interface HaiyueScriptReadApi {
  data(entity?: Entity | number | string | null): Record<string, unknown> | null;
  find(nameOrId: string | number): Entity | null;
  findAll(name?: string): Entity[];
  findByComponent(componentType: string | (new (...args: never[]) => Component)): Entity[];
  getSystem(system: string | (new (...args: never[]) => System)): System | null;
  readonly globals?: unknown;
  readonly components: Readonly<Record<string, unknown>>;
  readonly canvas: Readonly<Record<string, unknown>>;
  readonly pointer: Readonly<Record<string, unknown>>;
  readonly engine: Readonly<Record<string, unknown>>;
}
interface HaiyueScriptSceneApi {
  createEntity(name?: string, parent?: Entity | null): Entity;
  destroy(entity: Entity | number | string): void;
  removeEntity(entity: Entity | number | string): void;
  spawnPrefab(nameOrId: string | number, options?: Record<string, unknown>): Entity | null;
  addSystem(system: unknown, renderOptions?: Record<string, unknown> | false | null): unknown;
  addComponent(entity: Entity, component: Component): Entity;
  setText(entity: Entity | number | string, text: string): boolean;
}
interface HaiyueScriptAssetApi {
  findPrefab(nameOrId: string | number): unknown | null;
  readonly prefabs?: ReadonlyMap<number, unknown>;
  load?(url: string, options?: Record<string, unknown>): Promise<unknown>;
}
interface HaiyueScriptDebugApi {
  readonly console: Console;
  readonly performance: Performance | undefined;
  addDisposer(disposer: () => void): () => void;
  listen(target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): () => void;
  setTimeout(callback: () => void, delayMs?: number): () => void;
  setInterval(callback: () => void, delayMs?: number): () => void;
}
interface HaiyueScriptInputApi {
  isPressed(action: string): boolean;
  wasPressed(action: string): boolean;
  wasReleased(action: string): boolean;
  isKeyPressed(code: string): boolean;
  wasKeyPressed(code: string): boolean;
  wasKeyReleased(code: string): boolean;
  value(action: string): number;
  action(action: string): Readonly<{ action: string; value: number; pressed: boolean; down: boolean; up: boolean }>;
  pointer(pointerId?: number): Readonly<{ pointerId: number; x: number; y: number; deltaX: number; deltaY: number; buttons: readonly number[]; wheelX: number; wheelY: number; dragging: boolean }>;
  events(): readonly unknown[];
  interactions(): readonly Readonly<{ tick: number; type: 'hover' | 'click' | 'move' | 'down' | 'up' | 'drag' | 'wheel' | 'cancel'; entityId: string; pointerId: number; distance: number; point: readonly number[]; normal: readonly number[] }>[];
  snapshot(): unknown;
}
interface HaiyueScriptRuntimeApi {
${capabilityFields}
}
declare const api: HaiyueScriptRuntimeApi;
declare const entity: Entity;
declare const component: import('@haiyue/engine/components').ScriptComponent;
declare const world: import('@haiyue/engine').World | null;
declare const time: number;
declare const delta: number;
declare const event: { component?: Component };
`;
}
