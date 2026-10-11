# ADR 0117: CMYK color value through the existing color protocol

- Status: Accepted
- Date: 2026-10-08
- Release: unreleased, next minor (additive stable API; not a 0.2.1 patch publication)

## Context

Image tooling needs a CMYK authoring object that can be consumed by existing GPU materials without making renderers depend on image editors or changing shader inputs.

## Decision

Export one stable `ColorCMYK` class from `@haiyue/engine/color`. Extend `BuiltinColorSpace` and the built-in `ColorObject` union. Preserve the exact root export set and all material signatures. The object implements the existing `ColorValue` protocol via `Color`, retaining cached encoded-sRGB and linear-RGBA writers, alpha, cloning and change versions. Channels C/M/Y/K and alpha are finite normalized values in [0,1]; invalid updates fail atomically. No-op updates preserve versions.

Conversion uses the uncalibrated [CSS Color 5 CMYK conversion](https://www.w3.org/TR/css-color-5/#cmyk-rgb): R=(1-C)(1-K), G=(1-M)(1-K), B=(1-Y)(1-K), followed by the existing sRGB transfer function for linear GPU consumers. Reverse conversion maximizes K; the inverse is not unique. HDR and negative RGB inputs are rejected.

This is a color value, not an ICC engine, print proofing feature, CMYK texture format or CMYK PSD codec. Materials own clones exactly as for other color objects. No per-frame allocation or upload policy is introduced.

## API and validation

The reviewed `./color` count grows from 16 to 17 for this single capability. Root, other entrypoint counts and growth reserves remain unchanged. Baseline promotion and packed-package verification accompany the implementation. Focused tests cover canonical and mixed inks, alpha, linear conversion, round trips, invalid input atomicity, cloning, versioning, and BasicMaterial/Material2D/PbrMaterial consumption.

```ts
import { ColorCMYK } from '@haiyue/engine/color';
const ink = new ColorCMYK(0.8, 0.15, 0, 0.1);
// Pass ink as the color value of an existing material. GPU writers convert automatically.
const rgba = new Float32Array(4);
ink.writeLinear(rgba);
```
