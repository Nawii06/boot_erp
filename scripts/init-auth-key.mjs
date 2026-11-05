import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { localRoot } from './local-paths.mjs';
try {
  const folder=join(localRoot(),'auth');await mkdir(folder,{recursive:true});
  const file=join(folder,'encryption.key');
  try{await writeFile(file,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}
  catch(e){if(e.code!=='EEXIST')throw e;}
  if(!/^[0-9a-f]{64}$/.test(await readFile(file,'utf8')))throw new Error();
  console.log('Private authentication encryption key ready. Existing key preserved.');
}catch{console.error('Private authentication key unavailable. No values logged.');process.exitCode=1;}
