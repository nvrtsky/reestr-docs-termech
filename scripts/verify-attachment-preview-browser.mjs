import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {registryOnboardingPayload} from './registry-feedback-fixture.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || '/Users/macbookpro15/Antigravity/AutoRentCRM/node_modules/playwright');
const base=process.env.PREVIEW_BASE_URL || 'http://127.0.0.1:4189';
const published=Boolean(process.env.PREVIEW_BASE_URL);
const out='docs/evidence/attachment-preview-20261019'+(published?'/published':'');await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1366,height:768}});page.setDefaultTimeout(12000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let mode='pdf',accessCount=0,previewCount=0,unauthorizedOnce=false;
const pdf=await fs.readFile(new URL('./fixtures/attachment-preview/sample.pdf',import.meta.url)),png=await fs.readFile(new URL('./fixtures/attachment-preview/sample.png',import.meta.url));
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
  return route.fulfill({contentType:mode==='image'?'image/png':'application/pdf',body:mode==='image'?png:pdf});
 }
 if(path.endsWith('/documents/demo-client-101'))return route.fulfill({json:doc});
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
 await page.evaluate(()=>window.__previewApp.openDocument('demo-client-101'));
 await page.getByRole('button',{name:'Открыть',exact:true}).first().click();
 await page.locator('.registry-file-preview iframe').waitFor();
 assert.match(await page.locator('.registry-file-preview iframe').getAttribute('src'),/^blob:/);
 await page.waitForTimeout(700);await page.screenshot({path:out+'/pdf.png'});
 report.checks.push('Current attachment opens an authenticated blob PDF inside the Registry, not DETAIL_URL');
 await close();
 await page.evaluate(()=>{const a=window.__previewApp;a.setState({drawerHistoryOpen:true});});
 const history=page.getByRole('button',{name:'Открыть',exact:true});
 // History markup keeps its existing text action.
 const historyButton=page.getByText('Предыдущая версия.pdf',{exact:true});await historyButton.waitFor();
 await page.evaluate(()=>window.__previewApp.openAttachment('demo-client-101','old-file',false,{name:'Предыдущая версия.pdf',kind:'file'}));
 await page.locator('.registry-file-preview iframe').waitFor();assert.match(await dialog().innerText(),/Предыдущая версия/);await close();
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
 mode='pdf';await page.getByRole('button',{name:'Повторить',exact:true}).click();await page.locator('.registry-file-preview iframe').waitFor();
 report.checks.push('403 is visible, never loads content; Retry recovers');
 const popup=page.waitForEvent('popup');await page.getByRole('button',{name:'Скачать оригинал'}).click();const tab=await popup;await tab.waitForURL('https://files.test/download');await tab.close();
 await page.evaluate(()=>{window.__realOpen=window.open;window.open=()=>null;});
 await page.getByRole('button',{name:'Скачать оригинал'}).click();await dialog().getByRole('link',{name:'Скачать файл'}).waitFor();
 await page.evaluate(()=>window.open=window.__realOpen);await close();
 report.checks.push('Original download and popup-blocked fallback both use DOWNLOAD_URL');
 mode='unsupported';await open();await dialog().getByRole('status').filter({hasText:'формата недоступен'}).waitFor();await page.screenshot({path:out+'/unsupported.png'});await close();
 mode='slow';await open();await dialog().waitFor();await close();mode='pdf';await open();await page.locator('.registry-file-preview iframe').waitFor();await page.waitForTimeout(1000);assert.equal(await page.locator('.registry-file-preview').count(),1);await close();
 report.checks.push('Unsupported formats offer download; closing and reopening ignores late responses');
 mode='pdf';unauthorizedOnce=true;
 await page.evaluate(()=>{window.__previewApp.requestBitrixContext=async()=>({auth:{accessToken:'refreshed',domain:'demo.bitrix24.ru'}});});
 await open();await page.locator('.registry-file-preview iframe').waitFor();await close();report.checks.push('401 refresh retries preview once');
 await page.setViewportSize({width:390,height:650});mode='image';await open();await page.locator('.registry-file-preview img').waitFor();
 const box=await dialog().boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.width<=390&&box.height<=650);await page.screenshot({path:out+'/mobile.png'});await page.keyboard.press('Escape');assert.equal(await page.locator('.registry-file-preview').count(),0);
 report.checks.push('390px viewport fits; Escape closes dialog');
 await page.setViewportSize({width:1366,height:650});
 await page.route('**/nested-preview.html',r=>r.fulfill({contentType:'text/html',body:'<iframe src="/legacy/index.html?nested=1" style="border:0;width:100%;height:560px"></iframe>'}));
 await page.goto(base+'/nested-preview.html');const frame=page.frames().find(f=>f.url().includes('nested=1'))||await page.waitForEvent('framenavigated',{predicate:f=>f.url().includes('nested=1')});
 await frame.waitForFunction(()=>window.__previewApp?.state.registryReady);mode='text';await frame.evaluate(()=>window.__previewApp.openAttachment('demo-client-101','current-file',false,{name:'Документ',kind:'file'}));await frame.locator('.registry-file-preview pre').waitFor();
 const rect=await frame.locator('.registry-file-preview').evaluate(e=>({y:e.getBoundingClientRect().bottom,h:innerHeight}));assert.ok(rect.y<=rect.h+1);await page.screenshot({path:out+'/iframe.png'});
 report.checks.push('Preview fits and scrolls inside an iframe at laptop height');
 assert.deepEqual(errors,[]);report.status='pass';
} catch(error){report.status='fail';report.error=error.stack;process.exitCode=1;await page.screenshot({path:out+'/failure.png'});}
await fs.writeFile(out+'/browser.json',JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify(report,null,2));
