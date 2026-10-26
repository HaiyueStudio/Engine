import assert from 'node:assert/strict';
import {createLayoutSession, LayoutError} from '@haiyue/extensions/layout';
assert.equal(typeof globalThis.document, 'undefined');
assert.equal(typeof globalThis.navigator?.gpu, 'undefined');
const session = createLayoutSession();
const root = {id: 'root', contentVersion: 1, style: {display: 'flex', direction: 'row', columnGap: 4}, children: [
  {id: 'a', contentVersion: 1, style: {width: 20, height: 10}},
  {id: 'b', contentVersion: 1, style: {width: 30, height: 10}},
]};
const result = session.update(root, {width: {mode: 'exact', value: 100}, height: {mode: 'exact', value: 30}},
  () => ({width: 0, height: 0, minWidth: 0, minHeight: 0}), {metricsVersion: 1});
assert.deepEqual(result.rects.get('a'), {x: 0, y: 0, width: 20, height: 10});
assert.deepEqual(result.rects.get('b'), {x: 24, y: 0, width: 30, height: 10});
session.dispose(); session.dispose();
assert.throws(() => session.update(root, {width: {mode: 'unbounded'}, height: {mode: 'unbounded'}},
  () => ({width: 0, height: 0, minWidth: 0, minHeight: 0}), {metricsVersion: 1}), LayoutError);
console.log('Packed layout runs without DOM, GPU or Engine initialization.');
