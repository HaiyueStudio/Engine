import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleRiveExampleConversionRequest } from './rive-example-conversion-service.mjs';

test('Rive example conversion route declines unrelated requests', async () => {
  const response = captureResponse();
  const handled = await handleRiveExampleConversionRequest(request('/', 'GET'), response);
  assert.equal(handled, false);
  assert.equal(response.status, undefined);
});

test('Rive example conversion route accepts POST only', async () => {
  const response = captureResponse();
  const handled = await handleRiveExampleConversionRequest(
    request('/api/rive-hya-compare/convert/official-joystick-databound-keyframe', 'GET'),
    response,
  );
  assert.equal(handled, true);
  assert.equal(response.status, 405);
  assert.equal(response.headers.Allow, 'POST');
  assert.deepEqual(JSON.parse(response.body), { status: 'failed', error: 'Method not allowed.' });
});

test('Rive example conversion route rejects bytes without a formal asset identity', async () => {
  const response = captureResponse();
  const handled = await handleRiveExampleConversionRequest(
    request('/api/rive-hya-compare/convert/not-in-the-formal-manifest', 'POST', Buffer.from([1, 2, 3])),
    response,
  );
  assert.equal(handled, true);
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.body).error, /Unknown formal Rive asset/u);
});

function request(url, method, bytes = Buffer.alloc(0)) {
  const stream = Readable.from(bytes.byteLength > 0 ? [bytes] : []);
  stream.url = url;
  stream.method = method;
  stream.headers = { 'content-length': String(bytes.byteLength) };
  return stream;
}

function captureResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(bytes = '') { this.body += Buffer.from(bytes).toString('utf8'); },
  };
}
