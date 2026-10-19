import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {registryOnboardingPayload} from './registry-feedback-fixture.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || '/Users/macbookpro15/Antigravity/AutoRentCRM/node_modules/playwright');
const base=process.env.PREVIEW_BASE_URL || 'http://127.0.0.1:4193';
const published=Boolean(process.env.PREVIEW_BASE_URL);
const out='docs/evidence/drawer-backdrop-20261019'+(published?'/published':'');await fs.mkdir(out,{recursive:true});
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
 for (const [width,height] of [[1366,900],[1024,768],[390,700]]) {
  await page.setViewportSize({width,height});
  await page.route('**/drawer-host.html',r=>r.fulfill({contentType:'text/html',body:'<div style="height:100px">Synthetic CRM header</div><iframe src="/legacy/index.html?nested=1" style="border:0;width:100%;height:2400px"></iframe>'}));
  await page.goto(base+'/drawer-host.html');
  const frame=page.frames().find(f=>f.url().includes('nested=1'))||await page.waitForEvent('framenavigated',{predicate:f=>f.url().includes('nested=1')});
  await frame.waitForFunction(()=>window.__previewApp?.state.registryReady);
  await frame.evaluate(()=>{const a=window.__previewApp;a.placementContextType='deal';a.placementEntity={entityType:'deal',entityId:'1588'};a.setState({screen:'deal',contextDocumentsLoading:false,contextDocumentsError:''});a.reportContentSize();});
  await frame.waitForFunction(()=>!!document.querySelector('.registry-shell').style.getPropertyValue('--registry-dialog-height'));
  for(const scrolled of [false,true]) {
   if(scrolled){await page.evaluate(()=>window.scrollTo(0,500));await page.waitForTimeout(350);}
   await frame.evaluate(()=>window.__previewApp.openDocument('demo-client-101'));await frame.locator('[data-registry-drawer-panel]').waitFor();await page.waitForTimeout(250);
   const metrics=await frame.evaluate(()=>{const shell=document.querySelector('.registry-shell'),back=document.querySelector('[data-registry-drawer-backdrop]'),panel=document.querySelector('[data-registry-drawer-panel]');const a=shell.getBoundingClientRect(),b=back.getBoundingClientRect();return {topGap:b.top-a.top,heightGap:b.height-a.height,widthGap:b.width-a.width,color:getComputedStyle(back).backgroundColor,panelBackground:getComputedStyle(panel).backgroundColor,ancestors:[back.parentElement,back.parentElement.parentElement,back.parentElement.parentElement.parentElement,shell].map(n=>({tag:n.tagName,cls:n.className,embedded:n.dataset.embedded,position:getComputedStyle(n).position,top:getComputedStyle(n).top,height:getComputedStyle(n).height,rect:n.getBoundingClientRect().toJSON()}))};});
   assert.ok(Math.abs(metrics.topGap)<1&&Math.abs(metrics.heightGap)<1&&Math.abs(metrics.widthGap)<1,JSON.stringify(metrics));assert.equal(metrics.color,'rgba(24, 24, 27, 0.32)');assert.equal(metrics.panelBackground,'rgb(255, 255, 255)');
   const panel=await frame.locator('[data-registry-drawer-panel]').boundingBox();assert.ok(panel.y>=-2&&panel.y+panel.height<=height+2,JSON.stringify(panel));
   await page.screenshot({path:out+`/drawer-${width}-${scrolled?'scrolled':'top'}.png`});
   // Click the uncovered left margin of the drawer background, including the upper app area.
   const iframeBox=await page.locator('iframe').boundingBox();const x=iframeBox.x+3,y=Math.max(iframeBox.y+5,5);
   await page.mouse.click(x,y);await frame.locator('[data-registry-drawer]').waitFor({state:'detached'});
   assert.equal(await frame.evaluate(()=>window.__previewApp.state.drawerId),null);
  }
  report.checks.push(`${width}x${height}: backdrop covers full app before/after parent scroll; panel stays visible; top background click closes`);
  if(width===1366){
   await frame.evaluate(()=>window.__previewApp.openDocument('demo-client-101'));await frame.locator('[data-registry-drawer-panel]').waitFor();
   await frame.locator('[data-registry-drawer-panel]').getByRole('button',{name:'Открыть',exact:true}).click();await frame.locator('canvas[data-ready]').waitFor();
   await frame.getByRole('button',{name:'Закрыть предпросмотр'}).click();assert.equal(await frame.locator('[data-registry-drawer-panel]').count(),1);await frame.evaluate(()=>window.__previewApp.setState({drawerId:null}));
   report.checks.push('PDF opens above drawer; closing viewer returns to drawer');
  }
 }
 await page.goto(base+'/legacy/index.html');await page.waitForFunction(()=>window.__previewApp?.state.registryReady);await page.evaluate(()=>window.__previewApp.openDocument('demo-client-101'));await page.locator('[data-registry-drawer-panel]').waitFor();
 const full=await page.locator('[data-registry-drawer-backdrop]').boundingBox();assert.ok(full.y===0&&full.height===700);await page.evaluate(()=>window.__previewApp.setState({drawerId:null}));
 report.checks.push('Standalone registry keeps full viewport backdrop');
 assert.deepEqual(errors,[]);report.status='pass';
}catch(e){report.status='fail';report.error=e.stack;process.exitCode=1;await page.screenshot({path:out+'/failure.png'});}
finally{await fs.writeFile(out+'/browser.json',JSON.stringify(report,null,2));await Promise.race([browser.close(),new Promise(resolve=>setTimeout(resolve,10000))]);console.log(JSON.stringify(report,null,2));process.exit(report.status==='pass'?0:1);}
