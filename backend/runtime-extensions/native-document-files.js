import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {and,desc,eq,isNull,sql} from 'drizzle-orm';
import {registryAttachments,registryAuditLog} from '../db/schema/index.js';
import {AttachmentsService} from '../attachments/attachments.service.js';
import {readDiskFile} from '../attachments/attachment-preview.js';
import {ApiError} from '../http/api-error.js';

// CRM card IDs and generator IDs are separate. Store both in audit metadata,
// never persist machine URLs (they contain credentials).
export async function synchronizeNativeFiles(database,bitrix,context,items){
 const attachments=new AttachmentsService(database,bitrix);
 const call=(method,params)=>bitrix.call(context.bitrix.domain,context.bitrix.accessToken,method,params);
 let files=0,pending=0;
 for(const item of items){
  if(item.status==='removed'||!['bitrix_smart_invoice','bitrix_quote'].includes(item.source))continue;
  await database.transaction(async lock=>{
   const acquired=await lock.execute(sql`select pg_try_advisory_xact_lock(hashtext(${`native-files:${context.portalUrl}:${item.documentId}`})) as locked`);
   if(!acquired[0]?.locked)throw new ApiError(409,'native_sync_in_progress','Файлы уже синхронизируются. Повторите позже.');
   // Latest generated document is the printable version of this CRM card.
   const listed=await call('crm.documentgenerator.document.list',{filter:{entityTypeId:item.entityTypeId,entityId:item.externalId},order:{id:'desc'},start:0});
   const latest=(listed.documents||[])[0];
   if(!latest){pending++;return;}
   const result=await call('crm.documentgenerator.document.get',{id:latest.id});
   const doc=result.document||result;
   if(Number(doc.entityTypeId)!==Number(item.entityTypeId)||Number(doc.entityId)!==Number(item.externalId))throw new ApiError(502,'native_document_mismatch','Печатная форма относится к другой карточке.');
   if(doc.isTransformationError)throw new ApiError(502,'native_pdf_failed','Bitrix24 не смог подготовить PDF. Откройте документ счёта и повторите формирование.');
   for(const format of ['docx','pdf']){
    const url=doc[format==='pdf'?'pdfUrlMachine':'downloadUrlMachine'];
    if(!url){pending++;continue;}
    const key=`${item.source}:${item.externalId}:${format}`;
    const [last]=await database.select().from(registryAuditLog).where(and(eq(registryAuditLog.portalUrl,context.portalUrl),eq(registryAuditLog.documentId,item.documentId),sql`${registryAuditLog.metadata}->'integration'->>'source' = 'native_document'`,sql`${registryAuditLog.metadata}->'integration'->>'key' = ${key}`)).orderBy(desc(registryAuditLog.createdAt)).limit(1);
    const previousId=last?.after?.id;
    const [previous]=previousId?await database.select().from(registryAttachments).where(and(eq(registryAttachments.id,previousId),eq(registryAttachments.portalUrl,context.portalUrl),eq(registryAttachments.documentId,item.documentId),eq(registryAttachments.isCurrent,true),isNull(registryAttachments.deletedAt))):[];
    const revision=`${doc.id}:${doc[format==='pdf'?'pdfId':'fileId']||''}:${doc.updateTime||doc.createTime||''}`;
    if(previous&&last.metadata?.integration?.revision===revision)continue;
    const bytes=await readDiskFile(url,context.bitrix.domain,AbortSignal.timeout(45000));
    if(format==='pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw new ApiError(502,'native_file_invalid','Bitrix24 вернул некорректный PDF. Повторите позже.');
    if(format==='docx'&&(bytes[0]!==0x50||bytes[1]!==0x4b))throw new ApiError(502,'native_file_invalid','Bitrix24 вернул некорректный DOCX. Повторите позже.');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    const name=`${item.source==='bitrix_smart_invoice'?'Счёт':'КП'}-${item.externalId}.${format}`;
    const mimeType=format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const upload=await attachments.initializeFileUpload(context,item.documentId,{name,sizeBytes:bytes.length,mimeType,replacesAttachmentId:previous?.id},{source:'native_document',key,revision,sha256,generatorId:String(doc.id)});
    const form=new FormData();form.append(upload.fieldName,new Blob([new Uint8Array(bytes)],{type:mimeType}),name);
    const body=new Response(form);const payload=Buffer.from(await body.arrayBuffer());
    await attachments.uploadFile(context,item.documentId,upload.uploadId,Readable.from([payload]),body.headers.get('content-type'),String(payload.length));files++;
   }
  });
 }
 return {files,pending};
}
