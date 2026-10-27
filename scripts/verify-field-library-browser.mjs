import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {registryOnboardingPayload} from './registry-feedback-fixture.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1366,height:1000}});
const errors=[],writes=[];
page.on('pageerror',error=>errors.push(error.message));
const out=process.env.REGISTRY_BROWSER_OUTPUT||'docs/evidence/field-library-20261027';
await fs.mkdir(out,{recursive:true});
const base=process.env.REGISTRY_FRONTEND_URL||'http://127.0.0.1:4191';
await page.route('**/api/v1/registry/**',async route=>{
 const request=route.request(),url=new URL(request.url());
 const data=structuredClone(registryOnboardingPayload(url.href));
 if(url.pathname.endsWith('/admin/types')){
  data.fieldLibrary=[
   {key:'supplier_reference',name:'Номер договора поставщика',dataType:'text',options:[]},
   {key:'payment_date',name:'Срок оплаты',dataType:'date',options:[]},
   {key:'delivery_basis',name:'Базис поставки',dataType:'select',options:['Самовывоз','Доставка']},
   // A built-in accidentally included in the library must not become addable.
   {key:'amount',name:'Сумма',dataType:'money',options:[]},
   {key:'supplier_reference',name:'Номер договора поставщика',dataType:'text',options:[]},
  ];
 }
 if(request.method()!=='GET')writes.push({method:request.method(),path:url.pathname});
 await route.fulfill({json:data});
});
await page.route('**/legacy/index.html*',async route=>{
 const response=await route.fetch();const source=await response.text();
 await route.fulfill({contentType:'text/html',body:source.replace('  componentDidMount() {','  componentDidMount() { window.__app=this;')});
});
try{
 await page.goto(base+'/legacy/index.html');
 await page.waitForFunction(()=>!!window.__app?.serverPolicy);
 await page.evaluate(async()=>{const app=window.__app;await app.loadAdministrationData();app.setState({screen:'admin',adminTab:'types'});});
 await page.getByRole('button',{name:'＋ Тип',exact:true}).click();
 const library=page.getByRole('region',{name:'Библиотека полей',exact:true});
 const search=library.getByRole('textbox',{name:'Поиск в библиотеке полей'});
 const rows=library.getByRole('listitem');
 const row=key=>library.locator(`[data-field-key="${key}"]`);
 await search.scrollIntoViewIfNeeded();
 await page.waitForTimeout(350); // Let the modal opening transition finish before the evidence capture.
 assert.equal(await rows.count(),16);
 assert.equal(await row('amount').getByRole('button',{name:'Уже в карточке'}).isDisabled(),true);
 assert.equal(await row('supplier_reference').locator('.field-library-sections').innerText(),'Поставщик');
 await page.screenshot({path:out+'/library.png'});
 await search.fill('номер');assert.equal(await rows.count(),2);await page.screenshot({path:out+'/mixed-fields.png'});
 await search.fill('  СУММА  ');assert.equal(await rows.count(),1);assert.equal(await row('amount').count(),1);
 await search.fill('payment_date');assert.equal(await rows.count(),1);
 await row('payment_date').getByRole('button',{name:'+ Добавить',exact:true}).click();
 assert.equal(await row('payment_date').getByRole('button',{name:'Добавлено'}).isDisabled(),true);
 assert.deepEqual(await page.evaluate(()=>window.__app.state.newType.fields.map(f=>({key:f.key,dtype:f.dtype,lockedSource:f.lockedSource}))),[{key:'payment_date',dtype:'Дата',lockedSource:'library'}]);
 // Replaying an old handler cannot add the same definition twice.
 await page.evaluate(()=>{const app=window.__app;const entry=app.renderVals().libraryChips.find(f=>f.key==='payment_date');entry.onAdd();entry.onAdd();});
 assert.equal(await page.evaluate(()=>window.__app.state.newType.fields.length),1);
 await search.fill('список');assert.equal(await rows.count(),3);
 await row('delivery_basis').getByRole('button',{name:'+ Добавить',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.__app.state.newType.fields.find(f=>f.key==='delivery_basis').optionsText),'Самовывоз\nДоставка');
 await search.fill('поставщик');assert.equal(await rows.count(),1);
 await row('supplier_reference').getByRole('button',{name:'+ Добавить',exact:true}).click();
 await page.screenshot({path:out+'/search-and-added.png'});
 await search.fill('Несуществующее поле');assert.equal(await rows.count(),0);assert(await library.getByRole('status').isVisible());
 await page.screenshot({path:out+'/empty-search.png'});
 await search.fill('');await page.setViewportSize({width:600,height:800});await search.scrollIntoViewIfNeeded();
 const overflow=await library.evaluate(el=>el.scrollWidth>el.clientWidth);assert.equal(overflow,false);
 await page.screenshot({path:out+'/narrow.png'});
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 await fs.writeFile(out+'/browser.json',JSON.stringify({status:'passed',url:base,mode:'Synthetic API; no real document or settings writes',checks:['all 13 built-ins and 3 custom definitions share the same row layout','one search by name, code, type and section; trimmed and case-insensitive','built-ins and duplicate definitions never become addable twice','custom definitions retain keys, types and options','added state blocks repeated insertion','empty results explained','600px layout has no horizontal overflow','no browser errors or write requests'],errors},null,2));
 console.log('Field library browser checks passed');
}finally{await browser.close();}
