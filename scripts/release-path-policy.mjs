export function portableReleasePath(path) {
  if (typeof path !== 'string') throw new TypeError('Release path must be a string.');
  return path.replaceAll('\\', '/');
}
