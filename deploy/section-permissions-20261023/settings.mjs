import fs from 'node:fs';
import postgres from 'postgres';
const sql=postgres(process.env.DATABASE_URL,{max:1});
const portal=process.env.TEST_SETTINGS_PORTAL||'https://thermech.bitrix24.ru';
if(process.env.TEST_SETTINGS_PORTAL&&!new URL(portal).hostname.endsWith('.test'))throw new Error('Test portal must use .test');
const snapshot=process.env.SETTINGS_SNAPSHOT;
if(!snapshot)throw new Error('SETTINGS_SNAPSHOT required');
const rollback=process.argv.includes('--rollback');
try{await sql.begin(async tx=>{
 await tx`select pg_advisory_xact_lock(hashtext(${portal}),hashtext('registry_configuration'))`;
 const [before]=await tx`select id,role_name,permissions from registry_role_policies where portal_url=${portal} and role_code='sales' and is_active=true for update`;
 if(!before)throw new Error('Expected active sales role');
 let after;
 if(rollback){
  const saved=JSON.parse(fs.readFileSync(snapshot));
  const [version]=await tx`select version from registry_settings where portal_url=${portal} and key='registry_configuration'`;
  if(version?.version!==saved.appliedVersion)throw new Error('Settings changed after release; reconcile before rollback');
  after=saved.before;
 }else{
  if(fs.existsSync(snapshot))throw new Error('Snapshot already exists');
  const permissions=structuredClone(before.permissions);
  permissions.bySection={...permissions.bySection,client:{...permissions.bySection?.client,finance:true},supplier:{...permissions.bySection?.supplier,finance:false,content:false}};
  after={...before,role_name:'Product Manager',permissions};
 }
 await tx`update registry_role_policies set role_name=${after.role_name},permissions=${tx.json(after.permissions)},updated_at=now() where id=${before.id} and portal_url=${portal}`;
 const [version]=await tx`insert into registry_settings(portal_url,key,value,version) values (${portal},'registry_configuration','{}',1) on conflict(portal_url,key) do update set version=registry_settings.version+1,updated_at=now() returning version`;
 await tx`insert into registry_settings_audit(portal_url,setting_key,version,actor_id,actor_name,before,after) values (${portal},${rollback?'Откат прав разделов 23.10.2026':'Product Manager: права разделов 23.10.2026'},${version.version},0,'Выпуск по поручению администратора',${tx.json(before)},${tx.json(after)})`;
 if(!rollback)fs.writeFileSync(snapshot,JSON.stringify({before,after,appliedVersion:version.version}),{mode:0o600});
 console.log(JSON.stringify({status:rollback?'rolled-back':'applied',role:'sales',version:version.version}));
});}finally{await sql.end();}
