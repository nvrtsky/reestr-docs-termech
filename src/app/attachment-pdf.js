// PDF bytes and renderer assets stay on the Registry origin.
export async function mountPdf(root, blob, signal) {
  const pdfjs=await import('./vendor/pdfjs-6.4.299/pdf.min.mjs');
  if(signal.aborted)throw new DOMException('Aborted','AbortError');
  pdfjs.GlobalWorkerOptions.workerSrc='/legacy/vendor/pdfjs-6.4.299/pdf.worker.min.mjs';
  const task=pdfjs.getDocument({data:new Uint8Array(await blob.arrayBuffer()),isEvalSupported:false,enableXfa:false,
    cMapUrl:'/legacy/vendor/pdfjs-6.4.299/cmaps/',cMapPacked:true,standardFontDataUrl:'/legacy/vendor/pdfjs-6.4.299/standard_fonts/',wasmUrl:'/legacy/vendor/pdfjs-6.4.299/wasm/'});
  let stopped=false,renderTask,revision=0;
  const destroy=()=>{if(stopped)return;stopped=true;revision++;renderTask?.cancel();void task.destroy().catch(()=>{});signal.removeEventListener('abort',destroy);};
  signal.addEventListener('abort',destroy,{once:true});
  if(signal.aborted)destroy();
  try {
    const pdf=await task.promise;
    if(stopped)throw new DOMException('Aborted','AbortError');
    root.innerHTML='<div class="pdf-toolbar" aria-label="Управление документом"><button type="button" data-prev aria-label="Предыдущая страница">‹</button><span data-page></span><button type="button" data-next aria-label="Следующая страница">›</button><span class="pdf-toolbar-gap"></span><button type="button" data-minus aria-label="Уменьшить масштаб">−</button><output data-zoom aria-label="Масштаб"></output><button type="button" data-plus aria-label="Увеличить масштаб">+</button><button type="button" data-fit>По ширине</button><button type="button" data-actual>100%</button></div><div class="pdf-scroll" tabindex="0" aria-label="Страницы документа"><div class="pdf-paper"></div></div><div class="pdf-error" role="status" hidden></div>';
    const scroll=root.querySelector('.pdf-scroll'),paper=root.querySelector('.pdf-paper'),error=root.querySelector('.pdf-error');
    let number=1,zoom=null;
    const render=async(reset=false)=>{
      const current=++revision;renderTask?.cancel();error.hidden=true;
      try {
        const page=await pdf.getPage(number);
        if(stopped||current!==revision)return;
        const base=page.getViewport({scale:96/72});
        const fit=Math.max(.1,(scroll.clientWidth-32)/base.width);
        const scale=zoom===null?Math.min(1,fit):zoom==='fit'?fit:zoom;
        const viewport=page.getViewport({scale:96/72*scale});
        // Bound canvas allocation even for giant engineering sheets.
        const resolution=Math.min(devicePixelRatio||1,2,4096/Math.max(viewport.width,viewport.height));
        const canvas=document.createElement('canvas');canvas.setAttribute('role','img');canvas.setAttribute('aria-label',`Страница ${number} из ${pdf.numPages}`);
        canvas.width=Math.ceil(viewport.width*resolution);canvas.height=Math.ceil(viewport.height*resolution);
        canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
        paper.style.width=viewport.width+'px';paper.replaceChildren(canvas);
        root.querySelector('[data-page]').textContent=`${number} / ${pdf.numPages}`;
        root.querySelector('[data-zoom]').textContent=Math.round(scale*100)+'%';
        root.querySelector('[data-prev]').disabled=number<=1;root.querySelector('[data-next]').disabled=number>=pdf.numPages;
        root.querySelector('[data-minus]').disabled=scale<=.25;root.querySelector('[data-plus]').disabled=scale>=2;
        if(reset)scroll.scrollTo(0,0);
        renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[resolution,0,0,resolution,0,0]});
        await renderTask.promise;
        if(!stopped&&current===revision)canvas.dataset.ready='true';
      }catch(e){if(!stopped&&current===revision&&e.name!=='RenderingCancelledException'){error.hidden=false;error.textContent='Не удалось отобразить страницу. Попробуйте другую страницу или скачайте оригинал.';}}
    };
    root.querySelector('[data-prev]').onclick=()=>{if(number>1){number--;void render(true);}};
    root.querySelector('[data-next]').onclick=()=>{if(number<pdf.numPages){number++;void render(true);}};
    const changeZoom=delta=>{zoom=Math.max(.25,Math.min(2,(parseInt(root.querySelector('[data-zoom]').textContent,10)||100)/100+delta));void render();};
    root.querySelector('[data-minus]').onclick=()=>changeZoom(-.1);root.querySelector('[data-plus]').onclick=()=>changeZoom(.1);
    root.querySelector('[data-fit]').onclick=()=>{zoom='fit';void render();};root.querySelector('[data-actual]').onclick=()=>{zoom=1;void render();};
    await render(true);
    let width=scroll.clientWidth;
    const observer=new ResizeObserver(()=>{if(scroll.clientWidth!==width){width=scroll.clientWidth;void render();}});observer.observe(scroll);
    signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
    return ()=>{observer.disconnect();destroy();};
  }catch(e){destroy();throw e;}
}
