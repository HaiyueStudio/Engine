import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyProductionAdapterEnvironment } from './rive-production-adapter-bridge.mjs';
import { createProductionHostConfiguration } from './rive-create-production-host-config.mjs';

const scriptsRoot = dirname(fileURLToPath(import.meta.url));

test('host configuration pins gateway/provider bytes and preflights all three executable providers', async t => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'rive-production-config-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const capabilityProviderPath = resolve(temporary, 'capability.mjs');
  const officialProviderPath = resolve(temporary, 'official.mjs');
  const hyaProviderPath = resolve(temporary, 'hya.mjs');
  writeFileSync(capabilityProviderPath, 'export async function evaluate() { return {}; }\n');
  writeFileSync(officialProviderPath, 'export async function capture() { return {}; }\n');
  writeFileSync(hyaProviderPath, 'export async function capture() { return {}; }\n');
  const configuration = createProductionHostConfiguration({
    gatewayPath: resolve(scriptsRoot, 'rive-production-host.mjs'),
    capabilityProviderPath, officialProviderPath, hyaProviderPath,
  });
  const configPath = resolve(temporary, 'host-config.json');
  writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`);
  const environment = {
    RIVE_PRODUCTION_HOST_CONFIG_PATH: configPath,
    RIVE_OFFICIAL_CAPTURE_DESCRIPTOR_JSON: JSON.stringify({ poisoned: true }),
  };
  const identities = await Promise.all(['capability', 'official', 'hya'].map(kind => verifyProductionAdapterEnvironment(kind, environment)));
  assert.deepEqual(identities.map(value => value.kind), ['capability', 'official', 'hya']);
  assert.equal(identities[0].identity.evaluatorRevisionSha256, configuration.providers.capability.sha256);
  assert.equal(identities[1].identity.revisionSha256, configuration.providers.official.sha256);
  assert.equal(identities[2].identity.revisionSha256, configuration.providers.hya.sha256);

  writeFileSync(officialProviderPath, 'export async function capture() { return { changed: true }; }\n');
  await assert.rejects(verifyProductionAdapterEnvironment('official', environment), /exited with 1.*provider bytes/us);
});
