/** WGSL parses the positive, suffixed token before applying unary negation. */
export function wgslI32Literal(value: number): string {
  return value === -0x80000000 ? '(-2147483647i - 1i)' : `${value}i`;
}
