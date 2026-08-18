import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  MATERIAL_GRAPH_ARTIFACT_FORMAT,
  compileMaterialGraphDocumentV1,
  getMaterialGraphAuthoringCatalogV1,
  getMaterialGraphSurfaceSlotsV1,
} from '../dist/material-graph.js';

const source = await readFile(new URL('../pilot-pbr-composition.graph.json', import.meta.url), 'utf8');

test('Material Graph facade exposes authoring nodes and deployable output without Typed IR', () => {
  const catalog = getMaterialGraphAuthoringCatalogV1();
  assert.ok(catalog.length >= 4);
  assert.ok(catalog.every(node => node.id && node.label && node.category && Array.isArray(node.ports)));
  assert.ok(catalog.every(node => !('lower' in node) && !('module' in node)));
  assert.ok(getMaterialGraphSurfaceSlotsV1().includes('baseColor'));
  assert.ok(getMaterialGraphSurfaceSlotsV1().includes('clearcoat'));

  const result = compileMaterialGraphDocumentV1(source);
  assert.equal(result.ok, true);
  assert.equal(result.artifact.format, MATERIAL_GRAPH_ARTIFACT_FORMAT);
  assert.match(result.artifact.canonicalHash, /^[a-f0-9]{64}$/);
  assert.match(result.artifact.source.code, /@fragment/);
  assert.equal(result.artifact.runtimeAdapter, 'renderer-adapter-required');
  assert.ok(!('typedIr' in result.artifact));
  assert.ok(!('composition' in result.artifact));
  assert.deepEqual(Object.keys(result.artifact.graph).sort(), ['format', 'kind', 'profile', 'version']);
});

test('Material Graph facade returns stable authoring diagnostics instead of compiler internals', () => {
  const graph = JSON.parse(source);
  graph.nodes[0].type = 'vendor.private-ir-node';
  const result = compileMaterialGraphDocumentV1(graph);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'E_SHADER_GRAPH_NODE_UNKNOWN');
  assert.equal(result.diagnostics[0].path, 'nodes.0');
});
