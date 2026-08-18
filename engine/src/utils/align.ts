export function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

export function alignUp4(value: number): number {
  return alignUp(value, 4);
}

export function alignUp16(value: number): number {
  return alignUp(value, 16);
}
