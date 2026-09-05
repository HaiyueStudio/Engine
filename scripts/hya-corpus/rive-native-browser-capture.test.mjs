import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedArtboardHasLinkedViewModel } from './rive-native-browser-capture.mjs';

function importedArtboard(status, neutralFieldIds) {
  return {
    ir: { objects: [{ id: 'artboard', properties: [{ id: 'name', value: { type: 'string', value: 'Selected' } }] }] },
    report: { objects: [{
      neutralObjectId: 'artboard', sourceName: 'Artboard', properties: [
        { sourceName: 'name', status: 'consumed', neutralFieldIds: ['name'] },
        { sourceName: 'viewModelId', status, neutralFieldIds },
      ],
    }] },
  };
}

test('selected artboard ViewModel probe ignores models owned by other artboards', () => {
  assert.equal(selectedArtboardHasLinkedViewModel(importedArtboard('not-serialized', []), 'Selected'), false);
});

test('selected artboard ViewModel probe recognizes an authored viewModelId', () => {
  assert.equal(selectedArtboardHasLinkedViewModel(importedArtboard('consumed', ['view-model']), 'Selected'), true);
});
