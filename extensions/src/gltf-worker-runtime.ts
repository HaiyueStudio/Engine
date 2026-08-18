/**
 * Self-contained module entry consumed by module workers.
 *
 * Keep these exports backed by the production glTF loader so worker parsing,
 * Draco decoding, and geometry preparation cannot drift from the main thread.
 */
export {
  loadParsedGltfAsset,
  prepareGltfGeometryPayloads,
} from './gltf/gltfLoader';
