/** Actual submission-time compatibility. This module never owns graph ordering or GPU resources. */
export function canShareRenderPass(
  current: GPURenderPassDescriptor,
  currentTargetKey: string,
  currentSampleCount: number,
  next: GPURenderPassDescriptor,
  nextTargetKey: string,
  nextSampleCount: number,
): boolean {
  return hasSameRenderTarget(
    current,
    currentTargetKey,
    currentSampleCount,
    next,
    nextTargetKey,
    nextSampleCount,
  ) && hasSameRequiredPassState(current, next);
}

export function sharedPassConflictMessage(
  current: GPURenderPassDescriptor,
  currentTargetKey: string,
  currentSampleCount: number,
  next: GPURenderPassDescriptor,
  nextTargetKey: string,
  nextSampleCount: number,
): string {
  if (!hasSameRenderTarget(
    current,
    currentTargetKey,
    currentSampleCount,
    next,
    nextTargetKey,
    nextSampleCount,
  )) {
    return `Shared entry was split because target attachment identity, depth presence, or sample count changed from "${currentTargetKey}" to "${nextTargetKey}".`;
  }
  return `Shared entry was split because actual load/store or required pass state conflicts on target "${nextTargetKey}".`;
}

export function getResolvedRenderPassKey(
  descriptor: GPURenderPassDescriptor,
  targetKey: string,
  sampleCount: number,
): string {
  const colors = descriptor.colorAttachments as readonly (GPURenderPassColorAttachment | null | undefined)[];
  const colorState = colors.map(attachment => attachment
    ? `${attachment.loadOp ?? 'load?'}:${attachment.storeOp ?? 'store?'}`
    : 'none').join(',');
  const depth = descriptor.depthStencilAttachment;
  return `${targetKey}|samples:${sampleCount}|color:${colorState}|depth:${depth ? `${depth.depthLoadOp ?? 'load?'}:${depth.depthStoreOp ?? 'store?'}` : 'none'}`;
}

function hasSameRenderTarget(
  current: GPURenderPassDescriptor,
  currentTargetKey: string,
  currentSampleCount: number,
  next: GPURenderPassDescriptor,
  nextTargetKey: string,
  nextSampleCount: number,
): boolean {
  if (!currentTargetKey || currentTargetKey !== nextTargetKey || currentSampleCount !== nextSampleCount) return false;
  const currentColors = current.colorAttachments as readonly (GPURenderPassColorAttachment | null | undefined)[];
  const nextColors = next.colorAttachments as readonly (GPURenderPassColorAttachment | null | undefined)[];
  if (currentColors.length !== nextColors.length) return false;
  for (let index = 0; index < currentColors.length; index++) {
    const left = currentColors[index] ?? null;
    const right = nextColors[index] ?? null;
    if (left === null || right === null) {
      if (left !== right) return false;
      continue;
    }
    if (left.view === undefined || right.view === undefined
      || left.view !== right.view
      || left.resolveTarget !== right.resolveTarget
      || left.depthSlice !== right.depthSlice
    ) return false;
  }
  const currentDepth = current.depthStencilAttachment;
  const nextDepth = next.depthStencilAttachment;
  return currentDepth
    ? nextDepth !== undefined && currentDepth.view === nextDepth.view
    : nextDepth === undefined;
}

function hasSameRequiredPassState(
  current: GPURenderPassDescriptor,
  next: GPURenderPassDescriptor,
): boolean {
  if (current.occlusionQuerySet !== next.occlusionQuerySet
    || current.timestampWrites !== next.timestampWrites
    || current.maxDrawCount !== next.maxDrawCount
  ) return false;
  const currentColors = current.colorAttachments as readonly (GPURenderPassColorAttachment | null | undefined)[];
  const nextColors = next.colorAttachments as readonly (GPURenderPassColorAttachment | null | undefined)[];
  for (let index = 0; index < currentColors.length; index++) {
    const left = currentColors[index] ?? null;
    const right = nextColors[index] ?? null;
    if (left === null || right === null) continue;
    if (left.loadOp !== right.loadOp
      || left.storeOp !== right.storeOp
      || !sameGpuColor(left.clearValue, right.clearValue)
    ) return false;
  }
  const left = current.depthStencilAttachment;
  const right = next.depthStencilAttachment;
  if (!left || !right) return left === right;
  return left.depthLoadOp === right.depthLoadOp
    && left.depthStoreOp === right.depthStoreOp
    && left.depthClearValue === right.depthClearValue
    && left.depthReadOnly === right.depthReadOnly
    && left.stencilLoadOp === right.stencilLoadOp
    && left.stencilStoreOp === right.stencilStoreOp
    && left.stencilClearValue === right.stencilClearValue
    && left.stencilReadOnly === right.stencilReadOnly;
}

function sameGpuColor(left: GPUColor | undefined, right: GPUColor | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  const a = left as GPUColorDict & readonly number[];
  const b = right as GPUColorDict & readonly number[];
  return (a.r ?? a[0]) === (b.r ?? b[0])
    && (a.g ?? a[1]) === (b.g ?? b[1])
    && (a.b ?? a[2]) === (b.b ?? b[2])
    && (a.a ?? a[3]) === (b.a ?? b[3]);
}
