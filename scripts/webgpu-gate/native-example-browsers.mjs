// Keep Windows coverage and use the native Chrome/Metal path on macOS.
export function nativeExampleBrowserCandidates(platform = process.platform, chromePath = process.env.CHROME_PATH) {
  const defaults = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'metal'],
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'd3d11'],
    linux: ['/usr/bin/google-chrome', 'vulkan'],
  };
  const selected = defaults[platform];
  if (!selected) throw new Error(`Unsupported native example platform: ${platform}`);
  const [path, backend] = selected;
  return [
    { browser: 'chrome', path: chromePath || path, backend },
    ...(platform === 'win32' ? [{ browser: 'edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', backend }] : []),
  ];
}
