import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeExampleBrowserCandidates } from './native-example-browsers.mjs';

test('native example candidates retain Windows Chrome and Edge and accept Mac Metal', () => {
  assert.deepEqual(nativeExampleBrowserCandidates('darwin', ''), [{
    browser: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', backend: 'metal',
  }]);
  const windows = nativeExampleBrowserCandidates('win32', '');
  assert.deepEqual(windows.map(entry => [entry.browser, entry.backend]), [['chrome', 'd3d11'], ['edge', 'd3d11']]);
  assert.ok(windows.every(entry => entry.path.startsWith('C:\\Program Files')));
  assert.equal(nativeExampleBrowserCandidates('linux', '')[0].backend, 'vulkan');
});

test('explicit Chrome binary keeps the native backend without replacing Windows Edge coverage', () => {
  assert.deepEqual(nativeExampleBrowserCandidates('darwin', '/custom/chrome')[0], {
    browser: 'chrome', path: '/custom/chrome', backend: 'metal',
  });
  assert.equal(nativeExampleBrowserCandidates('win32', 'D:\\chrome.exe').length, 2);
  assert.throws(() => nativeExampleBrowserCandidates('unknown', ''), /Unsupported native example platform/);
});
