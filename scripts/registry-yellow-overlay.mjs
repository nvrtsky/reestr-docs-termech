import assert from 'node:assert/strict';
export function registryYellowOverlay(source) {
 let html=source;
 const replace=(a,b)=>{assert.equal(html.split(a).length-1,1,`Yellow overlay anchor: ${a.slice(0,100)}`);html=html.replace(a,b);};
 const inputStyle='padding:8px;border:1px solid #d4d4d8;border-radius:7px;font-size:12px;min-width:0;';
 // Settings filter and concise help, including the built-in document date.
 replace('const adminTypeRows = (S.adminTypes || []).map(type => {',`const adminTypeRows = (S.adminTypes || []).filter(type => !S.yellowTypeSection || this.typeSectionCodes(type).includes(S.yellowTypeSection)).map(type => {`);
 replace('<sc-if value="{{ admTypes }}" hint-placeholder-val="{{ false }}">',`<sc-if value="{{ admTypes }}" hint-placeholder-val="{{ false }}"><label style="display:block;margin-bottom:12px;">Раздел типов <select aria-label="Раздел типов" value="{{ yellowTypeSection }}" onchange="{{ yellowSetTypeSection }}" style="${inputStyle}"><option value="">Все разделы</option><sc-for list="{{ yellowSections }}" as="s"><option value="{{ s.code }}">{{ s.label }}</option></sc-for></select></label>`);
 replace('Эти поля появятся в мастере создания документа этого типа и в карточке документа.', 'Дата документа, номер, компания и сумма — встроенные реквизиты, их не нужно добавлять повторно. Дополнительные поля: «Текст» — название или заметка; «Число» — количество; «Дата» — календарная дата; «Сумма» — деньги с копейками; «Список» — выбор из заданных вариантов; «Да/Нет» — отметка; «Файл» — отдельное вложение.');
 // Search filters the view only; selected deals remain in state.
 replace('companyDealPickerTarget: target,','companyDealPickerTarget: target,\n      yellowDealSearch: "",');
 replace('const companyDealPickerItems = (S.companyDealPickerItems || []).map(item => {',`const companyDealPickerItems = (S.companyDealPickerItems || []).filter(item => [item.entityId,item.entityTitle,item.stageName].join(' ').toLocaleLowerCase('ru').includes(String(S.yellowDealSearch || '').trim().toLocaleLowerCase('ru'))).map(item => {`);
 replace('<div style="min-height:160px;max-height:440px;overflow:auto;padding:10px 18px;">',`<label style="padding:10px 18px;">Поиск сделки<input aria-label="Поиск сделки" value="{{ yellowDealSearch }}" oninput="{{ yellowSetDealSearch }}" placeholder="Номер, название или стадия" style="${inputStyle}display:block;width:100%;margin-top:4px;"></label><div style="min-height:160px;max-height:440px;overflow:auto;padding:10px 18px;">`);
 // Format on blur, never while typing or using IME. Normalization already strips whitespace.
 replace('value="{{ wzAmount }}" oninput="{{ wzSetAmount }}"','value="{{ wzAmount }}" oninput="{{ wzSetAmount }}" onblur="{{ yellowBlurAmount }}" inputmode="decimal"');
 replace('value="{{ drawerEditAmount }}" oninput="{{ setDrawerEditAmount }}"','value="{{ drawerEditAmount }}" oninput="{{ setDrawerEditAmount }}" onblur="{{ yellowBlurEditAmount }}"');
 replace('value="{{ r.amount }}" oninput="{{ r.onAmount }}"','value="{{ r.amount }}" oninput="{{ r.onAmount }}" onblur="{{ r.onAmountBlur }}"');
 replace('onDate: event => this.updateBulkUploadRow(row.id, { documentDate: event.target.value, status: \'ready\' }),',`onAmountBlur: event => this.updateBulkUploadRow(row.id, { amount: this.yellowMoney(event.target.value), status: 'ready' }),\n        onDate: event => this.updateBulkUploadRow(row.id, { documentDate: event.target.value, status: 'ready' }),`);
 // Parent selection reuses the permission-filtered relation picker; backend saves atomically.
 replace('if (!this.state.drawerId) return;\n    const current = this.docs.find',"if (!this.state.drawerId && mode !== 'wizard') return;\n    const current = this.docs.find");
 replace('if (!current || !current.counterpartyId) {',"const companyId = this.state.relationEditorMode === 'wizard' ? this.state.wz.counterpartyId : current?.counterpartyId;\n      if (!companyId) {");
 replace("params.set('counterpartyId', String(current.counterpartyId));","params.set('counterpartyId', String(companyId));");
 replace('async saveRelation() {',`async saveRelation() {
    if (this.state.relationEditorMode === 'wizard') {
      const id=this.state.relationEditorSelectedId;
      const candidate=this.state.relationEditorCandidates.find(item=>item.id===id);
      if(!candidate)return;
      this.setState({wz:{...this.state.wz,parentDocumentId:id,parentDocumentLabel:candidate.title+' · '+candidate.num,relationType:this.state.relationEditorType}});
      this.closeRelationEditor();return;
    }`);
 replace('supersedesId: wz.supersedesId || undefined,','supersedesId: wz.supersedesId || undefined,\n      parentDocumentId: wz.parentDocumentId || undefined,\n      relationType: wz.parentDocumentId ? wz.relationType : undefined,');
 replace('<label style="display: block;"><span style="font-size: 11px; color: #a1a1aa;">Этап сделки из контекста</span>',`<div style="grid-column:1/-1;border:1px solid #ddd6fe;border-radius:8px;padding:10px;"><b style="font-size:12px;">Связанные документы</b><div style="font-size:11px;margin:5px 0;">{{ yellowParentLabel }}</div><button type="button" onclick="{{ yellowPickParent }}" style="${inputStyle}background:#fff;cursor:pointer;">Выбрать основной документ</button> <button type="button" onclick="{{ yellowClearParent }}" style="${inputStyle}background:#fff;cursor:pointer;">Убрать связь</button></div><label style="display: block;"><span style="font-size: 11px; color: #a1a1aa;">Этап сделки из контекста</span>`);
 // Clear a parent from another company even when company is selected through native B24 picker.
 replace('const normalizedAmount = String(wz.amount ?? \'\').replace(/\\s/g, \'\').replace(\',\', \'.\');',`const normalizedAmount = String(wz.amount ?? '').replace(/\\s/g, '').replace(',', '.');`);
 replace('relationEditorOpen: !!doc && S.relationEditorOpen,', "relationEditorOpen: (!!doc || S.relationEditorMode === 'wizard') && S.relationEditorOpen,");
 replace("relationEditorTitle: S.relationEditorMode === 'parent'", "relationEditorTitle: S.relationEditorMode !== 'child'");
 replace("relationEditorHint: S.relationEditorMode === 'parent'", "relationEditorHint: S.relationEditorMode !== 'child'");
 // Company filters combine and apply to both presentations.
 replace('matchesMatrixFilter(document) {',`matchesMatrixFilter(document) {
    if (this.state.screen === 'company') {
      if(this.state.yellowCompanySection && document.section!==this.state.yellowCompanySection)return false;
      if(this.state.yellowCompanyType && document.typeCode!==this.state.yellowCompanyType)return false;
      if(this.state.yellowCompanyCounterparty && String(document.counterpartyId)!==this.state.yellowCompanyCounterparty)return false;
      const q=String(this.state.yellowCompanySearch||'').trim().toLocaleLowerCase('ru');
      if(q && ![document.title,document.num,document.counterparty].join(' ').toLocaleLowerCase('ru').includes(q))return false;
    }`);
 const companyAnchor='<sc-if value="{{ companyHasDropSections }}" hint-placeholder-val="true">';
 replace(companyAnchor,`<div class="yellow-company-filters"><label>Раздел<select aria-label="Раздел документов компании" value="{{ yellowCompanySection }}" onchange="{{ yellowSetCompanySection }}"><option value="">Все разделы</option><sc-for list="{{ yellowSections }}" as="s"><option value="{{ s.code }}">{{ s.label }}</option></sc-for></select></label><label>Тип<select aria-label="Тип документов компании" value="{{ yellowCompanyType }}" onchange="{{ yellowSetCompanyType }}"><option value="">Все типы</option><sc-for list="{{ yellowTypes }}" as="t"><option value="{{ t.code }}">{{ t.label }}</option></sc-for></select></label><label>Контрагент документа<select aria-label="Контрагент документов компании" value="{{ yellowCompanyCounterparty }}" onchange="{{ yellowSetCompanyCounterparty }}"><option value="">Все контрагенты</option><sc-for list="{{ yellowCounterparties }}" as="c"><option value="{{ c.id }}">{{ c.label }}</option></sc-for></select></label><label>Поиск<input aria-label="Поиск документов компании" value="{{ yellowCompanySearch }}" oninput="{{ yellowSetCompanySearch }}" placeholder="Номер или название"></label><button type="button" onclick="{{ yellowResetCompany }}">Сбросить</button></div><p style="font-size:11px;color:#71717a;">Показаны документы компании и её сделок, в том числе документы поставщиков. Контрагента и связи можно проверить в карточке документа.</p>${companyAnchor}`);
 replace('typeCode,\n        type: meta ?',`typeCode,\n        open: !S.collapsedGroups['company_type_'+typeCode],\n        caret: S.collapsedGroups['company_type_'+typeCode] ? '▸' : '▾',\n        onToggle:()=>this.toggleGroup('company_type_'+typeCode),\n        onKey:e=>{if(e.target===e.currentTarget && ['Enter',' '].includes(e.key)){e.preventDefault();this.toggleGroup('company_type_'+typeCode);}},\n        type: meta ?`);
 replace("label: section ? section.label : code,\n          c:","label: section ? section.label : code,\n          onPick:e=>{e?.stopPropagation();this.setState({yellowCompanySection:code,matrixFilter:null});},\n          c:");
 const groupStart=html.indexOf('<sc-for list="{{ companyDocsByType }}"');
 const groupEnd=html.indexOf('<!--',groupStart);
 let block=html.slice(groupStart,groupEnd);
 block=block.replace('<div style="padding:8px 14px;', '<div role="button" tabindex="0" onkeydown="{{ grp.onKey }}" onclick="{{ grp.onToggle }}" style="cursor:pointer;padding:8px 14px;');
 block=block.replace('{{ grp.type }}</span>','{{ grp.caret }} {{ grp.type }}</span>');
 block=block.replace('<span title="{{ sec.label }}"', '<button type="button" onclick="{{ sec.onPick }}" title="{{ sec.label }}"');
 block=block.replace('{{ sec.label }}</span></sc-for>','{{ sec.label }}</button></sc-for>');
 block=block.replace('<sc-for list="{{ grp.docs }}"','<sc-if value="{{ grp.open }}"><sc-for list="{{ grp.docs }}"');
 block=block.replace('              </sc-for>\n            </div>','              </sc-for></sc-if>\n            </div>');
 html=html.slice(0,groupStart)+block+html.slice(groupEnd);

 const cs=html.indexOf('<!-- ── EMBEDDED COMPANY TAB SCREEN ── -->');
 const ce=html.indexOf('<!-- ── ADMIN SCREEN ── -->',cs);
 let company=html.slice(cs,ce);
 company=company.replace('<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">','<div class="yellow-company-toolbar" style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">');
 company=company.replace('<sc-if value="{{ companyIsDocs }}" hint-placeholder-val="{{ false }}">','<sc-if value="{{ companyIsDocs }}" hint-placeholder-val="{{ false }}"><div class="yellow-company-table-scroll"><div style="min-width:900px;">');
 company=company.replace('        </div>\n        </sc-if>\n        </sc-if>','        </div></div></div>\n        </sc-if>\n        </sc-if>');
 html=html.slice(0,cs)+company+html.slice(ce);
 // Card timestamps do not replace the business date.
 replace("documentDateRaw: item.documentDate || '',", "documentDateRaw: item.documentDate || '',\n      yellowCreatedAt: item.createdAt || previous.yellowCreatedAt || null,");
 replace('<div data-requisite="date"', '<div style="background:#fff;padding:9px 12px;"><div style="font-size:10.5px;color:#71717a;">Создано в реестре</div><div style="font-size:12px;margin-top:2px;">{{ yellowCreatedLabel }}</div><div style="font-size:10px;color:#71717a;margin-top:4px;">Время загрузки и замены файлов — в истории ниже.</div></div><div data-requisite="date"');
 replace('>Колонки</button>', '>Колонки</button><span title="Каждый сотрудник настраивает список для себя. Сохраните представление кнопкой + рядом с вкладками." style="font-size:11px;color:#71717a;margin-left:6px;">Для себя ⓘ</span>');

 replace('createdBy: attachment.createdBy ? Number(attachment.createdBy) : null,', "createdBy: attachment.createdBy ? Number(attachment.createdBy) : null,\n          uploadedAtLabel: attachment.createdAt ? this.formatHistoryDate(attachment.createdAt) : 'См. историю',");
 replace('<span>{{ a.meta }}</span>', '<span>{{ a.meta }}</span><span>Загружено: {{ a.uploadedAtLabel }}</span>');
 replace('<div id="document-storage-copies"', '<p style="font-size:11px;color:#52525b;line-height:1.5;">Файлы хранятся на Диске Bitrix24: компания → сделка → раздел. Оригинал находится в ветке «Без сделки», для связанных сделок создаются копии. HTTPS-ссылки остаются ссылками.</p><div id="document-storage-copies"');
 replace('async createDocumentFromWizard(wz) {', `async createDocumentFromWizard(wz) {
    if(this.yellowCreating)return;
    this.yellowCreating=true;this.setState({yellowCreateBusy:true});
    try {
      const type=this.typeMeta(wz.sectionCode,wz.typeLabel);
      if(type && wz.number && wz.counterpartyId && !wz.supersedesId) {
        const params=new URLSearchParams({type:type.code,counterpartyId:String(wz.counterpartyId),search:wz.number.trim(),limit:'100'});
        const result=await this.api('/api/v1/registry/documents?'+params);
        const matches=(result.items||[]).filter(d=>String(d.number||'').normalize('NFKC').trim().toLocaleUpperCase('ru')===wz.number.normalize('NFKC').trim().toLocaleUpperCase('ru'));
        if(matches.length && !window.confirm('В реестре уже есть документ этого типа и компании с номером «'+wz.number+'». Проверьте существующую карточку, чтобы не создать дубль. Всё равно создать ещё один?'))return;
      }
      await this.yellowCreateDocument(wz);
    } catch(error){this.setState({wizardError:error.message||'Не удалось проверить документы. Повторите попытку.'});}
    finally{this.yellowCreating=false;this.setState({yellowCreateBusy:false});}
  }
  async yellowCreateDocument(wz) {`);
 replace("wzPrimaryLabel: wz.step < 3 ?", "wzPrimaryLabel: S.yellowCreateBusy ? 'Создание…' : wz.step < 3 ?");
 replace('      wzPrimary: () => {','      wzPrimary: () => {\n        if(this.yellowCreating)return;');
 replace('`Синхронизация завершена: создано ${summary.created},', '`Синхронизация завершена: файлов ${summary.copiedFiles || 0}${summary.pendingFiles ? "; ожидают формирования PDF/DOCX: " + summary.pendingFiles : ""}, создано ${summary.created},');

 replace('await this.loadDealFinancialSummary(this.state.dealTotalCurrency);', `await this.loadDealFinancialSummary(this.state.dealTotalCurrency);
        try {const status=await this.api('/api/v1/registry/documents/deal/'+this.placementEntity.entityId+'/sync-status');this.setState({yellowSyncStatus:status.status});}catch{this.setState({yellowSyncStatus:'error'});}`);
 replace('<sc-if value="{{ dealSyncDenied }}"', '<div role="status" style="margin:8px 0;font-size:11px;color:#52525b;">{{ yellowSyncLabel }}</div><sc-if value="{{ dealSyncDenied }}"');

 replace("accessLabel = 'Нет доступа к карточке и файлам';\n          detail = 'Все связанные сделки закрыты: действует специальное ограничение менеджера продаж.';", "accessLabel = policy.permissions?.closedDealAccess === 'hidden' ? 'Нет доступа к карточке и файлам' : policy.permissions?.closedDealAccess === 'read_download' ? 'Просмотр и скачивание' : baseLabel;\n          detail = 'Доступ зависит от CRM-прав и настроенного правила роли после закрытия сделок.';");
 // Format additional money fields too, preserving the same normalizer on save.
 replace('oninput="{{ tf.onInput }}" placeholder=', 'oninput="{{ tf.onInput }}" onblur="{{ tf.onBlur }}" placeholder=');
 replace('        dtype: dataTypeLabels[field.dataType] || field.dataType,', "        dtype: dataTypeLabels[field.dataType] || field.dataType,\n        onBlur:e=>{if(field.dataType==='money')this.setState({wz:{...this.state.wz,fieldVals:{...this.state.wz.fieldVals,[field.key]:this.yellowMoney(e.target.value)}}});},");
 replace('value="{{ ef.value }}" oninput="{{ ef.onInput }}"', 'value="{{ ef.value }}" oninput="{{ ef.onInput }}" onblur="{{ ef.onBlur }}"');
 replace('onInput: event => this.updateDocumentEditField(field.key, event.target.value),',"onInput: event => this.updateDocumentEditField(field.key, event.target.value),\n            onBlur:event=>{if(field.dataType==='money')this.updateDocumentEditField(field.key,this.yellowMoney(event.target.value));},");
 replace('  canModifyDocumentContent(document) {', "  canModifyDocumentContent(document) {\n    if(this.serverPolicy?.roleCode==='sales' && !this.canEditDocumentScope(document))return false;");
 // Render additions are scoped to the main view model.
 // Stable main-return anchor, rather than a nested map return.
 replace('      companyDocumentsGridStyle: `display:grid;', `      ...this.yellowValues(),\n      companyDocumentsGridStyle: \`display:grid;`);
 replace('  renderVals() {',`  yellowMoney(value) {
    const normalized=String(value??'').replace(/\\s/g,'').replace(',','.');
    if(!normalized || !/^\\d+(?:\\.\\d{0,2})?$/.test(normalized)) return value;
    const [whole,decimal='']=normalized.split('.');
    return whole.replace(/^0+(?=\\d)/,'').replace(/\\B(?=(\\d{3})+(?!\\d))/g,' ') + ',' + decimal.padEnd(2,'0');
  }
  yellowValues() {
    const s=this.state; const change=key=>e=>this.setState({[key]:e.target.value});
    const doc=this.drawerDocument||this.docs.find(d=>d.id===s.drawerId);
    const types=[...new Map(Object.values(this.TYPE_META||{}).flatMap(v=>Object.values(v||{})).map(t=>[t.code,{code:t.code,label:t.name||t.label||t.code}])).values()];
    return {
      yellowSyncLabel:({ready:'Автоматическая синхронизация включена. Сформированные файлы появляются после фоновой проверки.',starting:'Автоматическая синхронизация запускается. Проверка выполняется каждую минуту.',waiting_for_print:'Карточка синхронизирована. Ожидаем формирования DOCX/PDF в Bitrix24; проверка повторится автоматически.',error:'Синхронизация пока не завершена. Повторим автоматически; также можно нажать «Синхронизировать».'})[s.yellowSyncStatus]||'Автоматическая синхронизация файлов выполняется в фоне.',
      yellowTypeSection:s.yellowTypeSection||'',yellowSetTypeSection:change('yellowTypeSection'),
      yellowSections:this.SECTIONS.filter(x=>this.visibleSections().includes(x.code)),yellowTypes:types,
      yellowDealSearch:s.yellowDealSearch||'',yellowSetDealSearch:change('yellowDealSearch'),
      yellowBlurAmount:e=>this.setState({wz:{...this.state.wz,amount:this.yellowMoney(e.target.value)}}),
      yellowBlurEditAmount:e=>this.setState({drawerEdit:{...this.state.drawerEdit,amount:this.yellowMoney(e.target.value)}}),
      yellowParentLabel:s.wz.parentDocumentLabel||(s.wz.counterpartyId?'Основной документ не выбран.':'Основной документ не выбран. Сначала выберите компанию.'),
      yellowPickParent:()=>this.openRelationEditor('wizard'),yellowClearParent:()=>this.setState({wz:{...s.wz,parentDocumentId:null,parentDocumentLabel:null}}),
      yellowCompanySection:s.yellowCompanySection||'',yellowSetCompanySection:change('yellowCompanySection'),
      yellowCompanyType:s.yellowCompanyType||'',yellowSetCompanyType:change('yellowCompanyType'),
      yellowCompanyCounterparty:s.yellowCompanyCounterparty||'',yellowSetCompanyCounterparty:change('yellowCompanyCounterparty'),
      yellowCompanySearch:s.yellowCompanySearch||'',yellowSetCompanySearch:change('yellowCompanySearch'),
      yellowCounterparties:[...new Map(this.docs.filter(d=>d.counterpartyId).map(d=>[d.counterpartyId,{id:String(d.counterpartyId),label:d.counterparty||String(d.counterpartyId)}])).values()],
      yellowResetCompany:()=>this.setState({yellowCompanySection:'',yellowCompanyType:'',yellowCompanyCounterparty:'',yellowCompanySearch:'',matrixFilter:null}),
      yellowCreatedLabel:doc?.yellowCreatedAt?this.formatHistoryDate(doc.yellowCreatedAt):'См. историю документа',
    };
  }
  renderVals() {`);
 html=html.replace('</head>',`<style>
.yellow-company-toolbar {flex-wrap:wrap!important;}
.yellow-company-toolbar > button {flex-shrink:0;white-space:nowrap;}
.yellow-company-table-scroll {overflow-x:auto;max-width:100%;}
.yellow-company-filters {display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin:12px 0;}
.yellow-company-filters label {font-size:11px;color:#52525b;min-width:140px;flex:1;}
.yellow-company-filters input,.yellow-company-filters select,.yellow-company-filters button {display:block;width:100%;margin-top:4px;${inputStyle}background:#fff;}
.yellow-company-filters button {width:auto;cursor:pointer;}
.registry-context-screen > div > div:has(> [style*="flex: 1;"]) {flex-wrap:wrap;}
.registry-context-screen {min-width:0;}
@media(max-width:700px){.registry-context-screen>div {padding:12px!important;} .registry-context-screen > div > div {max-width:100%;} .registry-context-screen [style*="grid-template-columns:"] {overflow-x:auto;} }
</style></head>`);
 return html;
}
