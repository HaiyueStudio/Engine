import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { hostname, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from '../webgpu-gate/chrome-runner.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function createDeviceEnvironment({ browser, deviceClass = 'windows-10-plus-device-a' }) {
  if (process.platform !== 'win32') throw new Error('Formal Device A environment collection requires Windows.');
  if (!['chrome', 'edge'].includes(browser)) throw new TypeError('browser must be chrome or edge.');
  const previousChromePath = process.env.CHROME_PATH;
  process.env.CHROME_PATH = browserPath(browser);
  try {
    const probe = await runChromeWebGpuFixture({
      root,
      fixture: 'scripts/hya-corpus/fixtures/rive-device-probe.html',
      timeoutMs: 60_000,
      acceptedStatuses: ['passed'],
      crossOriginIsolation: true,
    });
    const identity = await machineIdentitySha256();
    const browserVersion = String(probe.browserEvidence?.product ?? '').split('/').at(-1);
    if (!browserVersion) throw new Error('Browser version was not reported by the native browser.');
    const build = release();
    const windowsMajor = Number(build.split('.')[0]);
    if (!Number.isSafeInteger(windowsMajor) || windowsMajor < 10) throw new Error(`Windows 10 or later is required; observed ${build}.`);
    return Object.freeze({
      deviceClass,
      physicalDevice: true,
      browser,
      browserVersion,
      os: `Windows ${windowsMajor}`,
      osBuild: build,
      gpu: `${probe.webgpu.description} / ${probe.webgl2.renderer}`,
      machineIdSha256: identity,
      officialBackend: 'webgl2',
      hyaBackend: 'webgpu',
      nativeBackend: probe.browserEvidence.nativeBackend === true,
      browserLogCaptured: true,
      consoleErrorCount: probe.browserDiagnostics.consoleErrorCount,
      exceptionCount: probe.browserDiagnostics.exceptionCount,
      adapter: { ...probe.webgpu },
      dpr: probe.dpr,
      viewport: probe.viewport,
      audioSampleRate: 48_000,
      fonts: [],
      externalAssets: [],
    });
  } finally {
    if (previousChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = previousChromePath;
  }
}

async function machineIdentitySha256() {
  const { stdout } = await execute('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true });
  const match = /MachineGuid\s+REG_SZ\s+([^\s]+)/iu.exec(stdout);
  if (!match) throw new Error('Windows MachineGuid is unavailable for hashed physical-machine identity.');
  return createHash('sha256').update(`haiyue-rive-device-v1\0${hostname()}\0${match[1]}`, 'utf8').digest('hex');
}

function browserPath(browser) {
  if (browser === 'edge') return process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  return process.env.GOOGLE_CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}

function argument(name) { return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1); }
function required(value, label) { if (!value) throw new TypeError(`${label} is required.`); return value; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = required(argument('--browser'), '--browser');
  const output = resolve(required(argument('--out'), '--out'));
  const environment = await createDeviceEnvironment({ browser, deviceClass: argument('--device-class') ?? 'windows-10-plus-device-a' });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(environment, null, 2)}\n`);
  console.log(`[rive-device-environment] ${browser} Device A identity written to ${output}; raw machine identifiers were not persisted.`);
}
