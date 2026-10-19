import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export function registryPreviewOverlay(baseline) {
 assert.equal(createHash('sha256').update(baseline).digest('hex'),'e24953d5e6d7615e65b0ea6fb23b770c1418b4c351150f66234a9dad1a291e62','Previous release changed; review preview anchors');
 let html=baseline;
 const replace=(before,after)=>{assert.equal(html.split(before).length,2,`Expected unique anchor ${before.slice(0,70)}`);html=html.replace(before,after);};
 replace('</head>','<link rel="stylesheet" href="/legacy/attachment-preview.css?v=20261019"><script src="/legacy/attachment-preview.js?v=20261019"></script></head>');
 replace('  async openAttachment(documentId, attachmentId, download = false) {',`  async openAttachment(documentId, attachmentId, download = false, attachment = {}) {
    if (download || attachment.kind === 'link') return this.openAttachmentDirect(documentId, attachmentId, download);
    if (!this.attachmentViewer) this.attachmentViewer = new window.RegistryAttachmentViewer();
    this.attachmentViewer.open({
      name: attachment.name || 'Документ',
      download: () => this.openAttachmentDirect(documentId, attachmentId, true),
      load: async signal => {
        const path = \`/api/v1/registry/documents/\${documentId}/attachments/\${attachmentId}\`;
        const access = await this.api(path + '/access', { signal });
        if (access.kind !== 'file') throw new Error('Это внешняя ссылка. Откройте её из карточки документа.');
        const blob = await this.attachmentPreviewBlob(path + '/preview', signal);
        return { blob, name: access.name || attachment.name };
      },
    });
  }

  async attachmentPreviewBlob(path, signal, canRetry = true) {
    const auth = this.bitrixContext && this.bitrixContext.auth;
    const { response, payload } = await this.registryNetworkRequest(path, { signal, headers: auth ? {
      authorization: \`Bearer \${auth.accessToken}\`, 'x-bitrix-domain': auth.domain, 'x-bitrix-member-id': auth.memberId,
    } : { 'x-registry-development-role': this.state.role || '' } }, 'blob');
    if (response.status === 401 && canRetry && !signal.aborted) {
      const context = await this.requestBitrixContext(true);
      if (context && context.auth) return this.attachmentPreviewBlob(path, signal, false);
    }
    if (!response.ok) throw new Error(payload?.error?.message || 'Не удалось загрузить документ. Повторите попытку.');
    return payload;
  }

  async openAttachmentDirect(documentId, attachmentId, download = false) {`);
 replace("        this.setState({ attachmentStatus: 'Браузер заблокировал новую вкладку. Нажмите «Перейти к файлу».', attachmentReadyUrl: url.href });", "        this.attachmentViewer?.notify('Браузер заблокировал новую вкладку.', url.href);\n        this.setState({ attachmentStatus: 'Браузер заблокировал новую вкладку. Нажмите «Перейти к файлу».', attachmentReadyUrl: url.href });");
 replace("      if (opened && !opened.closed) opened.close();", "      if (opened && !opened.closed) opened.close();\n      this.attachmentViewer?.notify('Не удалось скачать файл. ' + (error.message || 'Повторите попытку.'));");
 const old='void this.openAttachment(dd.id, attachment.id);';
 assert.equal(html.split(old).length-1,2);html=html.replaceAll(old,'void this.openAttachment(dd.id, attachment.id, false, attachment);');
 replace('  componentWillUnmount() {','  componentWillUnmount() {\n    this.attachmentViewer?.close();');
 return html;
}
