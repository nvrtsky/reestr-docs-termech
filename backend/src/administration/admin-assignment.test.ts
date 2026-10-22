import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createAdministrationRouter, requireAdministrator} from './administration.router.js';
import {BitrixSessionService} from '../auth/bitrix-session.service.js';
import {listBitrixUsers} from '../users/bitrix-users.service.js';
import {registryRolePolicies, registrySections, registrySettings, registryUserRoles} from '../db/schema/index.js';
import {ApiError} from '../http/api-error.js';

function fixture() {
 const assignments=new Map<number,string>([[7,'sales']]);
 const writes:unknown[]=[];
 const db:any={
  select(){let table:any;const q:any={from(t:any){table=t;return q;},where(){return q;},orderBy(){return q;},limit(){return q;},then(resolve:any,reject:any){
   let rows:any[]=[];
   if(table===registryRolePolicies)rows=[{roleCode:'admin',roleName:'Администратор',permissions:{administer:true},visibleSectionCodes:['client'],hiddenFields:[],isActive:true},{roleCode:'sales',permissions:{administer:false},isActive:true}];
   if(table===registrySections)rows=[{code:'client'}];
   if(table===registryUserRoles)rows=assignments.has(7)?[{roleCode:assignments.get(7)}]:[];
   if(table===registrySettings)rows=[{value:{'1':true}}];
   return Promise.resolve(rows).then(resolve,reject);
  }};return q;},
  insert(table:any){return {values(values:any){if(table===registryUserRoles){writes.push(values);for(const v of values)assignments.set(v.userId,v.roleCode);}return {onConflictDoUpdate:async()=>{},then:(r:any)=>Promise.resolve().then(r)};}};},
  delete(table:any){return {where:async()=>{if(table===registryUserRoles)assignments.clear();}};},
  transaction:async(fn:any)=>fn(db),
 };
 const bitrix:any={normalizeDomain:(d:string)=>d,call:async(_d:string,_t:string,method:string)=>{
  if(method==='profile')return {ID:'7',ADMIN:false};
  if(method==='user.current')return {ID:'7',ACTIVE:true};
  if(method==='user.get')return [{ID:1,NAME:'Portal Admin',ADMIN:true,ACTIVE:true},{ID:7,NAME:'Employee',ADMIN:false,ACTIVE:true}];
  throw Error('Unexpected '+method);
 }};
 return {db,bitrix,assignments,writes};
}
test('standard Administrator assignment is accepted; portal admins remain protected; invalid role rejected',async()=>{
 const {db,bitrix,assignments,writes}=fixture();const app=express();app.use(express.json());
 app.use((req,_res,next)=>{req.registryContext={portalUrl:'https://assign.bitrix24.ru',userId:1,roleCode:'admin',source:'bitrix',isBitrixAdmin:true,bitrix:{domain:'assign.bitrix24.ru',accessToken:'synthetic-only'}};next();});
 app.use(createAdministrationRouter({database:db,bitrix,bitrixEventHandlerUrl:'',bitrixPlacementHandlerUrl:'',bitrixEventTokenConfigured:false}));
 app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status||500).json({code:e.code}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const address=server.address() as {port:number};
 const put=(items:unknown[])=>fetch(`http://127.0.0.1:${address.port}/user-roles`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({items})});
 try{
  assert.equal((await put([{userId:7,roleCode:'admin'}])).status,200);assert.equal(assignments.get(7),'admin');
  const admin=await put([{userId:1,roleCode:'sales'}]);assert.equal(admin.status,400);assert.equal((await admin.json()).code,'bitrix_admin_role_fixed');
  assert.equal((await put([{userId:7,roleCode:'unknown'}])).status,400);assert.equal(writes.length,1);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('same verified session observes promotion, demotion and revocation without gaining portal administrator status',async()=>{
 const {db,bitrix,assignments}=fixture();const sessions=new BitrixSessionService(db,bitrix);
 const first=await sessions.resolve('session.bitrix24.ru','synthetic-token');assert.equal(first.roleCode,'sales');assert.equal(first.isBitrixAdmin,false);
 assignments.set(7,'admin');const promoted=await sessions.resolve('session.bitrix24.ru','synthetic-token');assert.equal(promoted.roleCode,'admin');assert.equal(promoted.isBitrixAdmin,false);
 const {policy}=await requireAdministrator(db,{registryContext:promoted} as never);assert.equal(policy.permissions.administer,true);
 const users=await listBitrixUsers(promoted,bitrix);assert.equal(users.find(u=>u.id===7)?.isBitrixAdmin,false);assert.equal(users.find(u=>u.id===1)?.isBitrixAdmin,true);
 assignments.set(7,'sales');assert.equal((await sessions.resolve('session.bitrix24.ru','synthetic-token')).roleCode,'sales');
 assignments.delete(7);await assert.rejects(()=>sessions.resolve('session.bitrix24.ru','synthetic-token'),e=>e instanceof ApiError&&e.status===403);
});
test('custom role name or code does not grant settings access',async()=>{
 const policy={roleCode:'application_admin',roleName:'Администратор приложения',permissions:{administer:false}};
 const q:any={from(){return q;},where(){return q;},limit:async()=>[policy]};
 await assert.rejects(()=>requireAdministrator({select:()=>q} as never,{registryContext:{portalUrl:'https://test.bitrix24.ru',roleCode:'application_admin'}} as never),e=>e instanceof ApiError&&e.code==='registry_admin_required');
});
