/** The scalar has already passed IR validation. Keep ordinary output stable. */
export function floatLiteral(value: number): string {
  const text = String(value);
  // A decimal point belongs in the significand, never after the exponent.
  return Number.isInteger(value) && !/[eE]/.test(text) ? `${text}.0` : text;
}
