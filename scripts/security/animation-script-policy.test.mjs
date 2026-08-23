import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditAnimationScriptIsolation, auditAnimationScriptPackageClosure, scanAnimationScriptSource } from './animation-script-policy.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('G09 runtime has no dynamic execution, ambient authority, source vocabulary or shader concatenation', () => {
  const report = auditAnimationScriptIsolation(workspace);
  assert.equal(report.status, 'passed', JSON.stringify(report.findings, null, 2));
  assert.equal(report.findings.length, 0);
  assert.ok(report.files >= 10);
});
test('security scanner classifies representative escape surfaces independently', () => {
  assert.deepEqual(scanAnimationScriptSource('const x = eval(userSource)'), ['dynamic-eval']);
  assert.deepEqual(scanAnimationScriptSource('fetch("https://example.invalid")'), ['network']);
  assert.deepEqual(scanAnimationScriptSource('window.localStorage.getItem("token")'), ['browser-ambient']);
  assert.deepEqual(scanAnimationScriptSource('import("./plugin.js")'), ['dynamic-module']);
  assert.deepEqual(scanAnimationScriptSource('import fs from "node:fs"'), ['filesystem-process']);
  assert.deepEqual(scanAnimationScriptSource('new ScriptExecutionScope()'), ['trusted-runtime']);
});
test('G09 stays absent from public package exports and published browser payloads until G13 integration', () => {
  const report = auditAnimationScriptPackageClosure(workspace);
  assert.equal(report.status, 'passed', JSON.stringify(report.findings, null, 2));
  assert.deepEqual(report.packages, ['@haiyue/animation-spec', '@haiyue/extensions']);
  assert.equal(report.denyListSchemaVersion, 1);
});
