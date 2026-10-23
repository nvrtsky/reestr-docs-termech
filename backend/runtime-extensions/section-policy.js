// Resolve one document's section without mutating a policy shared by other rows.
export function sectionPolicy(policy, sectionCode) {
 const base=policy.sectionBasePolicy||policy;
 if(base.roleCode==='admin')return base;
 const section=base.permissions.bySection?.[sectionCode];
 if(!section)return base;
 return {...base,sectionBasePolicy:base,sectionRule:section,
  hiddenFields:(section.hiddenFields===undefined?base.hiddenFields:[...section.hiddenFields]).filter(key=>section.finance!==true || !['amount','currency'].includes(key)),
  permissions:{...base.permissions}};
}
export function redactSectionCore(document,policy){
 const aliases={counterparty:['counterpartyId','counterpartyName'],legalEntity:['legalEntityId','legalEntityName'],responsible:['responsibleId','responsibleName']};
 const safe=new Set(['number','title','documentDate','uploadedAt','amount','currency','legalEntityId','legalEntityName','counterpartyId','counterpartyName','dealStageId','comment','responsibleId','responsibleName','createdAt','updatedAt']);
 const result={...document};
 for(const key of policy.hiddenFields||[])for(const field of aliases[key]||[key])if(safe.has(field))result[field]=null;
 return result;
}
