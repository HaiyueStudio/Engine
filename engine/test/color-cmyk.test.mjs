import test from 'node:test';
import assert from 'node:assert/strict';
import { ColorCMYK, resolveColor, writeColorLinear, writeColorSRGB } from '../dist/color.js';
import { BasicMaterial, Material2D, PbrMaterial } from '../dist/index.js';
const close = (values, expected) => expected.forEach((value, i) => assert.ok(Math.abs(values[i] - value) < 1e-6, `${i}: ${values[i]} != ${value}`));
test('CMYK inks convert through encoded sRGB into the existing linear GPU writer', () => {
  for (const [inks, rgb] of [[[0,0,0,0],[1,1,1]],[[0,0,0,1],[0,0,0]],[[1,0,0,0],[0,1,1]],[[0,1,1,0],[1,0,0]],[[0.2,0.4,0.6,0.5],[0.4,0.3,0.2]]]) {
    const color = new ColorCMYK(...inks, 0.3), output = new Float32Array(8).fill(-1);
    writeColorSRGB(color, output, 2); close(output.subarray(2,6), [...rgb,0.3]); assert.equal(output[0], -1); assert.equal(output[6], -1);
    close(writeColorLinear(color, new Float32Array(4)), [...rgb.map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4), 0.3]);
    close(new ColorCMYK().setFromSRGB(...rgb,0.3).toSRGB().toArray(), [...rgb,0.3]);
  }
});
test('CMYK ownership, revisions and invalid edits preserve cached GPU state atomically', () => {
  const color = new ColorCMYK(0.2,0.4,0.6,0.5,0.7), clone = resolveColor(color), version = color.version;
  assert.ok(clone instanceof ColorCMYK); color.c = 0.2; assert.equal(color.version, version);
  color.k = 0.2; assert.ok(color.version > version); assert.equal(clone.k, 0.5);
  const before = color.toArray(), bytes = color.writeLinear(new Float32Array(4)), revision = color.version;
  for (const bad of [NaN, Infinity, -0.1, 1.1]) {
    assert.throws(() => color.set(0, 0, bad, 0)); assert.throws(() => { color.a = bad; });
    assert.throws(() => color.setFromLinear(bad, 0, 0));
  }
  assert.deepEqual(color.toArray(), before); assert.equal(color.version, revision); assert.deepEqual(color.writeLinear(new Float32Array(4)), bytes);
  close(new ColorCMYK().setFromLinear(1,1,1,0.5).toSRGB().toArray(), [1,1,1,0.5]);
});
test('existing material ColorValue inputs preserve CMYK identity and auto-convert at GPU writes', () => {
  const input = new ColorCMYK(0,0.5,1,0.25,0.8);
  for (const material of [new BasicMaterial({ color: input }), new Material2D({ color: input }), new PbrMaterial({ baseColor: input })]) {
    const color = material.color ?? material.baseColor;
    assert.ok(color instanceof ColorCMYK); assert.notEqual(color, input);
    close(color.writeSRGB(new Float32Array(4)), [0.75,0.375,0,0.8]);
    color.k = 1; close(color.writeLinear(new Float32Array(4)), [0,0,0,0.8]);
  }
});
