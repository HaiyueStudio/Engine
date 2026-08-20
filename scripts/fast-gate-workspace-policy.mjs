export const MANDATORY_FAST_TEST_TARGETS = Object.freeze([
  target('engine', 'Engine', ['test', '-w', './engine']),
  target('animation-spec', 'Engine', ['test', '-w', './animation-spec']),
  target('extensions', 'Engine', ['test', '-w', './extensions']),
  target('ui', 'UI', ['test']),
  target('games', 'Games', ['test']),
  target('editor', 'Editor', ['test', '-w', './editor']),
  target('AnimationEditor', 'Editor', ['test', '-w', './AnimationEditor']),
  target('voxelEditor', 'Editor', ['test', '-w', './voxelEditor']),
]);

function target(id, repository, npmArgs) {
  return Object.freeze({ id, repository, npmArgs: Object.freeze(npmArgs) });
}
