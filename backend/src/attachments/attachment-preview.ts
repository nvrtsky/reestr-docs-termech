import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApiError } from '../http/api-error.js';

export const PREVIEW_LIMIT = 25 * 1024 * 1024;
const office = new Set(['.doc','.docx','.odt','.rtf','.xls','.xlsx','.ods','.ppt','.pptx','.odp']);
const text = new Set(['.txt','.csv','.log','.md']);
const images = new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp']);
export function previewKind(name: string) {
  const ext = extname(name).toLowerCase();
  return ext === '.pdf' ? 'pdf' : images.has(ext) ? 'image' : text.has(ext) ? 'text' : office.has(ext) ? 'office' : null;
}
export function assertFileUrl(value: string, domain: string, redirect = false) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const cdn = redirect && ['.bitrix24.ru','.bitrix24.com','.bitrix24.net','.bitrix.info','.1c-bitrix-cdn.ru'].some(suffix => host.endsWith(suffix));
  if (url.protocol !== 'https:' || (host !== domain && !cdn) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new ApiError(502, 'preview_url_invalid', 'Не удалось получить безопасную ссылку на файл. Скачайте оригинал.');
  }
  return url;
}
export async function readDiskFile(value: string, domain: string, signal: AbortSignal, fetcher = fetch) {
  let url = assertFileUrl(value, domain);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(url, {redirect:'manual', signal});
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) break;
      url = assertFileUrl(new URL(location, url).href, domain, true); continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ApiError(response.status === 403 ? 403 : 502, 'preview_download_failed', 'Bitrix24 не предоставил содержимое файла. Проверьте доступ или повторите попытку.');
    }
    const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(type==='text/html'||type==='application/json') {
      await response.body.cancel();
      throw new ApiError(502,'preview_download_failed','Вместо файла Bitrix24 вернул страницу ошибки. Повторите попытку или скачайте оригинал.');
    }
    if (Number(response.headers.get('content-length')) > PREVIEW_LIMIT) {
      await response.body.cancel(); throw tooLarge();
    }
    const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
    try {
      while(true) {
        const chunk=await reader.read(); if(chunk.done)break;
        size+=chunk.value.length;
        if(size>PREVIEW_LIMIT)throw tooLarge();
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(()=>{}); }
    return Buffer.concat(chunks, size);
  }
  throw new ApiError(502, 'preview_redirect_failed', 'Не удалось загрузить файл из Bitrix24. Скачайте оригинал.');
}
export function tooLarge() { return new ApiError(413,'preview_too_large','Предпросмотр доступен для файлов до 25 МБ. Скачайте оригинал.'); }

let conversions=0;
export async function convertOffice(data: Buffer, extension: string, signal: AbortSignal) {
  if(!office.has(extension))throw new ApiError(415,'preview_unsupported','Формат не поддерживается.');
  if(conversions)throw new ApiError(503,'preview_busy','Сейчас готовится другой документ. Повторите попытку через несколько секунд.');
  conversions++;
  let directory:string|undefined;
  try {
    directory=await mkdtemp(join(tmpdir(),'registry-preview-'));
    const profile=join(directory,'profile'); await mkdir(join(profile,'user'),{recursive:true});
    await writeFile(join(profile,'user','registrymodifications.xcu'),`<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item><item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetProxyType" oor:op="fuse"><value>1</value></prop><prop oor:name="ooInetHTTPProxyName" oor:op="fuse"><value>127.0.0.1</value></prop><prop oor:name="ooInetHTTPProxyPort" oor:op="fuse"><value>9</value></prop><prop oor:name="ooInetHTTPSProxyName" oor:op="fuse"><value>127.0.0.1</value></prop><prop oor:name="ooInetHTTPSProxyPort" oor:op="fuse"><value>9</value></prop></item></oor:items>`);
    const input=join(directory,'document'+extension); await writeFile(input,data,{mode:0o600});
    await new Promise<void>((resolve,reject)=>{
      const child=spawn('libreoffice',[`-env:UserInstallation=${pathToFileURL(profile).href}`,'--headless','--nologo','--nodefault','--norestore','--convert-to','pdf','--outdir',directory!,input],{
        detached:true, stdio:'ignore',
        // The converter must not inherit CRM tokens or database credentials.
        env:{PATH:process.env.PATH,HOME:directory!,TMPDIR:directory!,LANG:'C.UTF-8',SAL_USE_VCLPLUGIN:'svp'},
      });
      let timedOut=false;
      const stop=()=>{try {if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}};
      const timer=setTimeout(()=>{timedOut=true;stop();},35000);
      const abort=()=>stop(); signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)stop();
      child.once('error',()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new Error('converter unavailable'));});
      child.once('exit',code=>{
        clearTimeout(timer);signal.removeEventListener('abort',abort);
        code===0&&!signal.aborted&&!timedOut ? resolve() : reject(new Error('conversion failed'));
      });
    });
    const output=join(directory,'document.pdf');
    if((await stat(output)).size>PREVIEW_LIMIT)throw tooLarge();
    const pdf=await readFile(output);
    if(!pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('invalid PDF');
    return pdf;
  } catch(error) {
    if(error instanceof ApiError)throw error;
    throw new ApiError(422,'preview_conversion_failed','Не удалось подготовить предпросмотр. Возможно, файл повреждён или защищён паролем. Скачайте оригинал.');
  } finally {
    if(directory)await rm(directory,{recursive:true,force:true}).catch(()=>{});
    conversions--;
  }
}
export async function preparePreview(name:string, data:Buffer, signal:AbortSignal, converter=convertOffice) {
  const kind=previewKind(name);
  if(kind==='office') {
    const extension=extname(name).toLowerCase();
    const zip=data.subarray(0,4).equals(Buffer.from([80,75,3,4]));
    const ole=data.subarray(0,8).equals(Buffer.from([208,207,17,224,161,177,26,225]));
    const rtf=data.subarray(0,5).toString()==='{\\rtf';
    const valid=['.docx','.xlsx','.pptx','.odt','.ods','.odp'].includes(extension)?zip:extension==='.rtf'?rtf:ole||(extension==='.doc'&&rtf);
    if(!valid)throw new ApiError(422,'preview_invalid_file','Содержимое не соответствует формату документа. Возможно, файл повреждён. Скачайте оригинал.');
    return {data:await converter(data,extension,signal),mime:'application/pdf'};
  }
  if(kind==='pdf'&&data.subarray(0,5).equals(Buffer.from('%PDF-')))return {data,mime:'application/pdf'};
  if(kind==='image') {
    const head=data.subarray(0,12);
    const mime=head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':head[0]===255&&head[1]===216&&head[2]===255?'image/jpeg':/^GIF8[79]a/.test(head.toString())?'image/gif':head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP'?'image/webp':head.toString('ascii',0,2)==='BM'?'image/bmp':null;
    if(mime)return {data,mime};
  }
  if(kind==='text') {
    if(data.length>2*1024*1024)throw new ApiError(413,'preview_text_too_large','Для просмотра текстового файла больше 2 МБ скачайте оригинал.');
    const utf16=data[0]===255&&data[1]===254?'utf-16le':data[0]===254&&data[1]===255?'utf-16be':null;
    let value=new TextDecoder(utf16||'utf-8').decode(data);
    if(!utf16&&value.includes('\uFFFD'))value=new TextDecoder('windows-1251').decode(data);
    return {data:Buffer.from(value),mime:'text/plain; charset=utf-8'};
  }
  throw new ApiError(415,'preview_unsupported','Предпросмотр этого формата недоступен. Скачайте оригинал и откройте его на компьютере.');
}
