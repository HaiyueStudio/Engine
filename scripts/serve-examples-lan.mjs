import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '..');
const defaultCertificate = resolve(repositoryRoot, '.cert/haiyue-lan.pem');
const defaultPrivateKey = resolve(repositoryRoot, '.cert/haiyue-lan-key.pem');

const defaultMountDefinitions = [
  { prefix: '/examples', directory: resolve(repositoryRoot, 'examples') },
  { prefix: '/engine/dist', directory: resolve(repositoryRoot, 'engine/dist') },
  { prefix: '/extensions/dist', directory: resolve(repositoryRoot, 'extensions/dist') },
  { prefix: '/ui/dist', directory: resolve(repositoryRoot, 'ui/dist') },
  { prefix: '/extensions/test/fixtures/gltf', directory: resolve(repositoryRoot, 'extensions/test/fixtures/gltf') },
  {
    prefix: '/scripts/webgpu-gate/assets/gltf-corpus',
    directory: resolve(repositoryRoot, 'scripts/webgpu-gate/assets/gltf-corpus'),
  },
  {
    prefix: '/animation-spec/corpus/.cache',
    directory: resolve(repositoryRoot, 'animation-spec/corpus/.cache'),
    optional: true,
  },
  {
    prefix: '/animation-spec/corpus/references',
    directory: resolve(repositoryRoot, 'animation-spec/corpus/references'),
  },
  { prefix: '/animation-spec/samples', directory: resolve(repositoryRoot, 'animation-spec/samples') },
  { prefix: '/animation-spec', directory: resolve(repositoryRoot, 'animation-spec/viewer') },
  {
    prefix: '/node_modules/draco3dgltf/draco_decoder_gltf_nodejs.js',
    file: resolve(repositoryRoot, 'node_modules/draco3dgltf/draco_decoder_gltf_nodejs.js'),
  },
  {
    prefix: '/node_modules/draco3dgltf/draco_decoder_gltf.wasm',
    file: resolve(repositoryRoot, 'node_modules/draco3dgltf/draco_decoder_gltf.wasm'),
  },
];

const contentTypes = new Map([
  ['.bin', 'application/octet-stream'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json'],
  ['.hdr', 'application/octet-stream'],
  ['.html', 'text/html; charset=utf-8'],
  ['.hya', 'application/vnd.haiyue.animation'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.ktx2', 'image/ktx2'],
  ['.map', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.ts', 'text/plain; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

export function parseOptions(argumentsList, environment = process.env) {
  const values = {
    host: environment.HAIYUE_EXAMPLES_LAN_HOST ?? '0.0.0.0',
    port: environment.HAIYUE_EXAMPLES_LAN_PORT,
    certificate: environment.HAIYUE_EXAMPLES_LAN_CERT ?? defaultCertificate,
    privateKey: environment.HAIYUE_EXAMPLES_LAN_KEY ?? defaultPrivateKey,
    http: false,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--http') {
      values.http = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') return { help: true };
    const [name, inlineValue] = argument.split('=', 2);
    if (!['--host', '--port', '--cert', '--key'].includes(name)) throw new Error(`Unknown option ${argument}.`);
    const value = inlineValue ?? argumentsList[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--host') values.host = value;
    else if (name === '--port') values.port = value;
    else if (name === '--cert') values.certificate = value;
    else values.privateKey = value;
  }

  return {
    help: false,
    host: values.host,
    port: positivePort(values.port, values.http ? 3000 : 8443),
    protocol: values.http ? 'http' : 'https',
    certificate: resolvePath(values.certificate),
    privateKey: resolvePath(values.privateKey),
  };
}

export async function createExamplesServer({ protocol = 'https', certificate, privateKey, mounts } = {}) {
  const normalizedMounts = await normalizeMounts(mounts ?? defaultMountDefinitions);
  const handler = createStaticHandler(normalizedMounts);
  if (protocol === 'http') return createHttpServer(handler);
  if (protocol !== 'https') throw new Error(`Unsupported protocol ${protocol}.`);

  const [cert, key] = await Promise.all([
    readRequiredCredential(certificate ?? defaultCertificate, 'certificate'),
    readRequiredCredential(privateKey ?? defaultPrivateKey, 'private key'),
  ]);
  return createHttpsServer({ cert, key }, handler);
}

export function createStaticHandler(mounts) {
  return async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendText(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
        return;
      }

      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      if (requestUrl.pathname === '/') {
        response.writeHead(302, { Location: '/examples/', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      if (requestUrl.pathname === '/favicon.ico') {
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }

      const pathname = decodeURIComponent(requestUrl.pathname);
      const mount = mounts.find(candidate => pathname === candidate.prefix || pathname.startsWith(`${candidate.prefix}/`));
      if (!mount) throw new HttpError(404, 'Not found');

      let requested;
      let information;
      if (mount.file) {
        if (pathname !== mount.prefix) throw new HttpError(404, 'Not found');
        requested = mount.file;
        information = await stat(requested);
      } else {
        const relativePath = pathname.slice(mount.prefix.length).replace(/^\/+/, '');
        requested = resolve(mount.directory, relativePath);
        assertInsideRoot(mount.directory, requested);
        information = await stat(requested);
        if (information.isDirectory()) {
          if (!pathname.endsWith('/')) {
            response.writeHead(308, {
              Location: `${requestUrl.pathname}/${requestUrl.search}`,
              'Cache-Control': 'no-store',
            });
            response.end();
            return;
          }
          requested = resolve(requested, 'index.html');
          information = await stat(requested);
        }
        const canonicalPath = await realpath(requested);
        assertInsideRoot(mount.directory, canonicalPath);
        requested = canonicalPath;
      }
      if (!information.isFile()) throw new HttpError(404, 'Not found');

      const range = parseRange(request.headers.range, information.size);
      const headers = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': String(range.length),
        'Content-Type': contentTypes.get(extname(requested).toLowerCase()) ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      };
      if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${information.size}`;
      response.writeHead(range.partial ? 206 : 200, headers);
      if (request.method === 'HEAD' || range.length === 0) response.end();
      else {
        const stream = createReadStream(requested, { start: range.start, end: range.end });
        stream.once('error', error => response.destroy(error));
        stream.pipe(response);
      }
    } catch (error) {
      if (error instanceof URIError) sendText(response, 400, 'Malformed URL');
      else if (error instanceof HttpError) sendText(response, error.status, error.message, error.headers);
      else if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') sendText(response, 404, 'Not found');
      else {
        console.error('[examples:lan] request failed:', error);
        sendText(response, 500, 'Internal server error');
      }
    }
  };
}

export function lanIPv4Addresses(interfaces = networkInterfaces()) {
  const addresses = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || (entry.family !== 'IPv4' && entry.family !== 4)) continue;
      addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)].sort();
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`[examples:lan] ${error instanceof Error ? error.message : String(error)}`);
    printUsage();
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    printUsage();
    return;
  }

  let server;
  try {
    server = await createExamplesServer({
      protocol: options.protocol,
      certificate: options.certificate,
      privateKey: options.privateKey,
    });
  } catch (error) {
    console.error(`[examples:lan] ${error instanceof Error ? error.message : String(error)}`);
    if (options.protocol === 'https') printCertificateHelp(options);
    process.exitCode = 1;
    return;
  }

  server.on('error', error => {
    console.error(`[examples:lan] server failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(options.port, options.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : options.port;
    console.log('[examples:lan] serving allowlisted example/runtime routes only');
    console.log(`[examples:lan] listening on ${options.host}:${port} (${options.protocol.toUpperCase()})`);
    for (const url of accessUrls(options.protocol, options.host, port)) console.log(`[examples:lan] ${url}`);
    if (options.protocol === 'http') {
      console.warn('[examples:lan] warning: LAN HTTP is not a secure context; WebGPU may be unavailable on the client.');
    } else {
      console.log('[examples:lan] the client must trust the CA that signed this certificate.');
    }
  });

  const stop = signal => {
    console.log(`[examples:lan] received ${signal}; stopping.`);
    server.close(error => {
      if (error) {
        console.error(`[examples:lan] shutdown failed: ${error.message}`);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

async function normalizeMounts(definitions) {
  const mounts = [];
  for (const definition of definitions) {
    try {
      if (!definition.prefix?.startsWith('/') || definition.prefix.endsWith('/')) {
        throw new Error(`Invalid static route prefix ${definition.prefix}.`);
      }
      if (Boolean(definition.directory) === Boolean(definition.file)) {
        throw new Error(`Static route ${definition.prefix} must declare exactly one directory or file.`);
      }
      if (definition.directory) mounts.push({ prefix: definition.prefix, directory: await realpath(definition.directory) });
      else mounts.push({ prefix: definition.prefix, file: await realpath(definition.file) });
    } catch (error) {
      if (definition.optional && error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return mounts.sort((left, right) => right.prefix.length - left.prefix.length);
}

function accessUrls(protocol, host, port) {
  const hosts = host === '0.0.0.0' ? lanIPv4Addresses() : [host];
  if (hosts.length === 0) return [`${protocol}://localhost:${port}/examples/`];
  return hosts.map(value => `${protocol}://${formatHost(value)}:${port}/examples/`);
}

function assertInsideRoot(root, candidate) {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new HttpError(403, 'Forbidden');
}

function parseRange(header, size) {
  if (!header) return { start: 0, end: Math.max(0, size - 1), length: size, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size === 0) throw rangeError(size);
  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) throw rangeError(size);
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] === '' ? size - 1 : Number.parseInt(match[2], 10);
    if (start >= size || end < start) throw rangeError(size);
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1, partial: true };
}

function rangeError(size) {
  return new HttpError(416, 'Range not satisfiable', { 'Content-Range': `bytes */${size}` });
}

function sendText(response, status, body, extraHeaders = {}) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(body);
}

async function readRequiredCredential(path, label) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`HTTPS ${label} was not found at ${path}.`);
    throw error;
  }
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(repositoryRoot, path);
}

function positivePort(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < 1 || value > 65_535 || String(value) !== String(raw)) {
    throw new Error(`Port must be an integer between 1 and 65535; received ${raw}.`);
  }
  return value;
}

function formatHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function printCertificateHelp(options) {
  const names = ['localhost', '127.0.0.1', '::1', ...lanIPv4Addresses()].join(' ');
  console.error('[examples:lan] create a locally trusted certificate with mkcert:');
  console.error('  mkdir -p .cert');
  console.error('  mkcert -install');
  console.error(`  mkcert -cert-file ${relativeCredential(options.certificate)} -key-file ${relativeCredential(options.privateKey)} ${names}`);
  console.error('[examples:lan] trust mkcert rootCA.pem on the Windows client; never copy rootCA-key.pem.');
  console.error('[examples:lan] for static HTTP-only diagnosis, append --http --port 3000.');
}

function relativeCredential(path) {
  return path.startsWith(`${repositoryRoot}${sep}`) ? path.slice(repositoryRoot.length + 1) : path;
}

function printUsage() {
  console.log(`Usage: npm run serve:examples:lan -- [options]

Options:
  --host <address>  Listen address (default: 0.0.0.0)
  --port <number>   Listen port (default: 8443, or 3000 with --http)
  --cert <path>     HTTPS certificate (default: .cert/haiyue-lan.pem)
  --key <path>      HTTPS private key (default: .cert/haiyue-lan-key.pem)
  --http            Explicit insecure HTTP diagnostic mode
  --help            Show this help

Environment equivalents:
  HAIYUE_EXAMPLES_LAN_HOST, HAIYUE_EXAMPLES_LAN_PORT,
  HAIYUE_EXAMPLES_LAN_CERT, HAIYUE_EXAMPLES_LAN_KEY`);
}

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) await main();
