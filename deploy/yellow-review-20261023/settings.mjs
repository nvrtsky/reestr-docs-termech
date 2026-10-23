import fs from 'node:fs';
import postgres from 'postgres';
const sql=postgres(process.env.DATABASE_URL,{max:1});
const portal=process.env.TEST_SETTINGS_PORTAL||'https://thermech.bitrix24.ru';
if(process.env.TEST_SETTINGS_PORTAL && !new URL(portal).hostname.endsWith('.test'))throw new Error('Test portal must use .test');const snapshot=process.env.SETTINGS_SNAPSHOT;
if(!snapshot)throw new Error('SETTINGS_SNAPSHOT required');
const rollback=process.argv.includes('--rollback');
try{await sql.begin(async tx=>{
 await tx`select pg_advisory_xact_lock(hashtext(${portal}),hashtext('registry_configuration'))`;
 const types=await tx`select id,content_required from registry_document_types where portal_url=${portal} and is_active=true`;
 const roles=await tx`select id,permissions from registry_role_policies where portal_url=${portal} and role_code='sales' and is_active=true`;
 const fields=await tx`select tf.id,tf.is_required from registry_type_fields tf join registry_field_definitions f on f.id=tf.field_definition_id join registry_document_types t on t.id=tf.type_id where tf.portal_url=${portal} and f.data_type='file' and t.is_active=true`;
 const before={types,roles,fields};let after;
 if(rollback){
  const saved=JSON.parse(fs.readFileSync(snapshot));
  // Configuration version prevents rollback from overwriting subsequent administrator changes.
  const [v]=await tx`select version from registry_settings where portal_url=${portal} and key='registry_configuration'`;
  if(v?.version!==saved.appliedVersion)throw new Error('Settings changed after release; manual reconciliation required');
  for(const row of saved.before.types)await tx`update registry_document_types set content_required=${row.content_required},updated_at=now() where id=${row.id} and portal_url=${portal}`;
  for(const row of saved.before.roles)await tx`update registry_role_policies set permissions=${tx.json(row.permissions)},updated_at=now() where id=${row.id} and portal_url=${portal}`;
  for(const row of saved.before.fields)await tx`update registry_type_fields set is_required=${row.is_required} where id=${row.id} and portal_url=${portal}`;
  after=saved.before;
 }else{
  if(fs.existsSync(snapshot))throw new Error('Settings snapshot already exists; inspect before retrying');
  if(roles.length!==1)throw new Error('Expected one sales role');
  await tx`update registry_document_types set content_required=false,updated_at=now() where portal_url=${portal} and is_active=true`;
  if(fields.length)await tx`update registry_type_fields set is_required=false where portal_url=${portal} and id in ${tx(fields.map(f=>f.id))}`;
  const permissions={...roles[0].permissions,editOwn:false,editAny:false,transitionOwn:false,transitionAny:false};
  permissions.byType=Object.fromEntries(Object.entries(permissions.byType||{}).map(([k,v])=>{const next={...v,edit:false,transition:false};return [k,next];}));
  await tx`update registry_role_policies set permissions=${tx.json(permissions)},updated_at=now() where id=${roles[0].id} and portal_url=${portal}`;
  after={types:types.map(t=>({...t,content_required:false})),fields:fields.map(f=>({...f,is_required:false})),roles:[{id:roles[0].id,permissions}]};
 }
 const [version]=await tx`insert into registry_settings(portal_url,key,value,version) values (${portal},'registry_configuration','{}',1) on conflict(portal_url,key) do update set version=registry_settings.version+1,updated_at=now() returning version`;
 await tx`insert into registry_settings_audit(portal_url,setting_key,version,actor_id,actor_name,before,after) values (${portal},${rollback?'Откат замечаний 23.10.2026':'Замечания 23.10.2026: отложенное содержимое и права менеджера'},${version.version},0,'Выпуск по поручению администратора',${tx.json(before)},${tx.json(after)})`;
 if(!rollback)fs.writeFileSync(snapshot,JSON.stringify({before,after,appliedVersion:version.version}),{mode:0o600});
 console.log(JSON.stringify({status:rollback?'rolled-back':'applied',types:types.length,fileFields:fields.length,role:'sales',version:version.version}));
});}finally{await sql.end();}
