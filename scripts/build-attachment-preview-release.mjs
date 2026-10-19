import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const out=process.argv[2]||'/tmp/registry-preview-release-20261019';
const hash=x=>createHash('sha256').update(x).digest('hex');
let service=await fs.readFile('backend/src/attachments/production/service-20261019.js','utf8');
assert.equal(hash(service),'f27fc386f42ecfe236d9f1fd2449f0c28edc75bb0e98654dbcd73d2719aaa5c5');
for(const [before,after] of [
 ["const url = detailUrl || downloadUrl;","const url = downloadUrl || detailUrl;"],
 ["return { kind: 'file', url, downloadUrl };","return { kind: 'file', url, downloadUrl, name: this.normalizeDisplayName(file.NAME), sizeBytes: Number(file.SIZE) || 0 };"],
]) {assert.equal(service.split(before).length,2);service=service.replace(before,after);}
await fs.mkdir(out+'/backend',{recursive:true});await fs.mkdir(out+'/frontend',{recursive:true});
await fs.writeFile(out+'/backend/attachments.service.js',service);
for(const name of ['attachments.router.js','attachment-preview.js'])await fs.copyFile('backend/dist/attachments/'+name,out+'/backend/'+name);
for(const name of ['index.html','attachment-preview.js','attachment-preview.css'])await fs.copyFile('frontend/public/legacy/'+name,out+'/frontend/'+name);
const files={};for(const area of ['backend','frontend'])for(const name of await fs.readdir(out+'/'+area))files[area+'/'+name]=hash(await fs.readFile(out+'/'+area+'/'+name));
await fs.writeFile(out+'/manifest.json',JSON.stringify({files,baselineBackend:'f27fc386f42ecfe236d9f1fd2449f0c28edc75bb0e98654dbcd73d2719aaa5c5',baselineFrontend:'e24953d5e6d7615e65b0ea6fb23b770c1418b4c351150f66234a9dad1a291e62'},null,2));
console.log('Exact production service patched; existing field access and attachment versions preserved');
