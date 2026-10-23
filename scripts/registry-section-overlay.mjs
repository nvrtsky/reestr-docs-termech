import assert from 'node:assert/strict';
export function registrySectionOverlay(source){
 let html=source;
 const replace=(a,b)=>{assert.equal(html.split(a).length-1,1,`Section UI anchor: ${a.slice(0,90)}`);html=html.replace(a,b);};
 // Names and immutable system permissions have independent capabilities.
 html=html.replaceAll('canEditName: false','canEditName: true').replaceAll("fixedName: 'Администратор'",'fixedName: null').replaceAll("fixedName: 'Менеджер продаж'",'fixedName: null');
 replace('if (role && !roleCapabilities.canEditPolicy) return;','if (role && !roleCapabilities.canEditName && !roleCapabilities.canEditPolicy) return;');
 replace('roleModalOpen: true,','roleModalOpen: true,\n      permissionSection: "",');
 replace("    if (!capabilities.canEditPolicy) {\n      this.setState({ adminEditError: 'Права этой системной роли нельзя изменять.' });\n      return;\n    }",`    if (!capabilities.canEditPolicy) {
      try{this.setState({roleSaving:true});await this.api('/api/v1/registry/admin/role-policies/'+roleCode+'/name',{method:'PATCH',body:JSON.stringify({roleName:input.roleName.trim()})});await Promise.all([this.loadPolicy(),this.loadAdministrationData()]);this.setState({roleModalOpen:false});}
      catch(error){this.setState({adminEditError:error.message});}finally{this.setState({roleSaving:false});}return;
    }`);
 html=html.replaceAll('editable: capabilities.canEditPolicy','editable: capabilities.canEditPolicy || capabilities.canEditName').replaceAll('editMarkVisible: capabilities.canEditPolicy','editMarkVisible: capabilities.canEditPolicy || capabilities.canEditName').replaceAll('onEdit: capabilities.canEditPolicy ?', 'onEdit: (capabilities.canEditPolicy || capabilities.canEditName) ?');
 replace('roleCanSave: editingRoleCapabilities.canEditPolicy,','roleCanSave: editingRoleCapabilities.canEditPolicy || editingRoleCapabilities.canEditName,\n      rolePolicyEditable:editingRoleCapabilities.canEditPolicy,');
 // Disable every protected policy control, leaving only the name editable for admin.
 replace('<div style="display:flex;gap:7px;margin-top:10px;"><button type="button" onclick="{{ toggleRoleActive }}"','<fieldset disabled="{{ !rolePolicyEditable }}" style="border:0;padding:0;margin:0;"><div style="display:flex;gap:7px;margin-top:10px;"><button type="button" onclick="{{ toggleRoleActive }}"');
 const modalEnd=html.indexOf('<div data-role-save-feedback',html.indexOf('{{ roleModalTitle }}'));
 assert(modalEnd>0);html=html.slice(0,modalEnd).replace(/<\/div>\s*$/, '</fieldset></div>\n')+html.slice(modalEnd);
 // A section draft lives in permissions.bySection; navigation never overwrites another draft.
 replace('const fieldOptionsByKey = new Map',`const permissionSection=S.permissionSection||'';
    const sectionRule=roleEdit.permissions.bySection?.[permissionSection]||{};
    const sectionHidden=sectionRule.hiddenFields??roleEdit.hiddenFields;
    const fieldOptionsByKey = new Map`);
 replace('(S.adminTypes || []).forEach(type => (type.fields || []).forEach(field => fieldOptionsByKey.set(field.key, field.name)));',"(S.adminTypes || []).filter(type=>!permissionSection||this.typeSectionCodes(type).includes(permissionSection)).forEach(type => (type.fields || []).forEach(field => fieldOptionsByKey.set(field.key, field.name || field.label || field.key)));");
 const start=html.indexOf('const roleFieldOptions =');const end=html.indexOf('    const permissionLabels',start);assert(start>0&&end>start);
 html=html.slice(0,start)+`const roleFieldOptions = [...fieldOptionsByKey].map(([key,label])=>({key,label,checked:!sectionHidden.includes(key)&&!(sectionRule.finance===false&&['amount','currency'].includes(key)),mark:(sectionHidden.includes(key)||(sectionRule.finance===false&&['amount','currency'].includes(key)))?'—':'✓',onToggle:()=>permissionSection?this.changeSectionRule(['amount','currency'].includes(key)?{finance:sectionRule.finance===false||sectionHidden.includes(key),hiddenFields:sectionHidden.filter(k=>!['amount','currency'].includes(k))}:{hiddenFields:toggleInList(sectionHidden,key)}):this.setState({roleEdit:{...roleEdit,hiddenFields:toggleInList(roleEdit.hiddenFields,key)}})}));
`+html.slice(end);
 replace('>2. Видимые поля</div>',`>2. Видимые поля</div><label>Настройки раздела <select aria-label="Настройки раздела" value="{{ permissionSection }}" onchange="{{ selectPermissionSection }}"><option value="">Общая политика</option><sc-for list="{{ permissionSections }}" as="s"><option value="{{ s.code }}">{{ s.name }}</option></sc-for></select></label><sc-if value="{{ permissionSection }}"><div style="display:flex;gap:12px;margin:12px 0;"><label>Финансы <select aria-label="Финансы раздела" value="{{ sectionFinance }}" onchange="{{ changeSectionFinance }}"><option value="inherit">По общей политике</option><option value="yes">Показывать</option><option value="no">Скрыть</option></select></label><label>Файлы и ссылки <select aria-label="Содержимое раздела" value="{{ sectionContent }}" onchange="{{ changeSectionContent }}"><option value="inherit">По общей политике</option><option value="yes">Разрешить</option><option value="no">Запретить</option></select></label><button type="button" onclick="{{ resetSectionRule }}">Вернуть общую политику</button></div></sc-if>`);
 replace('      roleFieldOptions,',`      roleFieldOptions,
      permissionSection,permissionSections:adminSectionSource.filter(s=>s.isActive!==false),
      selectPermissionSection:e=>this.setState({permissionSection:e.target.value}),
      sectionFinance:sectionRule.finance===undefined?'inherit':sectionRule.finance?'yes':'no',
      sectionContent:sectionRule.content===undefined?'inherit':sectionRule.content?'yes':'no',
      changeSectionFinance:e=>this.changeSectionRule({finance:e.target.value==='inherit'?undefined:e.target.value==='yes'}),
      changeSectionContent:e=>this.changeSectionRule({content:e.target.value==='inherit'?undefined:e.target.value==='yes'}),
      resetSectionRule:()=>{const bySection={...roleEdit.permissions.bySection};delete bySection[permissionSection];this.setState({roleEdit:{...roleEdit,permissions:{...roleEdit.permissions,bySection}}});},`);
 replace('  renderVals() {',`  changeSectionRule(patch){const role=this.state.roleEdit;const section=this.state.permissionSection;if(!section)return;const bySection={...role.permissions.bySection};bySection[section]={...bySection[section],...patch};this.setState({roleEdit:{...role,permissions:{...role.permissions,bySection}}});}
  renderVals() {`);
 // Full field library: built-ins are informational because they already exist in every card.
 replace('    const libraryChips = (S.adminFieldLibrary || []).map(field => ({',`    const libraryChips = (S.adminFieldLibrary || []).filter(field=>[field.name,field.key].join(' ').toLowerCase().includes((S.librarySearch||'').toLowerCase())).map(field => ({`);
 replace('      name: field.name,\n      onAdd:',`      name: field.name+' · '+(dataTypeByCode[field.dataType]||field.dataType)+' · '+(S.adminTypes||[]).filter(t=>(t.fields||[]).some(f=>f.key===field.key)).flatMap(t=>t.sectionNames||[t.sectionName]).filter((s,i,a)=>s&&a.indexOf(s)===i).join(', '),
      onAdd:`);
 replace('<sc-for list="{{ libraryChips }}"',`<input aria-label="Поиск в библиотеке полей" placeholder="Название или код поля" value="{{ librarySearch }}" oninput="{{ setLibrarySearch }}" style="width:100%;padding:8px;margin-bottom:8px;"><div style="font-size:11px;color:#71717a;margin-bottom:8px;">Встроенные реквизиты уже есть в карточке; повторно добавлять их не нужно.</div><sc-for list="{{ builtinFields }}" as="b"><span style="display:inline-block;padding:5px;border:1px solid #ddd;margin:3px;">{{ b.label }}</span></sc-for><sc-for list="{{ libraryChips }}"`);
 replace('      newTypeFields, libraryChips, dataTypes,',`      newTypeFields, libraryChips, dataTypes,
      librarySearch:S.librarySearch||'',setLibrarySearch:e=>this.setState({librarySearch:e.target.value}),
      builtinFields:[['number','Номер','Текст'],['title','Название','Текст'],['documentDate','Дата документа','Дата'],['amount','Сумма','Сумма'],['currency','Валюта','Список'],['counterparty','Контрагент','Компания'],['legalEntity','Юридическое лицо','Компания'],['responsible','Ответственный','Сотрудник'],['status','Статус','Список'],['comment','Комментарий','Текст'],['createdAt','Создано','Дата и время'],['updatedAt','Обновлено','Дата и время'],['attachments','Файлы и ссылки','Файл']].filter(x=>x.join(' ').toLowerCase().includes((S.librarySearch||'').toLowerCase())).map(x=>({label:x[1]+' · '+x[2]+' · Все разделы'})),`);
 html=html.replaceAll('Уникальность тип + компания:', 'Уникальный номер в пределах типа и компании:');
 replace('Уникальный номер в пределах типа и компании: {{ ntNumberUniqueLabel }}</button>', 'Уникальный номер в пределах типа и компании: {{ ntNumberUniqueLabel }}</button><p style="font-size:11px;color:#71717a;">При включении нельзя создать второй документ с тем же номером, типом и компанией. Разные номера разрешены. Настройка не сравнивает файлы и не удаляет существующие документы.</p>');
 // Decimal strings retain precision; never use floating point for existing values.
 replace("!/^\\d+(?:\\.\\d{0,2})?$/.test(normalized)","!/^\\d+(?:\\.\\d*)?$/.test(normalized)");
 replace("    if (!doc.amount) return '—';", "    if (doc.amountRaw === '' || (doc.amountRaw == null && doc.amount == null)) return '—';");
 replace("    const n = Number(doc.amount).toLocaleString('ru-RU', {\n      minimumFractionDigits: 2,\n      maximumFractionDigits: 2,\n    });","    const n = this.yellowMoney(doc.amountRaw ?? doc.amount);");
 replace("    if (Array.isArray(value)) return value.join(', ');","    if (field.dataType === 'money') return this.yellowMoney(value);\n    if (Array.isArray(value)) return value.join(', ');");
 replace("    if (field.dataType === 'date') return String(value).slice(0, 10);","    if (field.dataType === 'money') return this.yellowMoney(value);\n    if (field.dataType === 'date') return String(value).slice(0, 10);");
 html=html.replaceAll("amount: document.amountRaw || '',","amount: this.yellowMoney(document.amountRaw || ''),");
 replace('      moneyHidden: !!item.moneyHidden,','      moneyHidden: !!item.moneyHidden,\n      contentVisible:item.contentVisible!==false,');
 replace('  canModifyDocumentContent(document) {','  canModifyDocumentContent(document) {\n    if(document.contentVisible===false || this.serverPolicy?.permissions?.bySection?.[document.section]?.content===false)return false;');
 replace('  roleHidesMoney(typeCode = null) {',`  roleHidesMoney(typeCode = null, sectionCode = null) {
    const section=sectionCode||this.state.wz?.sectionCode;
    const rule=this.serverPolicy?.permissions?.bySection?.[section];
    if(rule?.finance!==undefined)return !rule.finance;`);
 replace('return type && !this.roleHidesMoney(type.code);','return type && !this.roleHidesMoney(type.code,section.code);');
 html=html.replace('</head>','<style>select[aria-label="Настройки раздела"],select[aria-label="Финансы раздела"],select[aria-label="Содержимое раздела"] {padding:7px 9px;border:1px solid #d4d4d8;border-radius:7px;background:white;font-size:12px;} fieldset[disabled] button {pointer-events:none;opacity:.55;}</style></head>');

 // Bulk rows each carry their own section, independent from the single-document wizard.
 const bulkStart=html.indexOf('  bulkUploadRowValidation('),bulkEnd=html.indexOf('  ',bulkStart+1);
 for(const [startText,endText,section] of [
  ['  bulkUploadValidation(', '  async ', 'row.sectionCode'],
  ['    const wizardSections =','    const wizardMoneyVisible','section.code'],
  ['    const bulkUploadRows =', '    const bulkUploadPendingCount', 'row.sectionCode'],
  ['    const bulkUploadSectionOptions =','    const bulkUploadCommonTypeOptions','section.code'],
  ['    const bulkUploadCommonTypeOptions =','    const bulkUploadCommonType =','S.bulkUploadCommonSection'],
  ['  canCreateInSection(sectionCode)', '  registryMoneyAvailable()', 'sectionCode']
 ]){
  const start=html.indexOf(startText),end=html.indexOf(endText,start+startText.length);
  if(start>=0&&end>start){const chunk=html.slice(start,end).replaceAll('this.roleHidesMoney(type.code)','this.roleHidesMoney(type.code,'+section+')').replaceAll('this.roleHidesMoney(item.code)','this.roleHidesMoney(item.code,'+section+')');html=html.slice(0,start)+chunk+html.slice(end);}
 }
 html=html.replaceAll('this.roleHidesMoney(document.typeCode)','this.roleHidesMoney(document.typeCode,document.section)');
 replace('value="{{ f.value }}" oninput="{{ f.onInput }}"','value="{{ f.value }}" oninput="{{ f.onInput }}" onblur="{{ f.onBlur }}"');
 replace('          onInput: event => this.updateBulkUploadRow(row.id, {',`          onBlur:event=>{if(field.dataType==='money')this.updateBulkUploadRow(row.id,{fieldVals:{...row.fieldVals,[field.key]:this.yellowMoney(event.target.value)}});},
          onInput: event => this.updateBulkUploadRow(row.id, {`);
 replace("const financialNumber = (value, digits = 2) => Number(value || 0).toLocaleString('ru-RU', {","const financialNumber = (value, digits = 2) => digits===2 ? this.yellowMoney(value || 0) : Number(value || 0).toLocaleString('ru-RU', {");
 html=html.replaceAll("? '0'\n            :", "? '0,00'\n            :");
 return html;
}
