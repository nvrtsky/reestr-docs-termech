import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {registryOnboardingPayload} from './registry-feedback-fixture.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/macbookpro15/Antigravity/AutoRentCRM/node_modules/playwright');
const out=process.env.REGISTRY_BROWSER_OUTPUT||'docs/evidence/admin-role-20261022';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1366,height:1000}});
let userId=1,assigned='application_admin';const writes=[];const errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=registryOnboardingPayload('https://fixture/api/v1/registry/me/policy');
const admin={...base,roleCode:'admin',roleName:'Администратор',isActive:true};
const custom={...base,roleCode:'application_admin',roleName:'Администратор приложения',isActive:true,permissions:{...base.permissions,administer:false}};
await page.route('**/api/v1/registry/**',async route=>{
 const req=route.request(),p=new URL(req.url()).pathname;
 let value=registryOnboardingPayload(req.url());
 if(p.endsWith('/admin/configuration/version'))value={configurationVersion:1};
 if(p.endsWith('/me/policy'))value={...(userId===1||assigned==='admin'?admin:custom),userId};
 if(p.endsWith('/admin/role-policies'))value={items:[admin,custom]};
 if(p.endsWith('/admin/user-roles')){
  if(req.method()==='PUT'){const data=req.postDataJSON();writes.push(data);assigned=data.items.find(x=>x.userId===7)?.roleCode||'';value=data;}
  else value={users:[{id:1,name:'Тестовый администратор Bitrix24',isBitrixAdmin:true},{id:7,name:'Тестовый сотрудник',isBitrixAdmin:false}],items:assigned?[{userId:7,roleCode:assigned}]:[]};
 }
 if(p.endsWith('/admin/access-assignments')&&req.method()==='PUT'){const data=req.postDataJSON();if(req.headers()['x-registry-preview']==='true'){value={configurationVersion:1,previewToken:'synthetic-preview',affectedDocuments:3,changes:['Назначения пользователей'],effects:['Изменение роли тестового сотрудника']};}else{writes.push(data);assigned=data.userRoles.items.find(x=>x.userId===7)?.roleCode||'';value={userRoles:data.userRoles.items,departmentRoles:data.departmentRoles.items};}}
 if(p.endsWith('/admin/department-roles'))value={departments:[],items:[]};
 if(p.endsWith('/admin/settings'))value={rules:{responsibilityMode:'primary_deal',version:0},managers:{userIds:[],version:0,editable:userId===1},integration:{}};
 await route.fulfill({json:value});
});
const report={mode:'isolated browser, synthetic API/users, real built frontend',checks:[],errors};
try{
 await page.goto((process.env.REGISTRY_FRONTEND_URL||'http://127.0.0.1:4188')+'/legacy/index.html');
 await page.getByRole('button',{name:/^⚙ Настройки/}).click();
 await page.getByRole('button',{name:'Роли и доступ',exact:true}).click();
 const row=page.locator('div').filter({has:page.getByText('Тестовый сотрудник',{exact:true})}).filter({has:page.locator('select')}).last();
 const select=row.locator('select');await select.waitFor();
 assert(await select.locator('option[value="admin"]').count()===1);
 await select.selectOption('admin');
 await page.screenshot({path:out+'/01-assign-standard-admin.png',fullPage:true});
 await page.getByRole('button',{name:'Сохранить назначения',exact:true}).click();await page.getByRole('button',{name:'Применить',exact:true}).click();
 await page.getByText('Сохранено',{exact:true}).waitFor();assert.equal(assigned,'admin');
 report.checks.push('Standard admin selectable and saved for ordinary employee; portal admin remains fixed');
 userId=7;await page.reload();await page.getByRole('button',{name:/^⚙ Настройки/}).click();
 await page.getByRole('button',{name:'Общие правила',exact:true}).waitFor();
 await page.screenshot({path:out+'/02-assigned-admin-settings.png',fullPage:true});
 await page.getByRole('button',{name:'Роли и доступ',exact:true}).click();
 assert.equal(await select.count(),1);
 report.checks.push('Assigned application admin sees settings and remains an editable employee, not portal admin');
 userId=1;await page.reload();await page.getByRole('button',{name:/^⚙ Настройки/}).click();await page.getByRole('button',{name:'Роли и доступ',exact:true}).click();
 await select.selectOption('application_admin');await page.getByRole('button',{name:'Сохранить назначения',exact:true}).click();await page.getByRole('button',{name:'Применить',exact:true}).click();await page.getByText('Сохранено',{exact:true}).waitFor();
 userId=7;await page.reload();await page.getByRole('button',{name:/^⚙ Настройки/}).click();await page.getByText('Доступно только администратору',{exact:true}).waitFor();
 await page.screenshot({path:out+'/03-custom-role-denied.png',fullPage:true});
 report.checks.push('Removing standard admin revokes settings; similarly named custom role stays restricted');
 assert.equal(writes.length,2);assert.deepEqual(errors,[]);report.status='passed';
}catch(e){report.status='failed';report.error=e.message;await page.screenshot({path:out+'/failure.png',fullPage:true});console.log((await page.locator('body').innerText()).slice(-3500));process.exitCode=1;}
finally{await fs.writeFile(out+'/browser.json',JSON.stringify(report,null,2));console.log(report);await browser.close();}
