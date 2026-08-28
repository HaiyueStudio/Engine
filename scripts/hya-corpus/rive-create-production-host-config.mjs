import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function createProductionHostConfiguration({
  gatewayPath,
  capabilityProviderPath,
  officialProviderPath,
  hyaProviderPath,
  command = process.execPath,
  capabilityEvaluatorId = providerId(capabilityProviderPath),
  officialCaptureId = providerId(officialProviderPath),
  hyaCaptureId = providerId(hyaProviderPath),
  optionsRevision = 'rive-7.3-production-v1',
}) {
  const gateway = fileIdentity(gatewayPath);
  const capability = fileIdentity(capabilityProviderPath);
  const official = fileIdentity(officialProviderPath);
  const hya = fileIdentity(hyaProviderPath);
  const capabilityDescriptor = {
    adapterId: 'haiyue-rive-production-host', adapterRevisionSha256: gateway.sha256,
    evaluatorId: required(capabilityEvaluatorId, 'capability evaluator id'), evaluatorRevisionSha256: capability.sha256,
    optionsRevision: required(optionsRevision, 'options revision'),
  };
  const officialDescriptor = {
    id: required(officialCaptureId, 'official capture id'), revisionSha256: official.sha256,
    runtime: '@rive-app/webgl2@2.40.0', backend: 'webgl2', nativeBackend: true,
  };
  const hyaDescriptor = {
    id: required(hyaCaptureId, 'HYA capture id'), revisionSha256: hya.sha256,
    runtime: 'haiyue-exact-hya', backend: 'webgpu', nativeBackend: true,
  };
  return Object.freeze({
    schemaVersion: 1,
    kind: 'haiyue-rive-production-host-configuration',
    gateway,
    providers: Object.freeze({ capability, official, hya }),
    environment: Object.freeze({
      RIVE_CAPABILITY_EVALUATOR_COMMAND: command,
      RIVE_CAPABILITY_EVALUATOR_ARGS_JSON: JSON.stringify([gateway.path, '--kind=capability', `--provider=${capability.path}`]),
      RIVE_CAPABILITY_EVALUATOR_DESCRIPTOR_JSON: JSON.stringify(capabilityDescriptor),
      RIVE_OFFICIAL_CAPTURE_COMMAND: command,
      RIVE_OFFICIAL_CAPTURE_ARGS_JSON: JSON.stringify([gateway.path, '--kind=official', `--provider=${official.path}`]),
      RIVE_OFFICIAL_CAPTURE_DESCRIPTOR_JSON: JSON.stringify(officialDescriptor),
      RIVE_HYA_CAPTURE_COMMAND: command,
      RIVE_HYA_CAPTURE_ARGS_JSON: JSON.stringify([gateway.path, '--kind=hya', `--provider=${hya.path}`]),
      RIVE_HYA_CAPTURE_DESCRIPTOR_JSON: JSON.stringify(hyaDescriptor),
    }),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputPath = insideRoot(required(argument('--out'), '--out'));
  const configuration = createProductionHostConfiguration({
    gatewayPath: resolve(dirname(fileURLToPath(import.meta.url)), 'rive-production-host.mjs'),
    capabilityProviderPath: resolve(required(argument('--capability-provider'), '--capability-provider')),
    officialProviderPath: resolve(required(argument('--official-provider'), '--official-provider')),
    hyaProviderPath: resolve(required(argument('--hya-provider'), '--hya-provider')),
    capabilityEvaluatorId: argument('--capability-id') ?? undefined,
    officialCaptureId: argument('--official-id') ?? undefined,
    hyaCaptureId: argument('--hya-id') ?? undefined,
    optionsRevision: argument('--options-revision') ?? 'rive-7.3-production-v1',
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(configuration, null, 2)}\n`);
  console.log(`[rive-production-host] configuration written to ${relative(root, outputPath)}; set RIVE_PRODUCTION_HOST_CONFIG_PATH to this file.`);
}

function fileIdentity(path) {
  const absolute = resolve(required(path, 'provider path'));
  const bytes = readFileSync(absolute);
  return Object.freeze({ path: absolute, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength });
}
function providerId(path) { const name = basename(String(path ?? ''), extname(String(path ?? ''))); return name || undefined; }
function argument(name) { return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1); }
function required(value, label) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} is required.`); return value; }
function insideRoot(value) {
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) throw new TypeError('--out must be a relative POSIX path inside Engine.');
  const path = resolve(root, value); const candidate = relative(root, path);
  if (candidate === '..' || candidate.startsWith('../') || candidate.startsWith('..\\')) throw new TypeError('--out escapes Engine root.');
  return path;
}
