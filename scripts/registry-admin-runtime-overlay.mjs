import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const hashes={
 'administration/administration.router.js':'ee6bf5c5c6eb529120f3eebf01131702b58e3594e2edf08396c824fcdf48a404',
 'users/bitrix-users.service.js':'27b022f0ae1e91f8fcbda95356c86d5ac856a5073ebb70a56667f0494dd4dd37',
 'administration/configuration-mutation.js':'c46f1d86b0617afe113e2fdadbf6b0150d1b3ed8ada8bf522178751a69b0c8a9',
};
// The deployed runtime has additional marketplace/configuration protections.
// Apply narrow, audited changes to its exact modules instead of replacing them
// with the older repository runtime. No existing protection is removed.
export function registryAdminRuntimeOverlay(file, baseline){
 assert.equal(createHash('sha256').update(baseline).digest('hex'),hashes[file],`Production module changed: ${file}`);
 let code=baseline;
 const replace=(before,after)=>{assert.equal(code.split(before).length-1,1,`Expected one runtime anchor: ${before}`);code=code.replace(before,after);};
 if(file==='users/bitrix-users.service.js'){
  assert.equal(code.split("context.roleCode === 'admin'").length-1,2);
  return code.replaceAll("context.roleCode === 'admin'", "context.roleSource === 'bitrix_admin'");
 }
 if(file==='administration/configuration-mutation.js'){
  replace("const administrator = context.roleSource === 'bitrix_admin'\n                || (context.source === 'development' && policy.permissions.administer);", "const administrator = context.roleSource === 'bitrix_admin'\n                || (context.roleCode === 'admin' && policy.permissions.administer)\n                || (context.source === 'development' && policy.permissions.administer);");
  replace('const current = await configurationVersion(tx, context.portalUrl);', `const current = await configurationVersion(tx, context.portalUrl);
                // Recheck an assigned administrator under the configuration lock.
                if (context.source === 'bitrix' && context.roleSource !== 'bitrix_admin' && context.roleCode === 'admin') {
                    const [assignment] = await tx.select({ roleCode: registryUserRoles.roleCode }).from(registryUserRoles)
                        .where(and(eq(registryUserRoles.portalUrl, context.portalUrl), eq(registryUserRoles.userId, context.userId)));
                    if (assignment?.roleCode !== 'admin') throw new ApiError(403, 'registry_admin_required', 'Роль администратора реестра отозвана.');
                }`);
  return code;
 }
 replace("const administrator = context.roleSource === 'bitrix_admin'\n        || (context.source === 'development' && policy.permissions.administer);", "const administrator = context.roleSource === 'bitrix_admin'\n        || (context.roleCode === 'admin' && policy.permissions.administer)\n        || (context.source === 'development' && policy.permissions.administer);");
 replace("const activeRoleCodes = new Set(activePolicies.map((policy) => policy.roleCode).filter((roleCode) => roleCode !== 'admin'));", "const activeRoleCodes = new Set(activePolicies.map((policy) => policy.roleCode));");
 const start=code.indexOf("router.put('/access-assignments'");
 assert(start>0);const before=code.slice(0,start);let rest=code.slice(start);
 assert.equal(rest.split(".filter((roleCode) => roleCode !== 'admin')").length-1,1);
 rest=rest.replace(".filter((roleCode) => roleCode !== 'admin')",'');
 rest=rest.replace("for (const item of input.departmentRoles.items) {\n                if (!activeRoleCodes.has(item.roleCode))", "for (const item of input.departmentRoles.items) {\n                if (item.roleCode === 'admin' || !activeRoleCodes.has(item.roleCode))");
 code=before+rest;
 replace('function requireBitrixAdministrator(request) {',`async function assertAdministratorAssignments(database, context, items) {
    if (context.roleSource === 'bitrix_admin' || context.roleCode === 'admin'
        || context.source === 'development') return;
    const current = await database.select({ userId: registryUserRoles.userId, roleCode: registryUserRoles.roleCode })
        .from(registryUserRoles).where(eq(registryUserRoles.portalUrl, context.portalUrl));
    const ids = rows => rows.filter(row => row.roleCode === 'admin').map(row => row.userId).sort((a,b) => a-b);
    if (JSON.stringify(ids(current)) !== JSON.stringify(ids(items))) {
        throw new ApiError(403, 'registry_administrator_assignment_required', 'Назначать и отзывать роль «Администратор» может только администратор реестра или Bitrix24.');
    }
}
function requireBitrixAdministrator(request) {`);
 replace('const input = replaceUserRolesSchema.parse(request.body);', 'const input = replaceUserRolesSchema.parse(request.body);\n            await assertAdministratorAssignments(database, context, input.items);');
 replace('const input = replaceAccessAssignmentsSchema.parse(request.body);', 'const input = replaceAccessAssignmentsSchema.parse(request.body);\n            await assertAdministratorAssignments(database, context, input.userRoles.items);');
 return code;
}
