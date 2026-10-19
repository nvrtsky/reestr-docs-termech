/* File contents are loaded by the authenticated app, never by a public viewer. */
(() => {
  class AttachmentViewer {
    constructor() { this.dialog = null; }
    open({ name, load, download }) {
      this.close();
      const previousFocus=document.activeElement;
      const dialog=document.createElement('dialog'); dialog.className='registry-file-preview';
      dialog.setAttribute('aria-labelledby','registry-preview-title');
      dialog.innerHTML=`<header><div><h2 id="registry-preview-title"></h2><p>Предпросмотр документа</p></div><div class="preview-actions"><button type="button" data-download>Скачать оригинал</button><button type="button" data-close aria-label="Закрыть предпросмотр">✕</button></div></header><div class="preview-status" role="status"></div><div class="preview-content"></div><footer><span data-hint>Оригинал файла хранится в Bitrix24</span><button type="button" data-retry>Повторить</button></footer>`;
      this.dialog=dialog; this.previousFocus=previousFocus;
      const title=dialog.querySelector('h2'),status=dialog.querySelector('.preview-status'),content=dialog.querySelector('.preview-content');
      title.textContent=name||'Документ';
      dialog.querySelector('[data-close]').onclick=()=>this.close();
      dialog.addEventListener('cancel',event=>{event.preventDefault();this.close();});
      const downloadButton=dialog.querySelector('[data-download]');
      downloadButton.onclick=async()=>{
        downloadButton.disabled=true;
        try {await download();}catch(error){status.hidden=false;status.textContent=error.message||'Не удалось скачать файл.';}
        finally {downloadButton.disabled=false;}
      };
      const retry=dialog.querySelector('[data-retry]');
      const run=async()=>{
        this.cleanupPdf?.(); this.cleanupPdf=null;
        this.controller?.abort(); this.controller=new AbortController();
        const controller=this.controller;
        if(this.objectUrl)URL.revokeObjectURL(this.objectUrl);this.objectUrl=null;
        content.replaceChildren();status.hidden=false; status.textContent='Загружаем документ… Офисный файл может открываться до минуты.';
        retry.hidden=true;
        try {
          const result=await load(controller.signal);
          if(controller.signal.aborted||this.dialog!==dialog)return;
          title.textContent=result.name||name||'Документ';
          const mime=result.blob.type.split(';')[0];
          let element;
          if(mime==='text/plain') {element=document.createElement('pre');element.textContent=await result.blob.text();}
          else if(['image/png','image/jpeg','image/gif','image/webp','image/bmp'].includes(mime)) {
            element=document.createElement('img');element.alt=result.name||'Изображение документа';
            this.objectUrl=URL.createObjectURL(result.blob);element.src=this.objectUrl;
            element.onerror=()=>{status.hidden=false;status.textContent='Не удалось отобразить изображение. Скачайте оригинал.';retry.hidden=false;};
          } else if(mime==='application/pdf') {
            element=document.createElement('div');element.className='preview-pdf';content.replaceChildren(element);
            const {mountPdf}=await import('/legacy/attachment-pdf.js?v=20261019c');
            if(controller.signal.aborted||this.dialog!==dialog)return;
            this.cleanupPdf=await mountPdf(element,result.blob,controller.signal);
            if(controller.signal.aborted||this.dialog!==dialog){this.cleanupPdf?.();this.cleanupPdf=null;return;}
          } else throw new Error('Предпросмотр этого формата недоступен. Скачайте оригинал.');
          if(controller.signal.aborted||this.dialog!==dialog)return;
          content.replaceChildren(element);status.hidden=true;
          dialog.querySelector('[data-hint]').textContent=mime==='application/pdf'?'Колёсико прокручивает документ. Масштаб и страницы — на панели сверху.':'Оригинал файла хранится в Bitrix24';
        } catch(error) {
          if(controller.signal.aborted||this.dialog!==dialog)return;
          content.replaceChildren();status.hidden=false;status.textContent=error.message||'Не удалось открыть документ.';retry.hidden=false;
        }
      };
      retry.onclick=run;
      (document.querySelector('.registry-shell')||document.body).append(dialog);dialog.showModal();dialog.scrollIntoView({block:'nearest'});dialog.querySelector('[data-close]').focus();void run();
    }
    notify(message, url) {
      if(!this.dialog)return;
      const status=this.dialog.querySelector('.preview-status');status.hidden=false;status.textContent=message;
      if(url) {const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=' Скачать файл';status.append(link);}
    }
    close() {
      this.cleanupPdf?.(); this.cleanupPdf=null;
      this.controller?.abort(); this.controller=null;
      if(this.objectUrl)URL.revokeObjectURL(this.objectUrl);this.objectUrl=null;
      this.dialog?.close();this.dialog?.remove();this.dialog=null;
      if(this.previousFocus?.isConnected)this.previousFocus.focus();
    }
  }
  window.RegistryAttachmentViewer=AttachmentViewer;
})();
