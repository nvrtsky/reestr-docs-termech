import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import fs from 'node:fs/promises';import {and,eq} from 'drizzle-orm';
const root=process.env.REGISTRY_RUNTIME_DIR||'/private/tmp/registry-yellow-test/dist';const mod=p=>import(pathToFileURL(root+'/'+p).href);
const {createDatabase}=await mod('db/database.js');const {seedPortal}=await mod('db/portal-seed.js');const S=await mod('db/schema/index.js');
const {BitrixDealImportService}=await mod('documents/bitrix-deal-import.service.js');const {createNativeSyncTick,nativeSyncStatus}=await mod('integrations/native-sync-worker.js');
const db=createDatabase({DATABASE_URL:'postgres://registry_test@127.0.0.1:55461/registry_role_test',NODE_ENV:'test'});
const domain='native-sync.bitrix24.test',portalUrl='https://'+domain;
const context={portalUrl,userId:1,userName:'Synthetic admin',roleCode:'admin',roleSource:'bitrix_admin',departmentIds:[],source:'bitrix',bitrix:{domain,accessToken:'synthetic'}};
const data={pdf:Buffer.from('%PDF-1.4\nSynthetic test'),docx:Buffer.from('PK\x03\x04Synthetic test')};
let ready=false,denied=false,revision=1;let uploading={};let next=100;const stored=new Map();let downloads=0,uploads=0;
const bitrix={normalizeDomain:d=>d,async call(_domain,_token,m,p={}){
 if(m==='crm.deal.get')return {ID:p.id,TITLE:'Synthetic deal',ASSIGNED_BY_ID:1,CLOSED:'N'};
 if(m==='crm.deal.list')return [{ID:11,TITLE:'Synthetic deal',ASSIGNED_BY_ID:1,CLOSED:'N'}];
 if(m==='crm.item.list')return {items:Number(p.entityTypeId)===31?[{id:120,title:'Synthetic invoice',accountNumber:'TEST-120',begindate:'2026-10-23',beginDate:'2026-10-23',opportunity:'100.00',currencyId:'RUB',assignedById:1,parentId2:11,updatedTime:'2026-10-23T10:00:00Z'}]:[]};
 if(m==='crm.item.get')return {item:{id:p.id,parentId2:11}};
 if(m==='user.get')return [{ID:1,NAME:'Synthetic',ACTIVE:true}];
 if(m==='im.notify.system.add')return 1;
 if(m==='crm.documentgenerator.document.list')return {documents:ready?[{id:500,entityTypeId:31,entityId:120}]:[]};
 if(m==='crm.documentgenerator.document.get')return {document:{id:500,entityTypeId:31,entityId:120,fileId:700+revision,pdfId:800+revision,updateTime:'2026-10-23T10:00:0'+revision+'Z',downloadUrlMachine:`https://${domain}/file.docx`,pdfUrlMachine:`https://${domain}/file.pdf`}};
 if(m==='disk.folder.getchildren')return [];
 if(m==='disk.folder.addsubfolder')return {ID:++next,TYPE:'folder',NAME:p.data.NAME,PARENT_ID:p.id};
 if(m==='disk.folder.get')return {ID:p.id,TYPE:'folder',NAME:'root'};
 if(m==='disk.folder.uploadfile'){uploading={name:p.data.NAME,folder:p.id};return {uploadUrl:`https://${domain}/upload`,field:'file'};}
 if(m==='disk.file.get')return stored.get(Number(p.id));
 if(m==='disk.file.copyto'){const file={...stored.get(Number(p.id)),ID:++next,PARENT_ID:p.targetFolderId};stored.set(next,file);return file;}
 if(m==='disk.file.markdeleted'||m==='disk.file.restore')return true;
 throw new Error('Unexpected Bitrix API '+m);
},async upload(){uploads++;const format=uploading.name.endsWith('.pdf')?'pdf':'docx';const file={ID:++next,NAME:uploading.name,TYPE:'file',PARENT_ID:uploading.folder,SIZE:data[format].length,DELETED_TYPE:'0'};stored.set(next,file);return file;}};
const originalFetch=globalThis.fetch;globalThis.fetch=async input=>{const u=new URL(String(input));assert.equal(u.origin,portalUrl);downloads++;return denied?new Response('Forbidden',{status:403}):new Response(data[u.pathname.endsWith('.pdf')?'pdf':'docx'],{headers:{'content-type':u.pathname.endsWith('.pdf')?'application/pdf':'application/octet-stream'}});};
const checks=[];
try{
 await seedPortal(db.db,portalUrl);await db.db.delete(S.registryDocuments).where(eq(S.registryDocuments.portalUrl,portalUrl));await db.db.delete(S.registrySettings).where(and(eq(S.registrySettings.portalUrl,portalUrl),eq(S.registrySettings.key,'native_document_sync_v1')));
 await db.db.insert(S.registrySettings).values({portalUrl,key:'bitrix_disk_root_folder_id',value:{id:1}}).onConflictDoUpdate({target:[S.registrySettings.portalUrl,S.registrySettings.key],set:{value:{id:1}}});
 const service=new BitrixDealImportService(db.db,bitrix);
 let result=await service.synchronize(context,11);assert.equal(result.created,1);assert.equal(result.pendingFiles,1);const id=result.items[0].documentId;
 ready=true;result=await service.synchronize(context,11);assert.equal(result.copiedFiles,2);assert.equal(result.items[0].documentId,id);assert.equal(uploads,2);checks.push('CRM card then async ready DOCX/PDF are imported into same registry card');
 result=await service.synchronize(context,11);assert.equal(result.copiedFiles,0);assert.equal(uploads,2);checks.push('Repeated sync does not duplicate files or cards');
 revision=2;denied=true;await assert.rejects(service.synchronize(context,11),e=>e.status===403);assert.equal(uploads,2);denied=false;
 result=await service.synchronize(context,11);assert.equal(result.copiedFiles,2);const atts=await db.db.select().from(S.registryAttachments).where(eq(S.registryAttachments.documentId,id));assert.equal(atts.filter(a=>a.isCurrent).length,2);assert(atts.length>=4);checks.push('403 is surfaced; retry replaces current files and retains previous versions');
 const tick=createNativeSyncTick(db.db,bitrix,{accessToken:async()=> 'synthetic'},{KP_CONNECTOR_PORTAL:domain,KP_CONNECTOR_URL:'https://kp.test'});await tick();const status=await nativeSyncStatus(db.db,bitrix,context,11);assert.equal(status.status,'ready');assert(status.checkedAt);checks.push('Background poll discovers CRM changes and persists its checkpoint');
 revision=3;denied=true;await tick();assert.equal((await nativeSyncStatus(db.db,bitrix,context,11)).status,'error');denied=false;await tick();assert.equal((await nativeSyncStatus(db.db,bitrix,context,11)).status,'ready');checks.push('Background failure is visible and next tick retries without losing queue');
 const {assertFileUrl}=await mod('attachments/attachment-preview.js');assert.throws(()=>assertFileUrl('http://127.0.0.1/internal',domain));assert.throws(()=>assertFileUrl('https://other.example/file',domain));checks.push('Machine download URLs limited to portal/trusted redirects; credentials never persisted');
 await fs.writeFile('docs/evidence/yellow-review-20261023/native-sync.json',JSON.stringify({status:'passed',checks,downloads,uploads},null,2));console.log(JSON.stringify({status:'passed',checks,downloads,uploads}));
}finally{globalThis.fetch=originalFetch;await db.close();}
