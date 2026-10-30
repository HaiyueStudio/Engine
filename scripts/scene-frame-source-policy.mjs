// Both forms read fog from the shared environment. The inline form lets the
// renderer subsequently request the light snapshot for this exact frame.
export const SHARED_SCENE_FRAME_UNIFORM_CALL = /getSceneFrameUniformSnapshot\(\s*cameraFrame\s*,\s*(?:sceneEnvironment\.fog|getSceneRenderEnvironment\(\s*frameData\s*,\s*world\s*\)\.fog)\s*\)/;

/** G04 retains camera copies until submission; follow the owner to the same shared ABI. */
export function usesOwnedSharedSceneFrame(renderer, owner) {
  return /import\s*\{Camera3DFrameSnapshots\}\s*from\s*['"]\.\.\/frame\/Camera3DFrameSnapshots['"]/.test(renderer)
    && /_cameraFrames\s*=\s*new Camera3DFrameSnapshots\(\)/.test(renderer)
    && /this\._cameraFrames\.uniforms\(\s*cameraFrame\s*,\s*sceneEnvironment\.fog\s*\)/.test(renderer)
    && /uniforms\(data:Camera3DFrameData,fog:Fog\|null\):SceneFrameUniformSnapshot\s*\{\s*const snapshot=getSceneFrameUniformSnapshot\(data,fog\);trackSceneFrameUniformOwner\(data,snapshot\);return snapshot;\s*\}/.test(owner);
}
