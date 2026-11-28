import type {GuiStyle} from './GuiTypes';
import type {GuiSkin, GuiThemeState} from './GuiThemeTypes';

/** The old hover/focus/pressed/disabled ordering is retained; disabled always wins. */
export const guiStyleStateOrder = ['checked','selected','readOnly','open','hover','focus','pressed','invalid','loading','disabled'] as const;
export function sameGuiStyleValue(a:unknown,b:unknown,depth=0):boolean {
  if(Object.is(a,b))return true;
  if(depth>20||!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  const plain=(value:object)=>Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null;
  if(!plain(a)||!plain(b))return false;
  const x=a as Record<string,unknown>,y=b as Record<string,unknown>,keys=Object.keys(x);if(keys.length!==Object.keys(y).length)return false;
  return keys.every(key=>Object.hasOwn(y,key)&&(key==='icon'||key==='source'?Object.is(x[key],y[key]):sameGuiStyleValue(x[key],y[key],depth+1)));
}

export function mergeGuiStyle(target: GuiStyle, source: Readonly<GuiStyle> | undefined, depth=0): void {
  if (!source) return;
  if(depth>16)throw new TypeError('GUI style merge exceeds nesting bounds.');
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key === 'palette') target.palette = {...target.palette, ...source.palette};
    else if (key === 'parts' || key === 'states') {
      const parts: Record<string, GuiStyle> = {...target[key]};
      for (const [name, part] of Object.entries(source[key] ?? {})) {const merged = {...parts[name]}; mergeGuiStyle(merged, part,depth+1); parts[name] = merged;}
      target[key] = parts;
    } else (target as Record<string, unknown>)[key] = value;
  }
}

export function guiStyleLayer(style: Readonly<GuiStyle>, state: GuiThemeState): GuiSkin {
  const result: GuiStyle = {}; mergeGuiStyle(result, style);
  for (const key of guiStyleStateOrder) if (state[key]) mergeGuiStyle(result, style.states?.[key]);
  delete result.states;
  return result;
}

/** Copy configuration only. Never freeze a caller's image, canvas or GPU texture. */
export function captureGuiStyle(value: Readonly<GuiStyle>, depth = 0, seen = new Set<object>()): GuiStyle {
  if (depth > 16 || seen.has(value)) throw new TypeError('Cyclic or excessively deep GUI style.');
  seen.add(value);
  try {
    for (const key of ['fontSize','fontWeight','lineHeight','borderWidth','radius','padding','paddingY','iconSize','iconGap','focusWidth','clipRadius','opacity'] as const) {
      const n = value[key];
      if (n !== undefined && (!Number.isFinite(n) || n < 0 || key === 'opacity' && n > 1 || key === 'fontWeight' && (n < 1 || n > 1000))) throw new RangeError(`Invalid GUI style ${key}.`);
    }
    if (value.iconRotation !== undefined && !Number.isFinite(value.iconRotation)) throw new RangeError('Invalid GUI icon rotation.');
    if (value.cornerRadii && (value.cornerRadii.length !== 4 || value.cornerRadii.some(n => !Number.isFinite(n) || n < 0))) throw new RangeError('Invalid GUI corner radii.');
    if (value.shadow && (typeof value.shadow.color !== 'string' || !Number.isFinite(value.shadow.blur) || value.shadow.blur < 0 || value.shadow.blur > 128 || ['x','y','spread'].some(k => {const n = value.shadow![k as 'x'|'y'|'spread']; return n !== undefined && !Number.isFinite(n);}))) throw new RangeError('Invalid GUI shadow.');
    if (value.gradient && (typeof value.gradient.from !== 'string' || typeof value.gradient.to !== 'string' || value.gradient.angle !== undefined && !Number.isFinite(value.gradient.angle))) throw new TypeError('Invalid GUI gradient.');
    if (value.textOverflow !== undefined && !['clip','ellipsis'].includes(value.textOverflow)) throw new TypeError('Invalid GUI text overflow.');
    if(value.states&&Object.keys(value.states).some(key=>!(guiStyleStateOrder as readonly string[]).includes(key)))throw new TypeError('Unknown GUI visual state.');
    const nested = (record: Readonly<Record<string, GuiStyle>> | undefined): Readonly<Record<string, GuiStyle>> | undefined => record && Object.freeze(Object.fromEntries(Object.entries(record).map(([name, style]) => {
      if (!name || ['__proto__','prototype','constructor'].includes(name)) throw new TypeError('Invalid GUI style part/state name.');
      return [name, captureGuiStyle(style, depth + 1, seen)];
    })));
    return Object.freeze({...value,
      ...(value.palette ? {palette: Object.freeze({...value.palette})} : {}),
      ...(value.cornerRadii ? {cornerRadii: Object.freeze([...value.cornerRadii]) as typeof value.cornerRadii} : {}),
      ...(value.shadow ? {shadow: Object.freeze({...value.shadow})} : {}),
      ...(value.gradient ? {gradient: Object.freeze({...value.gradient})} : {}),
      ...(value.parts ? {parts: nested(value.parts)!} : {}),
      ...(value.states ? {states: nested(value.states)!} : {}),
    });
  } finally {seen.delete(value);}
}
