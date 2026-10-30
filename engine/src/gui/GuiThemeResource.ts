import type {GuiSkin, GuiThemeState, GuiThemeResourceBinding} from './GuiThemeTypes';

type Layers = Readonly<Partial<Record<'normal' | keyof GuiThemeState, GuiSkin>>>;
interface Definition extends Layers {
  readonly parent?: GuiThemeResource;
  readonly controls?: Readonly<Record<string, Layers>>;
}
interface State {
  definition: Definition;
  version: number;
  disposed: boolean;
  listeners: Set<() => void>;
  parentOff: (() => void) | null;
}
const states = new WeakMap<GuiThemeResource, State>();
const order = ['normal', 'hover', 'focus', 'pressed', 'disabled'] as const;
const empty: GuiSkin = Object.freeze({});
let revision = 0;

function skin(value: GuiSkin): GuiSkin {
  for (const name of ['fontSize', 'iconSize', 'iconGap', 'radius', 'padding', 'opacity'] as const) {
    const number = value[name];
    if (number !== undefined && (!Number.isFinite(number) || number < 0 || (name === 'opacity' && number > 1))) throw new RangeError(`Invalid theme ${name}.`);
  }
  if (value.fontFamily !== undefined && (typeof value.fontFamily !== 'string' || !value.fontFamily.trim())) throw new TypeError('Invalid theme font family.');
  let insets = value.contentInsets;
  if (insets) {
    if (['top', 'right', 'bottom', 'left'].some(key => !Number.isFinite(insets![key as keyof typeof insets]) || insets![key as keyof typeof insets] < 0)) throw new RangeError('Invalid theme content insets.');
    insets = Object.freeze({...insets});
  }
  // Texture/font objects are borrowed. Only configuration containers are frozen.
  const nineSlice = value.nineSlice;
  if (value.palette) for (const [name, color] of Object.entries(value.palette)) {
    if (!['text','textMuted','primary','danger','background','surface','border','hover','active','disabled'].includes(name) || typeof color !== 'string') throw new TypeError('Invalid GUI theme palette token.');
  }
  if (nineSlice && (!Number.isFinite(nineSlice.sourceWidth) || nineSlice.sourceWidth <= 0 || !Number.isFinite(nineSlice.sourceHeight) || nineSlice.sourceHeight <= 0 || nineSlice.cuts.length !== 4 || nineSlice.cuts.some(v => !Number.isFinite(v) || v < 0) || nineSlice.cuts[0] + nineSlice.cuts[2] > nineSlice.sourceWidth || nineSlice.cuts[1] + nineSlice.cuts[3] > nineSlice.sourceHeight)) throw new RangeError('Invalid theme nine-slice borders.');
  if (nineSlice?.pixelRatio !== undefined && (!Number.isFinite(nineSlice.pixelRatio) || nineSlice.pixelRatio <= 0)) throw new RangeError('Invalid theme nine-slice pixel ratio.');
  if (nineSlice?.uv && (nineSlice.uv.length !== 4 || nineSlice.uv.some(v => !Number.isFinite(v) || v < 0) || nineSlice.uv[0] + nineSlice.uv[2] > 1 || nineSlice.uv[1] + nineSlice.uv[3] > 1)) throw new RangeError('Invalid theme atlas UV rectangle.');
  const sliceInsets = nineSlice?.contentInsets;
  if (sliceInsets && ['top','right','bottom','left'].some(key => !Number.isFinite(sliceInsets[key as keyof typeof sliceInsets]) || sliceInsets[key as keyof typeof sliceInsets] < 0)) throw new RangeError('Invalid theme skin content insets.');
  return Object.freeze({...Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)),
    ...(insets ? {contentInsets: insets} : {}),
    ...(value.palette ? {palette: Object.freeze({...value.palette})} : {}),
    ...(nineSlice ? {nineSlice: Object.freeze({...nineSlice, cuts: Object.freeze([...nineSlice.cuts]) as typeof nineSlice.cuts, ...(nineSlice.uv ? {uv: Object.freeze([...nineSlice.uv]) as typeof nineSlice.uv} : {}), ...(sliceInsets ? {contentInsets: Object.freeze({...sliceInsets})} : {})})} : {}),
  });
}

function layers(value: Layers): Layers {
  const result: Partial<Record<typeof order[number], GuiSkin>> = {};
  for (const key of order) if (value[key]) result[key] = skin(value[key]!);
  return Object.freeze(result);
}

function snapshot(resource: GuiThemeResource, definition: Definition): Definition {
  const seen = new Set([resource]);
  for (let parent = definition.parent; parent; parent = states.get(parent)?.definition.parent) {
    if (seen.has(parent) || seen.size >= 128 || !states.has(parent)) throw new TypeError('Invalid or cyclic GUI theme inheritance.');
    seen.add(parent);
  }
  const controls: Record<string, Layers> = Object.create(null) as Record<string, Layers>;
  for (const [key, value] of Object.entries(definition.controls ?? {})) {
    if (!key || key === '*') throw new TypeError('Control theme keys must be nonempty named control types.');
    controls[key] = layers(value);
  }
  return Object.freeze({...layers(definition), ...(definition.parent ? {parent: definition.parent} : {}), controls: Object.freeze(controls)});
}

function notify(state: State): void {
  const errors: unknown[] = [];
  for (const listener of [...state.listeners]) if (state.listeners.has(listener)) {
    try {listener();} catch (error) {errors.push(error);}
  }
  if (errors.length) throw new AggregateError(errors, 'GUI theme subscriber failed.');
}

/** Reusable borrowed resource; roots subscribe while attached and never dispose it. */
export class GuiThemeResource implements GuiThemeResourceBinding {
  constructor(definition: Definition = {}) {
    const captured = snapshot(this, definition);
    states.set(this, {definition: captured, version: ++revision, disposed: false, listeners: new Set(), parentOff: null});
  }

  get version(): number {
    const state = states.get(this)!;
    return Math.max(state.version, state.definition.parent?.version ?? 0);
  }

  /** '*' resolves inherited defaults; named controls resolve only their type layer. */
  resolve(controlType: string, active: GuiThemeState): GuiSkin {
    const state = states.get(this)!;
    if (state.disposed) return empty;
    const definitions: Definition[] = [];
    for (let current: GuiThemeResource | undefined = this; current; current = states.get(current)!.definition.parent) definitions.unshift(states.get(current)!.definition);
    const result: GuiSkin = {};
    for (const key of order) if (key === 'normal' || active[key]) for (const definition of definitions) {
      const selected = controlType === '*' ? definition : definition.controls?.[controlType];
      const part = selected?.[key];
      const palette = part?.palette ? {...result.palette, ...part.palette} : result.palette;
      Object.assign(result, part, ...(palette ? [{palette}] : []));
    }
    return Object.freeze(result);
  }

  /** Replace atomically; callers can retain/update multiple independent theme instances. */
  update(definition: Definition): void {
    const state = states.get(this)!;
    if (state.disposed) throw new Error('GUI theme resource is disposed.');
    const captured = snapshot(this, definition);
    state.parentOff?.(); state.parentOff = null;
    state.definition = captured; state.version = ++revision;
    this.observeParent();
    notify(state);
  }

  subscribe(changed: () => void): () => void {
    const state = states.get(this)!;
    if (state.disposed) return () => {};
    // Each call owns its own registration even when callback identity is reused.
    const listener = () => changed();
    state.listeners.add(listener); this.observeParent();
    return () => {
      state.listeners.delete(listener);
      if (!state.listeners.size) {state.parentOff?.(); state.parentOff = null;}
    };
  }

  dispose(): void {
    const state = states.get(this)!;
    if (state.disposed) return;
    state.disposed = true; state.version = ++revision;
    state.parentOff?.(); state.parentOff = null;
    state.definition = Object.freeze({});
    try {notify(state);} finally {state.listeners.clear();}
  }

  private observeParent(): void {
    const state = states.get(this)!;
    if (state.listeners.size && !state.parentOff && state.definition.parent) {
      state.parentOff = state.definition.parent.subscribe(() => {state.version = ++revision; notify(state);});
    }
  }
}
