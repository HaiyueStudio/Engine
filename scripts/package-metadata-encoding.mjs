/** Release metadata has an explicit encoding independent of checkout line endings.
 * Executables, declarations, assets and licenses are never normalized here.
 */
export function canonicalPackageMetadata(bytes,path,policy={}){
  for(const [file,ending]of Object.entries(policy))if(!['package.json','README.md'].includes(file)||!['lf','crlf'].includes(ending))throw Error('Only named package metadata may declare LF or CRLF');
  if(!Object.hasOwn(policy,path))return bytes;
  const text=bytes.toString('utf8');if(!Buffer.from(text,'utf8').equals(bytes)||text.includes('\0')||/\r(?!\n)/.test(text))throw Error('Package metadata must be valid UTF-8 with ordinary line endings');
  const lf=text.replaceAll('\r\n','\n');return Buffer.from(policy[path]==='crlf'?lf.replaceAll('\n','\r\n'):lf,'utf8');
}
