(() => {
 class AttachmentPicker {
  open({title,downloadOnly,load,onSelect}) {
   this.close();this.focus=document.activeElement;const dialog=document.createElement('dialog');this.dialog=dialog;
   dialog.className='registry-file-picker';dialog.setAttribute('aria-label','Файлы документа');
   dialog.innerHTML='<header><h2></h2><button type="button" aria-label="Закрыть список файлов">✕</button></header><div role="status">Загружаем файлы…</div><div class="picker-files"></div>';
   dialog.querySelector('h2').textContent=title||'Файлы документа';dialog.querySelector('header button').onclick=()=>this.close();
   dialog.addEventListener('cancel',e=>{e.preventDefault();this.close();});
   const controller=new AbortController();this.controller=controller;
   (document.querySelector('.registry-shell')||document.body).append(dialog);dialog.showModal();dialog.scrollIntoView({block:'nearest'});
   // Preserve the user's gesture for a single-file download after metadata loads.
   let reserved=downloadOnly?window.open('about:blank','_blank'):null;if(reserved)reserved.opener=null;this.reserved=reserved;
   const select=async(file,windowRef=null)=>{
    try {const result=await onSelect(file,windowRef);if(result!==false&&this.dialog===dialog)this.close();}
    catch(e){windowRef?.close();this.notify(e.message||'Не удалось открыть файл.');}
   };
   load(controller.signal).then(files=>{
    if(controller.signal.aborted||this.dialog!==dialog){reserved?.close();return;}
    files=files.filter(f=>f.isCurrent!==false&&(!downloadOnly||f.kind==='file'));
    if(files.length===1){this.reserved=null;void select(files[0],reserved);return;}
    reserved?.close();this.reserved=null;
    this.notify(files.length?'Выберите файл:':downloadOnly?'Нет текущих файлов для скачивания.':'У документа пока нет файлов или ссылок.');
    for(const file of files){const button=document.createElement('button');button.type='button';button.className='picker-file';button.textContent=(downloadOnly?'Скачать: ':'Открыть: ')+(file.name||'Документ');button.onclick=()=>void select(file);dialog.querySelector('.picker-files').append(button);}
   }).catch(e=>{reserved?.close();this.reserved=null;if(!controller.signal.aborted)this.notify(e.message||'Не удалось получить файлы. Повторите попытку.');});
  }
  notify(message,url){if(!this.dialog)return;const s=this.dialog.querySelector('[role=status]');s.textContent=message;if(url){const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=' Скачать файл';s.append(a);}}
  close(){this.controller?.abort();this.reserved?.close();this.reserved=null;this.dialog?.close();this.dialog?.remove();this.dialog=null;if(this.focus?.isConnected)this.focus.focus();}
 }
 window.RegistryAttachmentPicker=AttachmentPicker;
})();
