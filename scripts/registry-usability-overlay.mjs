import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export function registryUsabilityOverlay(baseline) {
 assert.equal(createHash('sha256').update(baseline).digest('hex'),'c9d25c15bbb8fc63ab05cb79972e497b719fee158d1bfc5924c9f3e8420c1ce9');
 let html=baseline;
 const replace=(before,after)=>{assert.equal(html.split(before).length,2,before.slice(0,80));html=html.replace(before,after);};
 html=html.replaceAll('/legacy/attachment-preview.css?v=20261019','/legacy/attachment-preview.css?v=20261019c').replaceAll('/legacy/attachment-preview.js?v=20261019','/legacy/attachment-preview.js?v=20261019c');
 replace('</head>','<script src="/legacy/attachment-picker.js?v=20261019c"></script></head>');
 const actions=alias=>`<div class="registry-row-file-actions"><button type="button" onclick="{{ ${alias}.onOpenFiles }}" title="Открыть файл без карточки документа">Открыть</button><button type="button" onclick="{{ ${alias}.onDownloadFiles }}" title="Скачать файл без карточки документа">Скачать</button></div>`;
 const r="<div style=\"font-family: 'IBM Plex Mono'; font-size: 10px; color: #a1a1aa;\">{{ r.num }}</div>";
 assert.equal(html.split(r).length-1,2);html=html.replaceAll(r,r+actions('r'));
 const d="<div style=\"font-family: 'IBM Plex Mono'; font-size: 10px; color: #a1a1aa;\">{{ d.num }}</div>";
 assert.equal(html.split(d).length-1,2);html=html.replaceAll(d,d+actions('d'));
 replace("      onOpen: () => { void this.openDocument(d.id); },",`      onOpenFiles: event => { event?.preventDefault(); event?.stopPropagation(); this.openDocumentFiles(d.id,d.title,false); },
      onDownloadFiles: event => { event?.preventDefault(); event?.stopPropagation(); this.openDocumentFiles(d.id,d.title,true); },
      onOpen: () => { void this.openDocument(d.id); },`);
 replace('  async openAttachment(documentId, attachmentId, download = false, attachment = {}) {',`  openDocumentFiles(documentId,title,downloadOnly) {
    this.filePicker ||= new window.RegistryAttachmentPicker();
    this.filePicker.open({title,downloadOnly,
      load: async signal => {const detail=await this.api(\`/api/v1/registry/documents/\${documentId}\`,{signal});return detail.attachments || [];},
      onSelect: async (file,reserved) => {
        if(downloadOnly || file.kind==='link') return this.openAttachmentDirect(documentId,file.id,downloadOnly,reserved);
        this.filePicker.close();await this.openAttachment(documentId,file.id,false,file);return true;
      },
    });
  }

  async openAttachment(documentId, attachmentId, download = false, attachment = {}) {`);
 replace('  async openAttachmentDirect(documentId, attachmentId, download = false) {','  async openAttachmentDirect(documentId, attachmentId, download = false, reserved = null) {');
 replace('    if (this.attachmentOpening) return;', '    if (this.attachmentOpening) { reserved?.close(); return false; }');
 replace("    const opened = window.open('about:blank', '_blank');", "    const opened = reserved || window.open('about:blank', '_blank');");
 replace("        opened.location.replace(url.href);\n        this.setState({ attachmentStatus: '', attachmentReadyUrl: '' });", "        opened.location.replace(url.href);\n        this.setState({ attachmentStatus: '', attachmentReadyUrl: '' });\n        return true;");
 replace("        this.attachmentViewer?.notify('Браузер заблокировал новую вкладку.', url.href);", "        this.attachmentViewer?.notify('Браузер заблокировал новую вкладку.', url.href);\n        this.filePicker?.notify('Браузер заблокировал новую вкладку.', url.href);");
 replace("      this.attachmentViewer?.notify('Не удалось скачать файл. ' + (error.message || 'Повторите попытку.'));", "      this.attachmentViewer?.notify('Не удалось скачать файл. ' + (error.message || 'Повторите попытку.'));\n      this.filePicker?.notify(error.message || 'Не удалось получить файл. Повторите попытку.');");
 replace('    } finally { this.attachmentOpening = false; }','    } finally { this.attachmentOpening = false; }\n    return false;');
 replace('    this.attachmentViewer?.close();','    this.attachmentViewer?.close();\n    this.filePicker?.close();');
 return html;
}
