import {createLayoutSession, LayoutError} from './layout/layout.js';
import type {LayoutNode, LayoutMeasure} from './layout/layout.js';

if ('document' in globalThis || 'GPUDevice' in globalThis) throw new Error('Independent consumer must run without DOM/GPU globals.');
const root: LayoutNode = {id: 'root', contentVersion: 0, style: {alignItems: 'start'}, children: [
  {id: 'a', contentVersion: 0, style: {grow: 1, basis: 0, maxWidth: 100}},
  {id: 'b', contentVersion: 0, style: {grow: 1, basis: 0}},
]};
let calls = 0;
const measure: LayoutMeasure = () => {calls++; return {width: 40, height: 20, minWidth: 0, minHeight: 0};};
const session = createLayoutSession();
const constraints = {width: {mode: 'exact' as const, value: 300}, height: {mode: 'exact' as const, value: 40}};
const first = session.update(root, constraints, measure);
if (first.rects.get('a')?.width !== 100 || first.rects.get('b')?.width !== 200) throw new Error('Independent layout geometry differs.');
const before = calls, second = session.update(root, constraints, measure);
if (calls !== before || second.measuredNodes !== 0 || second.generation !== first.generation + 1) throw new Error('Independent cached generation differs.');
for (let i = 0; i < 25; i++) {
  const repeated = session.update(root, constraints, measure);
  for (const [id, rect] of first.rects) if (JSON.stringify(repeated.rects.get(id)) !== JSON.stringify(rect)) throw new Error('Independent geometry accumulated drift.');
}
session.invalidate(['a']);
if (session.update(root, constraints, measure).measuredNodes === 0) throw new Error('Explicit invalidation ignored.');
if (session.update(root, constraints, measure, {metricsVersion: 1}).measuredNodes === 0) throw new Error('Metrics generation ignored.');
session.dispose(); session.dispose();
let disposed = false;
try {session.update(root, constraints, measure);} catch (error) {disposed = error instanceof LayoutError && error.code === 'disposed';}
if (!disposed || first.rects.get('a')?.width !== 100) throw new Error('Independent disposal or previous result changed.');
const limited = createLayoutSession({maxNodes: 1});
let bounded = false;
try {limited.update(root, constraints, measure);} catch (error) {bounded = error instanceof LayoutError && error.code === 'limit';}
finally {limited.dispose();}
if (!bounded) throw new Error('Independent tree bound ignored.');
for (const limits of [{maxNodes: 10001}, {maxDepth: 129}, {maxMeasureEntriesPerNode: 9}, {maxConstraintPasses: 5}]) {
  let rejected = false;
  try {createLayoutSession(limits);} catch (error) {rejected = error instanceof LayoutError && error.code === 'invalid-input';}
  if (!rejected) throw new Error('Independent consumer could raise a hard bound.');
}
export const result = {status: 'passed', independent: true, dom: false, gpu: false, engine: false, sourceFormats: false, generationCache: true, deterministic: true, bounds: true, explicitInvalidation: true, metricsVersion: true, disposal: true};
// @ts-expect-error CSS strings are intentionally outside the supported input contract.
const unsupported: LayoutNode = {id: 'unsupported', contentVersion: 0, style: {width: '12px'}};
void unsupported;
