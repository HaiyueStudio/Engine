export const FRAMEGRAPH_GPU_CONTROL = Object.freeze({ profileName: 'Google Chrome', applicationName: 'chrome.exe', applicationCount: 1, settingId: 274197361, value: 1, clockLock: false });
export function validateFrameGraphGpuPolicy(observation, policy) {
  if (!policy) return;
  if (JSON.stringify(policy) !== JSON.stringify(FRAMEGRAPH_GPU_CONTROL)) throw Error('Unknown Chrome GPU power policy');
  const expected = { Found: true, ProfileName: policy.profileName, ApplicationName: policy.applicationName, ApplicationCount: policy.applicationCount, SettingId: policy.settingId, Type: 0, Location: 0, CurrentPredefined: 0, Value: policy.value };
  if (!observation || Object.entries(expected).some(([key, value]) => observation[key] !== value)) throw Error('Chrome GPU power policy missing, inherited or changed');
}
