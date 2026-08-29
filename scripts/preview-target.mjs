import { createReadStream, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { handleRiveExampleConversionRequest } from './rive-example-conversion-service.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = process.argv[2];
const [kind, id] = target?.split(':') ?? [];
const directory = kind === 'example' ? 'examples' : kind === 'game' ? 'games' : null;
if (!directory || !id) {
  console.error('Usage: npm run preview:target -- example:<id> | game:<id>');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(resolve(root, directory, 'manifest.json'), 'utf8'));
if (!manifest.entries.some(entry => entry.id === id)) {
  console.error(`Unknown manifest target ${target}.`);
  process.exit(1);
}
const home = `/${directory}/${id}/`;
const port = Number(process.env.PORT ?? 8080);
const server = createServer(async (request, response) => {
  if (id === 'rive-hya-compare' && await handleRiveExampleConversionRequest(request, response)) return;
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    response.writeHead(302, { location: home });
    response.end();
    return;
  }
  const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  let absolute = resolve(root, relativePath);
  if (url.pathname.endsWith('/')) absolute = resolve(absolute, 'index.html');
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  const stream = createReadStream(absolute);
  stream.once('error', () => {
    if (!response.headersSent) response.writeHead(404);
    response.end('Not found');
  });
  stream.once('open', () => {
    response.writeHead(200, { 'content-type': mime(extname(absolute)), 'cache-control': 'no-store' });
    stream.pipe(response);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`[preview] ${target} -> http://127.0.0.1:${port}${home}`));

function mime(extension) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.wasm': 'application/wasm' })[extension] ?? 'application/octet-stream';
}
