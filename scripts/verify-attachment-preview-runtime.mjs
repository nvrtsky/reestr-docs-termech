// Run in the candidate image with --network none and synthetic files only.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import express from '/app/node_modules/express/index.js';
import {preparePreview,convertOffice} from '/app/backend/dist/attachments/attachment-preview.js';
import {AttachmentsService} from '/app/backend/dist/attachments/attachments.service.js';
import {createAttachmentsRouter} from '/app/backend/dist/attachments/attachments.router.js';
import {createRegistryContextMiddleware} from '/app/backend/dist/http/registry-context.js';
import {ApiError} from '/app/backend/dist/http/api-error.js';
const root='/proof';const checks=[];
const tempFiles=async()=> (await readdir('/tmp')).filter(n=>n.startsWith('registry-preview-'));
assert.deepEqual(await tempFiles(),[]);
for(const ext of ['docx','xlsx','pptx','rtf']) {
 const input=await readFile(`${root}/sample.${ext}`),before=createHash('sha256').update(input).digest('hex');
 const result=await preparePreview(`Проверка.${ext}`,input,new AbortController().signal);
 assert.equal(result.mime,'application/pdf');assert.equal(result.data.subarray(0,5).toString(),'%PDF-');
 assert.equal(createHash('sha256').update(input).digest('hex'),before);
 await writeFile(`${root}/${ext}.pdf`,result.data);assert.deepEqual(await tempFiles(),[]);checks.push(`${ext}: valid PDF, source unchanged, temporary files cleaned`);
}
// Rejection, cancellation and concurrency release must not leave office processes/jobs behind.
await assert.rejects(()=>preparePreview('broken.docx',Buffer.from([0,255,0,1]),new AbortController().signal));
assert.deepEqual(await tempFiles(),[]);checks.push('damaged Office file is rejected and temporary files cleaned');
const cancelled=new AbortController();cancelled.abort();
await assert.rejects(()=>convertOffice(awaitableDummy(),'.docx',cancelled.signal));
function awaitableDummy(){return Buffer.from('cancelled');}
assert.deepEqual(await tempFiles(),[]);checks.push('cancelled conversion cleans up');
const office=await readFile(`${root}/sample.docx`);
const first=convertOffice(office,'.docx',new AbortController().signal);
await assert.rejects(()=>convertOffice(office,'.docx',new AbortController().signal),e=>e.status===503);
await first;assert.deepEqual(await tempFiles(),[]);checks.push('concurrent conversion is bounded and next operation recovers');
const pdf=await readFile(`${root}/sample.pdf`);
const originalFetch=globalThis.fetch;
let upstreamCalls=0,fileName='sample.pdf',upstreamStatus=200;
globalThis.fetch=async(url,options)=>{
 if(String(url).startsWith('https://demo.bitrix24.ru/')) {
  upstreamCalls++;assert.equal(options.redirect,'manual');assert.equal(options.headers,undefined);
  return new Response(pdf,{status:upstreamStatus,headers:{'content-type':'application/pdf'}});
 }
 return originalFetch(url,options);
};
const query={from(){return this;},where(){return this;},async limit(){return [{kind:'file',diskFileId:123,fieldDefinitionId:null}];}};
const database={select(){return query;}};
const bitrix={async call(domain,token,method,params){assert.equal(domain,'demo.bitrix24.ru');assert.equal(token,'synthetic-token');assert.equal(method,'disk.file.get');assert.equal(params.id,123);return {TYPE:'file',NAME:fileName,SIZE:pdf.length,DETAIL_URL:'https://demo.bitrix24.ru/docs/file/broken',DOWNLOAD_URL:'https://demo.bitrix24.ru/rest/download?token=synthetic'};}};
const originalVisible=AttachmentsService.prototype.loadVisibleDocument;
AttachmentsService.prototype.loadVisibleDocument=async function(context){if(context.userId===8)throw new ApiError(403,'denied','Нет доступа');return {typeId:'t',typeCode:'client_contract'};};
const app=express();
app.use(createRegistryContextMiddleware({NODE_ENV:'production'},{async resolve(domain,token){if(domain!=='demo.bitrix24.ru')throw new ApiError(403,'domain_denied','Домен запрещён');return {source:'bitrix',portalUrl:'https://'+domain,userId:token==='denied-token'?8:7,roleCode:'sales',bitrix:{domain,accessToken:token}};}}));
app.use('/documents/:id/attachments',createAttachmentsRouter({database,bitrix}));
app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:{message:error.message,code:error.code}}));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}/documents/11111111-1111-4111-8111-111111111111/attachments/22222222-2222-4222-8222-222222222222`;
const headers={authorization:'Bearer synthetic-token','x-bitrix-domain':'demo.bitrix24.ru'};
try {
 const unauth=await originalFetch(base+'/preview');assert.equal(unauth.status,401);assert.equal(upstreamCalls,0);
 const denied=await originalFetch(base+'/preview',{headers:{...headers,authorization:'Bearer denied-token'}});assert.equal(denied.status,403);assert.equal(upstreamCalls,0);
 const access=await originalFetch(base+'/access',{headers});assert.equal(access.status,200);const metadata=await access.json();assert.equal(metadata.name,fileName);assert.equal(metadata.url,metadata.downloadUrl);
 const response=await originalFetch(base+'/preview',{headers});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf');assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf);
 checks.push('actual router: unauthenticated 401, denied 403 before download, allowed PDF bytes and no-store');
 fileName='archive.zip';const unsupported=await originalFetch(base+'/preview',{headers});assert.equal(unsupported.status,415);
 fileName='sample.pdf';upstreamStatus=403;const unavailable=await originalFetch(base+'/preview',{headers});assert.equal(unavailable.status,403);
 checks.push('actual router: unsupported format and upstream refusal produce useful errors');
} finally {globalThis.fetch=originalFetch;AttachmentsService.prototype.loadVisibleDocument=originalVisible;await new Promise(r=>server.close(r));}
const report={status:'pass',checks};await writeFile(root+'/runtime-checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
