import type { AssetManager } from '@haiyue/engine/assets';
import type { GuiButton, GuiImage, GuiLabel } from '@haiyue/engine/gui';
import type { I18n } from './I18n';
import type { I18nParams } from './types';

export interface I18nTextBinding {
  refresh(): void;
  setParams(params: I18nParams): void;
  dispose(): void;
}
/** Call dispose (or abort the scene signal) when removing the target. */
export function bindI18nText(i18n: I18n, target: GuiLabel | GuiButton, key: string,
  options: { params?: I18nParams; signal?: AbortSignal } = {}): I18nTextBinding {
  let dead = false;
  let params = { ...options.params };
  let unsubscribe = () => {};
  const binding: I18nTextBinding = {
    refresh() { if (!dead) target.setText(i18n.text(key, params)); },
    setParams(next) { params = { ...next }; binding.refresh(); },
    dispose() {
      if (dead) return;
      dead = true;
      unsubscribe();
      options.signal?.removeEventListener('abort', binding.dispose);
    },
  };
  if (options.signal?.aborted || i18n.disposed) { dead = true; return binding; }
  unsubscribe = i18n.subscribe(event => event.type === 'dispose' ? binding.dispose() : binding.refresh());
  options.signal?.addEventListener('abort', binding.dispose, { once: true });
  try { binding.refresh(); } catch (error) { binding.dispose(); throw error; }
  return binding;
}
export interface I18nImageHandle {
  readonly texture: GPUTexture;
  /** Release this lease, not other consumers of a shared texture. Must not throw. */
  release(): void;
}
export type I18nImageLoader = (path: string, signal: AbortSignal) => Promise<I18nImageHandle>;
export interface I18nImageOptions {
  load: I18nImageLoader;
  textKey: string;
  /** Plain text displayed until the first image succeeds. Existing images survive failure. */
  fallbackLabel?: GuiLabel;
  signal?: AbortSignal;
}
export interface I18nImageBinding {
  /** Completion of the latest image request; errors are available through error. */
  readonly ready: Promise<void>;
  readonly error: unknown;
  /** Semantic text for the displayed image, or the fallback text before first success. */
  readonly description: string;
  refresh(): Promise<void>;
  dispose(): void;
}
/** Texture replacement preserves the GuiImage's logical dimensions and UVs. */
export function bindI18nImage(i18n: I18n, target: GuiImage, key: string, options: I18nImageOptions): I18nImageBinding {
  let dead = false, generation = 0;
  let request: AbortController | undefined;
  let owned: I18nImageHandle | undefined;
  let loadedPath: string | undefined;
  let source: { texture: GPUTexture; version: number } | undefined;
  let error: unknown;
  let description = '';
  let ready: Promise<void> = Promise.resolve();
  let unsubscribe = () => {};
  const originalSource = target.source, originalKey = target.sourceKey;
  const originalFallbackVisible = options.fallbackLabel?.visible;
  const originalFallbackText = options.fallbackLabel?.text;
  const binding: I18nImageBinding = {
    get ready() { return ready; }, get error() { return error; }, get description() { return description; },
    refresh() {
      if (dead) return ready;
      request?.abort();
      const controller = request = new AbortController();
      const id = ++generation;
      ready = (async () => {
        try {
          const nextDescription = i18n.text(options.textKey);
          const path = i18n.asset(key);
          error = undefined;
          if (!owned) {
            description = nextDescription;
            options.fallbackLabel?.setText(description);
            options.fallbackLabel?.setVisible(!target.source);
          }
          if (!path) throw new Error(`Missing localized image: ${key}`);
          if (owned && path === loadedPath) { description = nextDescription; return; }
          const next = await options.load(path, controller.signal);
          if (dead || id !== generation || controller.signal.aborted) { next.release(); return; }
          const previous = owned;
          owned = next;
          loadedPath = path;
          description = nextDescription;
          // A stable source identity lets the GUI retire its previous bind group on version changes.
          if (source) source.version++;
          else source = { get texture() { return owned!.texture; }, version: 0 };
          target.setSource(source, path);
          options.fallbackLabel?.setVisible(false);
          previous?.release();
        } catch (cause) {
          if (!dead && id === generation && !controller.signal.aborted) error = cause;
        }
      })();
      return ready;
    },
    dispose() {
      if (dead) return;
      dead = true; generation++;
      request?.abort(); unsubscribe();
      options.signal?.removeEventListener('abort', binding.dispose);
      if (source && target.source === source) target.setSource(originalSource, originalKey);
      owned?.release(); owned = undefined;
      if (options.fallbackLabel) {
        options.fallbackLabel.setText(originalFallbackText!);
        options.fallbackLabel.setVisible(originalFallbackVisible!);
      }
    },
  };
  if (options.signal?.aborted || i18n.disposed) { dead = true; return binding; }
  unsubscribe = i18n.subscribe(event => { if (event.type === 'dispose') binding.dispose(); else void binding.refresh(); });
  options.signal?.addEventListener('abort', binding.dispose, { once: true });
  void binding.refresh();
  return binding;
}
/** Uses the engine's cache/reference counting. Resolve paths relative to an explicit game asset URL. */
export function createI18nTextureLoader(assets: Pick<AssetManager, 'loadTexture'>, baseUrl: string): I18nImageLoader {
  return async (path, signal) => {
    const handle = await assets.loadTexture(new URL(path, baseUrl).href, { signal, mipmaps: 'none', premultipliedAlpha: false });
    return { get texture() { return handle.value; }, release: () => handle.release() };
  };
}
