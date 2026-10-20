interface DepthUse {
  readonly loadOp: GPULoadOp;
  readonly clearValue?: number;
  /** Must agree with every pipeline used by the render pass. */
  readonly writesDepth: boolean;
  /** Any later test/sample/copy, external observer, or history requires preservation. */
  readonly retained: boolean;
}

/** Private proven-use policy. A partial viewport never implies a full overwrite. */
export function depthAttachmentOperations(use: DepthUse, optimize = true): Omit<GPURenderPassDepthStencilAttachment, 'view'> {
  // Read-only depth has no load/store operations in WebGPU. Existing contents are preserved.
  if (optimize && !use.writesDepth && use.loadOp === 'load') return { depthReadOnly: true };
  return {
    depthLoadOp: use.loadOp,
    depthStoreOp: !optimize || use.retained ? 'store' : 'discard',
    ...(use.loadOp === 'clear' ? { depthClearValue: use.clearValue ?? 1 } : {}),
  };
}
