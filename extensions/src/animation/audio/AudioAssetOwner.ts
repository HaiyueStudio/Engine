import { AudioRuntimeError, audioRuntimeFail } from './diagnostics.js';
import type {
  AudioDecoderPort,
  AudioResourceResolverPort,
  DecodedAudioHandle,
  RuntimeAudioResource,
} from './runtime-types.js';

interface AudioResourceSlot {
  descriptor: RuntimeAudioResource;
  generation: number;
  controller?: AbortController;
  pending?: Promise<DecodedAudioHandle>;
  cacheDigest?: string;
}

interface AudioCacheEntry {
  readonly handle: DecodedAudioHandle;
  readonly decodedBytes: number;
  references: number;
}

export interface AudioAssetOwnerOptions {
  readonly resolver?: AudioResourceResolverPort;
  readonly ownsDecoder?: boolean;
  readonly maxDecodeJobs: number;
  readonly maxDecodedFrames: number;
  readonly maxDecodedBytes: number;
}

export class AudioAssetOwner {
  private readonly slots: Map<string, AudioResourceSlot>;
  private readonly cache = new Map<string, AudioCacheEntry>();
  private activeDecodeJobs = 0;
  private decodedBytes = 0;
  private disposed = false;

  constructor(
    resources: readonly RuntimeAudioResource[],
    private readonly decoder: AudioDecoderPort,
    private readonly options: AudioAssetOwnerOptions,
  ) {
    this.slots = new Map(resources.map(descriptor => [
      descriptor.id,
      { descriptor, generation: 0 },
    ]));
  }

  load(resourceId: string, signal?: AbortSignal): Promise<DecodedAudioHandle> {
    this.assertLive();
    const slot = this.requireSlot(resourceId);
    if (slot.cacheDigest) return Promise.resolve(this.cache.get(slot.cacheDigest)!.handle);
    if (slot.pending) return slot.pending;
    return this.loadCandidate(resourceId, slot, slot.descriptor, signal);
  }

  private loadCandidate(resourceId: string, slot: AudioResourceSlot, descriptor: RuntimeAudioResource, signal?: AbortSignal): Promise<DecodedAudioHandle> {
    if (signal?.aborted) return Promise.reject(new AudioRuntimeError('E_AUDIO_RUNTIME_ABORTED', `resources.${resourceId}`, 'audio resource job was aborted'));
    const reusable = this.cache.get(descriptor.integrity.digest);
    if (reusable) {
      checkedDecodedBytes(reusable.handle, descriptor, this.options);
      this.commitCache(slot, descriptor);
      return Promise.resolve(reusable.handle);
    }
    if (this.activeDecodeJobs >= this.options.maxDecodeJobs) {
      audioRuntimeFail(
        'E_AUDIO_RUNTIME_LIMIT',
        `resources.${resourceId}`,
        'decode job budget exceeded',
      );
    }

    const generation = slot.generation;
    const controller = new AbortController();
    slot.controller = controller;
    const unlink = forwardAbort(signal, controller);
    this.activeDecodeJobs++;

    const job = this.resolveAndDecode(descriptor, controller.signal)
      .then(handle => {
        if (this.disposed || controller.signal.aborted || slot.generation !== generation) {
          handle.release();
          audioRuntimeFail(
            'E_AUDIO_RUNTIME_ABORTED',
            `resources.${resourceId}`,
            'late decoded result was retired',
          );
        }
        let decodedBytes: number;
        try {
          decodedBytes = checkedDecodedBytes(handle, descriptor, this.options);
        } catch (error) {
          handle.release();
          throw error;
        }
        const digest = descriptor.integrity.digest;
        const cached = this.cache.get(digest);
        if (cached) {
          handle.release();
          checkedDecodedBytes(cached.handle, descriptor, this.options);
          this.commitCache(slot, descriptor);
          return cached.handle;
        }
        if (this.decodedBytes + decodedBytes > this.options.maxDecodedBytes) {
          handle.release();
          audioRuntimeFail(
            'E_AUDIO_RUNTIME_LIMIT',
            `resources.${resourceId}`,
            'decoded audio byte budget exceeded',
          );
        }
        this.cache.set(digest, { handle, decodedBytes, references: 0 });
        this.decodedBytes += decodedBytes;
        this.commitCache(slot, descriptor);
        return handle;
      })
      .catch(error => {
        if (error instanceof AudioRuntimeError) throw error;
        if (controller.signal.aborted) {
          audioRuntimeFail(
            'E_AUDIO_RUNTIME_ABORTED',
            `resources.${resourceId}`,
            'audio resource job was aborted',
          );
        }
        audioRuntimeFail(
          'E_AUDIO_RUNTIME_DECODE',
          `resources.${resourceId}`,
          error instanceof Error ? error.message : 'audio decode failed',
        );
      })
      .finally(() => {
        unlink();
        this.activeDecodeJobs--;
        if (slot.pending === job) delete slot.pending;
        if (slot.controller === controller) delete slot.controller;
      });
    slot.pending = job;
    return job;
  }

  async replace(resource: RuntimeAudioResource, signal?: AbortSignal): Promise<DecodedAudioHandle> {
    this.assertLive();
    validateResourceDescriptor(resource);
    const slot = this.requireSlot(resource.id);
    slot.controller?.abort();
    slot.generation++;
    delete slot.pending;
    return this.loadCandidate(resource.id, slot, resource, signal);
  }

  /** The slot owns its committed lease throughout every overlapping replacement. */
  private commitCache(slot: AudioResourceSlot, descriptor: RuntimeAudioResource): void {
    const digest = descriptor.integrity.digest, previous = slot.cacheDigest;
    this.cache.get(digest)!.references++;
    slot.descriptor = descriptor;
    slot.cacheDigest = digest;
    if (previous) this.releaseCacheReference(previous);
  }

  abort(resourceId: string): void {
    const slot = this.slots.get(resourceId);
    if (!slot || this.disposed) return;
    slot.generation++;
    slot.controller?.abort();
    delete slot.pending;
    delete slot.controller;
  }

  releaseResource(resourceId: string): void {
    const slot = this.slots.get(resourceId);
    if (!slot) return;
    this.abort(resourceId);
    if (slot.cacheDigest) this.releaseCacheReference(slot.cacheDigest);
    delete slot.cacheDigest;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots.values()) {
      slot.generation++;
      slot.controller?.abort();
      delete slot.pending;
      delete slot.controller;
      if (slot.cacheDigest) this.releaseCacheReference(slot.cacheDigest);
      delete slot.cacheDigest;
    }
    for (const entry of this.cache.values()) entry.handle.release();
    this.cache.clear();
    this.decodedBytes = 0;
    this.options.resolver?.dispose?.();
    if (this.options.ownsDecoder ?? true) this.decoder.dispose?.();
  }

  get stats(): Readonly<{
    resources: number;
    loadedResources: number;
    cacheEntries: number;
    activeDecodeJobs: number;
    decodedBytes: number;
    disposed: boolean;
  }> {
    return Object.freeze({
      resources: this.slots.size,
      loadedResources: [...this.slots.values()].filter(slot => slot.cacheDigest !== undefined).length,
      cacheEntries: this.cache.size,
      activeDecodeJobs: this.activeDecodeJobs,
      decodedBytes: this.decodedBytes,
      disposed: this.disposed,
    });
  }

  private async resolveAndDecode(
    resource: RuntimeAudioResource,
    signal: AbortSignal,
  ): Promise<DecodedAudioHandle> {
    const bytes = resource.source.kind === 'embedded'
      ? decodeBase64(resource.source.data)
      : await this.resolveExternal(resource, signal);
    if (signal.aborted) audioRuntimeFail('E_AUDIO_RUNTIME_ABORTED', `resources.${resource.id}`, 'resource resolution was aborted');
    const buffer = exactArrayBuffer(bytes);
    const digest = await sha256Hex(buffer);
    if (digest !== resource.integrity.digest) {
      audioRuntimeFail(
        'E_AUDIO_RUNTIME_INTEGRITY',
        `resources.${resource.id}.integrity`,
        'audio resource SHA-256 mismatch',
        Object.freeze({ expected: resource.integrity.digest, observed: digest }),
      );
    }
    return this.decoder.decode(Object.freeze({ resource, bytes: buffer }), signal);
  }

  private async resolveExternal(
    resource: RuntimeAudioResource,
    signal: AbortSignal,
  ): Promise<ArrayBuffer | Uint8Array> {
    const resolver = this.options.resolver;
    if (!resolver) {
      audioRuntimeFail(
        'E_AUDIO_RUNTIME_PORT',
        `resources.${resource.id}.source`,
        'referenced and hosted audio require an explicit host resolver',
      );
    }
    return resolver.resolve(Object.freeze({ resource }), signal);
  }

  private releaseCacheReference(digest: string): void {
    const entry = this.cache.get(digest);
    if (!entry) return;
    entry.references--;
    if (entry.references > 0) return;
    entry.handle.release();
    this.decodedBytes -= entry.decodedBytes;
    this.cache.delete(digest);
  }

  private requireSlot(resourceId: string): AudioResourceSlot {
    const slot = this.slots.get(resourceId);
    if (!slot) audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', `resources.${resourceId}`, 'unknown audio resource');
    return slot;
  }

  private assertLive(): void {
    if (this.disposed) audioRuntimeFail('E_AUDIO_RUNTIME_STATE', '$', 'audio asset owner is disposed');
  }
}

function validateResourceDescriptor(resource: RuntimeAudioResource): void {
  if (!resource || typeof resource !== 'object' || typeof resource.id !== 'string') {
    audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', '$.resource', 'replacement resource descriptor is invalid');
  }
  if (!/^[0-9a-f]{64}$/u.test(resource.integrity.digest)) {
    audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', `resources.${resource.id}.integrity`, 'replacement digest is invalid');
  }
  if (resource.integrity.algorithm !== 'sha256') {
    audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', `resources.${resource.id}.integrity`, 'replacement integrity algorithm is invalid');
  }
  const mediaTypes: Readonly<Record<string, readonly string[]>> = {
    'pcm-f32': ['audio/vnd.haiyue.pcm-f32'],
    wav: ['audio/wav', 'audio/wave', 'audio/x-wav'],
    mp3: ['audio/mpeg'],
    aac: ['audio/aac', 'audio/mp4'],
    opus: ['audio/ogg', 'audio/webm'],
    vorbis: ['audio/ogg', 'audio/webm'],
    flac: ['audio/flac', 'audio/x-flac'],
  };
  if (!mediaTypes[resource.codec]?.includes(resource.mediaType)) {
    audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', `resources.${resource.id}.mediaType`, 'replacement codec/media type pair is invalid');
  }
  if (!Number.isSafeInteger(resource.sampleRate)
    || !Number.isSafeInteger(resource.channels)
    || !Number.isSafeInteger(resource.frameLength)
    || resource.sampleRate <= 0
    || resource.channels <= 0
    || resource.frameLength <= 0) {
    audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', `resources.${resource.id}`, 'replacement metadata is invalid');
  }
  const source = resource.source;
  if (source.kind === 'embedded') {
    if (typeof source.data !== 'string'
      || source.data.length === 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(source.data)) {
      audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', `resources.${resource.id}.source`, 'replacement embedded data is invalid');
    }
  } else if (source.kind === 'referenced') {
    if (typeof source.uri !== 'string' || source.uri.length === 0) {
      audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', `resources.${resource.id}.source`, 'replacement URI is invalid');
    }
  } else if (source.kind === 'hosted') {
    if (typeof source.key !== 'string' || source.key.length === 0) {
      audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', `resources.${resource.id}.source`, 'replacement host key is invalid');
    }
  } else {
    audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', `resources.${resource.id}.source`, 'replacement delivery kind is invalid');
  }
}

function checkedDecodedBytes(
  handle: DecodedAudioHandle,
  descriptor: RuntimeAudioResource,
  options: AudioAssetOwnerOptions,
): number {
  if (handle.sampleRate !== descriptor.sampleRate
    || handle.channels !== descriptor.channels
    || handle.frameLength !== descriptor.frameLength) {
    audioRuntimeFail(
      'E_AUDIO_RUNTIME_DECODE',
      `resources.${descriptor.id}`,
      'decoded audio metadata does not match the contract',
    );
  }
  const frames = handle.frameLength * handle.channels;
  const bytes = frames * 4;
  if (!Number.isSafeInteger(frames)
    || !Number.isSafeInteger(bytes)
    || frames > options.maxDecodedFrames) {
    audioRuntimeFail('E_AUDIO_RUNTIME_LIMIT', `resources.${descriptor.id}`, 'decoded frame budget exceeded');
  }
  return bytes;
}

function decodeBase64(value: string): ArrayBuffer {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

function exactArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value.slice(0);
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }
  const listener = () => controller.abort(signal.reason);
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}
