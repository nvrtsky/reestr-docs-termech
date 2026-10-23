import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const hashes=JSON.parse(readFileSync(new URL('../deploy/section-permissions-20261023/runtime-hashes.json',import.meta.url)));
export function registrySectionRuntimeOverlay(file,baseline){
 assert.equal(createHash('sha256').update(baseline).digest('hex'),hashes[file],`Unknown runtime: ${file}`);
 let code=baseline;
 const replace=(a,b)=>{assert.equal(code.split(a).length-1,1,`${file}: ${a.slice(0,100)}`);code=code.replace(a,b)};
 const scopeImport="import {sectionPolicy,redactSectionCore} from '../integrations/section-policy.js';\n";
 if(file==='permissions/policy.service.js'){
  replace("return policy.permissions.byType?.[typeCode]?.[permission];","if (['finance','content'].includes(permission) && policy.sectionRule?.[permission] !== undefined) return policy.sectionRule[permission];\n    return policy.permissions.byType?.[typeCode]?.[permission];");
  replace("export function isMoneyHidden(policy, typeCode) {","export function isMoneyHidden(policy, typeCode) {\n    if(policy.sectionRule?.finance !== undefined)return !policy.sectionRule.finance;");
  replace("return policy.hiddenFields.includes(field.key)","return (field.dataType === 'file' && policy.sectionRule?.content === false) || policy.hiddenFields.includes(field.key)");
  replace("roleName: 'Администратор',","roleName: policy.roleName,");
 }
 if(file==='documents/documents.service.js'){
  code=scopeImport+code;
  code=code.replaceAll('const policy = await loadRegistryPolicy(this.database, context);','let policy = await loadRegistryPolicy(this.database, context);');
  replace("assertSectionVisible(policy, row.sectionCode);","policy = sectionPolicy(policy, row.sectionCode);\n        assertSectionVisible(policy, row.sectionCode);");
  replace("const typeConfig = await this.loadTypeConfiguration(context, input.sectionCode, input.typeCode);","const typeConfig = await this.loadTypeConfiguration(context, input.sectionCode, input.typeCode);\n        policy = sectionPolicy(policy, input.sectionCode);");
  code=code.replaceAll('assertSectionVisible(policy, current.sectionCode);','policy = sectionPolicy(policy, current.sectionCode);\n        assertSectionVisible(policy, current.sectionCode);');
  replace('    toResponse(row, policy) {','    toResponse(row, policy) {\n        policy = sectionPolicy(policy, row.sectionCode);');
  replace('            ...document,\n            amount: moneyHidden', '            ...redactSectionCore(document,policy),\n            contentVisible: isTypePermissionAllowed(policy,row.typeCode,\'content\'),\n            amount: moneyHidden');
  replace('const typeCodeByDocument = new Map(rows.map((row) => [row.id, row.typeCode]));','const typeCodeByDocument = new Map(rows.map((row) => [row.id, row.typeCode]));\n        const sectionByDocument = new Map(rows.map(row=>[row.id,row.sectionCode]));');
  replace('isDocumentFieldHidden(policy, field, typeCodeByDocument.get(field.documentId))','isDocumentFieldHidden(sectionPolicy(policy,sectionByDocument.get(field.documentId)), field, typeCodeByDocument.get(field.documentId))');
  replace('.filter((field) => isDocumentFieldHidden(policy, field, query.type))','.filter((field) => allowedSections.some(section=>isDocumentFieldHidden(sectionPolicy(policy,section), field, query.type)))');
  // Filters on hidden built-in values must not act as an oracle for hidden data.
  replace('const dynamicFilters = Object.entries(query.fieldFilters ?? {});',`for(const section of allowedSections){
            const hidden=sectionPolicy(policy,section).hiddenFields;
            if ((query.search && hidden.some(key=>['number','title','counterparty','counterpartyName','counterpartyId'].includes(key))) ||
                ((query.counterparty||query.counterpartyId)&&hidden.some(key=>['counterparty','counterpartyName','counterpartyId'].includes(key))) ||
                ((query.from||query.to)&&hidden.includes('documentDate')) ||
                (query.responsibleId&&hidden.some(key=>['responsible','responsibleId','responsibleName'].includes(key))))
                throw new ApiError(403,'document_fields_access_denied','Фильтрация по скрытым полям недоступна.');
        }
        const dynamicFilters = Object.entries(query.fieldFilters ?? {});`);
  replace("if (typeConfig.isFinancial && isMoneyHidden(policy, typeConfig.typeCode)) {", "if (typeConfig.isFinancial && isMoneyHidden(policy, typeConfig.typeCode) && (input.amount != null || input.currency != null)) {");
  replace('const { fields, ...coreInput } = input;',`const hiddenCore=Object.keys(input).filter(key=>policy.hiddenFields.includes(key));
        if(hiddenCore.length)throw new ApiError(403,'document_fields_access_denied','Изменение скрытых полей запрещено.');
        const { fields, ...coreInput } = input;`);
 }
 if(file==='attachments/attachments.service.js'){
  code=scopeImport+code;
  code=code.replaceAll('const policy = await loadRegistryPolicy(this.database, context);','let policy = await loadRegistryPolicy(this.database, context);');
  replace('assertSectionVisible(policy, document.sectionCode);','policy=sectionPolicy(policy,document.sectionCode);\n        assertSectionVisible(policy, document.sectionCode);');
  code=code.replaceAll('isDocumentFieldHidden(policy, field, document.typeCode)','isDocumentFieldHidden(sectionPolicy(policy,document.sectionCode), field, document.typeCode)');
 }
 if(file==='administration/administration.schemas.js'){
  replace('    byType: z.record(codeSchema, z.object({',`    bySection: z.record(codeSchema,z.object({finance:z.boolean().optional(),content:z.boolean().optional(),hiddenFields:z.array(z.string().trim().min(1).max(200)).max(500).optional()})).optional(),
    byType: z.record(codeSchema, z.object({`);
 }
 if(file==='administration/system-roles.js'){
  code=code.replaceAll('canEditName: false','canEditName: true').replace("fixedName: 'Администратор'","fixedName: null").replace("fixedName: 'Менеджер продаж'","fixedName: null");
 }

 if(file==='finance/deal-financial.service.js'){
  code=scopeImport+code;
  code=code.replaceAll("isTypePermissionAllowed(policy, row.typeCode, 'finance')","isTypePermissionAllowed(sectionPolicy(policy,row.sectionCode), row.typeCode, 'finance')").replaceAll('isMoneyHidden(policy, row.typeCode)','isMoneyHidden(sectionPolicy(policy,row.sectionCode), row.typeCode)');
 }
 if(file==='documents/documents-export.service.js'){
  code=scopeImport+code;
  replace('!isDocumentFieldHidden(policy, field, field.typeCode)','policy.visibleSectionCodes.some(section=>!isDocumentFieldHidden(sectionPolicy(policy,section), field, field.typeCode))');
  // Columns do not grant visibility: each cell was already redacted by DocumentsService.
  replace("selected.has('amount') && !hideMoney && !hiddenFields.includes('amount')","selected.has('amount')");
  replace("selected.has('amount') && !hideMoney && !hiddenFields.includes('currency')","selected.has('amount')");
 }
 if(file==='catalogs/catalogs.router.js'){
  code=scopeImport+code;
  code=code.replaceAll('if (isDocumentFieldHidden(policy, field, typeCodeById.get(field.typeId)))','if (policy.visibleSectionCodes.every(section=>isDocumentFieldHidden(sectionPolicy(policy,section), field, typeCodeById.get(field.typeId))))');
  // The section catalogue feeds the creation/edit forms; filter per actual section.
  const anchor='fields: (fieldsByType.get(type.id) ?? []).map((field) => ({';
  assert.equal(code.split(anchor).length-1,2);
  code=code.replace(anchor,'fields: (fieldsByType.get(type.id) ?? []).filter(field=>!isDocumentFieldHidden(sectionPolicy(policy,section.code),field,type.code)).map((field) => ({');
 }
 if(file==='administration/administration.router.js'){
  replace("    router.put('/role-policies/:roleCode',",`    router.patch('/role-policies/:roleCode/name', configurationMutation(database, async (database, request, response, next) => {
        try {
            const { context }=await requireAdministrator(database,request);
            const roleCode=request.params.roleCode;
            const body=request.body;
            if(!body || Object.keys(body).some(k=>k!=='roleName') || typeof body.roleName!=='string' || !body.roleName.trim() || body.roleName.trim().length>120)
                throw new ApiError(400,'role_name_invalid','Укажите название роли (до 120 символов).');
            const [updated]=await database.update(registryRolePolicies).set({roleName:body.roleName.trim(),updatedAt:new Date()})
                .where(and(eq(registryRolePolicies.portalUrl,context.portalUrl),eq(registryRolePolicies.roleCode,roleCode)))
                .returning({roleCode:registryRolePolicies.roleCode,roleName:registryRolePolicies.roleName});
            if(!updated)throw new ApiError(404,'role_policy_not_found','Role policy was not found.');
            response.json(updated);
        }catch(error){next(error);}
    },request=>sessions.invalidatePortal?.(requireRegistryContext(request).portalUrl)));
    router.put('/role-policies/:roleCode',`);
  replace("    for (const fieldKey of input.hiddenFields) {",`    for(const [section,rule] of Object.entries(input.permissions.bySection||{})){
        if(!knownSections.has(section))throw new ApiError(400,'section_not_found','Unknown section: '+section);
        for(const key of rule.hiddenFields||[])if(!knownFields.has(key))throw new ApiError(400,'field_definition_not_found','Unknown field: '+key);
    }
    for (const fieldKey of input.hiddenFields) {`);
 }
 return code;
}
