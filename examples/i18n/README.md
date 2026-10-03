# Internationalization · Text & Artwork

GPU GUI menu with English, Simplified Chinese and Traditional Chinese JSON packs, localized SVG title artwork,
parameterized score, plural coin count and language buttons. No external assets or services.

```sh
npm run build -w ./extensions
npm run build:target -- example:i18n
```

Serve the Engine repository over localhost and open `examples/i18n/index.html`.
Use `?verify=1` to run language/image switching, plural, latest-wins and pack completeness checks.
The hidden `#result` contains JSON (`passed: true`); `#error` reports initialization/render/asset failure.
UI controls are Engine GPU GUI; DOM is only canvas, error diagnostics and verification output.

The three SVG images are self-authored demonstration artwork. JSON schemaVersion 1 is runtime-independent.
Scene lifetime aborts bindings before Engine teardown. The I18n instance disposes remaining loaders and subscriptions.

[Guide](../../docs/engine-guide/i18n.md) · [API](../../docs/api/i18n.md)
