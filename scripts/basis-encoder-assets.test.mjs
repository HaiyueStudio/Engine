import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import {verifiedBasisEncoderUrls} from './webgpu-gate/basis-encoder-assets.mjs';
const base=new URL('./fixtures/basis-encoder/',import.meta.url),manifest=JSON.parse(readFileSync(new URL('manifest.json',base),'utf8'));
const fetchFile=async url=>{const bytes=readFileSync(url);return{ok:true,json:async()=>JSON.parse(bytes.toString()),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)};};
test('pinned standalone encoder bytes and licenses match provenance without a compressor dependency',async()=>{
 for(const [name,expected]of Object.entries(manifest.files)){const bytes=readFileSync(new URL(name,base));assert.equal(bytes.length,expected.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),expected.sha256);}
 for(const license of manifest.licenses)assert.ok(readFileSync(new URL(license,base)).length>500);
 const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
 for(const name of ['@loaders.gl/textures','texture-compressor','image-size'])assert.equal(lock.packages['node_modules/'+name],undefined);
 const version=lock.packages['node_modules/serialize-javascript'].version.split('.').map(Number);assert.equal(version[0],7);assert.ok(version[1]>1||version[1]===1&&version[2]>=3);
 const urls=await verifiedBasisEncoderUrls(fetchFile,base,webcrypto);assert.equal(urls.basisEncoderWasmUrl,new URL('basis_encoder.wasm',base).href);
});
test('encoder corruption or failed asset requests fail before a loader can consume the URLs',async()=>{
 const corrupt=async url=>{const response=await fetchFile(url);if(String(url).endsWith('.wasm'))response.arrayBuffer=async()=>new Uint8Array([0]).buffer;return response;};
 await assert.rejects(verifiedBasisEncoderUrls(corrupt,base,webcrypto),/integrity mismatch/);
 await assert.rejects(verifiedBasisEncoderUrls(async()=>({ok:false}),base,webcrypto),/manifest fetch failed/);
});
