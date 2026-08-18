import { parseAtlas, type AtlasRegion } from './SpineAtlasParser';
import { normalizeSpineData } from './SpineSkeletonRuntime';

export interface SpineAssetParserInput { json: unknown; atlasText: string; }
/** Structured-clone-safe parser boundary; the runtime validates and narrows this payload before use. */
export interface SpineParsedAsset { data: unknown; regions: Array<[string, AtlasRegion]>; }

export const SPINE_ASSET_PARSER = Object.freeze({
  type: 'skeleton/spine',
  parse(input: SpineAssetParserInput, _context?: { signal?: AbortSignal; source?: string }): SpineParsedAsset {
    return {
      data: normalizeSpineData(input.json),
      regions: [...parseAtlas(input.atlasText).entries()],
    };
  },
});

export function parseSpineAssetPayload(input: SpineAssetParserInput): SpineParsedAsset {
  return SPINE_ASSET_PARSER.parse(input, { source: 'spine' });
}
