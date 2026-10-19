import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export function registryFeedbackOverlay(baseline) {
  assert.equal(createHash('sha256').update(baseline).digest('hex'), '14cd2f0c42a9362d562c843054015c1a96646bab2dfb7ece7dda8fb91e7429e4', 'Production baseline changed: review overlay anchors before building');
  let html = baseline;
  function replace(before, after) {
    const at = html.indexOf(before);
    assert.ok(at >= 0, `Missing feedback anchor: ${before.slice(0, 90)}`);
    assert.equal(html.indexOf(before, at + before.length), -1, `Ambiguous anchor: ${before.slice(0, 90)}`);
    html = html.slice(0,at) + after + html.slice(at + before.length);
  }
  const css = `
.registry-wizard { width:min(620px,calc(100% - 24px)) !important; }
.registry-wizard > :first-child,.registry-wizard > :last-child { flex-shrink:0; }
.registry-wizard-scroll { min-height:0; flex:1 1 auto !important; overflow-y:auto !important; overscroll-behavior:contain; touch-action:pan-y; scrollbar-gutter:stable; }
.registry-role-choices button { min-height:36px; border:1px solid #d4d4d8 !important; }
.registry-role-choices button[aria-pressed="true"] { background:#eef2ff !important; border-color:#818cf8 !important; color:#3730a3 !important; }
.registry-role-choices button:focus-visible { outline:2px solid #4f46e5; outline-offset:2px; }
`;
  replace('<style>\n.registry-shell', '<style>\n' + css + '.registry-shell');
  const start = html.indexOf('  <!-- ░░ CREATE WIZARD ░░ -->');
  const stop = html.indexOf('  <!--', start + 40);
  const wizard = html.slice(start,stop);
  replace(wizard, wizard.replace('<div style="position: relative; width: 620px;', '<div class="registry-wizard" role="dialog" aria-modal="true" aria-label="Добавление документа" style="position: relative; width: 620px;').replace('<div style="flex: 1; overflow-y: auto; padding: 20px 22px;">', '<div class="registry-wizard-scroll" tabindex="0" aria-label="Поля документа" style="flex: 1; overflow-y: auto; padding: 20px 22px;">'));

  replace("key, label, checked: roleEdit.hiddenFields.includes(key), mark: roleEdit.hiddenFields.includes(key) ? '✓' : '',", "key, label, checked: !roleEdit.hiddenFields.includes(key), mark: !roleEdit.hiddenFields.includes(key) ? '✓' : '—',");
  replace("roleHideMoneyLabel: roleEdit.hideMoney ? 'Да' : 'Нет',", "roleHideMoneyLabel: roleEdit.hideMoney ? 'Нет' : 'Да',");
  replace('Скрывать суммы: {{ roleHideMoneyLabel }}', 'Показывать суммы: {{ roleHideMoneyLabel }}');
  replace('>Скрытые поля</div>', '>2. Видимые поля</div>');
  replace('Отмеченные поля будут скрыты от пользователей этой роли.', 'Отмеченное поле видно пользователям роли. Снимите отметку, чтобы скрыть поле. Настройка «Показывать суммы» и права на финансы могут дополнительно ограничивать денежные поля.');
  replace('>Доступные разделы</div>', '>1. Доступные разделы</div><p style="font-size:12px;color:#52525b;">✓ — доступно или показывается. — — недоступно или скрыто. Сначала выберите разделы, затем поля и разрешённые действия.</p>');
  replace('Снимите отметки с этих полей в блоке «Скрытые поля»', 'Отметьте эти поля в блоке «Видимые поля»');
  for (const name of ['roleSectionOptions','roleFieldOptions','rolePermissionOptions']) {
    const begin = html.indexOf('<sc-for list="{{ ' + name + ' }}"');
    const end = html.indexOf('</sc-for>',begin) + '</sc-for>'.length;
    const block = html.slice(begin,end);
    replace(block, '<div class="registry-role-choices" style="display:contents">' + block.replace('type="button" onclick="{{ o.onToggle }}"','type="button" aria-pressed="{{ o.checked }}" onclick="{{ o.onToggle }}"') + '</div>');
  }
  const methodStart = html.indexOf('  async openAttachment(documentId, attachmentId) {');
  const methodEnd = html.indexOf('\n  async deleteAttachment(',methodStart);
  replace(html.slice(methodStart,methodEnd), `  async openAttachment(documentId, attachmentId, download = false) {
    if (this.attachmentOpening) return;
    this.attachmentOpening = true;
    const opened = window.open('about:blank', '_blank');
    if (opened) opened.opener = null;
    this.setState({ attachmentStatus: 'Получаем доступ к файлу…', attachmentReadyUrl: '' });
    try {
      const access = await this.api(\`/api/v1/registry/documents/\${documentId}/attachments/\${attachmentId}/access\`);
      const url = new URL(download ? access.downloadUrl || access.url : access.url);
      if (url.protocol !== 'https:' && !(access.kind === 'link' && url.protocol === 'http:')) throw new Error('Сервис вернул некорректную ссылку на файл.');
      if (opened && !opened.closed) {
        opened.location.replace(url.href);
        this.setState({ attachmentStatus: '', attachmentReadyUrl: '' });
      } else {
        this.setState({ attachmentStatus: 'Браузер заблокировал новую вкладку. Нажмите «Перейти к файлу».', attachmentReadyUrl: url.href });
      }
    } catch (error) {
      if (opened && !opened.closed) opened.close();
      this.setState({ attachmentStatus: 'Не удалось открыть файл. ' + (error instanceof Error ? error.message : 'Повторите попытку или проверьте доступ к файлу на Диске Bitrix24.'), attachmentReadyUrl: '' });
    } finally { this.attachmentOpening = false; }
  }
`);
  // Both current attachments and file history share the same checked access API.
  const original = 'onOpen: () => { void this.openAttachment(dd.id, attachment.id); },';
  const replacement = original + "\n            canDownload: attachment.kind === 'file',\n            onDownload: () => { void this.openAttachment(dd.id, attachment.id, true); },";
  assert.equal(html.split(original).length - 1, 2, 'Expected current and history attachment callbacks');
  html = html.replaceAll(original,replacement);
  const openButton = '<button type="button" onclick="{{ a.onOpen }}" title="Открыть" style="background: none; border: none; color: #71717a; font-size: 14px; line-height: 1; padding: 4px; cursor: pointer;">↗</button>';
  replace(openButton, '<button type="button" onclick="{{ a.onOpen }}" style="border:1px solid #d4d4d8;border-radius:6px;background:#fff;padding:6px 8px;cursor:pointer;">Открыть</button><sc-if value="{{ a.canDownload }}"><button type="button" onclick="{{ a.onDownload }}" style="border:1px solid #d4d4d8;border-radius:6px;background:#fff;padding:6px 8px;cursor:pointer;">Скачать</button></sc-if>');
  const shellEnd = html.indexOf('\n', html.indexOf('<div class="registry-shell"'));
  const feedback = '\n<sc-if value="{{ attachmentStatusVisible }}"><div role="status" style="position:fixed;z-index:200;top:12px;left:12px;right:12px;padding:12px;background:#fff7ed;border:1px solid #fdba74;border-radius:8px;color:#7c2d12;">{{ attachmentStatus }} <sc-if value="{{ attachmentReady }}"><a href="{{ attachmentReadyUrl }}" target="_blank" rel="noopener noreferrer">Перейти к файлу</a></sc-if><button type="button" onclick="{{ dismissAttachmentStatus }}" aria-label="Закрыть сообщение" style="float:right;">✕</button></div></sc-if>';
  html = html.slice(0,shellEnd) + feedback + html.slice(shellEnd);
  replace('      roleFieldOptions,', "      attachmentStatus: S.attachmentStatus || '',\n      attachmentStatusVisible: !!S.attachmentStatus,\n      attachmentReady: !!S.attachmentReadyUrl,\n      attachmentReadyUrl: S.attachmentReadyUrl || '',\n      dismissAttachmentStatus: () => this.setState({attachmentStatus:'',attachmentReadyUrl:''}),\n      roleFieldOptions,");
  return html;
}
