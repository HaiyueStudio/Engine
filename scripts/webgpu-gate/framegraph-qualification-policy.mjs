import { selectReleaseQualification } from '../release-platform-policy.mjs';

export const FRAMEGRAPH_QUALIFICATION_CONTRACT = 'engine-native-021-v2';
const check = (condition, message) => { if (!condition) throw Error(message); };

/** A power preference is a hint, never evidence of a second physical GPU. */
export function createFrameGraphQualification(matrix, platform) {
  const path = selectReleaseQualification(matrix, platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'unsupported');
  check(path.nodePlatform === platform, 'Qualification host platform mismatch');
  return { contractId: FRAMEGRAPH_QUALIFICATION_CONTRACT, platform, path,
    targets: path.browserIds.map(browserId => ({ browserId, powerPreference: 'high-performance' })) };
}

export function validateFrameGraphAdapter(adapter, qualification) {
  check(adapter?.isFallbackAdapter === false && adapter.vendor && adapter.architecture, 'Native identified adapter required');
  const name = [adapter.vendor, adapter.architecture, adapter.device, adapter.description].filter(Boolean).join(' ');
  check(!/swiftshader|software|llvmpipe|lavapipe|warp|virtual|remote/i.test(name), 'Software/remote adapters cannot qualify');
  if (!qualification) return; // Diagnostic mode cannot grant path qualification.
  check(qualification.contractId === FRAMEGRAPH_QUALIFICATION_CONTRACT, 'Wrong hardware contract');
  // The Windows AMD browser identity often omits the product name. A specific
  // Radeon RX description is required; an RDNA architecture alone also includes APUs.
  check(new RegExp(qualification.path.adapterPattern, 'i').test(name), 'Adapter outside required qualification path; extended compatibility cannot qualify');
}

export function validateFrameGraphBrowser(result, job, qualification) {
  const browser = result?.browserEvidence;
  check(qualification.targets.some(t => t.browserId === job.browserId && t.powerPreference === job.powerPreference), 'Unregistered browser/preference job');
  check(browser?.nativeBackend === true && browser.angleBackend === qualification.path.angleBackend, 'Native qualification backend required');
  const edge = /^Edg\//.test(browser.product ?? '');
  const chrome = /^(?:Headless)?Chrome\//.test(browser.product ?? '') && !/Edg\//.test(browser.userAgent ?? '');
  check(job.browserId.startsWith('edge-') ? edge : chrome, 'Browser identity mismatch (Chrome cannot substitute for Edge)');
  check(qualification.platform === 'win32' ? /Win/i.test(browser.platform ?? '') : /Mac/i.test(browser.platform ?? ''), 'Browser OS mismatch');
}

export function frameGraphAdapterKey(adapter) {
  return JSON.stringify([adapter.vendor, adapter.architecture, adapter.device ?? '', adapter.description ?? '']);
}

export function validateFrameGraphAdapterConsistency(adapters) {
  check(adapters.length > 0 && new Set(adapters.map(frameGraphAdapterKey)).size === 1, 'Physical adapter changed during qualification');
}
