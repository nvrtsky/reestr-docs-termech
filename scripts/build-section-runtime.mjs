import {registrySectionRuntimeOverlay} from './registry-section-runtime-overlay.mjs';
import fs from 'node:fs';import path from 'node:path';
const baseline=process.env.RUNTIME_BASELINE,out=process.env.RUNTIME_OUT;
if(!baseline||!out||path.resolve(baseline)===path.resolve(out))throw new Error('Separate RUNTIME_BASELINE and RUNTIME_OUT required');
for(const file of Object.keys(JSON.parse(fs.readFileSync('deploy/section-permissions-20261023/runtime-hashes.json')))){
 const target=path.join(out,file);fs.mkdirSync(path.dirname(target),{recursive:true});
 fs.writeFileSync(target,registrySectionRuntimeOverlay(file,fs.readFileSync(path.join(baseline,file),'utf8')));
}
fs.mkdirSync(path.join(out,'integrations'),{recursive:true});fs.copyFileSync('backend/runtime-extensions/section-policy.js',path.join(out,'integrations/section-policy.js'));
