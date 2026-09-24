// Historical documentation and source-neutral HYA contracts are intentionally allowed.
const rivePath = /(?:^|[/_.-])rive(?:$|[/_.-])/i;
const runtimeTokens = /@rive-app\/|convertRivBytesToHya|quantizeRiveTextCoverage|fs_main_rive_text|['"]rive-text['"]/;

export function validateNoRiveRelease({ files, packages, lock, examples, runtimeSources }) {
  const errors = [];
  for (const file of files) {
    if (rivePath.test(file) || /\.riv$/i.test(file)) errors.push(`Rive implementation or asset: ${file}`);
  }
  for (const [path, pkg] of Object.entries(packages)) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dependency of Object.keys(pkg[field] ?? {})) {
        if (dependency.startsWith('@rive-app/') || /^rive(?:-|$)/i.test(dependency)) {
          errors.push(`Rive dependency in ${path}#${field}: ${dependency}`);
        }
      }
    }
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      if (/^rive:/.test(name) || /(?:^|[\s/])rive[-/]/i.test(command)) errors.push(`Rive command in ${path}: ${name}`);
    }
    const exports = JSON.stringify(pkg.exports ?? {});
    if (runtimeTokens.test(exports) || /(?:["/])rive(?:["/.-])/.test(exports)) errors.push(`Rive export in ${path}`);
  }
  for (const name of Object.keys(lock.packages ?? {})) {
    if (/(?:^|\/)node_modules\/(?:@rive-app\/|rive(?:-|$))/i.test(name)) errors.push(`Rive lockfile entry: ${name}`);
  }
  for (const entry of examples.entries ?? []) {
    if (rivePath.test(entry.id) || rivePath.test(entry.entry)) errors.push(`Rive example: ${entry.id}`);
  }
  for (const [path, source] of Object.entries(runtimeSources)) {
    if (runtimeTokens.test(source)) errors.push(`Rive runtime path: ${path}`);
  }
  return errors;
}
