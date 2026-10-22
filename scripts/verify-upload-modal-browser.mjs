import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {registryOnboardingPayload} from './registry-feedback-fixture.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || '/Users/macbookpro15/Antigravity/AutoRentCRM/node_modules/playwright');
const baseline=process.env.BASELINE==='1';
const base=process.env.PREVIEW_BASE_URL||'http://127.0.0.1:4197';
const out='docs/evidence/upload-modal-20261022/'+(baseline?'before':process.env.PREVIEW_BASE_URL?'published':'after');
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/v1/registry/**',r=>{
 const data=structuredClone(registryOnboardingPayload(r.request().url()));
 if(new URL(r.request().url()).pathname.endsWith('/sections'))for(const s of data.items||[])for(const t of s.types||[])t.fields=Array.from({length:24},(_,i)=>({key:'test_'+i,label:'Дополнительное поле '+(i+1),name:'Дополнительное поле '+(i+1),dataType:'text',isRequired:false}));
 return r.fulfill({json:data});
});
await page.route('**/legacy/index.html*',async r=>{const source=await(await r.fetch()).text();await r.fulfill({contentType:'text/html',body:source.replace('  componentDidMount() {','  componentDidMount() { window.__modalApp = this;')});});
await page.route('**/modal-host.html',r=>r.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><body style="margin:0"><header style="height:160px;background:#eef2ff;padding:16px;box-sizing:border-box">Карточка компании · тестовая область CRM</header><iframe src="/legacy/index.html?nested=1" style="border:0;width:100%;height:2400px"></iframe></body>'}));
const checks=[];
try{
 for(const [width,height] of [[1366,768],[1024,600],[390,700]]) {
  await page.setViewportSize({width,height});await page.goto(base+'/modal-host.html');
  const f=page.frames().find(f=>f.url().includes('nested=1'))||await page.waitForEvent('framenavigated',{predicate:f=>f.url().includes('nested=1')});
  await f.waitForFunction(()=>window.__modalApp?.state.registryReady);
  await f.evaluate(()=>{const a=window.__modalApp;a.placementContextType='company';a.placementEntity={entityType:'company',entityId:'14'};a.setState({screen:'company',contextDocumentsLoading:false});document.querySelector('.registry-shell').style.minHeight='2200px';a.reportContentSize();});
  await f.waitForFunction(()=>document.querySelector('.registry-shell').style.getPropertyValue('--registry-dialog-height'));
  await f.getByRole('button',{name:'＋ Добавить документ',exact:true}).click();
  await f.getByRole('button',{name:'Клиентские',exact:true}).click();
  await f.getByRole('button',{name:'Договор',exact:true}).click();
  await f.getByRole('button',{name:/Далее/}).click();
  const panel=f.locator('div[style*="width: 620px"]').filter({hasText:'Новый документ'});
  const body=panel.locator('.registry-wizard-scroll');
  for(const scrolled of [false,true]){
   if(scrolled)await page.evaluate(()=>window.scrollTo(0,450));
   await page.waitForTimeout(350);
   const box=await panel.boundingBox();const iframe=await page.locator('iframe').boundingBox();
   const top=Math.max(0,iframe.y);const bottom=Math.min(height,iframe.y+iframe.height);
   const metrics={width,height,scrolled,box,visibleTop:top,visibleBottom:bottom};checks.push(metrics);
   await page.screenshot({path:`${out}/modal-${width}-${scrolled?'scrolled':'top'}.png`});
   if(baseline)continue;
   assert(box.x>=0&&box.x+box.width<=width,JSON.stringify(metrics));
   assert(box.y>=top-2&&box.y+box.height<=bottom+2,JSON.stringify(metrics));
   assert(Math.abs(box.y+box.height/2-(top+bottom)/2)<3,JSON.stringify(metrics));
   const footer=await panel.getByRole('button',{name:'Отмена',exact:true}).boundingBox();assert(footer.y>=top&&footer.y+footer.height<=bottom);
   const area=await body.boundingBox();await page.mouse.move(area.x+area.width/2,area.y+area.height/2);
   const scrollBefore=await page.evaluate(()=>scrollY);
   await page.mouse.wheel(0,1800);await page.waitForTimeout(150);await page.mouse.wheel(0,1800);await page.waitForTimeout(150);
   assert.equal(await page.evaluate(()=>scrollY),scrollBefore,'Scroll must stay inside modal');
   const scroll=await body.evaluate(e=>({top:e.scrollTop,max:e.scrollHeight-e.clientHeight}));assert(scroll.max>0&&scroll.top>=scroll.max-2,JSON.stringify(scroll));
   await page.screenshot({path:`${out}/modal-${width}-${scrolled?'scrolled':'top'}-bottom.png`});
   await page.mouse.wheel(0,-3600);await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>scrollY),scrollBefore);
  }
  await panel.getByRole('button',{name:'Отмена',exact:true}).click();
 }
 if(!baseline){
  await page.goto(base+'/legacy/index.html');await page.waitForFunction(()=>window.__modalApp?.state.registryReady);
  await page.getByRole('button',{name:'＋ Создать документ',exact:true}).click();
  await page.getByRole('button',{name:'Клиентские',exact:true}).click();await page.getByRole('button',{name:'Договор',exact:true}).click();await page.getByRole('button',{name:/Далее/}).click();
  for(const size of [{width:1366,height:768},{width:1024,height:600}]){await page.setViewportSize(size);await page.waitForTimeout(150);const b=await page.locator('[data-registry-upload-panel]').boundingBox();assert(b.y>=0&&b.y+b.height<=size.height);}
  checks.push('Standalone registry + resize: dialog and controls remain visible');await page.screenshot({path:out+'/standalone.png'});
 }
 assert.deepEqual(errors,[]);
 await fs.writeFile(out+'/browser.json',JSON.stringify({status:'passed',baseline,checks,errors,api:'synthetic fixtures; real browser layout'},null,2));
 console.log(JSON.stringify({status:'passed',baseline,checks}));
}catch(e){await page.screenshot({path:out+'/failure.png'});console.error(e);process.exitCode=1;}finally{await browser.close();}
