import { parseTextureCoordinateSemantic } from './GltfUvSemanticPlanner';
import type { GltfAsset, GltfDracoMeshCompression } from './GltfSchema';
import type {
  DracoDecoder,
  DracoDecoderConfig,
  DracoDecoderFactory,
  DracoDecoderModule,
  DracoMesh,
  DracoPrimitiveGeometry,
  LoadGltfOptions,
} from './GltfLoaderContract';
import { gltfDataError, throwIfGltfLoadAborted } from './GltfLoaderErrors';

const DEFAULT_DRACO_DECODER_SCRIPT_URL = 'draco_decoder_gltf_nodejs.js';
const FALLBACK_DRACO_DECODER_SCRIPT_URL = '../node_modules/draco3dgltf/draco_decoder_gltf_nodejs.js';

let sharedDecoderPromise: Promise<DracoDecoderModule> | null = null;
const sharedScriptPromises = new Map<string, Promise<DracoDecoderFactory>>();

/** Resolves and decodes one KHR_draco_mesh_compression primitive. */
export async function decodeDracoPrimitive(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  extension: GltfDracoMeshCompression,
  options: LoadGltfOptions,
): Promise<DracoPrimitiveGeometry> {
  throwIfGltfLoadAborted(options.signal);
  const view = gltf.bufferViews?.[extension.bufferView];
  if (!view) throw gltfDataError(`Missing Draco bufferView ${extension.bufferView}.`);
  const source = buffers[view.buffer];
  if (!source) throw gltfDataError(`Missing Draco buffer ${view.buffer}.`);

  const module = await resolveDracoDecoder(options);
  throwIfGltfLoadAborted(options.signal);
  const decoder = new module.Decoder();
  const decoderBuffer = new module.DecoderBuffer();
  const mesh = new module.Mesh();
  const bytes = new Uint8Array(source, view.byteOffset ?? 0, view.byteLength);
  decoderBuffer.Init(bytes, bytes.byteLength);

  try {
    const status = decoder.DecodeBufferToMesh(decoderBuffer, mesh);
    throwIfGltfLoadAborted(options.signal);
    if (!status.ok()) throw gltfDataError(`Draco decode failed: ${status.error_msg()}`);
    const positions = readFloatAttribute(module, decoder, mesh, extension, 'POSITION', 3);
    if (!positions) throw gltfDataError('Draco primitive is missing POSITION attribute.');
    const normals = readFloatAttribute(module, decoder, mesh, extension, 'NORMAL', 3);
    const textureCoordinates = Object.keys(extension.attributes)
      .map(semantic => ({ semantic, set: parseTextureCoordinateSemantic(semantic) }))
      .filter((entry): entry is { semantic: string; set: number } => entry.set !== null)
      .sort((a, b) => a.set - b.set)
      .map(entry => {
        const data = readFloatAttribute(module, decoder, mesh, extension, entry.semantic, 2);
        if (!data) throw gltfDataError(`Draco primitive is missing ${entry.semantic}.`);
        return { set: entry.set, data };
      });
    const joints = readUnsignedAttribute(module, decoder, mesh, extension, 'JOINTS_0', 4);
    const weights = readFloatAttribute(module, decoder, mesh, extension, 'WEIGHTS_0', 4);
    const indices = readIndices(module, decoder, mesh);
    throwIfGltfLoadAborted(options.signal);
    return {
      positions,
      ...(normals === null ? {} : { normals }),
      textureCoordinates,
      ...(joints === null ? {} : { joints }),
      ...(weights === null ? {} : { weights }),
      indices,
    };
  } finally {
    module.destroy(mesh);
    module.destroy(decoderBuffer);
    module.destroy(decoder);
  }
}

async function resolveDracoDecoder(options: LoadGltfOptions): Promise<DracoDecoderModule> {
  throwIfGltfLoadAborted(options.signal);
  const provided = options.dracoDecoder;
  if (provided) {
    const module = typeof provided === 'function'
      ? await provided(options.dracoDecoderConfig)
      : await provided;
    throwIfGltfLoadAborted(options.signal);
    return module;
  }
  if (!sharedDecoderPromise) sharedDecoderPromise = loadDefaultDecoder(options.dracoDecoderConfig);
  const module = await sharedDecoderPromise;
  throwIfGltfLoadAborted(options.signal);
  return module;
}

async function loadDefaultDecoder(config: DracoDecoderConfig | undefined): Promise<DracoDecoderModule> {
  let factory: DracoDecoderFactory;
  if (config?.scriptUrl) {
    factory = await loadDecoderFactory(config.scriptUrl);
  } else {
    try {
      factory = await loadDecoderFactory(DEFAULT_DRACO_DECODER_SCRIPT_URL);
    } catch {
      factory = await loadDecoderFactory(FALLBACK_DRACO_DECODER_SCRIPT_URL);
    }
  }
  return factory(config);
}

function loadDecoderFactory(scriptUrl: string): Promise<DracoDecoderFactory> {
  const existing = getGlobalDecoderFactory();
  if (existing) return Promise.resolve(existing);
  const existingPromise = sharedScriptPromises.get(scriptUrl);
  if (existingPromise) return existingPromise;
  const promise = new Promise<DracoDecoderFactory>((resolve, reject) => {
    if (typeof document === 'undefined') {
      const workerScope = globalThis as typeof globalThis & { postMessage?: unknown; location?: unknown };
      if (typeof workerScope.postMessage !== 'function' || workerScope.location === undefined) {
        reject(gltfDataError('Draco decoder is not available. Provide LoadGltfOptions.dracoDecoder in non-browser environments.'));
        return;
      }
      void loadWorkerDecoderFactory(scriptUrl).then(resolve, reject);
      return;
    }
    const script = document.createElement('script');
    script.async = true;
    script.src = scriptUrl;
    script.onload = () => {
      const factory = getGlobalDecoderFactory();
      if (factory) resolve(factory);
      else reject(gltfDataError(`Draco decoder script loaded without DracoDecoderModule: ${scriptUrl}`, { url: scriptUrl }));
    };
    script.onerror = () => reject(gltfDataError(`Failed to load Draco decoder script: ${scriptUrl}`, { url: scriptUrl }));
    document.head.appendChild(script);
  });
  sharedScriptPromises.set(scriptUrl, promise);
  promise.catch(() => sharedScriptPromises.delete(scriptUrl));
  return promise;
}

async function loadWorkerDecoderFactory(scriptUrl: string): Promise<DracoDecoderFactory> {
  const response = await fetch(scriptUrl);
  if (!response.ok) {
    throw gltfDataError(
      `Failed to load Draco decoder script: ${scriptUrl}`,
      { url: scriptUrl, status: response.status },
    );
  }
  const source = await response.text();
  const factory = new Function(
    `${source}\nreturn typeof DracoDecoderModule === "function" ? DracoDecoderModule : null;\n//# sourceURL=${scriptUrl}`,
  )() as unknown;
  if (typeof factory !== 'function') {
    throw gltfDataError(`Draco decoder script loaded without DracoDecoderModule: ${scriptUrl}`, { url: scriptUrl });
  }
  return factory as DracoDecoderFactory;
}

function getGlobalDecoderFactory(): DracoDecoderFactory | null {
  const globalScope = globalThis as typeof globalThis & { DracoDecoderModule?: DracoDecoderFactory };
  return typeof globalScope.DracoDecoderModule === 'function' ? globalScope.DracoDecoderModule : null;
}

function readUnsignedAttribute(
  module: DracoDecoderModule,
  decoder: DracoDecoder,
  mesh: DracoMesh,
  extension: GltfDracoMeshCompression,
  semantic: string,
  expectedSize: number,
): Uint16Array | Uint32Array | null {
  const uniqueId = extension.attributes[semantic];
  if (uniqueId === undefined) return null;
  const attribute = decoder.GetAttributeByUniqueId(mesh, uniqueId);
  if (!attribute) throw gltfDataError(`Draco primitive is missing attribute ${semantic} with unique id ${uniqueId}.`);
  const pointCount = mesh.num_points();
  const decode = <T extends Uint16Array | Uint32Array>(
    ArrayType: { new(length: number): T },
    ValuesType: (new () => import('./GltfLoaderContract').DracoDecoderArray) | undefined,
    read: ((mesh: DracoMesh, attribute: import('./GltfLoaderContract').DracoPointAttribute, out: import('./GltfLoaderContract').DracoDecoderArray) => boolean) | undefined,
  ): T | null => {
    if (!ValuesType || !read) return null;
    const values = new ValuesType();
    try {
      if (!read.call(decoder, mesh, attribute, values)) throw gltfDataError(`Failed to decode Draco attribute ${semantic}.`);
      if (values.size() < pointCount * expectedSize) {
        throw gltfDataError(`Draco attribute ${semantic} returned ${values.size()} values, expected at least ${pointCount * expectedSize}.`);
      }
      const out = new ArrayType(pointCount * expectedSize);
      for (let i = 0; i < out.length; i++) out[i] = values.GetValue(i);
      return out;
    } finally {
      module.destroy(values);
    }
  };
  const u16 = decode(Uint16Array, module.DracoUInt16Array, decoder.GetAttributeUInt16ForAllPoints);
  if (u16) return u16;
  const u32 = decode(Uint32Array, module.DracoUInt32Array, decoder.GetAttributeUInt32ForAllPoints);
  if (u32) return u32;
  const values = readFloatAttribute(module, decoder, mesh, extension, semantic, expectedSize);
  if (!values) return null;
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.max(0, Math.round(requiredFiniteValue(values, i, `Draco ${semantic}`)));
  return out;
}

function readFloatAttribute(
  module: DracoDecoderModule,
  decoder: DracoDecoder,
  mesh: DracoMesh,
  extension: GltfDracoMeshCompression,
  semantic: string,
  expectedSize: number,
): Float32Array | null {
  const uniqueId = extension.attributes[semantic];
  if (uniqueId === undefined) return null;
  const attribute = decoder.GetAttributeByUniqueId(mesh, uniqueId);
  if (!attribute) throw gltfDataError(`Draco primitive is missing attribute ${semantic} with unique id ${uniqueId}.`);
  const values = new module.DracoFloat32Array();
  try {
    if (!decoder.GetAttributeFloatForAllPoints(mesh, attribute, values)) throw gltfDataError(`Failed to decode Draco attribute ${semantic}.`);
    const pointCount = mesh.num_points();
    if (values.size() < pointCount * expectedSize) {
      throw gltfDataError(`Draco attribute ${semantic} returned ${values.size()} values, expected at least ${pointCount * expectedSize}.`);
    }
    const out = new Float32Array(pointCount * expectedSize);
    for (let i = 0; i < out.length; i++) out[i] = values.GetValue(i);
    return out;
  } finally {
    module.destroy(values);
  }
}

function readIndices(module: DracoDecoderModule, decoder: DracoDecoder, mesh: DracoMesh): Uint16Array | Uint32Array {
  const faceCount = mesh.num_faces();
  const indices = mesh.num_points() > 65535 ? new Uint32Array(faceCount * 3) : new Uint16Array(faceCount * 3);
  const face = new module.DracoInt32Array();
  try {
    for (let faceIndex = 0; faceIndex < faceCount; faceIndex++) {
      if (!decoder.GetFaceFromMesh(mesh, faceIndex, face)) throw gltfDataError(`Failed to decode Draco face ${faceIndex}.`);
      indices[faceIndex * 3] = face.GetValue(0);
      indices[faceIndex * 3 + 1] = face.GetValue(1);
      indices[faceIndex * 3 + 2] = face.GetValue(2);
    }
    return indices;
  } finally {
    module.destroy(face);
  }
}

function requiredFiniteValue(values: ArrayLike<number>, index: number, label: string): number {
  const value = values[index];
  if (value === undefined || !Number.isFinite(value)) throw gltfDataError(`${label} is missing a finite value at index ${index}.`);
  return value;
}
