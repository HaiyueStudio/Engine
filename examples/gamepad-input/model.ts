import type {InputActionMapDescriptor, PlayerInputSnapshot} from '@haiyue/engine/experimental/simulation';

export const BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Menu', 'L3', 'R3', 'Up', 'Down', 'Left', 'Right', 'Home'] as const;
export const AXES = ['LeftX', 'LeftY', 'RightX', 'RightY'] as const;
export const bindings: InputActionMapDescriptor = Object.fromEntries([
  ...BUTTONS.map((name, index) => [name, {gamepadButtons: [index]}]),
  // The diagram shows physical travel, not a game-specific dead-zone remapping.
  ...AXES.map((name, axis) => [name, {gamepadAxes: [{axis, deadZone: 0}]}]),
]);
export const LOG_LIMIT = 100;
export interface Operation {id: number; time: number; control: string; detail: string}

/** Edge logging and rate-limited analog changes; held input never fills the log each frame. */
export class OperationLog {
  readonly entries: Operation[] = [];
  revision = 0;
  private serial = 0;
  private analog = new Map<string, {value: number[]; time: number; active: boolean}>();

  add(time: number, control: string, detail: string): void {
    this.entries.unshift({id: ++this.serial, time, control, detail});
    this.entries.length = Math.min(this.entries.length, LOG_LIMIT);
    this.revision++;
  }
  clear(): void { this.entries.length = 0; this.revision++; }
  reset(): void { this.analog.clear(); }
  sample(frame: PlayerInputSnapshot, time: number): void {
    const values = Object.fromEntries(frame.actions.map(action => [action.action, action.value]));
    for (const action of frame.actions) {
      if (!(BUTTONS as readonly string[]).includes(action.action) || action.action === 'LT' || action.action === 'RT') continue;
      if (action.pressed) this.add(time, action.action, '按下');
      if (action.released) this.add(time, action.action, '松开');
    }
    for (const [name, keys] of [['左摇杆', ['LeftX', 'LeftY']], ['右摇杆', ['RightX', 'RightY']], ['LT', ['LT']], ['RT', ['RT']]] as const) {
      const value = keys.map(key => values[key] ?? 0);
      const active = value.some(v => Math.abs(v) > (keys.length === 2 ? 0.12 : 0.02));
      const previous = this.analog.get(name) ?? {value: keys.map(() => 0), time: -Infinity, active: false};
      const changed = value.some((v, i) => Math.abs(v - previous.value[i]!) >= 0.08);
      if (active !== previous.active || (active && changed && time - previous.time >= 160)) {
        this.add(time, name, !active ? (keys.length === 2 ? '回中' : '松开') : keys.length === 2 ? `X ${value[0]!.toFixed(2)} · Y ${value[1]!.toFixed(2)}` : `压力 ${Math.round(value[0]! * 100)}%`);
        this.analog.set(name, {value, time, active});
      }
    }
  }
}
