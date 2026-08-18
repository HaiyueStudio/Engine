import {
  ANIMATION_MIME_TYPE,
  parseAnimation,
  type AnimationResource,
  type AnimationParseOptions,
  type ParsedAnimation,
} from '@haiyue/animation-spec';
import type { AssetLoaderRegistration } from '@haiyue/engine/assets';

export const HAIYUE_ANIMATION_ASSET_TYPE = 'animation/haiyue' as const;

export interface AnimationAssetLoaderOptions {
  parse?: AnimationParseOptions;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

let nextAnimationLoaderId = 1;

/** Creates an AssetManager loader without installing source-format converters in the runtime. */
export function createAnimationAssetLoader(
  options: AnimationAssetLoaderOptions = {},
): AssetLoaderRegistration<ParsedAnimation> {
  const fetchResource = options.fetch ?? fetch;
  const loaderId = nextAnimationLoaderId++;
  return {
    type: HAIYUE_ANIMATION_ASSET_TYPE,
    extensions: ['.hya'],
    mimeTypes: [ANIMATION_MIME_TYPE],
    aliases: ['hya'],
    async load(url, context) {
      context.setPhase('loading');
      const networkKey = `network:hya:${url}`;
      let buffer = context.cache.network.get(networkKey) as ArrayBuffer | undefined;
      let responseUrl = '';
      if (!buffer) {
        const response = await fetchResource(url, { signal: context.signal });
        if (!response.ok) throw new Error(`Failed to load Haiyue animation (${response.status} ${response.statusText}): ${url}`);
        responseUrl = response.url;
        buffer = await response.arrayBuffer();
        if (context.signal.aborted) throw context.signal.reason;
        context.cache.network.set(networkKey, buffer, buffer.byteLength);
      }
      context.reportProgress(buffer.byteLength, buffer.byteLength);
      context.setPhase('parsing');
      const parsedKey = `parsed:hya:${loaderId}:${url}`;
      let animation = context.cache.parsed.get(parsedKey) as ParsedAnimation | undefined;
      if (!animation) {
        animation = resolveAnimationResourceUris(
          parseAnimation(buffer, options.parse),
          responseUrl || absoluteAnimationUrl(url),
        );
        context.cache.parsed.set(parsedKey, animation, buffer.byteLength);
      }
      return animation;
    },
  };
}

/** Package-relative resources resolve from the fetched HYA, including redirects. */
function resolveAnimationResourceUris(animation: ParsedAnimation, sourceUrl: string): ParsedAnimation {
  if (!sourceUrl || animation.resources.length === 0) return animation;
  const resources = animation.resources.map(resource => {
    try {
      return Object.freeze({ ...resource, uri: new URL(resource.uri, sourceUrl).href });
    } catch {
      return resource;
    }
  }) as readonly AnimationResource[];
  return Object.freeze({ ...animation, resources: Object.freeze(resources) });
}

function absoluteAnimationUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    const base = typeof globalThis.location === 'object' ? globalThis.location.href : '';
    if (!base) return '';
    try {
      return new URL(url, base).href;
    } catch {
      return '';
    }
  }
}
