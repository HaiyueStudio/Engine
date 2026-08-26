import { AnimationFormatError } from './errors';

export const HYA_SAFE_EXPRESSION_VERSION = 1 as const;
export const HYA_SAFE_EXPRESSION_MAX_INSTRUCTIONS = 256;
export const HYA_SAFE_EXPRESSION_MAX_STACK = 64;
export const HYA_SAFE_EXPRESSION_MAX_LOCALS = 16;
export const HYA_SAFE_EXPRESSION_MAX_STRING_LENGTH = 4096;
export const HYA_SAFE_EXPRESSION_MAX_DATA_PATH_DEPTH = 32;

export type AnimationSafeExpressionPrimitive = number | string | boolean | null;
export type AnimationSafeExpressionUnaryOperator = 'positive' | 'negative' | 'not';
export type AnimationSafeExpressionBinaryOperator =
  | 'add' | 'subtract' | 'multiply' | 'divide' | 'remainder'
  | 'less' | 'less-equal' | 'greater' | 'greater-equal' | 'equal' | 'not-equal'
  | 'and' | 'or';
export type AnimationSafeExpressionFunction =
  | 'abs' | 'min' | 'max' | 'clamp' | 'floor' | 'ceil' | 'round'
  | 'sqrt' | 'pow' | 'sin' | 'cos' | 'tan' | 'asin' | 'acos' | 'atan' | 'atan2' | 'log' | 'exp'
  | 'lerp' | 'to-fixed';

export type AnimationSafeExpressionInstruction =
  | Readonly<{ readonly op: 'constant'; readonly value: AnimationSafeExpressionPrimitive }>
  | Readonly<{ readonly op: 'time' | 'text' }>
  | Readonly<{ readonly op: 'data'; readonly resource: string; readonly path: readonly string[] }>
  | Readonly<{ readonly op: 'local.get' | 'local.set'; readonly index: number }>
  | Readonly<{ readonly op: 'pop' }>
  | Readonly<{ readonly op: 'unary'; readonly operator: AnimationSafeExpressionUnaryOperator }>
  | Readonly<{ readonly op: 'binary'; readonly operator: AnimationSafeExpressionBinaryOperator }>
  | Readonly<{ readonly op: 'select' }>
  | Readonly<{ readonly op: 'branch.false' | 'jump'; readonly target: number }>
  | Readonly<{ readonly op: 'call'; readonly function: AnimationSafeExpressionFunction; readonly argc: number }>
  | Readonly<{ readonly op: 'return' }>;

/** Source-neutral, side-effect-free expression program. Source scripts are never retained in HYA. */
export interface AnimationSafeExpressionProgram {
  readonly version: typeof HYA_SAFE_EXPRESSION_VERSION;
  readonly result: 'text';
  readonly localCount: number;
  readonly instructions: readonly AnimationSafeExpressionInstruction[];
}

export interface AnimationSafeExpressionContext {
  readonly time: number;
  readonly text: string;
  readonly data?: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>;
}

/** Parses and statically verifies an untrusted HYA expression program. */
export function parseSafeExpressionProgram(value: unknown, path = '$.expression'): AnimationSafeExpressionProgram {
  const root = expressionRecord(value, path);
  if (root.version !== HYA_SAFE_EXPRESSION_VERSION) expressionFail('Unsupported safe expression version.', `${path}.version`);
  if (root.result !== 'text') expressionFail('Safe expression result must be "text".', `${path}.result`);
  const localCount = expressionInteger(root.localCount, 0, HYA_SAFE_EXPRESSION_MAX_LOCALS, `${path}.localCount`);
  if (!Array.isArray(root.instructions) || root.instructions.length < 1
    || root.instructions.length > HYA_SAFE_EXPRESSION_MAX_INSTRUCTIONS) {
    expressionFail(`Safe expression must contain 1–${HYA_SAFE_EXPRESSION_MAX_INSTRUCTIONS} instructions.`, `${path}.instructions`);
  }
  const instructionValues = root.instructions as unknown[];
  const instructions = instructionValues.map((entry, index) => parseInstruction(
    entry, `${path}.instructions[${index}]`, localCount, index, instructionValues.length,
  ));
  verifyStack(instructions, path);
  return Object.freeze({ version: HYA_SAFE_EXPRESSION_VERSION, result: 'text', localCount, instructions: Object.freeze(instructions) });
}

/** Evaluates an already verified program without exposing host objects or executable source code. */
export function evaluateSafeExpression(
  program: Readonly<AnimationSafeExpressionProgram>,
  context: Readonly<AnimationSafeExpressionContext>,
): string {
  const stack: unknown[] = [];
  const locals: unknown[] = new Array(program.localCount).fill(null);
  let pc = 0;
  while (pc < program.instructions.length) {
    const instruction = program.instructions[pc]!;
    switch (instruction.op) {
      case 'constant': stack.push(instruction.value); break;
      case 'time': stack.push(finiteRuntimeNumber(context.time)); break;
      case 'text': stack.push(context.text); break;
      case 'data': stack.push(readData(context.data, instruction.resource, instruction.path)); break;
      case 'local.get': stack.push(locals[instruction.index]); break;
      case 'local.set': locals[instruction.index] = pop(stack); break;
      case 'pop': pop(stack); break;
      case 'unary': stack.push(evaluateUnary(instruction.operator, pop(stack))); break;
      case 'binary': {
        const right = pop(stack);
        const left = pop(stack);
        stack.push(evaluateBinary(instruction.operator, left, right));
        break;
      }
      case 'select': {
        const alternate = pop(stack);
        const consequent = pop(stack);
        stack.push(expressionBoolean(pop(stack)) ? consequent : alternate);
        break;
      }
      case 'branch.false':
        pc = expressionBoolean(pop(stack)) ? pc + 1 : instruction.target;
        continue;
      case 'jump':
        pc = instruction.target;
        continue;
      case 'call': {
        const args = stack.splice(stack.length - instruction.argc, instruction.argc);
        stack.push(evaluateFunction(instruction.function, args));
        break;
      }
      case 'return': return boundedString(pop(stack));
    }
    if (stack.length > HYA_SAFE_EXPRESSION_MAX_STACK) throw new TypeError('Safe expression runtime stack limit exceeded.');
    pc++;
  }
  throw new TypeError('Safe expression terminated without return.');
}

export function safeExpressionDataResources(program: Readonly<AnimationSafeExpressionProgram>): readonly string[] {
  return Object.freeze([...new Set(program.instructions.flatMap(instruction => instruction.op === 'data' ? [instruction.resource] : []))]);
}

function parseInstruction(
  value: unknown,
  path: string,
  localCount: number,
  instructionIndex: number,
  instructionCount: number,
): AnimationSafeExpressionInstruction {
  const instruction = expressionRecord(value, path);
  const op = instruction.op;
  if (op === 'constant') {
    const constant = instruction.value;
    if (constant !== null && typeof constant !== 'number' && typeof constant !== 'string' && typeof constant !== 'boolean') {
      expressionFail('Expression constant must be a number, string, boolean or null.', `${path}.value`);
    }
    if (typeof constant === 'number' && !Number.isFinite(constant)) expressionFail('Expression number constants must be finite.', `${path}.value`);
    if (typeof constant === 'string' && constant.length > HYA_SAFE_EXPRESSION_MAX_STRING_LENGTH) expressionFail('Expression string constant is too long.', `${path}.value`);
    return Object.freeze({ op, value: constant as AnimationSafeExpressionPrimitive });
  }
  if (op === 'time' || op === 'text' || op === 'pop' || op === 'select' || op === 'return') return Object.freeze({ op });
  if (op === 'branch.false' || op === 'jump') {
    const target = expressionInteger(instruction.target, instructionIndex + 1, instructionCount - 1, `${path}.target`);
    return Object.freeze({ op, target });
  }
  if (op === 'data') {
    if (typeof instruction.resource !== 'string' || instruction.resource.length < 1) expressionFail('Expression data resource must be a non-empty string.', `${path}.resource`);
    if (!Array.isArray(instruction.path) || instruction.path.length < 1 || instruction.path.length > HYA_SAFE_EXPRESSION_MAX_DATA_PATH_DEPTH
      || instruction.path.some(segment => typeof segment !== 'string' || segment.length < 1 || segment.length > 128 || forbiddenDataSegment(segment))) {
      expressionFail('Expression data path is invalid or unsafe.', `${path}.path`);
    }
    return Object.freeze({ op, resource: instruction.resource, path: Object.freeze([...instruction.path]) as readonly string[] });
  }
  if (op === 'local.get' || op === 'local.set') {
    const index = expressionInteger(instruction.index, 0, Math.max(0, localCount - 1), `${path}.index`);
    if (localCount === 0) expressionFail('Expression local instruction requires at least one local.', `${path}.index`);
    return Object.freeze({ op, index });
  }
  if (op === 'unary') {
    const operator = expressionLiteral(instruction.operator, ['positive', 'negative', 'not'] as const, `${path}.operator`);
    return Object.freeze({ op, operator });
  }
  if (op === 'binary') {
    const operator = expressionLiteral(instruction.operator, [
      'add', 'subtract', 'multiply', 'divide', 'remainder', 'less', 'less-equal', 'greater', 'greater-equal',
      'equal', 'not-equal', 'and', 'or',
    ] as const, `${path}.operator`);
    return Object.freeze({ op, operator });
  }
  if (op === 'call') {
    const fn = expressionLiteral(instruction.function, [
      'abs', 'min', 'max', 'clamp', 'floor', 'ceil', 'round', 'sqrt', 'pow', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'log', 'exp', 'lerp', 'to-fixed',
    ] as const, `${path}.function`);
    const argc = expressionInteger(instruction.argc, 1, 3, `${path}.argc`);
    const expected = functionArity(fn);
    if (!expected.includes(argc)) expressionFail(`Expression function "${fn}" does not accept ${argc} arguments.`, `${path}.argc`);
    return Object.freeze({ op, function: fn, argc });
  }
  expressionFail(`Unknown safe expression opcode "${String(op)}".`, `${path}.op`);
}

function verifyStack(instructions: readonly AnimationSafeExpressionInstruction[], path: string): void {
  if (instructions[instructions.length - 1]?.op !== 'return') {
    expressionFail('Expression return must be the final instruction.', `${path}.instructions`);
  }
  const depths = new Map<number, number>([[0, 0]]);
  const pending = [0];
  while (pending.length > 0) {
    const index = pending.shift()!;
    const instruction = instructions[index]!;
    const depth = depths.get(index)!;
    const consumed = instruction.op === 'binary' ? 2 : instruction.op === 'select' ? 3
      : instruction.op === 'call' ? instruction.argc
        : instruction.op === 'local.set' || instruction.op === 'pop' || instruction.op === 'unary'
          || instruction.op === 'branch.false' || instruction.op === 'return' ? 1 : 0;
    const produced = instruction.op === 'constant' || instruction.op === 'time' || instruction.op === 'text'
      || instruction.op === 'data' || instruction.op === 'local.get' || instruction.op === 'unary'
      || instruction.op === 'binary' || instruction.op === 'select' || instruction.op === 'call' ? 1 : 0;
    if (depth < consumed) expressionFail('Expression instruction stack underflow.', `${path}.instructions[${index}]`);
    const nextDepth = depth - consumed + produced;
    if (nextDepth > HYA_SAFE_EXPRESSION_MAX_STACK) expressionFail('Expression instruction stack limit exceeded.', `${path}.instructions[${index}]`);
    if (instruction.op === 'return' && depth !== 1) expressionFail('Expression return requires exactly one result value.', `${path}.instructions[${index}]`);
    const successors = instruction.op === 'return' ? []
      : instruction.op === 'jump' ? [instruction.target]
        : instruction.op === 'branch.false' ? [index + 1, instruction.target]
          : [index + 1];
    for (const successor of successors) {
      if (successor >= instructions.length) expressionFail('Expression control flow leaves the program.', `${path}.instructions[${index}]`);
      const previous = depths.get(successor);
      if (previous !== undefined && previous !== nextDepth) {
        expressionFail('Expression control-flow branches must merge at the same stack depth.', `${path}.instructions[${successor}]`);
      }
      if (previous === undefined) {
        depths.set(successor, nextDepth);
        pending.push(successor);
      }
    }
  }
  if (!depths.has(instructions.length - 1)) expressionFail('Expression final return is unreachable.', `${path}.instructions`);
  if (depths.size !== instructions.length) expressionFail('Expression contains unreachable instructions.', `${path}.instructions`);
}

function readData(data: AnimationSafeExpressionContext['data'], resource: string, path: readonly string[]): unknown {
  let value = data instanceof Map
    ? data.get(resource)
    : (data as Readonly<Record<string, unknown>> | undefined)?.[resource];
  for (const segment of path) {
    if (value === null || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      const match = /(?:^|\s)(\d+)$/.exec(segment);
      value = match ? value[Number(match[1])] : undefined;
      continue;
    }
    if (forbiddenDataSegment(segment) || !Object.prototype.hasOwnProperty.call(value, segment)) return null;
    value = (value as Readonly<Record<string, unknown>>)[segment];
  }
  return value;
}

function evaluateUnary(operator: AnimationSafeExpressionUnaryOperator, value: unknown): AnimationSafeExpressionPrimitive {
  if (operator === 'not') return !expressionBoolean(value);
  const number = expressionNumber(value);
  return finiteRuntimeNumber(operator === 'negative' ? -number : number);
}

function evaluateBinary(operator: AnimationSafeExpressionBinaryOperator, left: unknown, right: unknown): AnimationSafeExpressionPrimitive {
  if (operator === 'add') return typeof left === 'string' || typeof right === 'string'
    ? boundedString(`${boundedString(left)}${boundedString(right)}`)
    : finiteRuntimeNumber(expressionNumber(left) + expressionNumber(right));
  if (operator === 'and') return expressionBoolean(left) && expressionBoolean(right);
  if (operator === 'or') return expressionBoolean(left) || expressionBoolean(right);
  if (operator === 'equal' || operator === 'not-equal') {
    const equal = primitiveValue(left) === primitiveValue(right);
    return operator === 'equal' ? equal : !equal;
  }
  const a = expressionNumber(left);
  const b = expressionNumber(right);
  switch (operator) {
    case 'subtract': return finiteRuntimeNumber(a - b);
    case 'multiply': return finiteRuntimeNumber(a * b);
    case 'divide': return finiteRuntimeNumber(a / b);
    case 'remainder': return finiteRuntimeNumber(a % b);
    case 'less': return a < b;
    case 'less-equal': return a <= b;
    case 'greater': return a > b;
    case 'greater-equal': return a >= b;
    default: throw new TypeError(`Unsupported safe expression binary operator ${operator}.`);
  }
}

function evaluateFunction(fn: AnimationSafeExpressionFunction, args: readonly unknown[]): AnimationSafeExpressionPrimitive {
  if (fn === 'to-fixed') {
    const digits = Math.trunc(expressionNumber(args[1]));
    if (digits < 0 || digits > 20) throw new TypeError('Safe expression to-fixed digits must be between 0 and 20.');
    return boundedString(expressionNumber(args[0]).toFixed(digits));
  }
  const numbers = args.map(expressionNumber);
  let result: number;
  switch (fn) {
    case 'abs': result = Math.abs(numbers[0]!); break;
    case 'min': result = Math.min(...numbers); break;
    case 'max': result = Math.max(...numbers); break;
    case 'clamp': result = Math.min(numbers[2]!, Math.max(numbers[1]!, numbers[0]!)); break;
    case 'floor': result = Math.floor(numbers[0]!); break;
    case 'ceil': result = Math.ceil(numbers[0]!); break;
    case 'round': result = Math.round(numbers[0]!); break;
    case 'sqrt': result = Math.sqrt(numbers[0]!); break;
    case 'pow': result = Math.pow(numbers[0]!, numbers[1]!); break;
    case 'sin': result = Math.sin(numbers[0]!); break;
    case 'cos': result = Math.cos(numbers[0]!); break;
    case 'tan': result = Math.tan(numbers[0]!); break;
    case 'asin': result = Math.asin(numbers[0]!); break;
    case 'acos': result = Math.acos(numbers[0]!); break;
    case 'atan': result = Math.atan(numbers[0]!); break;
    case 'atan2': result = Math.atan2(numbers[0]!, numbers[1]!); break;
    case 'log': result = Math.log(numbers[0]!); break;
    case 'exp': result = Math.exp(numbers[0]!); break;
    case 'lerp': result = numbers[0]! + (numbers[1]! - numbers[0]!) * numbers[2]!; break;
    default: throw new TypeError(`Unsupported safe expression function ${fn}.`);
  }
  return finiteRuntimeNumber(result);
}

function functionArity(fn: AnimationSafeExpressionFunction): readonly number[] {
  if (fn === 'min' || fn === 'max') return [1, 2, 3];
  if (fn === 'clamp' || fn === 'lerp') return [3];
  if (fn === 'pow' || fn === 'atan2' || fn === 'to-fixed') return [2];
  return [1];
}

function boundedString(value: unknown): string {
  const primitive = primitiveValue(value);
  const result = primitive === null ? '' : String(primitive);
  if (result.length > HYA_SAFE_EXPRESSION_MAX_STRING_LENGTH) throw new TypeError('Safe expression string limit exceeded.');
  return result;
}

function expressionNumber(value: unknown): number {
  const primitive = primitiveValue(value);
  if (typeof primitive === 'number') return finiteRuntimeNumber(primitive);
  if (typeof primitive === 'boolean') return primitive ? 1 : 0;
  if (primitive === null || primitive === '') return 0;
  const number = Number(primitive);
  return finiteRuntimeNumber(number);
}

function expressionBoolean(value: unknown): boolean {
  const primitive = primitiveValue(value);
  return primitive !== null && primitive !== false && primitive !== 0 && primitive !== '';
}

function primitiveValue(value: unknown): AnimationSafeExpressionPrimitive {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return finiteRuntimeNumber(value);
  throw new TypeError('Safe expression value is not a primitive.');
}

function finiteRuntimeNumber(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError('Safe expression produced a non-finite number.');
  return value;
}

function pop(stack: unknown[]): unknown {
  if (stack.length === 0) throw new TypeError('Safe expression runtime stack underflow.');
  return stack.pop();
}

function forbiddenDataSegment(value: string): boolean {
  return value === '__proto__' || value === 'prototype' || value === 'constructor';
}

function expressionRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) expressionFail('Expected an expression object.', path);
  return value as Record<string, unknown>;
}

function expressionInteger(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) expressionFail(`Expected an integer from ${min} to ${max}.`, path);
  return value;
}

function expressionLiteral<const T extends readonly string[]>(value: unknown, values: T, path: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) expressionFail(`Expected one of ${values.join(', ')}.`, path);
  return value as T[number];
}

function expressionFail(message: string, path: string): never {
  throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', message, path);
}
