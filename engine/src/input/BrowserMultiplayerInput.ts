import { hashSimulationState, type SimulationStateValue } from '../simulation/StateHash';
import { InputActionMap, type InputActionMapDescriptor, type InputActionValue, type StandardGamepadSnapshot } from './InputActionMap';
import {GamepadInputLayers,type GamepadControlSample} from './GamepadInputLayers';
import {isInputEventConsumed} from './InputEventConsumption';

export interface PlayerInputSnapshot {
  readonly id: string;
  readonly actions: readonly Readonly<{
    action: string;
    value: number;
    held: boolean;
    pressed: boolean;
    released: boolean;
  }>[];
  readonly hash: string;
}

export interface MultiplayerInputSnapshot {
  readonly tick: number;
  readonly players: readonly PlayerInputSnapshot[];
  readonly hash: string;
}

/** Configures the host keyboard/gamepad sampler that emits immutable player snapshots.
 * Routes borrow readonly controls without polling. `release()` preserves release edges;
 * `reset()` restarts ticks and held state without reattaching listeners.
 */
export interface BrowserMultiplayerInputOptions {
  readonly players: readonly Readonly<{
    id: string;
    bindings: InputActionMapDescriptor;
    gamepadIndex?: number;
  }>[];
  readonly eventTarget?: EventTarget;
  readonly visibilityTarget?: EventTarget & Readonly<{ hidden?: boolean }>;
  readonly getGamepads?: () => ArrayLike<StandardGamepadSnapshot | null>;
  readonly actionThreshold?: number;
  readonly preventDefault?: boolean;
}

/** Newest-first routing. Consumed controls and aliases remain masked until neutral,
   * including after unsubscribe. Capture reserves subthreshold motion before normalization. */
type GamepadLayerRelease = () => void;

interface PlayerRuntime {
  readonly id: string;
  readonly actionMap: InputActionMap;
  readonly gamepadIndex: number | null;
  readonly previous: Map<string, number>;
}

export class BrowserMultiplayerInput {
  readonly actionThreshold: number;
  readonly #players: readonly PlayerRuntime[];
  readonly #eventTarget: EventTarget | null;
  readonly #visibilityTarget: (EventTarget & Readonly<{ hidden?: boolean }>) | null;
  readonly #getGamepads: () => ArrayLike<StandardGamepadSnapshot | null>;
  readonly #preventDefault: boolean;
  readonly #keys = new Set<string>();
  readonly #unconsumedKeys = new Set<string>();
  readonly #gamepadLayers = new GamepadInputLayers();
  readonly #mappedKeys = new Set<string>();
  readonly #disconnectedGamepads = new Set<number>();
  #sampling?:boolean;
  #tick = 0;
  #disposed = false;
  #suspended = false;

  readonly #onKeyDown = (event: Event): void => {
    const code = keyboardCode(event);
    if (!code || !this.#mappedKeys.has(code)) return;
    if(!this.#keys.has(code))this.#unconsumedKeys.add(code);
    this.#keys.add(code);
    if(isInputEventConsumed(event))this.#unconsumedKeys.delete(code);
    if (this.#preventDefault) event.preventDefault();
  };

  readonly #onKeyUp = (event: Event): void => {
    const code = keyboardCode(event);
    if (!code || !this.#mappedKeys.has(code)) return;
    this.#keys.delete(code);
    this.#unconsumedKeys.delete(code);
    if (this.#preventDefault) event.preventDefault();
  };

  readonly #onRelease = (): void => { this.#keys.clear();this.#unconsumedKeys.clear();this.#gamepadLayers.release(); };
  readonly #onGamepadConnected = (event: Event): void => {
    const index = gamepadEventIndex(event);
    if (index !== null) this.#disconnectedGamepads.delete(index);
  };
  readonly #onGamepadDisconnected = (event: Event): void => {
    const index = gamepadEventIndex(event);
    if (index !== null) this.#disconnectedGamepads.add(index);
  };
  readonly #onVisibilityChange = (): void => {
    this.#suspended = this.#visibilityTarget?.hidden === true;
    if (this.#suspended) this.#onRelease();
  };

  constructor(options: BrowserMultiplayerInputOptions) {
    if (!options || !Array.isArray(options.players) || options.players.length < 1 || options.players.length > 8) {
      throw new TypeError('Browser multiplayer input requires from 1 to 8 players.');
    }
    this.actionThreshold = range(options.actionThreshold ?? 0.5, 0.000_001, 1, 'actionThreshold');
    const ids = new Set<string>();
    this.#players = Object.freeze(options.players.map((descriptor, index) => {
      const id=descriptor.id;
      if(typeof id!=='string'||!/^[A-Za-z][A-Za-z0-9._:-]{0,31}$/u.test(id))throw new TypeError('Browser multiplayer input player id is invalid.');
      if (ids.has(id)) throw new TypeError(`Browser multiplayer input player id is duplicated: ${id}.`);
      ids.add(id);
      const actionMap = new InputActionMap(descriptor.bindings);
      for (const binding of Object.values(actionMap.toJSON())) for (const code of binding.keys ?? []) this.#mappedKeys.add(code);
      const gamepadIndex = descriptor.gamepadIndex === undefined ? null : range(descriptor.gamepadIndex, 0, 31, `players[${index}].gamepadIndex`, true);
      return { id, actionMap, gamepadIndex, previous: new Map<string, number>() };
    }));
    this.#eventTarget = options.eventTarget ?? (typeof globalThis.addEventListener==='function'?globalThis:null);
    this.#visibilityTarget = options.visibilityTarget ?? (typeof document==='undefined'?null:document);
    this.#getGamepads = options.getGamepads ?? defaultGamepadProvider;
    this.#preventDefault = options.preventDefault ?? false;
    this.#eventTarget?.addEventListener('keydown', this.#onKeyDown);
    this.#eventTarget?.addEventListener('keyup', this.#onKeyUp);
    this.#eventTarget?.addEventListener('blur', this.#onRelease);
    this.#eventTarget?.addEventListener('gamepadconnected', this.#onGamepadConnected);
    this.#eventTarget?.addEventListener('gamepaddisconnected', this.#onGamepadDisconnected);
    this.#visibilityTarget?.addEventListener('visibilitychange', this.#onVisibilityChange);
    this.#onVisibilityChange();
  }

  get tick(): number { return this.#tick; }
  get suspended(): boolean { return this.#suspended; }
  get disposed(): boolean { return this.#disposed; }

  addGamepadLayer(bindings: InputActionMap, handle: (action: string, gamepadIndex: number) => boolean, options: {capture?: (gamepadIndex: number) => boolean} = {}): GamepadLayerRelease {
    this.#assertLive();
    return this.#gamepadLayers.add(bindings,handle,options.capture);
  }

  addGamepadRoute(handle:(sample:GamepadControlSample)=>boolean):GamepadLayerRelease {this.#assertLive();return this.#gamepadLayers.addRaw(handle);}

  sample(tick: number): MultiplayerInputSnapshot {
    this.#assertLive();if(this.#sampling)throw new Error('Browser multiplayer input sampling cannot reenter.');this.#sampling=true;try{
    if (!Number.isSafeInteger(tick) || tick !== this.#tick + 1) throw new RangeError(`Browser multiplayer input tick must advance exactly from ${this.#tick} to ${this.#tick + 1}.`);
    this.#tick = tick;
    const rawGamepads = this.#suspended ? EMPTY_GAMEPADS : this.#getGamepads();
    const gamepads = this.#suspended?EMPTY_GAMEPADS:this.#gamepadLayers.route(Array.from(rawGamepads,(pad,index)=>this.#disconnectedGamepads.has(index)?null:pad),this.actionThreshold);
    this.#assertLive();if(this.#tick!==tick)throw new Error('Browser multiplayer input tick changed during routing.');
    const players = this.#players.map(player => this.#samplePlayer(player, gamepads));
    return snapshot({tick,players:Object.freeze(players)});
    }finally{this.#sampling=false;}
  }

  release(): this {
    this.#assertLive();
    this.#keys.clear();
    this.#unconsumedKeys.clear();
    this.#gamepadLayers.release();
    return this;
  }

  reset(): this {
    this.#assertLive();
    this.#tick = 0;
    this.#keys.clear();
    this.#unconsumedKeys.clear();this.#gamepadLayers.clear();
    this.#disconnectedGamepads.clear();
    for (const player of this.#players) player.previous.clear();
    return this;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#keys.clear();
    this.#unconsumedKeys.clear();this.#gamepadLayers.dispose();
    this.#disconnectedGamepads.clear();
    for (const player of this.#players) player.previous.clear();
    this.#eventTarget?.removeEventListener('keydown', this.#onKeyDown);
    this.#eventTarget?.removeEventListener('keyup', this.#onKeyUp);
    this.#eventTarget?.removeEventListener('blur', this.#onRelease);
    this.#eventTarget?.removeEventListener('gamepadconnected', this.#onGamepadConnected);
    this.#eventTarget?.removeEventListener('gamepaddisconnected', this.#onGamepadDisconnected);
    this.#visibilityTarget?.removeEventListener('visibilitychange', this.#onVisibilityChange);
  }

  #samplePlayer(player: PlayerRuntime, gamepads: ArrayLike<StandardGamepadSnapshot | null>): PlayerInputSnapshot {
    const values = new Map<string, number>();
    if (!this.#suspended) mergeValues(values, player.actionMap.sampleKeyboard(this.#unconsumedKeys));
    const gamepad = player.gamepadIndex === null || this.#disconnectedGamepads.has(player.gamepadIndex) ? null : gamepads[player.gamepadIndex] ?? null;
    mergeValues(values, player.actionMap.sampleGamepad(gamepad));
    const actions = player.actionMap.actionNames().map(action => {
      const value = values.get(action) ?? 0;
      const previous = player.previous.get(action) ?? 0;
      const held = Math.abs(value) >= this.actionThreshold;
      const wasHeld = Math.abs(previous) >= this.actionThreshold;
      player.previous.set(action, value);
      return Object.freeze({ action, value, held, pressed: held && !wasHeld, released: !held && wasHeld });
    });
    return snapshot({id:player.id,actions:Object.freeze(actions)});
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('Browser multiplayer input has been disposed.');
  }
}

const EMPTY_GAMEPADS: ArrayLike<null> = Object.freeze([]);

function mergeValues(target: Map<string, number>, values: readonly InputActionValue[]): void {
  for (const { action, value } of values) {
    const previous = target.get(action) ?? 0;
    if (Math.abs(value) > Math.abs(previous)) target.set(action, value);
  }
}

function keyboardCode(event: Event): string | null {
  const code = (event as Event & Readonly<{ code?: unknown }>).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function gamepadEventIndex(event: Event): number | null {
  const index = (event as Event & Readonly<{ gamepad?: Readonly<{ index?: unknown }> }>).gamepad?.index;
  return Number.isSafeInteger(index) && (index as number) >= 0 && (index as number) <= 31 ? index as number : null;
}

function defaultGamepadProvider(): ArrayLike<StandardGamepadSnapshot | null> {
  return typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function' ? EMPTY_GAMEPADS : navigator.getGamepads();
}

function range(value:number,minimum:number,maximum:number,label:string,integer=false):number {
  if (!(integer?Number.isSafeInteger(value):Number.isFinite(value)) || value<minimum || value>maximum) throw new RangeError(`${label} must be ${integer?'an integer':'a finite number'} from ${minimum} to ${maximum}.`);
  return value;
}

function snapshot<T extends object>(value:T):Readonly<T & {hash:string}> {
  return Object.freeze({...value,hash:hashSimulationState(value as unknown as SimulationStateValue)});
}
