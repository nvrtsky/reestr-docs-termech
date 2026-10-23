import {and,eq,sql} from 'drizzle-orm';
import {registrySettings} from '../db/schema/index.js';
import {BitrixDealImportService} from '../documents/bitrix-deal-import.service.js';
const KEY='native_document_sync_v1';
export function createNativeSyncTick(database,bitrix,installations,config){
 const domain=config.KP_CONNECTOR_PORTAL,portalUrl=`https://${domain}`;let running=false;
 const tick=async()=>{
  if(running)return;running=true;
  try{await database.transaction(async lock=>{
   const acquired=await lock.execute(sql`select pg_try_advisory_xact_lock(hashtext(${`native-worker:${portalUrl}`})) as locked`);if(!acquired[0]?.locked)return;
   const [saved]=await database.select().from(registrySettings).where(and(eq(registrySettings.portalUrl,portalUrl),eq(registrySettings.key,KEY)));
   const state=saved?.value||{};const now=new Date();
   const since=state.since||new Date(now.getTime()-10*60000).toISOString();
   const accessToken=await installations.accessToken(domain);
   const context={portalUrl,userId:0,userName:'Синхронизация счетов',roleCode:'admin',roleSource:'bitrix_admin',departmentIds:[],source:'bitrix',bitrix:{domain,accessToken}};
   const call=(method,params)=>bitrix.call(domain,accessToken,method,params);
   const queue=new Map((state.pending||[]).map(x=>[x.dealId,x]));
   // A five-minute overlap catches delayed CRM timestamps. IDs and file revisions make replay idempotent.
   const from=new Date(new Date(since).getTime()-5*60000).toISOString();
   for(const entityTypeId of [31,7]){
    for(let start=0;start<2000;start+=50){
     const r=await call('crm.item.list',{entityTypeId,filter:{'>=updatedTime':from},select:['id','parentId2','dealId'],order:{id:'ASC'},start});
     const rows=r.items||[];for(const item of rows){const dealId=Number(item.parentId2||item.dealId);if(dealId>0&&!queue.has(dealId))queue.set(dealId,{dealId});}
     if(rows.length<50)break;if(start===1950)throw new Error('sync_page_limit');
    }
   }
   // A PDF can become ready without updating the invoice timestamp.
   for(let start=0;start<2000;start+=50){
    const r=await call('crm.documentgenerator.document.list',{filter:{'>=updateTime':from},order:{id:'ASC'},start});
    const rows=r.documents||[];
    for(const doc of rows){if(![31,7].includes(Number(doc.entityTypeId)))continue;const r=await call('crm.item.get',{entityTypeId:Number(doc.entityTypeId),id:Number(doc.entityId)});const dealId=Number(r.item?.parentId2||r.item?.dealId);if(dealId>0&&!queue.has(dealId))queue.set(dealId,{dealId});}
    if(rows.length<50)break;if(start===1950)throw new Error('sync_page_limit');
   }
   const service=new BitrixDealImportService(database,bitrix);
   for(const item of [...queue.values()].sort((a,b)=>String(a.checkedAt||'').localeCompare(String(b.checkedAt||''))).slice(0,10)){
    try{const result=await service.synchronize(context,item.dealId);if(result.pendingFiles){queue.set(item.dealId,{dealId:item.dealId,status:'waiting_for_print',checkedAt:now.toISOString()});}else queue.delete(item.dealId);}
    catch(error){queue.set(item.dealId,{dealId:item.dealId,status:'error',code:String(error.code||'sync_failed').slice(0,80),checkedAt:now.toISOString()});}
   }
   const value={since:now.toISOString(),checkedAt:now.toISOString(),pending:[...queue.values()]};
   await database.insert(registrySettings).values({portalUrl,key:KEY,value}).onConflictDoUpdate({target:[registrySettings.portalUrl,registrySettings.key],set:{value,updatedAt:now}});
  });}catch{
    console.warn('Native document sync postponed; scheduled retry will follow.');
    try {await database.execute(sql`insert into registry_settings(portal_url,key,value) values (${portalUrl},${KEY},'{"pollError":true}'::jsonb) on conflict(portal_url,key) do update set value=registry_settings.value || '{"pollError":true}'::jsonb, updated_at=now()`);} catch {}
   }finally{running=false;}
 };
 return tick;
}
export async function nativeSyncStatus(database,bitrix,context,dealId){
 if(!context.bitrix)throw new Error('Bitrix24 session required');
 const deal=await bitrix.call(context.bitrix.domain,context.bitrix.accessToken,'crm.deal.get',{id:dealId});
 if(Number(deal.ID)!==dealId)throw new Error('Deal unavailable');
 const [row]=await database.select({value:registrySettings.value}).from(registrySettings).where(and(eq(registrySettings.portalUrl,context.portalUrl),eq(registrySettings.key,KEY)));
 const state=row?.value||{};const pending=(state.pending||[]).find(x=>x.dealId===dealId);
 return {status:pending?.status|| (state.pollError?'error':state.checkedAt?'ready':'starting'),checkedAt:pending?.checkedAt||state.checkedAt||null};
}

export function startNativeSyncWorker(database,bitrix,installations,config){
 if(!config.KP_CONNECTOR_PORTAL||!config.KP_CONNECTOR_URL)return;
 const tick=createNativeSyncTick(database,bitrix,installations,config);
 const timer=setInterval(()=>void tick(),60000);timer.unref();void tick();return timer;
}
