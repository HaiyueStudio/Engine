import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, relative, isAbsolute, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('../dist/',import.meta.url)));
const port = Number(process.argv[2] ?? 4173);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Use a port from 1 to 65535.');
const types = { '.html':'text/html; charset=utf-8','.css':'text/css','.json':'application/json',
  '.js':'text/javascript','.mjs':'text/javascript','.wav':'audio/wav' };
createServer(async (request,response) => {
  try {
    const path = decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    const file = await realpath(resolve(root, '.' + (path === '/' ? '/index.html' : path)));
    const offset = relative(root,file);
    if (offset === '..' || offset.startsWith('..'+sep) || isAbsolute(offset) || !(await stat(file)).isFile()) throw new Error('outside server root');
    response.writeHead(200, { 'Content-Type':types[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options':'nosniff' });
    createReadStream(file).on('error',()=>response.destroy()).pipe(response);
  } catch { response.writeHead(404).end(); }
}).listen(port,'127.0.0.1',()=>console.log('雾港  http://127.0.0.1:' + port));
