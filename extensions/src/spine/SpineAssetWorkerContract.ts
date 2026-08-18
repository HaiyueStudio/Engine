/** Stable structural seam for optional Spine parsing offload. */
export interface SpineAssetWorker {
  loadParsedAsset(jsonUrl: string, atlasUrl: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}
