/** The corpus needs only these pinned codec assets, never the compressor CLI dependency tree. */
export async function verifiedBasisEncoderUrls(fetchAsset=fetch,base=new URL('../fixtures/basis-encoder/',import.meta.url),cryptoPort=crypto){
 const response=await fetchAsset(new URL('manifest.json',base));if(!response.ok)throw Error('Basis encoder manifest fetch failed');
 const manifest=await response.json(),urls={};
 for(const [name,key]of [['basis_encoder.js','basisEncoderScriptUrl'],['basis_encoder.wasm','basisEncoderWasmUrl']]){
  const expected=manifest.files[name];if(!expected||!Number.isSafeInteger(expected.bytes)||!/^[a-f0-9]{64}$/u.test(expected.sha256))throw Error('Invalid Basis encoder provenance');
  const url=new URL(name,base),asset=await fetchAsset(url);if(!asset.ok)throw Error('Basis encoder fetch failed: '+name);
  const bytes=await asset.arrayBuffer(),sha256=Array.from(new Uint8Array(await cryptoPort.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  if(bytes.byteLength!==expected.bytes||sha256!==expected.sha256)throw Error('Basis encoder integrity mismatch: '+name);
  urls[key]=url.href;
 }
 return urls;
}
