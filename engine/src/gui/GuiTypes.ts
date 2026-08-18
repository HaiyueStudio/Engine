export const enum GuiDirtyFlags {
  None = 0,
  Layout = 1 << 0,
  Visual = 1 << 1,
  Text = 1 << 2,
  Input = 1 << 3,
  Children = 1 << 4,
  All = Layout | Visual | Text | Input | Children,
}

export type GuiLength = number | `${number}%`;

export interface GuiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GuiStyle {
  backgroundColor?: string;
  borderColor?: string;
  color?: string;
  opacity?: number;
  radius?: number;
  padding?: number;
}

export interface GuiTheme {
  fontFamily: string;
  fontSize: number;
  radius: number;
  colors: {
    text: string;
    textMuted: string;
    primary: string;
    danger: string;
    background: string;
    surface: string;
    border: string;
    hover: string;
    active: string;
    disabled: string;
  };
}

export const DEFAULT_GUI_THEME: GuiTheme = {
  fontFamily: 'sans-serif',
  fontSize: 14,
  radius: 6,
  colors: {
    text: '#f8fafc',
    textMuted: '#94a3b8',
    primary: '#2563eb',
    danger: '#dc2626',
    background: '#020617',
    surface: '#1e293b',
    border: '#475569',
    hover: '#334155',
    active: '#1d4ed8',
    disabled: '#64748b',
  },
};

export interface GuiPointerEvent {
  type: 'pointerenter' | 'pointerleave' | 'pointerdown' | 'pointermove' | 'pointerup' | 'click';
  target: unknown;
  currentTarget: unknown;
  x: number;
  y: number;
  localX: number;
  localY: number;
  button: number;
  buttons: number;
  pointerId: number;
  nativeEvent: PointerEvent;
  stopped: boolean;
  defaultPrevented: boolean;
  stopPropagation(): void;
  preventDefault(): void;
}

export type GuiPointerHandler = (event: GuiPointerEvent) => void;
export type GuiValueChangeHandler<T> = (value: T) => void;

export interface GuiElementOptions {
  id?: string | undefined;
  x?: GuiLength | undefined;
  y?: GuiLength | undefined;
  width?: GuiLength | undefined;
  height?: GuiLength | undefined;
  visible?: boolean | undefined;
  disabled?: boolean | undefined;
  style?: GuiStyle | undefined;
  onPointerEnter?: GuiPointerHandler;
  onPointerLeave?: GuiPointerHandler;
  onPointerDown?: GuiPointerHandler;
  onPointerMove?: GuiPointerHandler;
  onPointerUp?: GuiPointerHandler;
  onClick?: GuiPointerHandler;
}

export function resolveGuiLength(value: GuiLength | undefined, parentSize: number, fallback: number): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.endsWith('%')) {
    const ratio = Number.parseFloat(value.slice(0, -1));
    return Number.isFinite(ratio) ? parentSize * ratio / 100 : fallback;
  }
  return fallback;
}

export function containsPoint(rect: GuiRect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height;
}
