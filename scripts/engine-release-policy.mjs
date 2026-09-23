export function createEngineSlowChecks(plan) {
  if (!['smoke', 'full'].includes(plan.tier) || plan.targets.some(target => !target.startsWith('example:'))) {
    throw new Error('Engine release requires an Engine example plan with smoke/full tier.');
  }
  return [
    ['run', 'verify:engine-render'],
    ['run', plan.tier === 'full' ? 'verify:ambient-occlusion:performance' : 'verify:ambient-occlusion:performance:smoke'],
    ['run', 'verify:shader-language-stage14'],
    ...(plan.targets.length ? [['run', 'build:target', '--', ...plan.targets]] : []),
    ['run', 'benchmark'],
  ];
}
export function validateEngineEntryBudget(size, maximum) {
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(maximum) || maximum <= 0) throw new Error('Invalid Engine entry byte measurement/budget.');
  if (size > maximum) throw new Error(`Engine entry ${size}B exceeds ${maximum}B`);
}

// Logical paths from the former Studio-wide structural checks.
export function includesGatePath(path, scope = 'studio') {
  if (!['engine', 'studio'].includes(scope)) throw new Error(`Unknown gate scope: ${scope}`);
  return scope === 'studio' || !['ui', 'editor', 'AnimationEditor', 'voxelEditor', 'games'].includes(path.split('/')[0]);
}
