import { resolve } from 'node:path';
import {
  computeExampleSourceFingerprint,
  writeExampleBuildMetadata,
} from './example-build-fingerprint.mjs';

/** Writes a content-addressed sidecar after Rollup has atomically emitted bundle.js. */
export function exampleBuildMetadata(target) {
  return {
    name: `haiyue-example-build-metadata:${target}`,
    async writeBundle(outputOptions) {
      if (!outputOptions.file) this.error(`Example "${target}" must use output.file.`);
      const fingerprint = process.env.EXAMPLE_SOURCE_FINGERPRINT
        ? {
            hash: process.env.EXAMPLE_SOURCE_FINGERPRINT,
            inputCount: Number(process.env.EXAMPLE_SOURCE_INPUT_COUNT ?? 0),
          }
        : await computeExampleSourceFingerprint();
      await writeExampleBuildMetadata({
        outputFile: resolve(outputOptions.file),
        target,
        sourceFingerprint: fingerprint.hash,
        inputCount: fingerprint.inputCount,
      });
    },
  };
}
