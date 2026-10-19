import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PgDialect} from 'drizzle-orm/pg-core';
import {AttachmentsService} from './attachments.service.js';
import {ApiError} from '../http/api-error.js';
import {previewKind,assertFileUrl,readDiskFile,preparePreview,PREVIEW_LIMIT,convertOffice} from './attachment-preview.js';
const signal=()=>new AbortController().signal;
const pdf=Buffer.from('%PDF-1.7\nsynthetic');
test('common document families and unsafe/unknown extensions',()=>{
 for(const name of ['a.doc','a.DOCX','a.xlsx','a.pptx','a.odt','a.ods','a.odp','a.rtf'])assert.equal(previewKind(name),'office');
 assert.equal(previewKind('a.PDF'),'pdf');assert.equal(previewKind('a.JPEG'),'image');assert.equal(previewKind('a.csv'),'text');
 for(const name of ['a.svg','a.html','a.zip','a.exe','a.docm'])assert.equal(previewKind(name),null);
});
test('download starts only on the verified portal and validates every redirect',()=>{
 assert.equal(assertFileUrl('https://demo.bitrix24.ru/rest/download?token=secret','demo.bitrix24.ru').hostname,'demo.bitrix24.ru');
 for(const url of ['http://demo.bitrix24.ru/a','https://evil.test/a','https://user:pass@demo.bitrix24.ru/a','https://demo.bitrix24.ru:444/a','https://127.0.0.1/a','file:///etc/passwd'])assert.throws(()=>assertFileUrl(url,'demo.bitrix24.ru'));
 assert.throws(()=>assertFileUrl('https://bitrix24.ru.evil.test/a','demo.bitrix24.ru',true));
 assert.doesNotThrow(()=>assertFileUrl('https://cdn.bitrix24.net/a','demo.bitrix24.ru',true));
});
test('redirect to untrusted host is rejected without fetching that host',async()=>{
 let calls=0;
 await assert.rejects(()=>readDiskFile('https://demo.bitrix24.ru/file','demo.bitrix24.ru',signal(),async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://127.0.0.1/secret'}});}),/безопасную/);
 assert.equal(calls,1);
});
test('PDF bytes are returned, all downloads use manual redirects',async()=>{
 const data=await readDiskFile('https://demo.bitrix24.ru/file','demo.bitrix24.ru',signal(),async(_url,options)=>{assert.equal(options?.redirect,'manual');return new Response(pdf);});
 assert.deepEqual(data,pdf);
});
test('declared and streaming file sizes are bounded',async()=>{
 await assert.rejects(()=>readDiskFile('https://demo.bitrix24.ru/a','demo.bitrix24.ru',signal(),async()=>new Response('data',{headers:{'content-length':String(PREVIEW_LIMIT+1)}})),/25 МБ/);
 const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(PREVIEW_LIMIT+1));c.close();}});
 await assert.rejects(()=>readDiskFile('https://demo.bitrix24.ru/a','demo.bitrix24.ru',signal(),async()=>new Response(body)),/25 МБ/);
});
test('forbidden and failed downloads are not treated as documents',async()=>{
 await assert.rejects(()=>readDiskFile('https://demo.bitrix24.ru/a','demo.bitrix24.ru',signal(),async()=>new Response('denied',{status:403})),e=>e instanceof ApiError&&e.status===403);
 await assert.rejects(()=>preparePreview('login.pdf',Buffer.from('<html>login</html>'),signal()),/недоступен/);
});
test('PDF and images require content signatures, SVG is not active content',async()=>{
 assert.equal((await preparePreview('file.pdf',pdf,signal())).mime,'application/pdf');
 const png=Buffer.from([137,80,78,71,13,10,26,10,0]);
 assert.equal((await preparePreview('file.png',png,signal())).mime,'image/png');
 await assert.rejects(()=>preparePreview('file.jpg',Buffer.from('<svg onload=evil()>'),signal()));
 await assert.rejects(()=>preparePreview('file.svg',Buffer.from('<svg/>'),signal()));
});
test('text is served as text, supports UTF16 and bounds large files',async()=>{
 const html='<script>alert(1)</script>';const r=await preparePreview('text.txt',Buffer.from(html),signal());
 assert.equal(r.mime,'text/plain; charset=utf-8');assert.equal(r.data.toString(),html);
 const utf16=Buffer.concat([Buffer.from([255,254]),Buffer.from('Текст','utf16le')]);
 assert.equal((await preparePreview('text.txt',utf16,signal())).data.toString(),'Текст');
 await assert.rejects(()=>preparePreview('huge.txt',Buffer.alloc(2*1024*1024+1),signal()),/2 МБ/);
});
test('Office conversion receives only a supported extension and returns PDF',async()=>{
 const result=await preparePreview('../../Договор.DOCX',Buffer.from('PK\x03\x04source'),signal(),async(data,ext)=>{assert.equal(ext,'.docx');assert.equal(data.toString(),'PK\x03\x04source');return pdf;});
 assert.equal(result.mime,'application/pdf');assert.deepEqual(result.data,pdf);
 await assert.rejects(()=>convertOffice(Buffer.from('a'),'../../../file',signal()));
});
const context={portalUrl:'https://demo.bitrix24.ru',userId:7,roleCode:'sales',source:'bitrix' as const,bitrix:{domain:'demo.bitrix24.ru',accessToken:'secret-token'}};
test('document permission failure stops before file metadata or download',async()=>{
 let called=false;const service=new AttachmentsService({select(){called=true;throw Error('must not query');}} as never,{} as never);
 (service as any).loadVisibleDocument=async()=>{throw new ApiError(403,'denied','Нет доступа');};
 await assert.rejects(()=>service.getAccess(context,'document','attachment'),e=>e instanceof ApiError&&e.status===403);assert.equal(called,false);
});
test('file access uses tenant/document/attachment scope and the current user token',async()=>{
 let scope:any;
 const query={from(){return this;},where(condition:any){scope=new PgDialect().sqlToQuery(condition);return this;},async limit(){return [{kind:'file',diskFileId:123}];}};
 const service=new AttachmentsService({select(){return query;}} as never,{async call(domain:string,token:string,method:string,params:any){assert.equal(domain,context.bitrix.domain);assert.equal(token,context.bitrix.accessToken);assert.equal(method,'disk.file.get');assert.equal(params.id,123);return {TYPE:'file',NAME:'Счёт.pdf',SIZE:'42',DOWNLOAD_URL:'https://demo.bitrix24.ru/rest/download?token=secret',DETAIL_URL:'https://demo.bitrix24.ru/docs/file/broken'};}} as never);
 (service as any).loadVisibleDocument=async()=>({});
 const result=await service.getAccess(context,'document-id','attachment-id');
 assert.ok(scope.params.includes(context.portalUrl));assert.ok(scope.params.includes('document-id'));assert.ok(scope.params.includes('attachment-id'));assert.match(scope.sql,/deleted_at.*is null/);
 assert.equal(result.kind,'file');if(result.kind==='file'){assert.equal(result.name,'Счёт.pdf');assert.equal(result.sizeBytes,42);assert.equal(result.url,result.downloadUrl);}
});
test('deleted Bitrix files and unavailable attachments do not produce access URLs',async()=>{
 const query={from(){return this;},where(){return this;},async limit(){return [{kind:'file',diskFileId:123}];}};
 const service=new AttachmentsService({select(){return query;}} as never,{async call(){return {TYPE:'file',DELETED_TYPE:'3'};}} as never);
 (service as any).loadVisibleDocument=async()=>({});
 await assert.rejects(()=>service.getAccess(context,'doc','attachment'),e=>e instanceof ApiError&&e.status===404);
 query.limit=async()=>[];
 await assert.rejects(()=>service.getAccess(context,'doc','attachment'),e=>e instanceof ApiError&&e.status===404);
});
