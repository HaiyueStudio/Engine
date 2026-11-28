# Basis encoder test assets

These exact JS/WASM bytes came from `@loaders.gl/textures@4.4.4` (the npm
tarball integrity and original paths are recorded in `manifest.json`). The glTF
corpus uses only the codec assets, not loaders.gl's texture compressor CLI.
`basis-encoder-assets.mjs` verifies both lengths and SHA-256 before returning
the URLs to the existing KTX2 loader. It fails on unavailable or changed bytes.

Keep both the Basis Universal Apache 2.0 license and the loaders.gl MIT license
with these files. Updating them requires an explicit new provenance manifest
and the existing glTF/KTX2 browser verification; never edit generated codec
bytes. These are verification-only assets, excluded from public npm packages.
