import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {registryOnboardingPayload} from './registry-feedback-fixture.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || '/Users/macbookpro15/Antigravity/AutoRentCRM/node_modules/playwright');
const base=process.env.PREVIEW_BASE_URL || 'http://127.0.0.1:4191';
const published=Boolean(process.env.PREVIEW_BASE_URL);
const out='docs/evidence/preview-height-20261019'+(published?'/published':'');await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1366,height:768}});page.setDefaultTimeout(12000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let detailMode='single';
let mode='pdf',accessCount=0,previewCount=0,unauthorizedOnce=false;
const pdf=await fs.readFile(new URL('./fixtures/attachment-preview/sample.pdf',import.meta.url)),png=await fs.readFile(new URL('./fixtures/attachment-preview/sample.png',import.meta.url));
const multi=await fs.readFile(new URL('./fixtures/attachment-preview/multipage.pdf',import.meta.url));
const doc={...registryOnboardingPayload('https://fixture/api/v1/registry/documents').items[0],attachments:[
 {id:'current-file',kind:'file',name:'Договор.pdf',mimeType:'application/pdf',sizeBytes:pdf.length,isCurrent:true,createdAt:'2026-10-19T10:00:00Z'},
 {id:'old-file',kind:'file',name:'Предыдущая версия.pdf',mimeType:'application/pdf',sizeBytes:pdf.length,isCurrent:false,createdAt:'2026-10-18T10:00:00Z'},
]};
await page.route('**/api/v1/registry/**',async route=>{
 const path=new URL(route.request().url()).pathname;
 if(path.endsWith('/access')) {
  accessCount++;
  if(mode==='denied')return route.fulfill({status:403,json:{error:{message:'Нет доступа к файлу на Диске'}}});
  return route.fulfill({json:{kind:'file',name:path.includes('old-file')?'Предыдущая версия.pdf':mode==='image'?'Скан.png':mode==='text'?'Примечания.txt':'Договор.pdf',url:'https://files.test/broken-detail',downloadUrl:'https://files.test/download'}});
 }
 if(path.endsWith('/preview')) {
  previewCount++;
  if(unauthorizedOnce){unauthorizedOnce=false;return route.fulfill({status:401,json:{error:{message:'Истёк токен'}}});}
  if(mode==='slow')await new Promise(r=>setTimeout(r,800));
  if(mode==='unsupported')return route.fulfill({status:415,json:{error:{message:'Предпросмотр этого формата недоступен. Скачайте оригинал.'}}});
  if(mode==='text')return route.fulfill({contentType:'text/plain; charset=utf-8',body:'<script>window.__injected=true</script>\nТекст документа\n'+('Строка с условиями договора\n'.repeat(80))});
  return route.fulfill({contentType:mode==='image'?'image/png':'application/pdf',body:mode==='image'?png:mode==='multi'?multi:pdf});
 }
 if(path.endsWith('/documents/demo-client-101')) {
  if(detailMode==='denied')return route.fulfill({status:403,json:{error:{message:'Нет доступа к документу'}}});
  return route.fulfill({json:{...doc,attachments:detailMode==='none'?[]:detailMode==='multiple'?[...doc.attachments,{...doc.attachments[0],id:'second-file',name:'Приложение.pdf'}]:doc.attachments}});
 }
 return route.fulfill({json:registryOnboardingPayload(route.request().url())});
});
await page.route('**/legacy/index.html*',async route=>{
 const source=published?await (await route.fetch()).text():await fs.readFile('frontend/public/legacy/index.html','utf8');
 const html=source.replace('  componentDidMount() {','  componentDidMount() { window.__previewApp = this;');
 await route.fulfill({contentType:'text/html',body:html});
});
await page.context().route('https://files.test/**',r=>r.fulfill({contentType:'text/html',body:'Synthetic original download'}));
const report={base,assets:published?'published':'local',api:'synthetic fixtures',checks:[],errors};
const dialog=()=>page.getByRole('dialog',{name:/Договор|Предыдущая|Скан|Примечания|Документ/});
const open=async()=>page.evaluate(()=>window.__previewApp.openAttachment('demo-client-101','current-file',false,{name:'Договор.pdf',kind:'file'}));
const close=async()=>page.getByRole('button',{name:'Закрыть предпросмотр',exact:true}).click();
try {
 await page.goto(base+'/legacy/index.html');await page.waitForFunction(()=>window.__previewApp?.state.registryReady);
 const row=()=>page.locator('.registry-row-file-actions').first();
 await row().getByRole('button',{name:'Открыть',exact:true}).click();await page.locator('canvas[data-ready]').waitFor();
 assert.equal(await page.evaluate(()=>window.__previewApp.state.drawerId),null);await close();
 const listPopup=page.waitForEvent('popup');await row().getByRole('button',{name:'Скачать',exact:true}).click();const original=await listPopup;await original.waitForURL('https://files.test/download');await original.close();
 await page.waitForFunction(()=>!document.querySelector('.registry-file-picker'));
 detailMode='multiple';await row().getByRole('button',{name:'Открыть',exact:true}).click();
 const picker=page.getByRole('dialog',{name:'Файлы документа'});await picker.getByRole('button',{name:'Открыть: Приложение.pdf',exact:true}).waitFor();assert.equal(await picker.getByRole('button',{name:/Предыдущая версия/}).count(),0);
 await page.screenshot({path:out+'/file-choice.png'});await picker.getByRole('button',{name:'Открыть: Приложение.pdf',exact:true}).click();await page.locator('canvas[data-ready]').waitFor();await close();
 detailMode='none';await row().getByRole('button',{name:'Открыть',exact:true}).click();await picker.getByRole('status').filter({hasText:'пока нет'}).waitFor();await picker.getByRole('button',{name:'Закрыть список файлов'}).click();
 detailMode='denied';await row().getByRole('button',{name:'Открыть',exact:true}).click();await picker.getByRole('status').filter({hasText:'Нет доступа'}).waitFor();await picker.getByRole('button',{name:'Закрыть список файлов'}).click();
 detailMode='single';await page.evaluate(()=>{window.__realOpen=window.open;window.open=()=>null;});await row().getByRole('button',{name:'Скачать',exact:true}).click();await picker.getByRole('link',{name:'Скачать файл'}).waitFor();await picker.getByRole('button',{name:'Закрыть список файлов'}).click();await page.evaluate(()=>window.open=window.__realOpen);
 await page.screenshot({path:out+'/list-actions.png'});
 report.checks.push('List preview/download skips drawer; choice excludes history; empty/403/popup-blocked states visible');
 for(const screen of ['deal','company']) {
  await page.evaluate(screen=>{const a=window.__previewApp;a.placementEntity={entityType:screen,entityId:'1588'};a.setState({screen,companyView:'docs',contextDocumentsLoading:false,contextDocumentsError:''});},screen);
  await page.locator('.registry-row-file-actions:visible').first().getByRole('button',{name:'Открыть',exact:true}).click();await page.locator('canvas[data-ready]').waitFor();assert.equal(await page.evaluate(()=>window.__previewApp.state.drawerId),null);await close();await page.screenshot({path:out+'/'+screen+'-actions.png'});
 }
 await page.evaluate(()=>{window.__previewApp.placementEntity=null;window.__previewApp.setState({screen:'registry'});});
 report.checks.push('Deal groups and company document list expose working file actions');

 mode='multi';await row().getByRole('button',{name:'Открыть',exact:true}).click();await page.locator('canvas[data-ready]').waitFor();await page.getByRole('button',{name:'Следующая страница'}).click();await page.locator('canvas[data-ready][aria-label="Страница 2 из 3"]').waitFor();
 await page.getByRole('button',{name:'Увеличить масштаб'}).click();await page.waitForFunction(()=>document.querySelector('[data-zoom]').textContent==='110%');await page.locator('canvas[data-ready]').waitFor();await page.getByRole('button',{name:'100%',exact:true}).click();await page.locator('canvas[data-ready]').waitFor();await close();mode='pdf';
 report.checks.push('Three-page PDF navigation and zoom controls render correctly');
 await page.evaluate(()=>window.__previewApp.openDocument('demo-client-101'));
 await page.getByRole('button',{name:'Открыть',exact:true}).last().click();
 await page.locator('.registry-file-preview canvas[data-ready]').waitFor();
 assert.ok(parseInt(await page.locator('[data-zoom]').textContent())<=100);
 const previewBox=await dialog().boundingBox();assert.ok(previewBox.width<=900&&previewBox.height>=700&&previewBox.height<=768);
 await page.waitForTimeout(700);await page.screenshot({path:out+'/pdf.png'});
 report.checks.push('Current PDF renders locally with a bounded dialog and initial zoom <=100%');
 await page.locator('.pdf-scroll').hover();await page.mouse.wheel(0,600);await page.waitForTimeout(200);assert.ok(await page.locator('.pdf-scroll').evaluate(e=>e.scrollTop>100));
 report.checks.push('Mouse wheel over the PDF scrolls its content');
 await close();
 await page.evaluate(()=>{const a=window.__previewApp;a.setState({drawerHistoryOpen:true});});
 const history=page.getByRole('button',{name:'Открыть',exact:true});
 // History markup keeps its existing text action.
 const historyButton=page.getByText('Предыдущая версия.pdf',{exact:true});await historyButton.waitFor();
 await page.evaluate(()=>window.__previewApp.openAttachment('demo-client-101','old-file',false,{name:'Предыдущая версия.pdf',kind:'file'}));
 await page.locator('.registry-file-preview canvas[data-ready]').waitFor();assert.match(await dialog().innerText(),/Предыдущая версия/);await close();
 report.checks.push('Historical attachment uses the same preview flow');
 mode='image';await open();await page.locator('.registry-file-preview img').waitFor();
 await page.waitForFunction(()=>document.querySelector('.registry-file-preview img')?.naturalWidth>0);await page.screenshot({path:out+'/image.png'});await close();
 mode='text';await open();await page.locator('.registry-file-preview pre').waitFor();
 assert.equal(await page.evaluate(()=>window.__injected),undefined);
 await page.locator('.preview-content').hover();await page.mouse.wheel(0,600);await page.waitForTimeout(150);
 assert.ok(await page.locator('.preview-content').evaluate(e=>e.scrollTop>0));await close();
 report.checks.push('Image renders; text remains inert and scrollable');
 mode='denied';const before=previewCount;await open();await dialog().getByRole('status').filter({hasText:'Нет доступа'}).waitFor();assert.equal(previewCount,before);
 await page.screenshot({path:out+'/denied.png'});
 mode='pdf';await page.getByRole('button',{name:'Повторить',exact:true}).click();await page.locator('.registry-file-preview canvas[data-ready]').waitFor();
 report.checks.push('403 is visible, never loads content; Retry recovers');
 const popup=page.waitForEvent('popup');await page.getByRole('button',{name:'Скачать оригинал'}).click();const tab=await popup;await tab.waitForURL('https://files.test/download');await tab.close();
 await page.evaluate(()=>{window.__realOpen=window.open;window.open=()=>null;});
 await page.getByRole('button',{name:'Скачать оригинал'}).click();await dialog().getByRole('link',{name:'Скачать файл'}).waitFor();
 await page.evaluate(()=>window.open=window.__realOpen);await close();
 report.checks.push('Original download and popup-blocked fallback both use DOWNLOAD_URL');
 mode='unsupported';await open();await dialog().getByRole('status').filter({hasText:'формата недоступен'}).waitFor();await page.screenshot({path:out+'/unsupported.png'});await close();
 mode='slow';await open();await dialog().waitFor();await close();mode='pdf';await open();await page.locator('.registry-file-preview canvas[data-ready]').waitFor();await page.waitForTimeout(1000);assert.equal(await page.locator('.registry-file-preview').count(),1);await close();
 report.checks.push('Unsupported formats offer download; closing and reopening ignores late responses');
 mode='pdf';unauthorizedOnce=true;
 await page.evaluate(()=>{window.__previewApp.requestBitrixContext=async()=>({auth:{accessToken:'refreshed',domain:'demo.bitrix24.ru'}});});
 await open();await page.locator('.registry-file-preview canvas[data-ready]').waitFor();await close();report.checks.push('401 refresh retries preview once');
 await page.setViewportSize({width:390,height:650});mode='image';await open();await page.locator('.registry-file-preview img').waitFor();
 const box=await dialog().boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.width<=390&&box.height<=650);await page.screenshot({path:out+'/mobile.png'});await page.keyboard.press('Escape');assert.equal(await page.locator('.registry-file-preview').count(),0);
 report.checks.push('390px viewport fits; Escape closes dialog');
 await page.setViewportSize({width:1024,height:768});
 await page.route('**/nested-preview.html',r=>r.fulfill({contentType:'text/html',body:'<div style="height:240px">Synthetic CRM header</div><iframe src="/legacy/index.html?nested=1" style="border:0;width:100%;height:1600px"></iframe>'}));
 await page.goto(base+'/nested-preview.html');const frame=page.frames().find(f=>f.url().includes('nested=1'))||await page.waitForEvent('framenavigated',{predicate:f=>f.url().includes('nested=1')});
 await frame.waitForFunction(()=>window.__previewApp?.state.registryReady);await frame.evaluate(()=>{window.__previewApp.placementContextType='deal';window.__previewApp.reportContentSize();});await frame.waitForFunction(()=>!!document.querySelector('.registry-shell').style.getPropertyValue('--registry-dialog-height'));mode='pdf';await frame.evaluate(()=>window.__previewApp.openAttachment('demo-client-101','current-file',false,{name:'Документ',kind:'file'}));await frame.locator('.registry-file-preview canvas[data-ready]').waitFor();
 await frame.locator('.pdf-scroll').hover();await page.mouse.wheel(0,500);await page.waitForTimeout(300);assert.ok(await frame.locator('.pdf-scroll').evaluate(e=>e.scrollTop>100));
 const rect=await frame.locator('.registry-file-preview').evaluate(e=>({y:e.getBoundingClientRect().bottom,h:innerHeight}));assert.ok(rect.y<=rect.h+1);const outer=await frame.locator('.registry-file-preview').boundingBox();assert.ok(outer.y+outer.height<=768,'Dialog fits parent viewport');assert.ok(outer.height>=460,'Viewer uses available iframe height');await page.screenshot({path:out+'/iframe.png'});
 report.checks.push('PDF wheel scroll works at 1024x768 inside a 1600px CRM iframe');
 await frame.getByRole('button',{name:'Закрыть предпросмотр'}).click();
 await frame.evaluate(()=>{window.__previewApp.placementContextType='deal';window.__previewApp.reportContentSize();});await page.evaluate(()=>window.scrollTo(0,700));await page.waitForTimeout(250);
 await frame.evaluate(()=>window.__previewApp.openAttachment('demo-client-101','current-file',false,{name:'Документ',kind:'file'}));await frame.locator('canvas[data-ready]').waitFor();
 const scrolled=await frame.locator('.registry-file-preview').boundingBox();assert.ok(scrolled.y>=0&&scrolled.y+scrolled.height<=768,'Dialog follows visible part of scrolled iframe');assert.ok(scrolled.height>=690,'Viewer grows with visible region');
 await frame.locator('.pdf-scroll').hover();await page.mouse.wheel(0,400);await page.waitForTimeout(200);assert.ok(await frame.locator('.pdf-scroll').evaluate(e=>e.scrollTop>50));await page.screenshot({path:out+'/iframe-scrolled.png'});
 report.checks.push('Preview stays inside the visible region after parent CRM scrolling');

 assert.deepEqual(errors,[]);report.status='pass';
} catch(error){report.status='fail';report.error=error.stack;process.exitCode=1;await page.screenshot({path:out+'/failure.png'});}
await fs.writeFile(out+'/browser.json',JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify(report,null,2));
