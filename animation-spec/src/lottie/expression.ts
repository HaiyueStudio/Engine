import {
  HYA_SAFE_EXPRESSION_VERSION,
  parseSafeExpressionProgram,
  type AnimationSafeExpressionBinaryOperator,
  type AnimationSafeExpressionFunction,
  type AnimationSafeExpressionInstruction,
  type AnimationSafeExpressionProgram,
} from '../expression';

export interface LottieTextExpressionCompileOptions {
  readonly resolveDataLayer: (name: string) => string | undefined;
}

export class LottieTextExpressionCompileError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
    this.name = 'LottieTextExpressionCompileError';
  }
}

type AstNode =
  | { readonly kind: 'literal'; readonly value: number | string | boolean | null; readonly offset: number }
  | { readonly kind: 'identifier'; readonly name: string; readonly offset: number }
  | { readonly kind: 'unary'; readonly operator: '+' | '-' | '!'; readonly argument: AstNode; readonly offset: number }
  | { readonly kind: 'binary'; readonly operator: string; readonly left: AstNode; readonly right: AstNode; readonly offset: number }
  | { readonly kind: 'conditional'; readonly test: AstNode; readonly consequent: AstNode; readonly alternate: AstNode; readonly offset: number }
  | { readonly kind: 'member'; readonly object: AstNode; readonly property: string; readonly offset: number }
  | { readonly kind: 'call'; readonly callee: AstNode; readonly arguments: readonly AstNode[]; readonly offset: number }
  | { readonly kind: 'assignment'; readonly target: string; readonly value: AstNode; readonly offset: number };

type AstStatement =
  | { readonly kind: 'variable'; readonly declarations: readonly { readonly name: string; readonly initializer?: AstNode; readonly offset: number }[] }
  | { readonly kind: 'expression'; readonly expression: AstNode };

interface Token {
  readonly kind: 'identifier' | 'number' | 'string' | 'punctuation' | 'operator' | 'eof';
  readonly value: string | number;
  readonly offset: number;
}

interface DataReference { readonly resource: string; readonly path: readonly string[]; }

/** Compiles a strict AE/Bodymovin expression subset without evaluating source code. */
export function compileLottieTextExpression(
  source: string,
  options: Readonly<LottieTextExpressionCompileOptions>,
): AnimationSafeExpressionProgram {
  const statements = new Parser(source).parseProgram();
  const instructions: AnimationSafeExpressionInstruction[] = [];
  const locals = new Map<string, number>();
  const dataAliases = new Map<string, DataReference>();
  let outputSlot: number | undefined;
  let lastValueStatement = -1;
  for (let index = statements.length - 1; index >= 0; index--) {
    if (statements[index]!.kind === 'expression') { lastValueStatement = index; break; }
  }

  const allocateLocal = (name: string, offset: number): number => {
    const existing = locals.get(name);
    if (existing !== undefined) return existing;
    if (locals.size >= 16) throw compileError('Expression declares too many local variables.', offset);
    const index = locals.size;
    locals.set(name, index);
    return index;
  };

  const emitNode = (node: AstNode): void => {
    const data = resolveDataReference(node, dataAliases, options);
    if (data) {
      if (data.path.length === 0) throw compileError('Data Layer references must select a primitive field.', node.offset);
      instructions.push({ op: 'data', resource: data.resource, path: data.path });
      return;
    }
    switch (node.kind) {
      case 'literal': instructions.push({ op: 'constant', value: node.value }); return;
      case 'identifier': {
        if (node.name === 'time') { instructions.push({ op: 'time' }); return; }
        if (node.name === 'value') { instructions.push({ op: 'text' }); return; }
        const index = locals.get(node.name);
        if (index === undefined) throw compileError(`Unknown expression identifier "${node.name}".`, node.offset);
        instructions.push({ op: 'local.get', index });
        return;
      }
      case 'unary':
        emitNode(node.argument);
        instructions.push({ op: 'unary', operator: node.operator === '+' ? 'positive' : node.operator === '-' ? 'negative' : 'not' });
        return;
      case 'binary':
        emitNode(node.left);
        emitNode(node.right);
        instructions.push({ op: 'binary', operator: binaryOperator(node.operator, node.offset) });
        return;
      case 'conditional':
        emitNode(node.test);
        {
          const branchIndex = instructions.length;
          instructions.push({ op: 'branch.false', target: branchIndex + 1 });
          emitNode(node.consequent);
          const jumpIndex = instructions.length;
          instructions.push({ op: 'jump', target: jumpIndex + 1 });
          (instructions[branchIndex] as { op: 'branch.false'; target: number }).target = instructions.length;
          emitNode(node.alternate);
          (instructions[jumpIndex] as { op: 'jump'; target: number }).target = instructions.length;
        }
        return;
      case 'call': emitCall(node); return;
      case 'assignment': throw compileError('Nested assignments are not supported.', node.offset);
      case 'member':
        if (node.object.kind === 'identifier' && node.object.name === 'Math' && (node.property === 'PI' || node.property === 'E')) {
          instructions.push({ op: 'constant', value: node.property === 'PI' ? Math.PI : Math.E });
          return;
        }
        throw compileError(`Property "${node.property}" is not available in the safe expression profile.`, node.offset);
    }
  };

  const emitCall = (node: Extract<AstNode, { kind: 'call' }>): void => {
    if (node.callee.kind === 'identifier' && node.callee.name === '$bm_sum') {
      if (node.arguments.length !== 2) throw compileError('$bm_sum requires exactly two arguments.', node.offset);
      emitNode(node.arguments[0]!);
      emitNode(node.arguments[1]!);
      instructions.push({ op: 'binary', operator: 'add' });
      return;
    }
    if (node.callee.kind === 'member' && node.callee.property === 'toFixed') {
      if (node.arguments.length !== 1) throw compileError('toFixed requires exactly one digits argument.', node.offset);
      emitNode(node.callee.object);
      emitNode(node.arguments[0]!);
      instructions.push({ op: 'call', function: 'to-fixed', argc: 2 });
      return;
    }
    const name = callableName(node.callee);
    const fn = safeFunction(name);
    if (!fn) throw compileError(`Function "${name ?? '<dynamic>'}" is not available in the safe expression profile.`, node.offset);
    for (const argument of node.arguments) emitNode(argument);
    instructions.push({ op: 'call', function: fn, argc: node.arguments.length });
  };

  for (let statementIndex = 0; statementIndex < statements.length; statementIndex++) {
    const statement = statements[statementIndex]!;
    if (statement.kind === 'variable') {
      for (const declaration of statement.declarations) {
        if (declaration.name === '$bm_rt') {
          outputSlot = allocateLocal(declaration.name, declaration.offset);
          if (declaration.initializer) {
            emitNode(declaration.initializer);
            instructions.push({ op: 'local.set', index: outputSlot });
          }
          continue;
        }
        if (declaration.initializer) {
          const data = resolveDataReference(declaration.initializer, dataAliases, options);
          if (data) { dataAliases.set(declaration.name, data); continue; }
        }
        const index = allocateLocal(declaration.name, declaration.offset);
        if (declaration.initializer) emitNode(declaration.initializer);
        else instructions.push({ op: 'constant', value: null });
        instructions.push({ op: 'local.set', index });
      }
      continue;
    }
    const expression = statement.expression;
    if (expression.kind === 'assignment') {
      if (expression.target === '$bm_rt') {
        outputSlot = allocateLocal(expression.target, expression.offset);
        emitNode(expression.value);
        instructions.push({ op: 'local.set', index: outputSlot });
        continue;
      }
      const data = resolveDataReference(expression.value, dataAliases, options);
      if (data) { dataAliases.set(expression.target, data); continue; }
      const index = allocateLocal(expression.target, expression.offset);
      emitNode(expression.value);
      instructions.push({ op: 'local.set', index });
      continue;
    }
    emitNode(expression);
    if (statementIndex !== lastValueStatement || outputSlot !== undefined) instructions.push({ op: 'pop' });
  }
  if (outputSlot !== undefined) instructions.push({ op: 'local.get', index: outputSlot });
  if (outputSlot === undefined && lastValueStatement < 0) throw compileError('Expression does not produce a result.', 0);
  instructions.push({ op: 'return' });
  return parseSafeExpressionProgram({
    version: HYA_SAFE_EXPRESSION_VERSION,
    result: 'text',
    localCount: locals.size,
    instructions,
  }, '$.compiledExpression');
}

function resolveDataReference(
  node: AstNode,
  aliases: ReadonlyMap<string, DataReference>,
  options: Readonly<LottieTextExpressionCompileOptions>,
): DataReference | null {
  if (node.kind === 'identifier') return aliases.get(node.name) ?? null;
  if (node.kind === 'member') {
    const base = resolveDataReference(node.object, aliases, options);
    if (!base) return null;
    if (node.property === 'sourceData') return base;
    return { resource: base.resource, path: [...base.path, node.property] };
  }
  if (node.kind !== 'call') return null;
  if (node.callee.kind === 'member' && node.callee.property === 'layer'
    && node.callee.object.kind === 'identifier' && node.callee.object.name === 'thisComp') {
    const layer = literalStringArgument(node, 'thisComp.layer');
    const resource = options.resolveDataLayer(layer);
    if (!resource) throw compileError(`Expression references unknown or non-data layer "${layer}".`, node.offset);
    return { resource, path: [] };
  }
  const base = resolveDataReference(node.callee, aliases, options);
  if (!base) return null;
  const segment = literalStringArgument(node, 'Data Layer selector');
  if ((segment === 'Data' || segment === 'Outline') && base.path.length === 0) return base;
  return { resource: base.resource, path: [...base.path, normalizeDataSegment(segment)] };
}

function literalStringArgument(node: Extract<AstNode, { kind: 'call' }>, name: string): string {
  if (node.arguments.length !== 1 || node.arguments[0]?.kind !== 'literal' || typeof node.arguments[0].value !== 'string') {
    throw compileError(`${name} requires one static string argument.`, node.offset);
  }
  return node.arguments[0].value;
}

function normalizeDataSegment(value: string): string {
  const match = /^(.*) (\d+)$/.exec(value);
  return match && match[1] ? `${match[1]} ${match[2]}` : value;
}

function callableName(node: AstNode): string | null {
  if (node.kind === 'identifier') return node.name;
  if (node.kind === 'member' && node.object.kind === 'identifier' && node.object.name === 'Math') return node.property;
  return null;
}

function safeFunction(name: string | null): AnimationSafeExpressionFunction | null {
  const aliases: Readonly<Record<string, AnimationSafeExpressionFunction>> = {
    abs: 'abs', min: 'min', max: 'max', clamp: 'clamp', floor: 'floor', ceil: 'ceil', round: 'round',
    sqrt: 'sqrt', pow: 'pow', sin: 'sin', cos: 'cos', tan: 'tan', asin: 'asin', acos: 'acos', atan: 'atan',
    atan2: 'atan2', log: 'log', exp: 'exp', lerp: 'lerp',
  };
  return name ? aliases[name] ?? null : null;
}

function binaryOperator(operator: string, offset: number): AnimationSafeExpressionBinaryOperator {
  const operators: Readonly<Record<string, AnimationSafeExpressionBinaryOperator>> = {
    '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide', '%': 'remainder',
    '<': 'less', '<=': 'less-equal', '>': 'greater', '>=': 'greater-equal',
    '===': 'equal', '!==': 'not-equal',
  };
  const result = operators[operator];
  if (!result) throw compileError(`Operator "${operator}" is not supported.`, offset);
  return result;
}

class Parser {
  private readonly tokens: readonly Token[];
  private index = 0;

  constructor(source: string) { this.tokens = tokenize(source); }

  parseProgram(): readonly AstStatement[] {
    const statements: AstStatement[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'identifier' && VARIABLE_KEYWORDS.has(String(this.peek().value))) statements.push(this.parseVariableStatement());
      else statements.push({ kind: 'expression', expression: this.parseAssignment() });
      if (this.peek().value === ';') this.take();
      else if (this.peek().kind !== 'eof') throw compileError('Expected semicolon between expression statements.', this.peek().offset);
    }
    return statements;
  }

  private parseVariableStatement(): AstStatement {
    this.take();
    const declarations: { name: string; initializer?: AstNode; offset: number }[] = [];
    do {
      const name = this.expect('identifier');
      let initializer: AstNode | undefined;
      if (this.peek().value === '=') { this.take(); initializer = this.parseAssignment(); }
      declarations.push({ name: String(name.value), ...(initializer ? { initializer } : {}), offset: name.offset });
      if (this.peek().value !== ',') break;
      this.take();
    } while (true);
    return { kind: 'variable', declarations };
  }

  private parseAssignment(): AstNode {
    const left = this.parseConditional();
    if (this.peek().value !== '=') return left;
    const token = this.take();
    if (left.kind !== 'identifier') throw compileError('Only local identifier assignment is supported.', token.offset);
    return { kind: 'assignment', target: left.name, value: this.parseAssignment(), offset: token.offset };
  }

  private parseConditional(): AstNode {
    const test = this.parseBinary(0);
    if (this.peek().value !== '?') return test;
    const token = this.take();
    const consequent = this.parseAssignment();
    this.expectValue(':');
    return { kind: 'conditional', test, consequent, alternate: this.parseAssignment(), offset: token.offset };
  }

  private parseBinary(minimum: number): AstNode {
    let left = this.parseUnary();
    while (true) {
      const token = this.peek();
      const precedence = typeof token.value === 'string' ? BINARY_PRECEDENCE[token.value] : undefined;
      if (precedence === undefined || precedence < minimum) break;
      this.take();
      left = { kind: 'binary', operator: String(token.value), left, right: this.parseBinary(precedence + 1), offset: token.offset };
    }
    return left;
  }

  private parseUnary(): AstNode {
    const token = this.peek();
    if (token.value === '+' || token.value === '-' || token.value === '!') {
      this.take();
      return { kind: 'unary', operator: token.value, argument: this.parseUnary(), offset: token.offset } as AstNode;
    }
    return this.parsePostfix();
  }

  private parsePostfix(): AstNode {
    let node = this.parsePrimary();
    while (true) {
      const token = this.peek();
      if (token.value === '.') {
        this.take();
        const property = this.expect('identifier');
        node = { kind: 'member', object: node, property: String(property.value), offset: token.offset };
        continue;
      }
      if (token.value === '(') {
        this.take();
        const args: AstNode[] = [];
        if (this.peek().value !== ')') {
          do {
            args.push(this.parseAssignment());
            if (this.peek().value !== ',') break;
            this.take();
          } while (true);
        }
        this.expectValue(')');
        node = { kind: 'call', callee: node, arguments: args, offset: token.offset };
        continue;
      }
      return node;
    }
  }

  private parsePrimary(): AstNode {
    const token = this.take();
    if (token.kind === 'number' || token.kind === 'string') return { kind: 'literal', value: token.value, offset: token.offset };
    if (token.kind === 'identifier') {
      if (token.value === 'true' || token.value === 'false' || token.value === 'null') {
        return { kind: 'literal', value: token.value === 'null' ? null : token.value === 'true', offset: token.offset };
      }
      return { kind: 'identifier', name: String(token.value), offset: token.offset };
    }
    if (token.value === '(') {
      const node = this.parseAssignment();
      this.expectValue(')');
      return node;
    }
    throw compileError(`Unexpected token "${String(token.value)}".`, token.offset);
  }

  private peek(): Token { return this.tokens[this.index]!; }
  private take(): Token { return this.tokens[this.index++]!; }
  private expect(kind: Token['kind']): Token {
    const token = this.take();
    if (token.kind !== kind) throw compileError(`Expected ${kind}.`, token.offset);
    return token;
  }
  private expectValue(value: string): void {
    const token = this.take();
    if (token.value !== value) throw compileError(`Expected "${value}".`, token.offset);
  }
}

const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  '||': 1, '&&': 2, '==': 3, '!=': 3, '===': 3, '!==': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
};
const VARIABLE_KEYWORDS = new Set(['var', 'let', 'const']);

function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    const char = source[offset]!;
    if (/\s/.test(char)) { offset++; continue; }
    if (char === '/' && source[offset + 1] === '/') {
      offset += 2;
      while (offset < source.length && source[offset] !== '\n') offset++;
      continue;
    }
    if (char === '/' && source[offset + 1] === '*') {
      const end = source.indexOf('*/', offset + 2);
      if (end < 0) throw compileError('Unterminated block comment.', offset);
      offset = end + 2;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = offset++;
      while (offset < source.length && /[A-Za-z0-9_$]/.test(source[offset]!)) offset++;
      tokens.push({ kind: 'identifier', value: source.slice(start, offset), offset: start });
      continue;
    }
    if (/\d/.test(char) || (char === '.' && /\d/.test(source[offset + 1] ?? ''))) {
      const start = offset++;
      while (offset < source.length && /[0-9.eE+-]/.test(source[offset]!)) {
        const candidate = source.slice(start, offset + 1);
        if (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d*)?$/.test(candidate)) break;
        offset++;
      }
      const value = Number(source.slice(start, offset));
      if (!Number.isFinite(value)) throw compileError('Invalid numeric literal.', start);
      tokens.push({ kind: 'number', value, offset: start });
      continue;
    }
    if (char === '"' || char === "'") {
      const start = offset++;
      let value = '';
      while (offset < source.length && source[offset] !== char) {
        const current = source[offset++]!;
        if (current !== '\\') { value += current; continue; }
        if (offset >= source.length) throw compileError('Unterminated string escape.', start);
        const escape = source[offset++]!;
        const simple: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', "'": "'", '"': '"' };
        if (escape in simple) { value += simple[escape]; continue; }
        if (escape === 'x' || escape === 'u') {
          const length = escape === 'x' ? 2 : 4;
          const digits = source.slice(offset, offset + length);
          if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) throw compileError('Invalid hexadecimal string escape.', offset);
          value += String.fromCharCode(Number.parseInt(digits, 16));
          offset += length;
          continue;
        }
        value += escape;
      }
      if (source[offset] !== char) throw compileError('Unterminated string literal.', start);
      offset++;
      tokens.push({ kind: 'string', value, offset: start });
      continue;
    }
    const operator = ['===', '!==', '<=', '>=', '==', '!=', '&&', '||'].find(candidate => source.startsWith(candidate, offset));
    if (operator) { tokens.push({ kind: 'operator', value: operator, offset }); offset += operator.length; continue; }
    if ('+-*/%<>=!'.includes(char)) { tokens.push({ kind: 'operator', value: char, offset: offset++ }); continue; }
    if ('().,;?:'.includes(char)) { tokens.push({ kind: 'punctuation', value: char, offset: offset++ }); continue; }
    throw compileError(`Token "${char}" is not permitted in safe expressions.`, offset);
  }
  tokens.push({ kind: 'eof', value: '', offset: source.length });
  return tokens;
}

function compileError(message: string, offset: number): LottieTextExpressionCompileError {
  return new LottieTextExpressionCompileError(message, offset);
}
