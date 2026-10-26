import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEvidenceTargetVersion} from './engine-021-evidence-policy.mjs';
test('inherited rendering contract still requires the current candidate version',()=>{
  assert.doesNotThrow(()=>validateEvidenceTargetVersion({targetVersion:'0.2.2'},'0.2.2'));
  for(const manifest of [{},{targetVersion:'0.2.1'},{targetVersion:'0.3.0'}])assert.throws(()=>validateEvidenceTargetVersion(manifest,'0.2.2'),/target version/);
  assert.doesNotThrow(()=>validateEvidenceTargetVersion({},'0.2.1'));
});
