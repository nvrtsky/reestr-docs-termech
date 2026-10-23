import {createRequire} from 'node:module';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {registryOnboardingPayload} from './registry-feedback-fixture.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1366,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const out=process.env.REGISTRY_BROWSER_OUTPUT||'docs/evidence/section-permissions-20261023';await fs.mkdir(out,{recursive:true});
let role;const writes=[];
await page.route('**/api/v1/registry/**',async r=>{const req=r.request(),u=new URL(req.url());let data=structuredClone(registryOnboardingPayload(u.href));
 if(u.pathname.endsWith('/policy')){data.roleCode='admin';data.permissions.administer=true;}
 if(u.pathname.endsWith('/admin/role-policies')){const base=registryOnboardingPayload('https://fixture/api/v1/registry/me/policy');role||={...base,roleCode:'sales',roleName:'Product Manager',isActive:true,visibleSectionCodes:['client','supplier'],visibleTypeCodes:null,hiddenFields:[],permissions:{...base.permissions,bySection:{client:{finance:true},supplier:{finance:false,content:false}}},capabilities:{canEditPolicy:true,canEditName:true}};data={items:[role,{...base,roleCode:'admin',roleName:'Администратор',capabilities:{canEditName:true,canEditPolicy:false}}]};}
 if(req.method()!=='GET'){writes.push({path:u.pathname,body:req.postDataJSON()});if(req.headers()['x-registry-preview']==='true')data={configurationVersion:1,previewToken:'synthetic',affectedDocuments:2,changes:['Настройки роли'],effects:[]};else data=req.postDataJSON();}
 await r.fulfill({json:data});});
await page.route('**/legacy/index.html*',async r=>{const s=await(await r.fetch()).text();await r.fulfill({contentType:'text/html',body:s.replace('  componentDidMount() {','  componentDidMount() { window.__app=this;')});});
try{
 await page.goto((process.env.REGISTRY_FRONTEND_URL||'http://127.0.0.1:4191')+'/legacy/index.html');await page.waitForFunction(()=>!!window.__app?.serverPolicy,{},{timeout:30000});
 await page.evaluate(async()=>{const a=window.__app;await a.loadAdministrationData();a.setState({screen:'admin',adminTab:'roles'});});
 await page.waitForFunction(()=>window.__app.state.adminPolicies.some(p=>p.roleCode==='sales'));await page.evaluate(()=>window.__app.openRoleEditor(window.__app.state.adminPolicies.find(p=>p.roleCode==='sales')));
 await page.getByLabel('Настройки раздела',{exact:true}).selectOption('supplier');assert.equal(await page.getByLabel('Финансы раздела',{exact:true}).inputValue(),'no');
 await page.getByLabel('Финансы раздела',{exact:true}).selectOption('yes');await page.getByLabel('Настройки раздела',{exact:true}).selectOption('client');await page.getByLabel('Содержимое раздела',{exact:true}).selectOption('no');await page.getByLabel('Настройки раздела',{exact:true}).selectOption('supplier');assert.equal(await page.getByLabel('Финансы раздела',{exact:true}).inputValue(),'yes');
 assert.equal(await page.evaluate(()=>window.__app.state.roleEdit.permissions.bySection.client.content),false);
 await page.getByLabel('Финансы раздела',{exact:true}).selectOption('no');await page.screenshot({path:out+'/supplier-policy.png'});
 const values=await page.evaluate(()=>['0','1234567.89','12.3456'].map(x=>window.__app.yellowMoney(x)));assert.deepEqual(values,['0,00','1 234 567,89','12,3456']);
 assert.equal(await page.evaluate(()=>window.__app.fmtAmount({amount:0,amountRaw:'0.00',currency:'RUB'})),'0,00 ₽');
 await page.evaluate(()=>{const a=window.__app;a.openRoleEditor(a.state.adminPolicies.find(p=>p.roleCode==='admin'));});
 assert.equal(await page.getByLabel('Название роли',{exact:true}).isEnabled(),true);assert.equal(await page.getByRole('button',{name:/Активна:/}).isDisabled(),true);await page.screenshot({path:out+'/admin-name-only.png'});
 await page.evaluate(()=>{const a=window.__app;a.setState({roleModalOpen:false,adminTab:'types'});});await page.getByRole('button',{name:'＋ Тип',exact:true}).click();
 await page.getByRole('textbox',{name:'Поиск в библиотеке полей'}).fill('сумма');assert(await page.getByText('Сумма · Сумма · Все разделы',{exact:true}).isVisible());await page.screenshot({path:out+'/field-library.png'});
 await page.evaluate(()=>{const a=window.__app;a.closeTypeModal?.();a.setState({newTypeOpen:false,typeModalOpen:false});});
 const writesBefore=writes.length;
 page.once('dialog',dialog=>dialog.dismiss());
 await page.evaluate(async()=>{const a=window.__app;await a.createDocumentFromWizard({...a.state.wz,sectionCode:'client',typeLabel:'Договор',number:'ДЕМО-101',counterpartyId:14});});
 assert.equal(writes.length,writesBefore);
 const duplicateGuard=await page.evaluate(async()=>{
  const a=window.__app,original=a.yellowCreateDocument;let calls=0,release;
  a.yellowCreateDocument=async()=>{calls++;await new Promise(resolve=>{release=resolve;});};
  try{const first=a.createDocumentFromWizard({number:''});const second=a.createDocumentFromWizard({number:''});const busy=a.yellowCreating;release();await Promise.all([first,second]);return {calls,busy,finished:!a.yellowCreating};}
  finally{a.yellowCreateDocument=original;}
 });
 assert.deepEqual(duplicateGuard,{calls:1,busy:true,finished:true});
 assert.deepEqual(errors,[]);await fs.writeFile(out+'/browser.json',JSON.stringify({status:'passed',mode:'Published frontend with synthetic API; no CRM writes',checks:['section drafts survive switching','section finance/content tri-state controls','admin label editable but policy controls disabled','full field library searchable including built-ins','money zero grouping and old precision retained','duplicate warning cancellation sends no creation request','simultaneous create actions enter creation only once'],errors},null,2));
 console.log('Browser checks passed');
}finally{await browser.close();}
