import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';

export function releaseTemporaryBase({
  platform = process.platform,
  home = homedir(),
  systemTemp = tmpdir(),
} = {}) {
  // os.tmpdir() can expose an 8.3 user-profile alias on Windows even when
  // os.homedir() has the stable long spelling. Rollup/libuv must not watch a
  // checkout rooted below that alias.
  return platform === 'win32'
    ? resolve(home, 'AppData', 'Local', 'Temp')
    : systemTemp;
}
