import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const hashes=JSON.parse(readFileSync(new URL('../deploy/yellow-review-20261023/runtime-hashes.json',import.meta.url)));
export function registryYellowRuntimeOverlay(file,baseline){
 assert.equal(createHash('sha256').update(baseline).digest('hex'),hashes[file],`Production module changed: ${file}`);
 let code=baseline;
 const replace=(a,b)=>{assert.equal(code.split(a).length-1,1,`${file}: ${a.slice(0,90)}`);code=code.replace(a,b);};
 if(file==='documents/documents.schemas.js'){
  replace('supersedesId: documentIdSchema.optional(),',"supersedesId: documentIdSchema.optional(),\n    parentDocumentId: documentIdSchema.optional(),\n    relationType: z.enum(['addendum','appendix','other']).optional(),");
  replace('taskLinks: true, supersedesId: true','taskLinks: true, supersedesId: true, parentDocumentId: true, relationType: true');
 }
 if(file==='documents/documents.service.js'){
  replace('const initialStatus = typeConfig.lifecycleConfig.initialStatus;',`// A new child may reference a readable existing document without granting edit rights on that parent.
        const initialParent = input.parentDocumentId ? await this.getById(context, input.parentDocumentId) : null;
        if (initialParent && (!input.counterpartyId || initialParent.counterpartyId !== input.counterpartyId || initialParent.status === 'archived')) {
            throw new ApiError(409, 'document_relation_company_mismatch', 'Основной документ должен быть действующим документом той же компании.');
        }
        const initialStatus = typeConfig.lifecycleConfig.initialStatus;`);
  replace('await this.upsertFieldValues(transaction, context, document.id, typeConfig.typeId, input.fields);',`await this.upsertFieldValues(transaction, context, document.id, typeConfig.typeId, input.fields);
                if (initialParent) {
                    // Lock and recheck the parent in this transaction. The new child cannot form a cycle.
                    const [parent] = await transaction.select({ id: registryDocuments.id }).from(registryDocuments)
                        .where(and(eq(registryDocuments.id, initialParent.id), eq(registryDocuments.portalUrl, context.portalUrl),
                            eq(registryDocuments.counterpartyId, input.counterpartyId), eq(registryDocuments.isFinalized, true),
                            isNull(registryDocuments.deletedAt), ne(registryDocuments.status, 'archived'))).for('update');
                    if (!parent) throw new ApiError(409, 'document_relation_parent_changed', 'Основной документ изменён. Выберите его повторно.');
                    await transaction.insert(registryDocumentRelations).values({portalUrl:context.portalUrl,parentDocumentId:parent.id,childDocumentId:document.id,relationType:input.relationType||'other',createdBy:context.userId});
                    await transaction.insert(registryAuditLog).values({portalUrl:context.portalUrl,documentId:document.id,event:'relation_parent_added',actorId:context.userId,actorName:context.userName??null,after:{parentDocumentId:parent.id,relationType:input.relationType||'other'}});
                }`);
 }
 if(file==='attachments/attachments.service.js'){
  replace('        const contentAllowed = isTypePermissionGranted(policy, document.typeCode,', "        if (requireEdit && context.roleCode === 'sales' && document.isFinalized && !editScope) throw new ApiError(403, 'document_edit_access_denied', 'Изменение сохранённого документа менеджеру запрещено.');\n        const contentAllowed = isTypePermissionGranted(policy, document.typeCode,");
  replace('const editScope = policy.permissions.editAny\n            || (policy.permissions.editOwn && own);',`// Creation permission covers initial uploads only, never later changes to saved cards.
        const initialUpload = !document.isFinalized && document.createdBy === context.userId
            && isTypePermissionGranted(policy, document.typeCode, 'create', policy.permissions.create);
        const editScope = initialUpload || policy.permissions.editAny
            || (policy.permissions.editOwn && own);`);
 }
 if(file==='documents/bitrix-deal-import.service.js'){
  code="import {synchronizeNativeFiles} from '../integrations/native-document-files.js';\n"+code;
  replace('        return {\n            dealId,\n            created: result.created,',"        const nativeFiles = customRows ? {files:0,pending:0} : await synchronizeNativeFiles(this.database,this.bitrix,context,result.items.filter(item => activeImports.some(active=>active.id===item.documentId)));\n        return {\n            copiedFiles: nativeFiles.files, pendingFiles: nativeFiles.pending,\n            dealId,\n            created: result.created,");
 }
 if(file==='app.js'){
  code="import {startNativeSyncWorker} from './integrations/native-sync-worker.js';\n"+code;
  replace('const kpConnector = new KpConnector(database, bitrix, config);','const kpConnector = new KpConnector(database, bitrix, config);\n        startNativeSyncWorker(database, bitrix, installations, config);');
 }
 if(file==='documents/documents.router.js'){
  code="import {nativeSyncStatus} from '../integrations/native-sync-worker.js';\n"+code;
  replace("    router.post('/deal/:dealId/sync-bitrix',", "    router.get('/deal/:dealId/sync-status', async(request,response,next)=>{try{response.setHeader('cache-control','private, no-store');response.json(await nativeSyncStatus(database,bitrix,requireRegistryContext(request),dealIdSchema.parse(request.params.dealId)));}catch(error){next(error);}});\n    router.post('/deal/:dealId/sync-bitrix',");
 }
 return code;
}
