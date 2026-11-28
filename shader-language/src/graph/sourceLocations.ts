import type {ShaderGraphSourceLocation} from './contracts';

interface Frame {
  readonly kind: 'object' | 'array';
  readonly root: boolean;
  readonly nodes: boolean;
  readonly node: boolean;
  expectsKey: boolean;
  key?: string;
  keyLocation?: ShaderGraphSourceLocation;
  id?: string;
  idLocation?: ShaderGraphSourceLocation;
}

/** Index provenance once, after JSON validation; this scanner does not interpret graph semantics. */
export function shaderGraphNodeLocations(source: string): Readonly<Record<string, ShaderGraphSourceLocation>> {
  const stack: Frame[] = [], locations = new Map<string, ShaderGraphSourceLocation>();
  let index = 0, line = 1, column = 1;
  while (index < source.length) {
    const character = source[index], parent = stack[stack.length - 1];
    if (character === '"') {
      const start = index++, startColumn = column;
      while (index < source.length) {
        const next = source[index++];
        if (next === '\\') index++;
        else if (next === '"') break;
      }
      if (parent?.kind === 'object') {
        if (parent.expectsKey) {
          parent.key = JSON.parse(source.slice(start, index)) as string;
          parent.keyLocation = Object.freeze({line, column: startColumn});
          parent.expectsKey = false;
        } else if (parent.node && parent.key === 'id') {
          parent.id = JSON.parse(source.slice(start, index)) as string;
          parent.idLocation = parent.keyLocation!;
        }
      }
      column += index - start;
      continue;
    }
    if (character === '{' || character === '[') {
      const nodes = character === '[' && !!parent?.root && parent.key === 'nodes';
      // JSON permits duplicate root keys; provenance follows the final nodes value too.
      if (nodes) locations.clear();
      stack.push({kind: character === '{' ? 'object' : 'array', root: stack.length === 0,
        nodes, node: character === '{' && !!parent?.nodes, expectsKey: character === '{'});
    } else if (character === '}' || character === ']') {
      const frame = stack.pop();
      if (frame?.node && frame.id !== undefined && frame.idLocation) locations.set(frame.id, frame.idLocation);
    } else if (character === ',' && parent?.kind === 'object') {
      parent.expectsKey = true;
      delete parent.key; delete parent.keyLocation;
    }
    index++;
    if (character === '\n') {line++; column = 1;} else column++;
  }
  return Object.freeze(Object.fromEntries(locations));
}
