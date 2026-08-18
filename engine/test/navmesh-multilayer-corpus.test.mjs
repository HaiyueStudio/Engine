import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  evaluateNavMeshMultilayerCorpus,
  validateNavMeshMultilayerCorpus,
} from './support/navmesh-multilayer-oracle.mjs';

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/navmesh-multilayer-corpus.json', import.meta.url),
  'utf8',
));

test('multilayer NavMesh corpus pins all required topology and coordinate-frame features', () => {
  validateNavMeshMultilayerCorpus(corpus);
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.cases.length, 6);

  const features = new Set(corpus.cases.flatMap(corpusCase => corpusCase.features));
  for (const feature of [
    'bridge',
    'cave',
    'portal',
    'unconnected',
    'rotated-up-vector',
    'layer-scoped-obstacle',
  ]) {
    assert.ok(features.has(feature), `missing NavMesh corpus feature ${feature}`);
  }
});

test('independent graph oracle accepts all 16 checked-in multilayer expectations', () => {
  const report = evaluateNavMeshMultilayerCorpus(corpus);
  assert.equal(report.status, 'passed');
  assert.equal(report.queryCount, 16);
  assert.deepEqual(report.violations, []);
});

test('bridge, cave, and unconnected overlap never create implicit vertical edges', () => {
  const report = evaluateNavMeshMultilayerCorpus(corpus);
  const result = resultMap(report);

  assert.deepEqual(
    result.get('bridge-stacked-over-ground/bridge-remains-on-bridge').regionPath,
    ['bridge-west', 'bridge-mid', 'bridge-east'],
  );
  assert.deepEqual(
    result.get('cave-below-surface/cave-route-stays-under-surface').regionPath,
    ['cave-mouth', 'cave-tunnel', 'cave-chamber'],
  );
  assert.equal(
    result.get('stacked-without-connection/overlap-does-not-create-an-edge').status,
    'unreachable',
  );
});

test('explicit cross-layer portal is bidirectional and its disabled state removes connectivity', () => {
  const report = evaluateNavMeshMultilayerCorpus(corpus);
  const result = resultMap(report);
  const forward = result.get('explicit-portal-connectivity/portal-connects-disjoint-regions');
  const disabled = result.get('explicit-portal-connectivity/disabled-portal-is-unreachable');
  const reverse = result.get('explicit-portal-connectivity/bidirectional-portal-reverses');

  assert.deepEqual(forward.regionPath, ['room-a', 'room-b']);
  assert.deepEqual(forward.portalPath, ['door-a-b']);
  assert.equal(disabled.status, 'unreachable');
  assert.deepEqual(reverse.regionPath, ['room-b', 'room-a']);
});

test('rotated up vector derives a diagonal navigation plane without principal-axis assumptions', () => {
  const report = evaluateNavMeshMultilayerCorpus(corpus);
  const result = resultMap(report);
  assert.deepEqual(
    result.get('diagonal-up-rotated-navigation-frame/diagonal-up-path-uses-derived-plane').regionPath,
    ['diagonal-left', 'diagonal-right'],
  );
  assert.equal(
    result.get('diagonal-up-rotated-navigation-frame/diagonal-up-elevation-separates-overlap').status,
    'unreachable',
  );
});

test('dynamic obstacle oracle scopes identical projected blockers to their resolved layer', () => {
  const report = evaluateNavMeshMultilayerCorpus(corpus);
  const result = resultMap(report);
  const upperBlocked = result.get('layer-scoped-dynamic-obstacles/upper-obstacle-blocks-upper-layer');
  const groundUnaffected = result.get('layer-scoped-dynamic-obstacles/upper-obstacle-does-not-block-ground');
  const ignored = result.get('layer-scoped-dynamic-obstacles/ignored-layer-obstacle-restores-route');

  assert.deepEqual(upperBlocked.obstacleRegions, { 'upper-blocker': 'upper-left' });
  assert.deepEqual(upperBlocked.blockedPortalIds, ['upper-door']);
  assert.equal(upperBlocked.status, 'unreachable');
  assert.deepEqual(groundUnaffected.blockedPortalIds, ['upper-door']);
  assert.equal(groundUnaffected.status, 'complete');
  assert.deepEqual(ignored.obstacleRegions, {});
  assert.deepEqual(ignored.blockedPortalIds, []);
  assert.equal(ignored.status, 'complete');
});

test('oracle catches a missing explicit portal instead of inferring polygon proximity', () => {
  const candidate = structuredClone(corpus);
  const portalCase = candidate.cases.find(corpusCase => corpusCase.id === 'explicit-portal-connectivity');
  portalCase.portals = [];
  portalCase.queries = portalCase.queries.filter(query => query.id === 'portal-connects-disjoint-regions');
  portalCase.queries[0].expected.portalPath = [];

  const report = evaluateNavMeshMultilayerCorpus(candidate);
  assert.equal(report.status, 'failed');
  assert.match(report.violations[0].mismatches.join('\n'), /status: expected complete, received unreachable/);
});

test('oracle catches an obstacle assigned to the wrong stacked layer', () => {
  const candidate = structuredClone(corpus);
  const obstacleCase = candidate.cases.find(corpusCase => corpusCase.id === 'layer-scoped-dynamic-obstacles');
  const upperBlocker = obstacleCase.obstacles.find(obstacle => obstacle.id === 'upper-blocker');
  upperBlocker.position = [2.8, 0, 1];
  obstacleCase.queries = obstacleCase.queries.filter(query => (
    query.id === 'upper-obstacle-blocks-upper-layer'
    || query.id === 'upper-obstacle-does-not-block-ground'
  ));

  const report = evaluateNavMeshMultilayerCorpus(candidate);
  assert.equal(report.status, 'failed');
  assert.equal(report.violations.length, 2);
});

test('corpus validation rejects non-normalized up vectors and unknown expectation ids', () => {
  const invalidUp = structuredClone(corpus);
  invalidUp.cases[0].up = [0, 2, 0];
  assert.throws(
    () => validateNavMeshMultilayerCorpus(invalidUp),
    /up vector must be normalized/,
  );

  const invalidPortal = structuredClone(corpus);
  invalidPortal.cases[0].queries[0].expected.portalPath = ['unknown-portal'];
  assert.throws(
    () => validateNavMeshMultilayerCorpus(invalidPortal),
    /Unknown NavMesh .* expected portal id "unknown-portal"/,
  );
});

function resultMap(report) {
  return new Map(report.results.map(result => [`${result.caseId}/${result.queryId}`, result]));
}
