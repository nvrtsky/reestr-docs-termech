import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {registryOnboardingPayload} from './registry-feedback-fixture.mjs';
const {chromium}=createRequire(import.meta.url)('/Users/macbookpro15/Antigravity/AutoRentCRM/node_modules/playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1366,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const writes=[];
const out='docs/evidence/yellow-review-20261023';await fs.mkdir(out,{recursive:true});
await page.route('**/api/v1/registry/**',async r=>{
 if(r.request().method()!=='GET')writes.push(r.request().method()+' '+new URL(r.request().url()).pathname);
 const u=new URL(r.request().url());let data=structuredClone(registryOnboardingPayload(u.href));
 if(u.pathname.endsWith('/policy')) {data.permissions.administer=true;data.roleCode='admin';}
 if(u.pathname.endsWith('/sections'))for(const section of data.items||[])for(const type of section.types||[]){type.contentRequired=false;if(type.code==='client_contract')type.fields=[{key:'test_reference',label:'Тестовое поле',dataType:'text',isRequired:false}];}
 if(u.pathname.endsWith('/companies/14/deals'))data={items:[{entityId:1618,entityTitle:'ТЕСТ КП Альфа'},{entityId:1619,entityTitle:'ТЕСТ КП Бета'}]};
 if(u.pathname.endsWith('/documents')||u.pathname.endsWith('/by-entity'))for(const d of data.items||[]){d.counterpartyId=14;d.createdAt='2026-10-23T09:00:00Z';}
 if(u.pathname.includes('/documents/demo-')){data=structuredClone(registryOnboardingPayload('https://fixture.test/documents').items.find(d=>d.id===u.pathname.split('/').at(-1))||{});data.counterpartyId=14;data.createdAt='2026-10-23T09:00:00Z';data.attachments=[{id:'file-test',kind:'file',name:'Синтетический файл.pdf',sizeBytes:100,version:1,isCurrent:true,createdAt:'2026-10-23T10:00:00Z',storageCopies:[]}];}
 await r.fulfill({json:data});
});
await page.route('**/legacy/index.html*',async r=>{const s=await(await r.fetch()).text();await r.fulfill({contentType:'text/html',body:s.replace('  componentDidMount() {','  componentDidMount() { window.__app=this;')});});
const checks=[];
try {
 await page.goto('http://127.0.0.1:8894/legacy/index.html');await page.waitForFunction(()=>window.__app?.state.registryReady);
 assert.deepEqual(errors,[]);
 await page.getByRole('button',{name:'+ Добавить документ',exact:true}).click();
 await page.getByRole('button',{name:'Клиентские',exact:true}).click();await page.getByRole('button',{name:'Договор',exact:true}).click();await page.getByRole('button',{name:/Далее/}).click();
 const money=page.locator('[data-registry-upload-panel] label').filter({hasText:/^Сумма$/}).locator('input');
 await money.fill('1000000');await money.blur();assert.equal(await money.inputValue(),'1 000 000,00');checks.push('AC-2: money input formats on blur');
 await page.evaluate(()=>{const a=window.__app;a.setState({wz:{...a.state.wz,counterpartyId:14,counterparty:'Демо-компания А'}});});
 await page.getByRole('button',{name:'Выбрать основной документ',exact:true}).click();
 await page.getByRole('dialog',{name:'Выбрать основной документ'}).waitFor();
 await page.getByRole('dialog',{name:'Выбрать основной документ'}).getByRole('button',{name:/Синтетический договор клиента/}).click();
 await page.getByRole('button',{name:'Сохранить связь',exact:true}).click();
 assert(await page.evaluate(()=>!!window.__app.state.wz.parentDocumentId));checks.push('AC-3: parent selected before creation');
 await page.screenshot({path:out+'/wizard-parent-money.png'});
 await page.evaluate(()=>window.__app.openCompanyDealPicker(14,[],'wizard'));
 const search=page.getByRole('textbox',{name:'Поиск сделки',exact:true});await search.fill('Альфа');
 await page.getByRole('button',{name:/1618 · ТЕСТ КП Альфа/}).click();await search.fill('Бета');await page.getByRole('button',{name:/1619 · ТЕСТ КП Бета/}).click();
 await page.getByRole('button',{name:'Применить',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.__app.state.wz.links.filter(l=>l.entityType==='deal').length),2);checks.push('AC-2: search retains selection outside results');
 await page.locator('[data-registry-upload-panel]').getByRole('button',{name:'Отмена',exact:true}).click();
 await page.evaluate(()=>{const a=window.__app;a.placementContextType='company';a.placementEntity={entityType:'company',entityId:14};a.entityContext={company:{id:14,title:'Демо-компания А'},deals:[]};a.setState({screen:'company',companyView:'docs',contextDocumentsLoading:false});});
 await page.getByRole('button',{name:'По документам',exact:true}).click();
 await page.getByLabel('Раздел документов компании',{exact:true}).selectOption('client');
 await page.getByLabel('Тип документов компании',{exact:true}).selectOption('client_contract');
 await page.screenshot({path:out+'/company-filters.png'});
 checks.push('AC-4/7: company filters render together');
 const title=page.getByText('Синтетический договор клиента',{exact:true});assert(await title.isVisible());
 const group=page.getByRole('button',{name:/▾ Договор/});await group.click();assert.equal(await title.isVisible(),false);
 await page.getByRole('button',{name:/▸ Договор/}).click();assert(await title.isVisible());checks.push('AC-7: document type groups collapse and reopen');
 await page.getByLabel('Тип документов компании',{exact:true}).selectOption('supplier_contract');assert.equal(await title.isVisible(),false);
 await page.getByLabel('Раздел документов компании',{exact:true}).selectOption('supplier');assert(await page.getByText('Синтетический договор поставщика',{exact:true}).isVisible());checks.push('AC-4: section AND type filters change results');
 for(const [width,height] of [[1024,600],[390,700]]){
  await page.setViewportSize({width,height});const add=page.getByRole('button',{name:'＋ Добавить документ',exact:true});const b=await add.boundingBox();assert(b.x>=0&&b.x+b.width<=width+1,JSON.stringify(b));await page.screenshot({path:out+'/company-'+width+'.png'});
 }
 checks.push('AC-10: top actions visible at 1024 and 390 pixels');await page.setViewportSize({width:1366,height:900});
 await page.evaluate(async()=>{const a=window.__app;a.placementEntity=null;a.placementContextType=null;await a.loadAdministrationData();a.setState({screen:'admin',adminTab:'types'});});
 await page.getByLabel('Раздел типов',{exact:true}).selectOption('supplier');
 assert(await page.getByText('Договор поставщика',{exact:true}).isVisible());assert.equal(await page.getByText('Договор',{exact:true}).isVisible(),false);await page.screenshot({path:out+'/settings-filter.png'});checks.push('AC-1: admin types filter by section');
 await page.getByRole('button',{name:'＋ Тип',exact:true}).click();assert(await page.getByText(/Дата документа, номер, компания и сумма — встроенные реквизиты/).isVisible());await page.screenshot({path:out+'/type-help.png'});checks.push('AC-1: field-type guide and built-in date explained');
 await page.evaluate(()=>{const a=window.__app;a.setState({typeModalOpen:false,newTypeOpen:false,screen:'registry'});});
 // Close editor through its normal action to avoid covering the registry.
 await page.evaluate(()=>{const a=window.__app;a.closeTypeModal?.();a.setState({newTypeOpen:false,typeModalOpen:false});});
 await page.getByRole('button',{name:'Колонки',exact:true}).click();
 assert(await page.getByText(/Тестовое поле · Договор/).isVisible());await page.getByText(/Тестовое поле · Договор/).click();await page.screenshot({path:out+'/personal-columns.png'});checks.push('AC-6: custom field available in personal columns');
 await page.evaluate(()=>window.__app.setState({colsOpen:false}));
 await page.getByText('Синтетический договор клиента',{exact:true}).click();
 await page.getByText('Создано в реестре',{exact:true}).waitFor();await page.getByText(/Загружено:/).waitFor();await page.waitForTimeout(300);
 await page.screenshot({path:out+'/document-dates.png'});checks.push('AC-4: card creation and file upload timestamps visible separately from document date');
 await page.evaluate(()=>window.__app.setState({drawerId:null}));
 const before=writes.length;
 page.once('dialog',dialog=>dialog.dismiss());
 await page.evaluate(async()=>{const a=window.__app;await a.createDocumentFromWizard({...a.state.wz,sectionCode:'client',typeLabel:'Договор',number:'ДЕМО-101',counterpartyId:14});});
 assert.equal(writes.length,before);checks.push('AC-12: duplicate warning can cancel without any document creation request');


 assert.deepEqual(errors,[]);
 await fs.writeFile(out+'/browser.json',JSON.stringify({status:'passed',checks,errors},null,2));console.log(JSON.stringify({checks,errors}));
}catch(e){await page.screenshot({path:out+'/failure.png'});console.error(e);console.error(errors);process.exitCode=1;}finally{await browser.close();}
