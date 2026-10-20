import { comparePortablePixelRecords } from './visual-regression/portable-pixels.mjs';

export const PBR_PIXEL_MODES = Object.freeze(['off', 'on', 'specular', 'sheen', 'transmission', 'shadowInstancing']);
const original = 'review/baselines/render-pixels-stage9-pbr-example.json';

export function pbrPixelBaselinePath(platform) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw Error(`Unsupported PBR screenshot platform: ${platform}`);
  return platform === 'win32' ? 'review/baselines/render-pixels-stage9-pbr-example.win32.json' : original;
}

/** Full-page RGBA comparisons retain the original budgets and all six modes. */
export function comparePbrPixelBaseline(current, baseline, platform) {
  pbrPixelBaselinePath(platform);
  if (platform === 'win32' && baseline?.referencePlatform !== 'win32') throw Error('Windows PBR requires its reviewed Windows full-page baseline');
  if (platform !== 'win32' && baseline?.referencePlatform) throw Error('PBR baseline belongs to another platform');
  const identity = { schemaVersion: 3, fixture: 'haiyue-pbr-showcase-clearcoat-chrome-960x640', width: 960, height: 640 };
  for (const [key, value] of Object.entries(identity)) {
    if (current?.[key] !== value || baseline?.[key] !== value) throw Error(`PBR screenshot identity changed at ${key}`);
  }
  const wanted = [...PBR_PIXEL_MODES].sort().join(',');
  for (const record of [current, baseline]) {
    if (Object.keys(record.modes ?? {}).sort().join(',') !== wanted) throw Error('PBR requires all six exact screenshot modes');
    for (const mode of PBR_PIXEL_MODES) {
      if (record.modes[mode]?.visual?.width !== 960 || record.modes[mode]?.visual?.height !== 640) throw Error(`PBR ${mode} RGBA dimensions changed`);
    }
  }
  const modes = Object.fromEntries(PBR_PIXEL_MODES.map(mode => [mode, comparePortablePixelRecords(current.modes[mode], baseline.modes[mode])]));
  return { status: Object.values(modes).every(value => value.status === 'passed') ? 'passed' : 'failed',
    baseline: pbrPixelBaselinePath(platform), referencePlatform: platform, modes };
}
