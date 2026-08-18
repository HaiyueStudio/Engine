import assert from 'node:assert/strict';
import test from 'node:test';
import { LineGeometry } from '../dist/geometry.js';

test('LineGeometry supports independent segment pairs without changing legacy strip defaults', () => {
  const strip = new LineGeometry([0, 0, 0, 1, 0, 0, 2, 0, 0]);
  const segments = new LineGeometry([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0], { topology: 'segments' });
  assert.equal(strip.topology, 'strip');
  assert.equal(strip.pointCount, 3);
  assert.equal(segments.topology, 'segments');
  assert.equal(segments.pointCount, 4);
});
