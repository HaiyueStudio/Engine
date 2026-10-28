import test from 'node:test';import assert from 'node:assert/strict';import {canonicalPackageMetadata} from './package-metadata-encoding.mjs';
test('LF and CRLF checkouts produce identical explicitly frozen metadata bytes',()=>{
  const lf=Buffer.from('{\n  "name": "海月😀"\n}\n'),crlf=Buffer.from(lf.toString().replaceAll('\n','\r\n'));
  assert.deepEqual(canonicalPackageMetadata(lf,'package.json',{'package.json':'crlf'}),crlf);assert.deepEqual(canonicalPackageMetadata(crlf,'package.json',{'package.json':'crlf'}),crlf);assert.deepEqual(canonicalPackageMetadata(crlf,'README.md',{'README.md':'lf'}),lf);assert.deepEqual(lf,Buffer.from('{\n  "name": "海月😀"\n}\n'));
});
test('no executable, declaration, license or binary content can enter metadata normalization',()=>{
  const data=Buffer.from([0,255,13,10]);for(const file of ['dist/index.js','dist/index.d.ts','LICENSE','asset.png']){assert.equal(canonicalPackageMetadata(data,file),data);assert.throws(()=>canonicalPackageMetadata(data,file,{[file]:'crlf'}),/Only named/);}
});
test('invalid encodings and malformed metadata fail rather than changing hidden bytes',()=>{
  for(const data of [Buffer.from([255]),Buffer.from('bad\0text'),Buffer.from('bare\rreturn')])assert.throws(()=>canonicalPackageMetadata(data,'package.json',{'package.json':'crlf'}),/valid UTF-8/);assert.throws(()=>canonicalPackageMetadata(Buffer.from('ok'),'package.json',{'package.json':'unknown'}),/Only named/);
});
