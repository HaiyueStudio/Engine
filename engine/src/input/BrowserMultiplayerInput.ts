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
    bindings: InputActionMapDescriptor | InputActionMap;
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
  bindings: InputActionMapDescriptor;
  readonly blockedKeys: Set<string>;
  readonly blockedPointers: Set<number>;
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
  readonly #pointers = new Set<number>();
  readonly #unconsumedPointers = new Set<number>();
  readonly #disconnectedGamepads = new Set<number>();
  #sampling?:boolean;
  #tick = 0;
  #disposed = false;
  #suspended = false;

  readonly #onKeyDown = (event: Event): void => {
    const code = keyboardCode(event);
    if (!code || !this.#players.some(p=>p.actionMap.actionsForKey(code).length)) return;
    if(!this.#keys.has(code) && !(event as KeyboardEvent).repeat)this.#unconsumedKeys.add(code);
    this.#keys.add(code);
    if(isInputEventConsumed(event))this.#unconsumedKeys.delete(code);
    if (this.#preventDefault) event.preventDefault();
  };

  readonly #onKeyUp = (event: Event): void => {
    const code = keyboardCode(event);
    if (!code || (!this.#keys.has(code) && !this.#players.some(p=>p.actionMap.actionsForKey(code).length))) return;
    this.#keys.delete(code);
    this.#unconsumedKeys.delete(code);
    for(const player of this.#players)player.blockedKeys.delete(code);
    if (this.#preventDefault) event.preventDefault();
  };

  readonly #onPointerDown = (event: Event): void => {
    const button = pointerButton(event); if(button === null || !this.#players.some(p=>p.actionMap.actionsForPointerButton(button).length))return;
    if(!this.#pointers.has(button))this.#unconsumedPointers.add(button);this.#pointers.add(button);
    if(isInputEventConsumed(event))this.#unconsumedPointers.delete(button);
    if(this.#preventDefault)event.preventDefault();
  };
  readonly #onPointerUp = (event: Event): void => {
    const button = pointerButton(event);if(button===null)return;
    this.#pointers.delete(button);this.#unconsumedPointers.delete(button);
    for(const player of this.#players)player.blockedPointers.delete(button);
  };
  readonly #onPointerCancel = (): void => {this.#pointers.clear();this.#unconsumedPointers.clear();for(const player of this.#players)player.blockedPointers.clear();};
  readonly #onRelease = (): void => {this.#keys.clear();this.#unconsumedKeys.clear();this.#onPointerCancel();this.#gamepadLayers.release();};
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
      const actionMap = descriptor.bindings instanceof InputActionMap ? descriptor.bindings : new InputActionMap(descriptor.bindings);
      const gamepadIndex = descriptor.gamepadIndex === undefined ? null : range(descriptor.gamepadIndex, 0, 31, `players[${index}].gamepadIndex`, true);
      return { id, actionMap, gamepadIndex, previous: new Map<string, number>(),bindings:actionMap.toJSON(),blockedKeys:new Set<string>(),blockedPointers:new Set<number>() };
    }));
    this.#eventTarget = options.eventTarget ?? (typeof globalThis.addEventListener==='function'?globalThis:null);
    this.#visibilityTarget = options.visibilityTarget ?? (typeof document==='undefined'?null:document);
    this.#getGamepads = options.getGamepads ?? defaultGamepadProvider;
    this.#preventDefault = options.preventDefault ?? false;
    this.#eventTarget?.addEventListener('keydown', this.#onKeyDown);
    this.#eventTarget?.addEventListener('keyup', this.#onKeyUp);
    this.#eventTarget?.addEventListener('pointerdown',this.#onPointerDown);
    this.#eventTarget?.addEventListener('pointerup',this.#onPointerUp);
    this.#eventTarget?.addEventListener('pointercancel',this.#onPointerCancel);
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
    this.#refreshBindings();
    const gamepads = this.#suspended?EMPTY_GAMEPADS:this.#gamepadLayers.route(Array.from(rawGamepads,(pad,index)=>this.#disconnectedGamepads.has(index)?null:pad),this.actionThreshold);
    this.#assertLive();if(this.#tick!==tick)throw new Error('Browser multiplayer input tick changed during routing.');
    const changed=this.#refreshBindings();
    const players = this.#players.map(player => this.#samplePlayer(player, gamepads,changed.has(player)));
    return snapshot({tick,players:Object.freeze(players)});
    }finally{this.#sampling=false;}
  }

  release(): this {
    this.#assertLive();
    this.#keys.clear();
    this.#unconsumedKeys.clear();
    this.#onPointerCancel();
    this.#gamepadLayers.release();
    return this;
  }

  reset(): this {
    this.#assertLive();
    this.#tick = 0;
    this.#keys.clear();
    this.#unconsumedKeys.clear();this.#gamepadLayers.clear();
    this.#onPointerCancel();
    this.#disconnectedGamepads.clear();
    for (const player of this.#players) player.previous.clear();
    return this;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#keys.clear();
    this.#unconsumedKeys.clear();this.#gamepadLayers.dispose();
    this.#onPointerCancel();
    this.#disconnectedGamepads.clear();
    for (const player of this.#players) player.previous.clear();
    this.#eventTarget?.removeEventListener('keydown', this.#onKeyDown);
    this.#eventTarget?.removeEventListener('keyup', this.#onKeyUp);
    this.#eventTarget?.removeEventListener('pointerdown',this.#onPointerDown);
    this.#eventTarget?.removeEventListener('pointerup',this.#onPointerUp);
    this.#eventTarget?.removeEventListener('pointercancel',this.#onPointerCancel);
    this.#eventTarget?.removeEventListener('blur', this.#onRelease);
    this.#eventTarget?.removeEventListener('gamepadconnected', this.#onGamepadConnected);
    this.#eventTarget?.removeEventListener('gamepaddisconnected', this.#onGamepadDisconnected);
    this.#visibilityTarget?.removeEventListener('visibilitychange', this.#onVisibilityChange);
  }

  #refreshBindings():Set<PlayerRuntime> {
    const changed=new Set<PlayerRuntime>();
    for(const player of this.#players)if(player.bindings!==player.actionMap.toJSON()){
      changed.add(player);player.bindings=player.actionMap.toJSON();
      for(const code of this.#keys)player.blockedKeys.add(code);
      for(const button of this.#pointers)player.blockedPointers.add(button);
      if(player.gamepadIndex!==null)this.#gamepadLayers.release([player.gamepadIndex]);
    }
    return changed;
  }
  #samplePlayer(player: PlayerRuntime, gamepads: ArrayLike<StandardGamepadSnapshot | null>,bindingChanged=false): PlayerInputSnapshot {
    const values = new Map<string, number>();
    if (!this.#suspended) {
      mergeValues(values, player.actionMap.sampleKeyboard([...this.#unconsumedKeys].filter(code=>!player.blockedKeys.has(code))));
      for(const button of this.#unconsumedPointers)if(!player.blockedPointers.has(button))for(const action of player.actionMap.actionsForPointerButton(button))if(Math.abs(values.get(action)??0)<1)values.set(action,1);
    }
    const gamepad = bindingChanged || player.gamepadIndex === null || this.#disconnectedGamepads.has(player.gamepadIndex) ? null : gamepads[player.gamepadIndex] ?? null;
    mergeValues(values, player.actionMap.sampleGamepad(gamepad));
    const names = [...new Set([...player.actionMap.actionNames(),...player.previous.keys()])].sort();
    const actions = names.map(action => {
      const value = values.get(action) ?? 0;
      const previous = player.previous.get(action) ?? 0;
      const held = Math.abs(value) >= this.actionThreshold;
      const wasHeld = Math.abs(previous) >= this.actionThreshold;
      if(player.actionMap.hasAction(action))player.previous.set(action, value);else player.previous.delete(action);
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
function pointerButton(event: Event): number | null {
  const button=(event as PointerEvent).button;return Number.isSafeInteger(button)&&button>=0&&button<=31?button:null;
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
