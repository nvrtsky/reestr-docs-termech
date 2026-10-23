import {registryYellowRuntimeOverlay} from './registry-yellow-runtime-overlay.mjs';
import fs from 'node:fs';import path from 'node:path';
const baseline=process.env.RUNTIME_BASELINE;
const out=process.env.RUNTIME_OUT;
if(!baseline||!out)throw new Error('RUNTIME_BASELINE and RUNTIME_OUT required');
for(const file of Object.keys(JSON.parse(fs.readFileSync('deploy/yellow-review-20261023/runtime-hashes.json')))){
 const target=path.join(out,file);fs.mkdirSync(path.dirname(target),{recursive:true});
 fs.writeFileSync(target,registryYellowRuntimeOverlay(file,fs.readFileSync(path.join(baseline,file),'utf8')));
}
for(const file of ['native-document-files.js','native-sync-worker.js']){fs.mkdirSync(path.join(out,'integrations'),{recursive:true});fs.copyFileSync('backend/runtime-extensions/'+file,path.join(out,'integrations',file));}
