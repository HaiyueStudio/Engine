// Both forms read fog from the shared environment. The inline form lets the
// renderer subsequently request the light snapshot for this exact frame.
export const SHARED_SCENE_FRAME_UNIFORM_CALL = /getSceneFrameUniformSnapshot\(\s*cameraFrame\s*,\s*(?:sceneEnvironment\.fog|getSceneRenderEnvironment\(\s*frameData\s*,\s*world\s*\)\.fog)\s*\)/;
