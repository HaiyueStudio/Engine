import { hashSimulationState, type SimulationStateValue } from '../simulation/StateHash';
import { InputActionMap, type InputActionMapDescriptor, type InputActionValue, type StandardGamepadSnapshot } from './InputActionMap';

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

interface PlayerRuntime {
  readonly id: string;
  readonly actionMap: InputActionMap;
  readonly gamepadIndex: number | null;
  readonly previous: Map<string, number>;
}

/** Owner-safe browser keyboard/gamepad sampler that emits immutable per-player tick snapshots. */
export class BrowserMultiplayerInput {
  readonly actionThreshold: number;
  readonly #players: readonly PlayerRuntime[];
  readonly #eventTarget: EventTarget | null;
  readonly #visibilityTarget: (EventTarget & Readonly<{ hidden?: boolean }>) | null;
  readonly #getGamepads: () => ArrayLike<StandardGamepadSnapshot | null>;
  readonly #preventDefault: boolean;
  readonly #keys = new Set<string>();
  readonly #mappedKeys = new Set<string>();
  readonly #disconnectedGamepads = new Set<number>();
  #tick = 0;
  #disposed = false;
  #suspended = false;

  readonly #onKeyDown = (event: Event): void => {
    const code = keyboardCode(event);
    if (!code || !this.#mappedKeys.has(code)) return;
    this.#keys.add(code);
    if (this.#preventDefault) event.preventDefault();
  };

  readonly #onKeyUp = (event: Event): void => {
    const code = keyboardCode(event);
    if (!code || !this.#mappedKeys.has(code)) return;
    this.#keys.delete(code);
    if (this.#preventDefault) event.preventDefault();
  };

  readonly #onRelease = (): void => { this.#keys.clear(); };
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
    if (this.#suspended) this.#keys.clear();
  };

  constructor(options: BrowserMultiplayerInputOptions) {
    if (!options || !Array.isArray(options.players) || options.players.length < 1 || options.players.length > 8) {
      throw new TypeError('Browser multiplayer input requires from 1 to 8 players.');
    }
    this.actionThreshold = finiteRange(options.actionThreshold ?? 0.5, 0.000_001, 1, 'actionThreshold');
    const ids = new Set<string>();
    this.#players = Object.freeze(options.players.map((descriptor, index) => {
      const id = normalizePlayerId(descriptor.id);
      if (ids.has(id)) throw new TypeError(`Browser multiplayer input player id is duplicated: ${id}.`);
      ids.add(id);
      const actionMap = new InputActionMap(descriptor.bindings);
      for (const binding of Object.values(actionMap.toJSON())) for (const code of binding.keys ?? []) this.#mappedKeys.add(code);
      const gamepadIndex = descriptor.gamepadIndex === undefined ? null : integerRange(descriptor.gamepadIndex, 0, 31, `players[${index}].gamepadIndex`);
      return { id, actionMap, gamepadIndex, previous: new Map<string, number>() };
    }));
    this.#eventTarget = options.eventTarget ?? defaultEventTarget();
    this.#visibilityTarget = options.visibilityTarget ?? defaultVisibilityTarget();
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

  sample(tick: number): MultiplayerInputSnapshot {
    this.#assertLive();
    if (!Number.isSafeInteger(tick) || tick !== this.#tick + 1) throw new RangeError(`Browser multiplayer input tick must advance exactly from ${this.#tick} to ${this.#tick + 1}.`);
    this.#tick = tick;
    const gamepads = this.#suspended ? EMPTY_GAMEPADS : this.#getGamepads();
    const players = this.#players.map(player => this.#samplePlayer(player, gamepads));
    const value = { tick, players } as unknown as SimulationStateValue;
    return Object.freeze({ tick, players: Object.freeze(players), hash: hashSimulationState(value) });
  }

  /** Release held physical state while retaining the previous frame so the next sample reports releases. */
  release(): this {
    this.#assertLive();
    this.#keys.clear();
    return this;
  }

  /** Restart tick ownership and discard every held/previous action without reattaching listeners. */
  reset(): this {
    this.#assertLive();
    this.#tick = 0;
    this.#keys.clear();
    this.#disconnectedGamepads.clear();
    for (const player of this.#players) player.previous.clear();
    return this;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#keys.clear();
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
    if (!this.#suspended) mergeValues(values, player.actionMap.sampleKeyboard(this.#keys));
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
    const value = { id: player.id, actions } as unknown as SimulationStateValue;
    return Object.freeze({ id: player.id, actions: Object.freeze(actions), hash: hashSimulationState(value) });
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

function defaultEventTarget(): EventTarget | null {
  return typeof globalThis.addEventListener === 'function' ? globalThis : null;
}

function defaultVisibilityTarget(): (EventTarget & Readonly<{ hidden?: boolean }>) | null {
  return typeof document === 'undefined' ? null : document;
}

function defaultGamepadProvider(): ArrayLike<StandardGamepadSnapshot | null> {
  return typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function' ? EMPTY_GAMEPADS : navigator.getGamepads();
}

function normalizePlayerId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,31}$/u.test(value)) throw new TypeError('Browser multiplayer input player id is invalid.');
  return value;
}

function finiteRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`${label} must be a finite number from ${minimum} to ${maximum}.`);
  return value;
}

function integerRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
