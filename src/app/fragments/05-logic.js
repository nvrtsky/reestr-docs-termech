
class Component extends DCLogic {
  componentDidMount() {
    this.bitrixContextHandler = event => this.receiveBitrixContext(event);
    window.addEventListener('message', this.bitrixContextHandler);
    this.nativeFileDragHandler = event => this.handleNativeFileDrag(event);
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(type => {
      document.addEventListener(type, this.nativeFileDragHandler, true);
    });
    requestAnimationFrame(() => this.forceUpdate());
    void this.initializeRegistry();
  }
  componentWillUnmount() {
    window.removeEventListener('message', this.bitrixContextHandler);
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(type => {
      document.removeEventListener(type, this.nativeFileDragHandler, true);
    });
    if (this.documentsReloadTimer) clearTimeout(this.documentsReloadTimer);
    if (this.confirmResolver) {
      this.confirmResolver(false);
      this.confirmResolver = null;
    }
  }
  async initializeRegistry() {
    if (this.registryInitializing) return;
    this.registryInitializing = true;
    this.serverPolicy = null;
    this.policyLoadError = null;
    this.setState({
      registryLoading: true,
      registryReady: false,
      registryLoadError: '',
      accessDenied: false,
    });
    try {
      const context = await this.requestBitrixContext(false);
      this.applyPlacementContext(context);
      const policyLoaded = await this.loadPolicy();
      if (!policyLoaded) {
        if (this.policyLoadError && this.policyLoadError.code === 'registry_access_not_assigned') {
          this.registryInitialized = true;
          this.setState({ registryLoading: false, registryReady: true });
          return;
        }
        throw this.policyLoadError || new Error('Не удалось определить права пользователя.');
      }
      await Promise.all([
        this.loadCatalogs(),
        this.loadLifecycles(),
        this.loadUsers(),
        this.loadSavedViews(),
      ]);
      if (this.serverPolicy && this.serverPolicy.permissions.administer) {
        await this.loadAdministrationData();
        if (this.bitrixContext && this.bitrixContext.auth) {
          void this.ensureBitrixIntegrations();
        }
      }
      if (this.placementEntity) {
        await this.loadContextDocuments();
      } else if (this.placementContextType) {
        this.clearContextDocuments();
      } else {
        await Promise.all([this.loadDocuments(), this.loadDocumentOptions()]);
      }
      this.registryInitialized = true;
      this.setState({ registryLoading: false, registryReady: true });
    } catch (error) {
      console.error('Failed to initialize registry', error);
      this.setState({
        registryLoading: false,
        registryReady: false,
        registryLoadError: error instanceof Error
          ? error.message
          : 'Не удалось загрузить реестр.',
      });
    } finally {
      this.registryInitializing = false;
    }
  }
  receiveBitrixContext(event) {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    if (!event.data) return;
    if (event.data.type === 'registry-bitrix-select-crm-response') {
      const waiter = this.crmSelectorWaiters && this.crmSelectorWaiters[event.data.requestId];
      if (!waiter) return;
      delete this.crmSelectorWaiters[event.data.requestId];
      if (event.data.error) waiter.reject(new Error(event.data.error));
      else waiter.resolve(Array.isArray(event.data.items) ? event.data.items : []);
      return;
    }
    if (event.data.type !== 'registry-bitrix-context') return;
    this.bitrixContext = event.data.context || { auth: null, placement: null };
    const previousKey = this.placementEntity
      ? `${this.placementEntity.entityType}:${this.placementEntity.entityId}`
      : '';
    this.applyPlacementContext(this.bitrixContext);
    const nextKey = this.placementEntity
      ? `${this.placementEntity.entityType}:${this.placementEntity.entityId}`
      : '';
    if (this.registryInitialized && previousKey !== nextKey) {
      if (this.placementEntity) void this.loadContextDocuments();
      else if (this.placementContextType) this.clearContextDocuments();
      else void this.loadRegistryData();
    }
    const waiters = this.bitrixContextWaiters || [];
    this.bitrixContextWaiters = [];
    waiters.forEach(resolve => resolve(this.bitrixContext));
  }
  requestBitrixContext(refresh) {
    if (!this.bitrixContextWaiters) this.bitrixContextWaiters = [];
    return new Promise(resolve => {
      const timeout = setTimeout(() => resolve(this.bitrixContext || null), 2500);
      this.bitrixContextWaiters.push(context => {
        clearTimeout(timeout);
        resolve(context);
      });
      window.parent.postMessage(
        { type: 'registry-bitrix-context-request', refresh: refresh === true },
        window.location.origin,
      );
    });
  }

  requestCrmSelection(links, options = {}) {
    if (!this.crmSelectorWaiters) this.crmSelectorWaiters = {};
    const requestId = `crm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const value = { deal: [], company: [] };
    links.forEach(link => {
      if ((link.entityType === 'deal' || link.entityType === 'company') && link.entityId) {
        value[link.entityType].push(link.entityId);
      }
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        delete this.crmSelectorWaiters[requestId];
        reject(new Error('Время ожидания выбора в Bitrix24 истекло.'));
      }, 300000);
      this.crmSelectorWaiters[requestId] = {
        resolve: items => { clearTimeout(timeout); resolve(items); },
        reject: error => { clearTimeout(timeout); reject(error); },
      };
      window.parent.postMessage(
        { type: 'registry-bitrix-select-crm-request', requestId, value, options },
        window.location.origin,
      );
    });
  }

  async manageDocumentLinks(documentId, currentLinks) {
    try {
      const selected = await this.requestCrmSelection(currentLinks);
      const currentByKey = new Map(currentLinks.map(link => [
        `${link.entityType}:${link.entityId}`,
        link,
      ]));
      const selectedByKey = new Map(selected.map(item => [
        `${item.entityType}:${item.entityId}`,
        item,
      ]));
      for (const [key, link] of currentByKey) {
        if (!selectedByKey.has(key) && link.id) {
          await this.api(`/api/v1/registry/links/${link.id}`, { method: 'DELETE' });
        }
      }
      for (const [key, item] of selectedByKey) {
        if (!currentByKey.has(key)) {
          await this.api(`/api/v1/registry/documents/${documentId}/links`, {
            method: 'POST',
            body: JSON.stringify(item),
          });
        }
      }
      if (this.placementEntity) {
        await this.loadContextDocuments();
        if (this.docs.some(document => document.id === documentId)) {
          await this.openDocument(documentId);
        } else {
          this.setState({ drawerId: null });
        }
      } else {
        await this.openDocument(documentId);
      }
    } catch (error) {
      console.error('Failed to update CRM links', error);
    }
  }

  async loadUsers() {
    try {
      const payload = await this.api('/api/v1/registry/users');
      const registryUsers = payload.items || [];
      this.setState({ registryUsers });
      if (Array.isArray(this.docs) && this.docs.length) {
        this.docs = this.docs.map(document => this.withResolvedResponsible(document, registryUsers));
        this.forceUpdate();
      }
    } catch (error) {
      if (!this.state.accessDenied) console.error('Failed to load Bitrix24 users', error);
    }
  }

  responsibleNameById(responsibleId, users = this.state.registryUsers || []) {
    const id = Number(responsibleId);
    if (!Number.isSafeInteger(id) || id <= 0) return '';
    const user = users.find(item => Number(item.id) === id);
    return user && user.name ? user.name : '';
  }

  withResolvedResponsible(document, users = this.state.registryUsers || []) {
    if (!document) return document;
    const resolvedName = this.responsibleNameById(document.responsibleId, users)
      || (document.responsibleNameRaw && !/^Пользователь #\d+$/.test(document.responsibleNameRaw)
        ? document.responsibleNameRaw
        : '');
    return {
      ...document,
      responsible: resolvedName || '—',
      responsibleNameRaw: resolvedName,
    };
  }

  defaultResponsibleSelection() {
    const userId = Number(this.serverPolicy && this.serverPolicy.userId);
    const user = (this.state.registryUsers || [])
      .find(item => Number(item.id) === userId);
    return {
      responsibleId: userId > 0 ? String(userId) : '',
      responsibleName: user ? user.name : '',
    };
  }

  async ensureBitrixIntegrations() {
    try {
      this.bitrixIntegrationStatus = await this.api(
        '/api/v1/registry/admin/integrations/ensure',
        { method: 'POST' },
      );
    } catch (error) {
      console.error('Failed to ensure Bitrix24 registry integrations', error);
    }
  }

  async loadSavedViews() {
    try {
      const payload = await this.api('/api/v1/registry/saved-views');
      this.setState({ customSavedViews: payload.items || [] });
    } catch (error) {
      if (!this.state.accessDenied) console.error('Failed to load saved views', error);
    }
  }

  savedViewPayload() {
    const filters = this.state.filters;
    return {
      name: String(this.state.savedViewName || '').trim(),
      isShared: !!(
        this.serverPolicy
        && this.serverPolicy.permissions
        && this.serverPolicy.permissions.administer
        && this.state.savedViewShared === true
      ),
      filters: {
        search: String(this.state.search || '').trim(),
        view: ['all', 'mine', 'awaiting', 'draft'].includes(this.state.view)
          ? this.state.view
          : 'all',
        sections: Object.keys(filters.sections).filter(code => filters.sections[code]),
        statuses: Object.keys(filters.statuses).filter(code => filters.statuses[code]),
        type: filters.type === 'all' ? null : filters.type,
        responsibleId: filters.responsible === 'all' ? null : Number(filters.responsible),
        counterparty: String(filters.cp || '').trim(),
        from: this.toIsoDocumentDate(filters.from),
        to: this.toIsoDocumentDate(filters.to),
      },
      columns: Object.keys(this.state.cols).filter(key => this.state.cols[key]),
    };
  }

  openSavedViewEditor(view = null) {
    this.setState({
      savedViewEditorOpen: true,
      savedViewEditingId: view ? view.id : null,
      savedViewName: view ? view.name : '',
      savedViewShared: view ? view.isShared === true : false,
      savedViewError: '',
    });
  }

  async saveCurrentView() {
    const payload = this.savedViewPayload();
    if (!payload.name || this.state.savedViewSaving) {
      if (!payload.name) this.setState({ savedViewError: 'Укажите название представления.' });
      return;
    }
    const id = this.state.savedViewEditingId;
    this.setState({ savedViewSaving: true, savedViewError: '' });
    try {
      const saved = await this.api(`/api/v1/registry/saved-views${id ? '/' + id : ''}`, {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      await this.loadSavedViews();
      this.setState({
        activeSavedViewId: saved.id,
        savedViewEditorOpen: false,
        savedViewEditingId: null,
        savedViewName: '',
        savedViewShared: false,
        savedViewSaving: false,
      });
    } catch (error) {
      this.setState({
        savedViewSaving: false,
        savedViewError: error instanceof Error ? error.message : 'Не удалось сохранить представление.',
      });
    }
  }

  applySavedView(view) {
    const filters = view.filters || {};
    const sections = Object.fromEntries((filters.sections || []).map(code => [code, true]));
    const statuses = Object.fromEntries((filters.statuses || []).map(code => [code, true]));
    const columns = Object.fromEntries(
      ['section', 'counterparty', 'status', 'amount', 'docDate', 'responsible']
        .map(code => [code, (view.columns || []).includes(code)]),
    );
    this.persistColumnPreferences(columns);
    this.setState({
      activeSavedViewId: view.id,
      view: filters.view || 'all',
      search: filters.search || '',
      filters: {
        sections,
        statuses,
        type: filters.type || 'all',
        responsible: filters.responsibleId ? String(filters.responsibleId) : 'all',
        cp: filters.counterparty || '',
        from: filters.from || '',
        to: filters.to || '',
      },
      cols: columns,
      registryPage: 0,
      sel: {},
      savedViewEditorOpen: false,
    });
    this.scheduleDocumentsReload();
  }

  async deleteSavedView(view) {
    if (!view || !view.canManage) return;
    const confirmed = await this.requestConfirmation({
      title: 'Удалить представление?',
      message: `Представление «${view.name}» будет удалено без возможности восстановления.`,
    });
    if (!confirmed) return;
    try {
      await this.api(`/api/v1/registry/saved-views/${view.id}`, { method: 'DELETE' });
      await this.loadSavedViews();
      this.setState({
        activeSavedViewId: this.state.activeSavedViewId === view.id ? null : this.state.activeSavedViewId,
        savedViewEditorOpen: false,
        savedViewEditingId: null,
      });
    } catch (error) {
      this.setState({ savedViewError: error instanceof Error ? error.message : 'Не удалось удалить представление.' });
    }
  }

  async refreshVisibleDocuments() {
    if (this.placementEntity) await this.loadContextDocuments();
    else if (this.placementContextType) this.clearContextDocuments();
    else await Promise.all([this.loadDocuments(), this.loadDocumentOptions()]);
  }

  async deleteDocument(documentId) {
    const document = this.docs.find((item) => item.id === documentId);
    const confirmed = await this.requestConfirmation({
      title: 'Удалить документ?',
      message: document
        ? `Документ «${document.title}» будет перемещён в архив. Его можно будет восстановить.`
        : 'Документ будет перемещён в архив. Его можно будет восстановить.',
    });
    if (!confirmed) return;
    try {
      await this.api(`/api/v1/registry/documents/${documentId}`, { method: 'DELETE' });
      if (this.state.drawerId === documentId) this.setState({ drawerId: null });
      this.setState({ rowMenuId: null, sel: {} });
      await this.refreshVisibleDocuments();
    } catch (error) {
      console.error('Failed to delete registry document', error);
    }
  }

  async restoreDocument(documentId) {
    const document = this.docs.find((item) => item.id === documentId);
    const confirmed = await this.requestConfirmation({
      title: 'Восстановить документ?',
      message: document
        ? `Документ «${document.title}» вернётся в рабочий реестр.`
        : 'Документ вернётся в рабочий реестр.',
      confirmLabel: 'Восстановить',
    });
    if (!confirmed) return;
    try {
      await this.api(`/api/v1/registry/documents/${documentId}/restore`, { method: 'POST' });
      if (this.state.drawerId === documentId) this.setState({ drawerId: null });
      this.setState({ rowMenuId: null, sel: {} });
      await this.refreshVisibleDocuments();
    } catch (error) {
      this.setState({
        bulkError: error instanceof Error ? error.message : 'Не удалось восстановить документ.',
      });
    }
  }

  async bulkAssignDocuments() {
    const documentIds = Object.keys(this.state.sel).filter(id => this.state.sel[id]);
    const responsibleId = Number(this.state.bulkResponsibleId);
    if (!documentIds.length || !Number.isSafeInteger(responsibleId) || responsibleId <= 0) {
      this.setState({ bulkError: 'Выберите ответственного.' });
      return;
    }
    const responsible = (this.state.registryUsers || [])
      .find(user => Number(user.id) === responsibleId);
    this.setState({ bulkBusy: true, bulkError: '' });
    try {
      await this.api('/api/v1/registry/documents/bulk/assign', {
        method: 'POST',
        body: JSON.stringify({
          documentIds,
          responsibleId,
          responsibleName: responsible ? responsible.name : null,
        }),
      });
      this.setState({
        sel: {},
        bulkAssignOpen: false,
        bulkResponsibleId: '',
        bulkBusy: false,
      });
      await this.refreshVisibleDocuments();
    } catch (error) {
      this.setState({
        bulkBusy: false,
        bulkError: error instanceof Error ? error.message : 'Не удалось назначить ответственного.',
      });
    }
  }

  async bulkDeleteDocuments() {
    const documentIds = Object.keys(this.state.sel).filter(id => this.state.sel[id]);
    if (!documentIds.length) return;
    const confirmed = await this.requestConfirmation({
      title: 'Удалить выбранные документы?',
      message: `${documentIds.length} документ(ов) будут перемещены в архив. Их можно будет восстановить.`,
    });
    if (!confirmed) return;
    this.setState({ bulkBusy: true, bulkError: '' });
    try {
      await this.api('/api/v1/registry/documents/bulk/delete', {
        method: 'POST',
        body: JSON.stringify({ documentIds }),
      });
      this.setState({ sel: {}, bulkBusy: false, bulkAssignOpen: false });
      await this.refreshVisibleDocuments();
    } catch (error) {
      this.setState({
        bulkBusy: false,
        bulkError: error instanceof Error ? error.message : 'Не удалось удалить документы.',
      });
    }
  }

  async bulkRestoreDocuments() {
    const documentIds = Object.keys(this.state.sel).filter(id => this.state.sel[id]);
    if (!documentIds.length) return;
    const confirmed = await this.requestConfirmation({
      title: 'Восстановить выбранные документы?',
      message: `${documentIds.length} документ(ов) вернутся в рабочий реестр.`,
      confirmLabel: 'Восстановить',
    });
    if (!confirmed) return;
    this.setState({ bulkBusy: true, bulkError: '' });
    try {
      await this.api('/api/v1/registry/documents/bulk/restore', {
        method: 'POST',
        body: JSON.stringify({ documentIds }),
      });
      this.setState({ sel: {}, bulkBusy: false, bulkAssignOpen: false });
      await this.refreshVisibleDocuments();
    } catch (error) {
      this.setState({
        bulkBusy: false,
        bulkError: error instanceof Error ? error.message : 'Не удалось восстановить документы.',
      });
    }
  }

  textValue(value) {
    return typeof value === 'string' ? value : '';
  }

  loadColumnPreferences() {
    const defaults = {
      section: true,
      counterparty: true,
      status: true,
      amount: true,
      docDate: true,
      responsible: true,
    };
    try {
      const stored = JSON.parse(sessionStorage.getItem('termech.registry.columns') || 'null');
      if (!stored || typeof stored !== 'object') return defaults;
      return Object.fromEntries(
        Object.entries(defaults).map(([key, fallback]) => [
          key,
          typeof stored[key] === 'boolean' ? stored[key] : fallback,
        ]),
      );
    } catch {
      return defaults;
    }
  }

  persistColumnPreferences(columns) {
    try {
      sessionStorage.setItem('termech.registry.columns', JSON.stringify(columns));
    } catch {
      // The registry remains usable when browser storage is unavailable.
    }
  }

  requestConfirmation({ title, message, confirmLabel = 'Удалить' }) {
    if (this.confirmResolver) this.confirmResolver(false);
    return new Promise(resolve => {
      this.confirmResolver = resolve;
      this.setState({
        confirmDialog: { title, message, confirmLabel },
      });
    });
  }

  resolveConfirmation(confirmed) {
    const resolver = this.confirmResolver;
    this.confirmResolver = null;
    this.setState({ confirmDialog: null });
    if (resolver) resolver(confirmed);
  }

  async saveDocumentType(input) {
    if (!input.label.trim()) return;
    const dataTypes = {
      'Текст': 'text', 'Число': 'number', 'Дата': 'date', 'Сумма': 'money',
      'Список': 'select', 'Да/Нет': 'boolean', 'Файл': 'file',
    };
    try {
      await this.api(`/api/v1/registry/types${input.code ? '/' + input.code : ''}`, {
        method: input.code ? 'PUT' : 'POST',
        body: JSON.stringify({
          sectionCode: input.section,
          name: input.label,
          lifecycleCode: input.lifecycle,
          ...(input.code ? {
            description: this.textValue(input.description).trim() || null,
            sortOrder: Number(input.sortOrder) || 100,
            isActive: input.isActive !== false,
          } : {}),
          fields: input.fields.map(field => ({
            ...(field.key ? { key: field.key } : {}),
            name: field.name,
            dataType: dataTypes[field.dtype] || 'text',
            isRequired: field.required === true,
          })),
        }),
      });
      await Promise.all([this.loadCatalogs(), this.loadAdministrationData()]);
      this.setState({ typeModalOpen: false, adminEditError: '' });
    } catch (error) {
      this.setState({ adminEditError: error instanceof Error ? error.message : 'Не удалось сохранить тип документа.' });
    }
  }

  async loadAdministrationData() {
    if (this.state.adminDataLoading) return;
    this.setState({ adminDataLoading: true, adminDataError: '' });
    try {
      const [sections, types, lifecycles, roles] = await Promise.all([
        this.api('/api/v1/registry/admin/sections'),
        this.api('/api/v1/registry/admin/types'),
        this.api('/api/v1/registry/admin/lifecycles'),
        this.api('/api/v1/registry/admin/role-policies'),
      ]);
      this.setState({
        adminSections: sections.items || [],
        adminTypes: types.items || [],
        adminLifecyclesData: lifecycles.items || [],
        adminPolicies: (roles.items || []).filter(role => role.roleCode !== 'manager'),
        adminDataLoading: false,
      });
    } catch (error) {
      this.setState({
        adminDataLoading: false,
        adminDataError: error instanceof Error ? error.message : 'Не удалось загрузить настройки реестра.',
      });
    }
  }

  openSectionEditor(section = null) {
    this.setState({
      sectionModalOpen: true,
      editingSectionCode: section ? section.code : null,
      sectionEdit: {
        name: section ? section.name : '',
        description: section ? this.textValue(section.description) : '',
        color: section ? section.color || '#64748b' : '#64748b',
        sortOrder: section ? section.sortOrder : 100,
        isActive: section ? section.isActive !== false : true,
      },
      adminEditError: '',
    });
  }

  async saveSection() {
    const input = this.state.sectionEdit;
    const code = this.state.editingSectionCode;
    if (!input || !String(input.name || '').trim()) return;
    try {
      await this.api(`/api/v1/registry/admin/sections${code ? '/' + code : ''}`, {
        method: code ? 'PUT' : 'POST',
        body: JSON.stringify({
          name: String(input.name).trim(),
          description: this.textValue(input.description).trim() || null,
          color: input.color || null,
          sortOrder: Number(input.sortOrder) || 100,
          ...(code ? { isActive: input.isActive !== false } : {}),
        }),
      });
      await Promise.all([this.loadCatalogs(), this.loadAdministrationData()]);
      this.setState({ sectionModalOpen: false, adminEditError: '' });
    } catch (error) {
      this.setState({ adminEditError: error instanceof Error ? error.message : 'Не удалось сохранить раздел.' });
    }
  }

  async deleteSection() {
    const code = this.state.editingSectionCode;
    const input = this.state.sectionEdit;
    if (!code || !input) return;
    const confirmed = await this.requestConfirmation({
      title: 'Удалить раздел?',
      message: `Раздел «${input.name}» будет удалён. Удаление возможно только если в нём нет типов документов.`,
    });
    if (!confirmed) return;
    try {
      await this.api(`/api/v1/registry/admin/sections/${encodeURIComponent(code)}`, {
        method: 'DELETE',
      });
      await Promise.all([this.loadCatalogs(), this.loadAdministrationData()]);
      this.setState({ sectionModalOpen: false, adminEditError: '' });
    } catch (error) {
      this.setState({ adminEditError: error instanceof Error ? error.message : 'Не удалось удалить раздел.' });
    }
  }

  openTypeEditor(type = null) {
    const dataTypeLabels = { text: 'Текст', number: 'Число', date: 'Дата', money: 'Сумма', select: 'Список', boolean: 'Да/Нет', file: 'Файл' };
    this.setState({
      typeModalOpen: true,
      newType: type ? {
        code: type.code,
        section: type.sectionCode,
        label: type.name,
        lifecycle: type.lifecycleCode || 'simple',
        description: this.textValue(type.description),
        sortOrder: type.sortOrder,
        isActive: type.isActive !== false,
        fields: (type.fields || []).map(field => ({
          key: field.key,
          name: field.name,
          dtype: dataTypeLabels[field.dataType] || 'Текст',
          required: field.isRequired === true,
        })),
      } : {
        code: null,
        section: (this.state.adminSections[0] && this.state.adminSections[0].code) || 'client',
        label: '',
        lifecycle: (this.state.adminLifecyclesData[0] && this.state.adminLifecyclesData[0].code) || 'simple',
        description: '',
        sortOrder: 100,
        isActive: true,
        fields: [],
      },
      adminEditError: '',
    });
  }

  async deleteDocumentType() {
    const type = this.state.newType;
    if (!type || !type.code) return;
    const confirmed = await this.requestConfirmation({
      title: 'Удалить тип документа?',
      message: `Тип «${type.label}» будет удалён вместе с настройкой его полей. Удаление возможно только при отсутствии документов этого типа.`,
    });
    if (!confirmed) return;
    try {
      await this.api(`/api/v1/registry/admin/types/${encodeURIComponent(type.code)}`, {
        method: 'DELETE',
      });
      await Promise.all([this.loadCatalogs(), this.loadAdministrationData()]);
      this.setState({ typeModalOpen: false, adminEditError: '' });
    } catch (error) {
      this.setState({ adminEditError: error instanceof Error ? error.message : 'Не удалось удалить тип документа.' });
    }
  }

  openLifecycleEditor(lifecycle = null) {
    const config = lifecycle && lifecycle.config;
    this.setState({
      lifecycleModalOpen: true,
      editingLifecycleCode: lifecycle ? lifecycle.code : null,
      lifecycleEdit: {
        name: lifecycle ? lifecycle.name : '',
        isActive: lifecycle ? lifecycle.isActive !== false : true,
        initialStatus: config ? config.initialStatus : 'draft',
        states: config ? config.states.map(state => ({ ...state, color: state.color || '#71717a' })) : [
          { code: 'draft', label: 'Черновик', color: '#71717a', terminal: false },
          { code: 'active', label: 'Активен', color: '#15803d', terminal: false },
          { code: 'archived', label: 'В архиве', color: '#a1a1aa', terminal: true },
        ],
        transitions: config ? config.transitions.map(transition => ({
          ...transition,
          roles: [...(transition.roles || [])],
        })) : [
          { from: 'draft', to: 'active', roles: [], requiresAttachment: false },
          { from: 'active', to: 'archived', roles: [], requiresAttachment: false },
        ],
      },
      adminEditError: '',
    });
  }

  async saveLifecycle() {
    const input = this.state.lifecycleEdit;
    const code = this.state.editingLifecycleCode;
    if (!input || !String(input.name || '').trim()) return;
    try {
      await this.api(`/api/v1/registry/admin/lifecycles${code ? '/' + code : ''}`, {
        method: code ? 'PUT' : 'POST',
        body: JSON.stringify({
          name: String(input.name).trim(),
          config: {
            initialStatus: input.initialStatus,
            states: input.states.map(state => ({
              code: String(state.code || '').trim(),
              label: String(state.label || '').trim(),
              color: state.color || undefined,
              terminal: state.terminal === true,
            })),
            transitions: input.transitions.map(transition => ({
              from: transition.from,
              to: transition.to,
              roles: Array.isArray(transition.roles) && transition.roles.length
                ? transition.roles
                : undefined,
              requiresAttachment: transition.requiresAttachment === true,
            })),
          },
          ...(code ? { isActive: input.isActive !== false } : {}),
        }),
      });
      await Promise.all([this.loadLifecycles(), this.loadAdministrationData()]);
      this.setState({ lifecycleModalOpen: false, adminEditError: '' });
    } catch (error) {
      this.setState({ adminEditError: error instanceof Error ? error.message : 'Не удалось сохранить жизненный цикл.' });
    }
  }

  async deleteLifecycle() {
    const code = this.state.editingLifecycleCode;
    const input = this.state.lifecycleEdit;
    if (!code || !input) return;
    const confirmed = await this.requestConfirmation({
      title: 'Удалить жизненный цикл?',
      message: `Жизненный цикл «${input.name}» будет удалён. Удаление возможно только если он не назначен типам документов.`,
    });
    if (!confirmed) return;
    try {
      await this.api(`/api/v1/registry/admin/lifecycles/${encodeURIComponent(code)}`, {
        method: 'DELETE',
      });
      await Promise.all([this.loadLifecycles(), this.loadAdministrationData()]);
      this.setState({ lifecycleModalOpen: false, adminEditError: '' });
    } catch (error) {
      this.setState({ adminEditError: error instanceof Error ? error.message : 'Не удалось удалить жизненный цикл.' });
    }
  }

  openRoleEditor(role = null) {
    const defaultPermissions = {
      create: false,
      editOwn: false,
      editAny: false,
      transitionOwn: false,
      transitionAny: false,
      softDelete: false,
      restore: false,
      export: false,
      administer: false,
      byType: {},
    };
    this.setState({
      roleModalOpen: true,
      editingRoleCode: role ? role.roleCode : null,
      roleEdit: role ? {
        roleName: role.roleName,
        visibleSectionCodes: [...(role.visibleSectionCodes || [])],
        allTypes: role.visibleTypeCodes === null,
        visibleTypeCodes: [...(role.visibleTypeCodes || [])],
        hiddenFields: [...(role.hiddenFields || [])],
        permissions: {
          ...(role.permissions || {}),
          byType: { ...((role.permissions && role.permissions.byType) || {}) },
        },
        hideMoney: role.hideMoney === true,
        isActive: role.isActive !== false,
      } : {
        roleName: '',
        visibleSectionCodes: this.state.adminSections
          .filter(section => section.isActive !== false)
          .map(section => section.code),
        allTypes: true,
        visibleTypeCodes: [],
        hiddenFields: ['amount', 'currency'],
        permissions: defaultPermissions,
        hideMoney: true,
        isActive: true,
      },
      adminEditError: '',
    });
  }

  async saveRolePolicy() {
    const roleCode = this.state.editingRoleCode;
    const input = this.state.roleEdit;
    if (!input || !String(input.roleName || '').trim()) return;
    const visibleSections = new Set(input.visibleSectionCodes);
    const visibleTypeCodes = input.visibleTypeCodes.filter(typeCode => {
      const type = this.state.adminTypes.find(item => item.code === typeCode);
      return type && visibleSections.has(type.sectionCode);
    });
    try {
      await this.api(`/api/v1/registry/admin/role-policies${roleCode ? '/' + roleCode : ''}`, {
        method: roleCode ? 'PUT' : 'POST',
        body: JSON.stringify({
          roleName: input.roleName,
          visibleSectionCodes: input.visibleSectionCodes,
          visibleTypeCodes: input.allTypes ? null : visibleTypeCodes,
          hiddenFields: input.hiddenFields,
          permissions: input.permissions,
          hideMoney: input.hideMoney,
          isActive: input.isActive,
        }),
      });
      await Promise.all([this.loadPolicy(), this.loadAdministrationData()]);
      this.setState({ roleModalOpen: false, adminEditError: '' });
    } catch (error) {
      this.setState({ adminEditError: error instanceof Error ? error.message : 'Не удалось сохранить политику роли.' });
    }
  }

  async deleteRolePolicy() {
    const roleCode = this.state.editingRoleCode;
    const input = this.state.roleEdit;
    if (!roleCode || roleCode === 'admin' || !input) return;
    const confirmed = await this.requestConfirmation({
      title: 'Удалить роль?',
      message: `Роль «${input.roleName}» будет удалена. Удаление возможно только если она не назначена и не используется в переходах статусов.`,
    });
    if (!confirmed) return;
    try {
      await this.api(`/api/v1/registry/admin/role-policies/${encodeURIComponent(roleCode)}`, {
        method: 'DELETE',
      });
      await Promise.all([this.loadAdministrationData(), this.loadAdminAccess()]);
      this.setState({ roleModalOpen: false, adminEditError: '' });
    } catch (error) {
      this.setState({ adminEditError: error instanceof Error ? error.message : 'Не удалось удалить роль.' });
    }
  }

  async loadAdminAccess() {
    if (this.state.adminAccessLoading) return;
    this.setState({ adminAccessLoading: true, adminAccessError: '', adminAccessSaved: false });
    try {
      const payload = await this.api('/api/v1/registry/admin/user-roles');
      const assignments = {};
      const bitrixAdminIds = new Set(
        (payload.users || []).filter(user => user.isBitrixAdmin).map(user => String(user.id)),
      );
      (payload.items || []).forEach(item => {
        if (!bitrixAdminIds.has(String(item.userId))) {
          assignments[String(item.userId)] = item.roleCode;
        }
      });
      this.setState({
        adminUsers: payload.users || [],
        registryUsers: this.state.registryUsers.length
          ? this.state.registryUsers
          : (payload.users || []),
        adminUserRoles: assignments,
        adminAccessLoading: false,
      });
    } catch (error) {
      this.setState({
        adminAccessLoading: false,
        adminAccessError: error instanceof Error ? error.message : 'Не удалось загрузить назначения ролей.',
      });
    }
  }

  setAdminUserRole(userId, roleCode) {
    const user = (this.state.adminUsers || []).find(item => String(item.id) === String(userId));
    if (user && user.isBitrixAdmin) return;
    const assignments = { ...this.state.adminUserRoles };
    if (roleCode) assignments[String(userId)] = roleCode;
    else delete assignments[String(userId)];
    this.setState({ adminUserRoles: assignments, adminAccessSaved: false, adminAccessError: '' });
  }

  async saveAdminAccess() {
    if (this.state.adminAccessSaving) return;
    const users = new Map((this.state.adminUsers || []).map(user => [String(user.id), user]));
    const items = Object.entries(this.state.adminUserRoles)
      .filter(([userId, roleCode]) => !!roleCode && !users.get(userId)?.isBitrixAdmin)
      .map(([userId, roleCode]) => ({
        userId: Number(userId),
        userName: users.get(userId)?.name || `Пользователь #${userId}`,
        roleCode,
      }));
    this.setState({ adminAccessSaving: true, adminAccessError: '', adminAccessSaved: false });
    try {
      await this.api('/api/v1/registry/admin/user-roles', {
        method: 'PUT',
        body: JSON.stringify({ items }),
      });
      this.setState({ adminAccessSaving: false, adminAccessSaved: true });
    } catch (error) {
      this.setState({
        adminAccessSaving: false,
        adminAccessError: error instanceof Error ? error.message : 'Не удалось сохранить назначения ролей.',
      });
    }
  }

  wizardDocumentLinks(wizard = this.state.wz) {
    const links = new Map();
    for (const link of [
      ...this.creationContextLinks(),
      ...(Array.isArray(wizard.links) ? wizard.links : []),
    ]) {
      if (link.entityType !== 'deal' && link.entityType !== 'company') continue;
      links.set(`${link.entityType}:${link.entityId}`, link);
    }
    return [...links.values()];
  }

  async manageWizardLinks() {
    try {
      const selected = await this.requestCrmSelection(this.wizardDocumentLinks());
      const links = new Map(selected.map(link => [
        `${link.entityType}:${link.entityId}`,
        link,
      ]));
      for (const link of this.creationContextLinks()) {
        links.set(`${link.entityType}:${link.entityId}`, link);
      }
      this.setState({ wz: { ...this.state.wz, links: [...links.values()] } });
    } catch (error) {
      console.error('Failed to select CRM links for document', error);
    }
  }

  applyPlacementContext(context) {
    const placement = context && context.placement;
    const code = String(placement && placement.code || '').toUpperCase();
    const entityId = this.positiveEntityId(placement && placement.entityId)
      || this.placementEntityId(placement && placement.options);
    if (code === 'CRM_DEAL_DETAIL_TAB') {
      this.placementContextType = 'deal';
      this.placementEntity = entityId ? { entityType: 'deal', entityId } : null;
      this.setState({ screen: 'deal' });
      return;
    }
    if (code === 'CRM_COMPANY_DETAIL_TAB') {
      this.placementContextType = 'company';
      this.placementEntity = entityId ? { entityType: 'company', entityId } : null;
      this.setState({ screen: 'company' });
      return;
    }
    this.placementContextType = null;
    this.placementEntity = null;
    if (code === 'LEFT_MENU') this.setState({ screen: 'registry' });
  }

  clearContextDocuments() {
    this.entityContext = null;
    this.docs = [];
    this.documentsMeta = { total: 0, limit: 1000, offset: 0 };
    this.documentsSource = 'context_missing';
    this.forceUpdate();
  }

  placementEntityId(options) {
    let value = options;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return this.positiveEntityId(value); }
    }
    const direct = this.positiveEntityId(value);
    if (direct) return direct;
    if (!value || typeof value !== 'object') return null;
    const keys = ['ID', 'id', 'ENTITY_ID', 'entityId'];
    for (const key of keys) {
      const id = this.positiveEntityId(value[key]);
      if (id) return id;
    }
    for (const nestedKey of ['PLACEMENT_OPTIONS', 'placementOptions', 'options']) {
      const nested = value[nestedKey];
      if (!nested || typeof nested !== 'object') continue;
      for (const key of keys) {
        const id = this.positiveEntityId(nested[key]);
        if (id) return id;
      }
    }
    return null;
  }

  positiveEntityId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  bitrixCompanyUrl(companyId) {
    const id = this.positiveEntityId(companyId);
    const domain = String(this.bitrixContext && this.bitrixContext.auth && this.bitrixContext.auth.domain || '')
      .trim()
      .toLowerCase();
    if (!id || !/^[a-z0-9.-]+$/.test(domain)) return '';
    return `https://${domain}/crm/company/details/${id}/`;
  }
  state = {
    screen: 'registry',
    role: 'admin',
    registryLoading: true,
    registryReady: false,
    registryLoadError: '',
    accessDenied: false,
    activeSection: 'all',
    search: '',
    view: 'all',
    registryPage: 0,
    sel: {},
    registryUsers: [],
    bulkAssignOpen: false,
    bulkResponsibleId: '',
    responsibleMenuOpen: null,
    bulkBusy: false,
    bulkError: '',
    customSavedViews: [],
    activeSavedViewId: null,
    savedViewEditorOpen: false,
    savedViewEditingId: null,
    savedViewName: '',
    savedViewShared: false,
    savedViewSaving: false,
    savedViewError: '',
    rowMenuId: null,
    drawerId: null,
    drawerHistoryOpen: false,
    drawerEditing: false,
    drawerEditSaving: false,
    drawerEditError: '',
    drawerEdit: null,
    drawerLinkOpen: false,
    drawerLinkName: '',
    drawerLinkUrl: '',
    drawerLinkError: '',
    cols: this.loadColumnPreferences(),
    filterOpen: false, colsOpen: false,
    filters: { sections: {}, statuses: {}, type: 'all', responsible: 'all', cp: '', from: '', to: '' },
    dragTargetKey: null,
    bulkUploadOpen: false,
    bulkUploadRows: [],
    bulkUploadCommonSection: '',
    bulkUploadCommonType: '',
    bulkUploadCommonCompanyId: null,
    bulkUploadCommonCompanyName: '',
    bulkUploadCommonResponsibleId: '',
    bulkUploadCommonResponsibleName: '',
    bulkUploadContextLinks: [],
    bulkUploadBusy: false,
    bulkUploadError: '',
    bulkUploadDragActive: false,
    adminTab: 'sections',
    adminUsers: [],
    adminUserRoles: {},
    adminAccessLoading: false,
    adminAccessSaving: false,
    adminAccessError: '',
    adminAccessSaved: false,
    adminDataLoading: false,
    adminDataError: '',
    adminSections: [],
    adminTypes: [],
    adminLifecyclesData: [],
    adminPolicies: [],
    sectionModalOpen: false,
    editingSectionCode: null,
    sectionEdit: null,
    lifecycleModalOpen: false,
    editingLifecycleCode: null,
    lifecycleEdit: null,
    roleModalOpen: false,
    editingRoleCode: null,
    roleEdit: null,
    adminEditError: '',
    confirmDialog: null,
    expandedDeals: { '1234': true },
    collapsedGroups: {},
    companyView: 'deals',
    typeModalOpen: false,
    helpOpen: false,
    newType: { code: null, section: 'client', label: '', lifecycle: 'simple', description: '', sortOrder: 100, isActive: true, fields: [] },
    wizardOpen: false,
    wizardError: '',
    wz: { step: 1, sectionCode: null, typeLabel: null, number: '', date: '', amount: '', currency: 'RUB', counterparty: '', fieldVals: {}, links: [], file: null, externalLink: null, linkEditorOpen: false, linkName: '', linkUrl: '', linkError: '', supersedesId: null },
  };

  SECTIONS = [];
  TYPES = {};

  TYPE_META = {};
  LIFECYCLE_BY_CODE = {};
  serverPolicy = null;
  policyLoadError = null;
  registryInitializing = false;

  async loadRegistryData() {
    await Promise.all([
      this.loadCatalogs(),
      this.loadLifecycles(),
      this.loadPolicy(),
      this.loadDocuments(),
    ]);
  }

  async switchDevelopmentRole(role) {
    this.serverPolicy = null;
    this.setState({
      role,
      filters: { ...this.state.filters, sections: {} },
      sel: {},
      rowMenuId: null,
      drawerId: null,
      drawerEditing: false,
      drawerEditSaving: false,
      drawerEditError: '',
      drawerEdit: null,
      wizardOpen: false,
      wizardError: '',
    });
    await Promise.all([
      this.loadCatalogs(),
      this.loadLifecycles(),
      this.loadPolicy(),
    ]);
    if (this.placementEntity) await this.loadContextDocuments();
    else if (this.placementContextType) this.clearContextDocuments();
    else await Promise.all([this.loadDocuments(), this.loadDocumentOptions()]);
  }

  async loadContextDocuments() {
    if (!this.placementEntity) return;
    const requestId = (this.contextDocumentsRequestId || 0) + 1;
    this.contextDocumentsRequestId = requestId;
    const params = new URLSearchParams({
      entityType: this.placementEntity.entityType,
      entityId: String(this.placementEntity.entityId),
      limit: '1000',
      offset: '0',
    });
    try {
      const payload = await this.api(`/api/v1/registry/by-entity?${params.toString()}`);
      if (requestId !== this.contextDocumentsRequestId) return;
      this.entityContext = payload.context || null;
      this.docs = (payload.items || []).map(item => this.toDocument(item));
      this.documentsMeta = payload.meta || { total: this.docs.length, limit: 1000, offset: 0 };
      this.documentsSource = 'api';
      this.forceUpdate();
    } catch (error) {
      this.documentsSource = 'error';
      console.error('Failed to load registry context documents', error);
    }
  }

  async api(path, options = {}, canRetry = true) {
    const auth = this.bitrixContext && this.bitrixContext.auth;
    const developmentRole = this.state.role;
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const response = await fetch(path, {
      ...options,
      headers: {
        accept: 'application/json',
        ...(options.body && !isFormData ? { 'content-type': 'application/json' } : {}),
        ...(auth ? {
          authorization: `Bearer ${auth.accessToken}`,
          'x-bitrix-domain': auth.domain,
          'x-bitrix-member-id': auth.memberId,
        } : (developmentRole ? {
          'x-registry-development-role': developmentRole,
        } : {})),
        ...(options.headers || {}),
      },
    });
    if (response.status === 401 && canRetry) {
      const context = await this.requestBitrixContext(true);
      if (context && context.auth) return this.api(path, options, false);
    }
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const code = payload && payload.error ? payload.error.code : null;
      const message = payload && payload.error && payload.error.message
        ? payload.error.message
        : `Сервер реестра вернул ошибку ${response.status}.`;
      if (response.status === 403 && code === 'registry_access_not_assigned') {
        this.setState({ accessDenied: true });
      }
      const error = new Error(message);
      error.code = code;
      error.status = response.status;
      error.details = payload && payload.error ? payload.error.details : null;
      throw error;
    }
    return payload;
  }

  async download(path, canRetry = true) {
    const auth = this.bitrixContext && this.bitrixContext.auth;
    const developmentRole = this.state.role;
    const response = await fetch(path, {
      headers: {
        ...(auth ? {
          authorization: `Bearer ${auth.accessToken}`,
          'x-bitrix-domain': auth.domain,
          'x-bitrix-member-id': auth.memberId,
        } : (developmentRole ? {
          'x-registry-development-role': developmentRole,
        } : {})),
      },
    });
    if (response.status === 401 && canRetry) {
      const context = await this.requestBitrixContext(true);
      if (context && context.auth) return this.download(path, false);
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const message = payload && payload.error && payload.error.message
        ? payload.error.message
        : `Сервер реестра вернул ошибку ${response.status}.`;
      throw new Error(message);
    }
    const disposition = response.headers.get('content-disposition') || '';
    const filenameMatch = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = filenameMatch ? filenameMatch[1] : 'registry-documents.xlsx';
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  chooseFile() {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.style.display = 'none';
      input.addEventListener('change', () => resolve(input.files && input.files[0] ? input.files[0] : null), { once: true });
      input.click();
    });
  }

  chooseFiles() {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      input.addEventListener(
        'change',
        () => resolve(Array.from(input.files || [])),
        { once: true },
      );
      input.click();
    });
  }

  async uploadFileToDocument(documentId, file, replacesAttachmentId = null) {
    const initialized = await this.api(`/api/v1/registry/documents/${documentId}/attachments/file/init`, {
      method: 'POST',
      body: JSON.stringify({
        name: file.name,
        mimeType: file.type || undefined,
        sizeBytes: file.size,
        ...(replacesAttachmentId ? { replacesAttachmentId } : {}),
      }),
    });
    const form = new FormData();
    form.append(initialized.fieldName, file, initialized.name);
    return this.api(`/api/v1/registry/documents/${documentId}/attachments/file/${initialized.uploadId}`, {
      method: 'POST',
      body: form,
    });
  }

  normalizeExternalLink(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      url.hash = '';
      return url.toString();
    } catch {
      return null;
    }
  }

  async createExternalLink(documentId, link) {
    return this.api(`/api/v1/registry/documents/${documentId}/attachments/link`, {
      method: 'POST',
      body: JSON.stringify({
        name: String(link.name || '').trim() || undefined,
        url: link.url,
      }),
    });
  }

  async saveDrawerLink(documentId) {
    const url = this.normalizeExternalLink(this.state.drawerLinkUrl);
    if (!url) {
      this.setState({ drawerLinkError: 'Укажите корректную ссылку, начинающуюся с https://' });
      return;
    }
    try {
      await this.createExternalLink(documentId, {
        name: this.state.drawerLinkName,
        url,
      });
      this.setState({ drawerLinkOpen: false, drawerLinkName: '', drawerLinkUrl: '', drawerLinkError: '' });
      await this.openDocument(documentId);
    } catch (error) {
      this.setState({ drawerLinkError: error instanceof Error ? error.message : 'Не удалось добавить ссылку' });
    }
  }

  async openAttachment(documentId, attachmentId) {
    const opened = window.open('about:blank', '_blank');
    if (opened) opened.opener = null;
    try {
      const access = await this.api(`/api/v1/registry/documents/${documentId}/attachments/${attachmentId}/access`);
      if (opened) opened.location.replace(access.url);
      else window.open(access.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      if (opened) opened.close();
      console.error('Failed to open registry attachment', error);
    }
  }

  async deleteAttachment(documentId, attachmentId) {
    const confirmed = await this.requestConfirmation({
      title: 'Удалить вложение?',
      message: 'Вложение будет удалено из документа.',
    });
    if (!confirmed) return;
    try {
      await this.api(`/api/v1/registry/documents/${documentId}/attachments/${attachmentId}`, {
        method: 'DELETE',
      });
      await this.openDocument(documentId);
    } catch (error) {
      console.error('Failed to delete registry attachment', error);
    }
  }

  async addFileToDocument(documentId) {
    const file = await this.chooseFile();
    if (!file) return;
    try {
      await this.uploadFileToDocument(documentId, file);
      await this.openDocument(documentId);
    } catch (error) {
      console.error('Failed to add registry attachment', error);
    }
  }

  async replaceDocumentAttachment(documentId, attachmentId) {
    const file = await this.chooseFile();
    if (!file) return;
    try {
      await this.uploadFileToDocument(documentId, file, attachmentId);
      await this.openDocument(documentId);
    } catch (error) {
      console.error('Failed to replace registry attachment', error);
    }
  }

  openWizardForFile(file, sectionCode = null, links = []) {
    if (!file) return;
    const responsible = this.defaultResponsibleSelection();
    this.setState({
      wizardOpen: true,
      wizardError: '',
      responsibleMenuOpen: null,
      wz: { step: 1, sectionCode, typeLabel: null, number: '', date: '', amount: '', currency: 'RUB', counterparty: '', ...responsible, fieldVals: {}, links, file, externalLink: null, linkEditorOpen: false, linkName: '', linkUrl: '', linkError: '', supersedesId: null },
    });
  }

  bulkDocumentTitle(file) {
    const name = String(file && file.name || 'Документ').trim();
    return name.replace(/\.[^.]+$/, '') || name;
  }

  bulkContextCompany(links = []) {
    const combined = [...this.creationContextLinks(), ...(Array.isArray(links) ? links : [])];
    return combined.find(link => link.entityType === 'company') || null;
  }

  openBulkUpload(files = [], sectionCode = null, links = []) {
    const company = this.bulkContextCompany(links);
    const responsible = this.defaultResponsibleSelection();
    this.setState({
      bulkUploadOpen: true,
      bulkUploadRows: [],
      bulkUploadCommonSection: sectionCode || '',
      bulkUploadCommonType: '',
      bulkUploadCommonCompanyId: company ? Number(company.entityId) : null,
      bulkUploadCommonCompanyName: company ? company.entityTitle : '',
      bulkUploadCommonResponsibleId: responsible.responsibleId || '',
      bulkUploadCommonResponsibleName: responsible.responsibleName || '',
      bulkUploadContextLinks: Array.isArray(links) ? links : [],
      bulkUploadBusy: false,
      bulkUploadError: '',
      bulkUploadDragActive: false,
    });
    requestAnimationFrame(() => this.appendBulkUploadFiles(files, {
      sectionCode,
      links,
      company,
      responsible,
    }));
  }

  appendBulkUploadFiles(files, defaults = {}) {
    const selected = Array.from(files || []).filter(file => file && file.name);
    if (!selected.length) return;
    const sectionCode = defaults.sectionCode !== undefined
      ? defaults.sectionCode
      : this.state.bulkUploadCommonSection;
    const company = defaults.company !== undefined
      ? defaults.company
      : (this.state.bulkUploadCommonCompanyId ? {
          entityId: this.state.bulkUploadCommonCompanyId,
          entityTitle: this.state.bulkUploadCommonCompanyName,
        } : null);
    const responsible = defaults.responsible || {
      responsibleId: this.state.bulkUploadCommonResponsibleId,
      responsibleName: this.state.bulkUploadCommonResponsibleName,
    };
    const links = defaults.links !== undefined
      ? defaults.links
      : this.state.bulkUploadContextLinks;
    const date = new Date().toISOString().slice(0, 10);
    const rows = selected.map((file, index) => ({
      id: `bulk-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
      file,
      title: this.bulkDocumentTitle(file),
      sectionCode: sectionCode || '',
      typeLabel: '',
      documentDate: date,
      amount: '',
      currency: 'RUB',
      counterpartyId: company ? Number(company.entityId) : null,
      counterpartyName: company ? company.entityTitle : '',
      responsibleId: responsible.responsibleId || '',
      responsibleName: responsible.responsibleName || '',
      fieldVals: {},
      links: Array.isArray(links) ? links : [],
      status: 'ready',
      error: '',
      documentId: null,
    }));
    this.setState({
      bulkUploadRows: [...(this.state.bulkUploadRows || []), ...rows],
      bulkUploadError: '',
    });
  }

  updateBulkUploadRow(id, patch) {
    this.setState({
      bulkUploadRows: (this.state.bulkUploadRows || []).map(row =>
        row.id === id ? { ...row, ...patch, error: patch.error ?? '' } : row),
      bulkUploadError: '',
    });
  }

  removeBulkUploadRow(id) {
    if (this.state.bulkUploadBusy) return;
    this.setState({
      bulkUploadRows: (this.state.bulkUploadRows || []).filter(row => row.id !== id),
      bulkUploadError: '',
    });
  }

  applyBulkUploadCommon() {
    const sectionCode = this.state.bulkUploadCommonSection || '';
    const typeLabel = this.state.bulkUploadCommonType || '';
    const typeAllowed = typeLabel && (this.TYPES[sectionCode] || []).includes(typeLabel);
    this.setState({
      bulkUploadRows: (this.state.bulkUploadRows || []).map(row => {
        const nextTypeLabel = typeAllowed ? typeLabel : (sectionCode ? '' : row.typeLabel);
        const fieldsChanged = (sectionCode && sectionCode !== row.sectionCode)
          || (typeAllowed && typeLabel !== row.typeLabel);
        return {
          ...row,
          ...(sectionCode ? { sectionCode } : {}),
          ...(typeAllowed ? { typeLabel } : (sectionCode ? { typeLabel: '' } : {})),
          ...(fieldsChanged ? { fieldVals: {} } : {}),
          ...(this.state.bulkUploadCommonCompanyId ? {
            counterpartyId: this.state.bulkUploadCommonCompanyId,
            counterpartyName: this.state.bulkUploadCommonCompanyName,
          } : {}),
          ...(this.state.bulkUploadCommonResponsibleId ? {
            responsibleId: this.state.bulkUploadCommonResponsibleId,
            responsibleName: this.state.bulkUploadCommonResponsibleName,
          } : {}),
          typeLabel: nextTypeLabel,
          status: row.status === 'success' ? row.status : 'ready',
          error: '',
        };
      }),
      bulkUploadError: '',
    });
  }

  async pickBulkUploadCompany(rowId = null) {
    const row = rowId
      ? (this.state.bulkUploadRows || []).find(item => item.id === rowId)
      : null;
    const currentId = row ? row.counterpartyId : this.state.bulkUploadCommonCompanyId;
    try {
      const selected = await this.requestCrmSelection(
        currentId ? [{ entityType: 'company', entityId: currentId, entityTitle: row ? row.counterpartyName : this.state.bulkUploadCommonCompanyName }] : [],
        { entityTypes: ['company'], multiple: false },
      );
      const company = selected.find(item => item.entityType === 'company');
      if (!company) return;
      if (rowId) {
        this.updateBulkUploadRow(rowId, {
          counterpartyId: company.entityId,
          counterpartyName: company.entityTitle,
        });
      } else {
        this.setState({
          bulkUploadCommonCompanyId: company.entityId,
          bulkUploadCommonCompanyName: company.entityTitle,
          bulkUploadError: '',
        });
      }
    } catch (error) {
      this.setState({
        bulkUploadError: error instanceof Error
          ? error.message
          : 'Не удалось выбрать компанию Bitrix24.',
      });
    }
  }

  bulkUploadValidation(row) {
    if (!row.sectionCode) return 'Выберите раздел.';
    const type = this.typeMeta(row.sectionCode, row.typeLabel);
    if (!type) return 'Выберите тип документа.';
    if (!this.canCreateType(type)) return 'Для этого типа документов создание запрещено политикой роли.';
    if (!String(row.title || '').trim()) return 'Укажите название документа.';
    if (!this.toIsoDocumentDate(row.documentDate)) return 'Укажите дату документа.';
    if (!Number(row.responsibleId)) return 'Выберите ответственного.';
    if (row.counterpartyName && !Number(row.counterpartyId)) {
      return 'Выберите компанию из справочника Bitrix24.';
    }
    if (type.isFinancial && !String(row.amount || '').trim()) {
      return 'Укажите сумму финансового документа.';
    }
    for (const field of type.fields || []) {
      const rawValue = (row.fieldVals || {})[field.key];
      const normalized = this.normalizedDocumentFieldValue(field, rawValue);
      if (field.isRequired && (normalized === null || normalized === '')) {
        return `Заполните обязательное поле «${field.label}».`;
      }
      if (field.dataType === 'date' && rawValue && !normalized) {
        return `Укажите корректную дату в поле «${field.label}».`;
      }
      if ((field.dataType === 'number' || field.dataType === 'money')
        && normalized !== null && !/^-?\d+(\.\d+)?$/.test(normalized)) {
        return `Укажите число в поле «${field.label}».`;
      }
    }
    return '';
  }

  async createBulkUploadRow(row) {
    const validation = this.bulkUploadValidation(row);
    if (validation) throw new Error(validation);
    const type = this.typeMeta(row.sectionCode, row.typeLabel);
    const amount = String(row.amount || '').replace(/\s/g, '').replace(',', '.');
    const fields = {};
    (type.fields || []).forEach(field => {
      fields[field.key] = this.normalizedDocumentFieldValue(
        field,
        (row.fieldVals || {})[field.key],
      );
    });
    let payload = await this.api('/api/v1/registry/documents', {
      method: 'POST',
      body: JSON.stringify({
        sectionCode: row.sectionCode,
        typeCode: type.code,
        title: String(row.title).trim(),
        documentDate: this.toIsoDocumentDate(row.documentDate),
        counterpartyId: row.counterpartyId || undefined,
        counterpartyName: row.counterpartyName || null,
        responsibleId: Number(row.responsibleId),
        responsibleName: row.responsibleName || undefined,
        links: this.wizardDocumentLinks({ links: row.links || [] }),
        fields,
        ...(!this.roleHidesMoney(type.code) ? {
          amount: amount || null,
          currency: amount ? row.currency : null,
        } : {}),
      }),
    });
    try {
      const attachment = await this.uploadFileToDocument(payload.id, row.file);
      payload = { ...payload, attachments: [...(payload.attachments || []), attachment] };
      return payload;
    } catch (error) {
      await this.api(`/api/v1/registry/documents/${payload.id}/abandon`, { method: 'POST' })
        .catch(cleanupError => console.error('Failed to abandon incomplete bulk document', cleanupError));
      throw error;
    }
  }

  async createBulkUpload(rowIds = null) {
    if (this.state.bulkUploadBusy) return;
    const selectedIds = rowIds ? new Set(rowIds) : null;
    const candidates = (this.state.bulkUploadRows || []).filter(row =>
      row.status !== 'success' && (!selectedIds || selectedIds.has(row.id)));
    if (!candidates.length) return;
    const invalidRows = candidates.filter(row => this.bulkUploadValidation(row));
    if (invalidRows.length) {
      this.setState({
        bulkUploadRows: (this.state.bulkUploadRows || []).map(row => {
          const error = selectedIds && !selectedIds.has(row.id)
            ? ''
            : this.bulkUploadValidation(row);
          return error ? { ...row, status: 'error', error } : row;
        }),
        bulkUploadError: 'Исправьте поля, отмеченные в строках.',
      });
      return;
    }
    this.setState({ bulkUploadBusy: true, bulkUploadError: '' });
    for (const candidate of candidates) {
      this.updateBulkUploadRow(candidate.id, { status: 'uploading', error: '' });
      try {
        const created = await this.createBulkUploadRow(candidate);
        this.updateBulkUploadRow(candidate.id, {
          status: 'success',
          documentId: created.id,
          error: '',
        });
      } catch (error) {
        this.updateBulkUploadRow(candidate.id, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Не удалось загрузить файл.',
        });
      }
    }
    this.setState({ bulkUploadBusy: false });
    if (this.placementEntity) await this.loadContextDocuments();
    else await Promise.all([this.loadDocuments(), this.loadDocumentOptions()]);
  }

  openSupersedingWizard(document) {
    if (!document || !this.canSupersedeDocument(document) || document.status === 'archived') return;
    const fieldVals = Object.fromEntries(
      (document.dynamicFields || []).map(field => [field.key, this.documentEditFieldValue(field, document)]),
    );
    this.setState({
      drawerId: null,
      drawerEditing: false,
      responsibleMenuOpen: null,
      wizardOpen: true,
      wizardError: '',
      wz: {
        step: 2,
        sectionCode: document.section,
        typeLabel: document.type,
        number: '',
        date: document.documentDateRaw || '',
        amount: document.amountRaw || '',
        currency: document.currency || 'RUB',
        counterparty: document.counterpartyNameRaw || '',
        responsibleId: document.responsibleId ? String(document.responsibleId) : '',
        responsibleName: document.responsibleNameRaw || '',
        fieldVals,
        links: (document.links || []).map(link => ({
          entityType: link.entityType,
          entityId: Number(link.entityId),
          entityTitle: link.title,
        })),
        file: null,
        externalLink: null,
        linkEditorOpen: false,
        linkName: '',
        linkUrl: '',
        linkError: '',
        supersedesId: document.id,
        sourceTitle: document.title || '',
        legalEntityId: document.legalEntityId || null,
        legalEntityName: document.legalEntityNameRaw || '',
        counterpartyId: document.counterpartyId || null,
        sourceCounterpartyName: document.counterpartyNameRaw || '',
        dealStageId: document.dealStageIdRaw || '',
        comment: document.comment || '',
        responsibleId: document.responsibleId || null,
        responsibleName: document.responsibleNameRaw || '',
      },
    });
  }

  hasDraggedFiles(event) {
    const transfer = event && event.dataTransfer;
    if (!transfer) return false;
    if (transfer.files && transfer.files.length > 0) return true;
    return Array.from(transfer.types || []).includes('Files');
  }

  handleNativeFileDrag(event) {
    if (!this.hasDraggedFiles(event)) return;

    const target = event.target && event.target.nodeType === 1
      ? event.target
      : event.target && event.target.parentElement;
    const zone = target && target.closest
      ? target.closest('[data-registry-drop-zone="true"]')
      : null;

    if (event.type === 'dragenter' || event.type === 'dragover' || event.type === 'drop') {
      event.preventDefault();
    }

    if (!zone) {
      if (event.type === 'drop') this.setState({ dragTargetKey: null });
      return;
    }

    const targetKey = zone.getAttribute('data-drop-key');
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';

    if (event.type === 'dragenter' || event.type === 'dragover') {
      if (targetKey && this.state.dragTargetKey !== targetKey) {
        this.setState({ dragTargetKey: targetKey });
      }
      return;
    }

    if (event.type === 'dragleave') {
      const related = event.relatedTarget;
      if (related && zone.contains(related)) return;
      if (targetKey && this.state.dragTargetKey === targetKey) {
        this.setState({ dragTargetKey: null });
      }
      return;
    }

    event.stopPropagation();
    const files = event.dataTransfer && event.dataTransfer.files
      ? Array.from(event.dataTransfer.files)
      : [];
    this.setState({ dragTargetKey: null });
    if (!files.length) return;

    const sectionCode = zone.getAttribute('data-section-code');
    const dealId = zone.getAttribute('data-deal-id');
    const companyId = zone.getAttribute('data-company-id');
    const links = [];
    if (dealId) {
      links.push({
        entityType: 'deal',
        entityId: dealId,
        entityTitle: zone.getAttribute('data-deal-title') || '',
      });
    }
    if (companyId) {
      links.push({
        entityType: 'company',
        entityId: companyId,
        entityTitle: zone.getAttribute('data-company-title') || '',
      });
    }
    if (files.length > 1) this.openBulkUpload(files, sectionCode, links);
    else this.openWizardForFile(files[0], sectionCode, links);
  }

  handleFileDragOver(event, targetKey = null) {
    if (!event || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (targetKey && this.state.dragTargetKey !== targetKey) {
      this.setState({ dragTargetKey: targetKey });
    }
  }

  handleFileDragLeave(event, targetKey) {
    if (!event || this.state.dragTargetKey !== targetKey) return;
    const current = event.currentTarget;
    const related = event.relatedTarget;
    if (current && related && current.contains(related)) return;
    this.setState({ dragTargetKey: null });
  }

  handleSectionFileDrop(event, sectionCode, links = [], targetKey = null) {
    if (!event || !event.dataTransfer) return;
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from(event.dataTransfer.files || []);
    if (targetKey && this.state.dragTargetKey === targetKey) {
      this.setState({ dragTargetKey: null });
    }
    if (files.length > 1) this.openBulkUpload(files, sectionCode, links);
    else this.openWizardForFile(files[0], sectionCode, links);
  }

  async loadCatalogs() {
    try {
      const payload = await this.api('/api/v1/registry/sections');
      if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
        throw new Error('Catalog API returned no sections');
      }

      const backgroundByCode = {
        client: '#eef2ff', supplier: '#e6f5f2', logistics: '#fdf2e3',
        customs: '#fdeaea', legal: '#f2ecfd', internal: '#eef1f5',
      };
      const nextTypes = {};
      const nextTypeMeta = {};
      this.SECTIONS = payload.items.map(section => {
        const sectionTypes = Array.isArray(section.types) ? section.types : [];
        nextTypes[section.code] = sectionTypes.map(type => type.name);
        nextTypeMeta[section.code] = Object.fromEntries(
          sectionTypes.map(type => [type.name, type]),
        );
        return {
          code: section.code,
          label: section.name,
          c: section.color || '#64748b',
          bg: backgroundByCode[section.code] || '#f4f4f5',
        };
      });
      this.TYPES = nextTypes;
      this.TYPE_META = nextTypeMeta;
      this.catalogSource = 'api';
      this.forceUpdate();
    } catch (error) {
      this.catalogSource = 'error';
      console.error('Failed to load registry catalogs', error);
    }
  }

  async loadLifecycles() {
    try {
      const payload = await this.api('/api/v1/registry/lifecycles');
      this.LIFECYCLE_BY_CODE = Object.fromEntries(
        (payload.items || []).map(item => [item.code, item]),
      );
      (payload.items || []).forEach(item => {
        (item.config.states || []).forEach(state => {
          this.STATUS[state.code] = {
            label: state.label,
            c: state.color || '#71717a',
            bg: this.statusBackground(state.code),
          };
        });
      });
      this.forceUpdate();
    } catch (error) {
      console.error('Failed to load registry lifecycles', error);
    }
  }

  async loadPolicy() {
    try {
      this.serverPolicy = await this.api('/api/v1/registry/me/policy');
      this.policyLoadError = null;
      this.setState({ role: this.serverPolicy.roleCode });
      return true;
    } catch (error) {
      this.policyLoadError = error;
      console.error('Failed to load registry policy', error);
      return false;
    }
  }

  documentPageSize = 50;
  documentsMeta = { total: 0, limit: 50, offset: 0 };
  documentOptions = {
    scopeTotal: 0,
    archiveTotal: 0,
    sections: {},
    views: { all: 0, mine: 0, work: 0, draft: 0 },
    responsibles: [],
  };

  documentQueryParams() {
    const params = new URLSearchParams();
    const filters = this.state.filters;
    const search = String(this.state.search || '').trim();
    const sections = Object.keys(filters.sections).filter(code => filters.sections[code]);
    const statuses = Object.keys(filters.statuses).filter(code => filters.statuses[code]);
    const view = this.state.view === 'awaiting' ? 'work' : this.state.view;
    if (this.state.screen === 'archive') params.set('deleted', 'only');
    if (search) params.set('search', search);
    if (view && view !== 'all') params.set('view', view);
    if (sections.length) params.set('sections', sections.join(','));
    if (statuses.length) params.set('statuses', statuses.join(','));
    if (filters.type !== 'all') params.set('type', filters.type);
    if (filters.responsible !== 'all') params.set('responsibleId', filters.responsible);
    if (String(filters.cp || '').trim()) params.set('counterparty', filters.cp.trim());
    const from = this.toIsoDocumentDate(filters.from);
    const to = this.toIsoDocumentDate(filters.to);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    params.set('limit', String(this.documentPageSize));
    params.set('offset', String(this.state.registryPage * this.documentPageSize));
    return params;
  }

  async exportRegistry() {
    const params = this.documentQueryParams();
    params.delete('limit');
    params.delete('offset');
    params.set('columns', Object.keys(this.state.cols).filter(key => this.state.cols[key]).join(','));
    try {
      await this.download(`/api/v1/registry/documents/export.xlsx?${params.toString()}`);
    } catch (error) {
      console.error('Failed to export registry documents', error);
    }
  }

  scheduleDocumentsReload(delay = 0) {
    if (this.documentsReloadTimer) clearTimeout(this.documentsReloadTimer);
    this.documentsReloadTimer = setTimeout(() => {
      this.documentsReloadTimer = null;
      void this.loadDocuments();
    }, delay);
  }

  updateRegistryFilters(patch, delay = 0) {
    this.setState({
      filters: { ...this.state.filters, ...patch },
      activeSavedViewId: null,
      registryPage: 0,
      sel: {},
    });
    this.scheduleDocumentsReload(delay);
  }

  updateRegistrySearch(value) {
    this.setState({ search: value, activeSavedViewId: null, registryPage: 0, sel: {} });
    this.scheduleDocumentsReload(250);
  }

  updateRegistryView(view) {
    this.setState({ view, activeSavedViewId: null, registryPage: 0, sel: {} });
    this.scheduleDocumentsReload();
  }

  goToRegistryPage(page) {
    const pageCount = Math.max(1, Math.ceil(this.documentsMeta.total / this.documentPageSize));
    const nextPage = Math.max(0, Math.min(page, pageCount - 1));
    if (nextPage === this.state.registryPage) return;
    this.setState({ registryPage: nextPage, sel: {} });
    this.scheduleDocumentsReload();
  }

  async loadDocumentOptions() {
    try {
      this.documentOptions = await this.api('/api/v1/registry/documents/options');
      this.forceUpdate();
    } catch (error) {
      console.error('Failed to load registry document options', error);
    }
  }

  async loadDocuments() {
    const requestId = (this.documentsRequestId || 0) + 1;
    this.documentsRequestId = requestId;
    try {
      const payload = await this.api(`/api/v1/registry/documents?${this.documentQueryParams().toString()}`);
      if (requestId !== this.documentsRequestId) return;
      const pageCount = Math.max(1, Math.ceil(payload.meta.total / this.documentPageSize));
      if (this.state.registryPage >= pageCount) {
        this.setState({ registryPage: pageCount - 1, sel: {} });
        this.scheduleDocumentsReload();
        return;
      }
      this.docs = (payload.items || []).map(item => this.toDocument(item));
      this.documentsMeta = payload.meta;
      this.documentsSource = 'api';
      this.forceUpdate();
    } catch (error) {
      this.documentsSource = 'error';
      console.error('Failed to load registry documents', error);
    }
  }

  statusBackground(code) {
    return {
      draft: '#f4f4f5', on_review: '#fdf2e3', awaiting: '#eef2ff',
      signed: '#e7f5ec', active: '#e7f5ec', overdue: '#fdeaea',
      expired: '#fdeaea', archived: '#f4f4f5',
    }[code] || '#f4f4f5';
  }

  formatDocumentDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
    return match ? `${match[3]}.${match[2]}.${match[1]}` : '—';
  }

  toIsoDocumentDate(value) {
    const source = String(value || '').trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(source);
    const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(source);
    const parts = iso
      ? { year: iso[1], month: iso[2], day: iso[3] }
      : (ru ? { year: ru[3], month: ru[2], day: ru[1] } : null);
    if (!parts) return null;
    const normalized = `${parts.year}-${parts.month}-${parts.day}`;
    const date = new Date(`${normalized}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(normalized)
      ? normalized
      : null;
  }

  formatHistoryDate(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date(value));
  }

  historyLabel(event) {
    return {
      document_created: 'Документ создан', document_updated: 'Документ изменён',
      status_changed: 'Статус изменён', document_deleted: 'Документ удалён',
      document_restored: 'Документ восстановлен', document_creation_abandoned: 'Создание отменено',
      attachment_added: 'Вложение добавлено', attachment_deleted: 'Вложение удалено',
      attachment_replaced: 'Вложение заменено новой версией',
      document_superseded: 'Создана новая редакция документа',
      document_supersede_reverted: 'Создание новой редакции отменено',
      responsible_changed: 'Ответственный изменён',
      link_added: 'Привязка добавлена', link_removed: 'Привязка удалена',
      crm_entity_title_updated: 'Название CRM-сущности обновлено',
      crm_entity_deleted: 'CRM-сущность удалена',
    }[event] || event;
  }

  formatDynamicField(field) {
    const value = field && field.value;
    if (value === null || value === undefined || value === '') return '—';
    if (field.dataType === 'boolean') return value ? 'Да' : 'Нет';
    if (field.dataType === 'date') return this.formatDocumentDate(value);
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  toDocument(item, previous = {}) {
    const typeMeta = this.TYPE_META[item.section.code]
      ? this.TYPE_META[item.section.code][item.type.name]
      : null;
    const attachments = Array.isArray(item.attachments)
      ? item.attachments.map(attachment => ({
          id: attachment.id,
          icon: attachment.kind === 'link' ? '🔗' : '📎',
          name: attachment.name,
          meta: attachment.kind === 'link'
            ? 'Внешняя ссылка'
            : `${attachment.sizeBytes ? Math.ceil(attachment.sizeBytes / 1024) + ' КБ · ' : ''}v${attachment.version || 1}`,
          url: attachment.url || null,
          kind: attachment.kind,
          isCurrent: attachment.isCurrent !== false,
          replacesAttachmentId: attachment.replacesAttachmentId || null,
        }))
      : (previous.atts || []);
    const links = Array.isArray(item.links)
      ? item.links.map(link => ({
          id: link.id,
          type: link.entityType === 'deal' ? 'Сделка' : 'Компания',
          title: link.entityTitle,
          entityType: link.entityType,
          entityId: link.entityId,
        }))
      : (previous.links || []);
    const dealLink = links.find(link => link.entityType === 'deal');
    const dynamicFields = Array.isArray(item.fields)
      ? item.fields.map(field => ({
          key: field.key,
          label: field.label,
          dataType: field.dataType,
          rawValue: field.value,
          value: this.formatDynamicField(field),
        }))
      : (previous.dynamicFields || []);
    const history = Array.isArray(item.history)
      ? item.history.map(entry => ({
          what: this.historyLabel(entry.event),
          who: entry.actorId ? `Пользователь #${entry.actorId}` : 'Система',
          when: this.formatHistoryDate(entry.createdAt),
        }))
      : (previous.history || []);
    const storedResponsibleName = item.responsibleName
      && !/^Пользователь #\d+$/.test(item.responsibleName)
      ? item.responsibleName
      : '';
    const responsibleName = storedResponsibleName
      || this.responsibleNameById(item.responsibleId)
      || (previous.responsibleNameRaw && !/^Пользователь #\d+$/.test(previous.responsibleNameRaw)
        ? previous.responsibleNameRaw
        : '');
    return {
      ...previous,
      id: item.id,
      num: item.number || '—',
      numberRaw: item.number || '',
      title: item.title,
      section: item.section.code,
      type: item.type.name,
      typeCode: item.type.code,
      lifecycleCode: item.type.lifecycleCode || (typeMeta && typeMeta.lifecycleCode) || previous.lifecycleCode || null,
      isFinancial: !!item.type.isFinancial,
      status: item.status,
      counterparty: item.counterpartyName || '—',
      counterpartyId: item.counterpartyId || null,
      counterpartyNameRaw: item.counterpartyName || '',
      legalEntity: item.legalEntityName || '—',
      legalEntityId: item.legalEntityId || null,
      legalEntityNameRaw: item.legalEntityName || '',
      dealStageIdRaw: item.dealStageId || '',
      amount: item.amount == null ? 0 : Number(item.amount),
      amountRaw: item.amount == null ? '' : String(item.amount),
      currency: item.currency || '',
      moneyHidden: !!item.moneyHidden,
      docDate: this.formatDocumentDate(item.documentDate),
      documentDateRaw: item.documentDate || '',
      comment: item.comment || '',
      responsibleId: item.responsibleId || null,
      responsible: responsibleName || '—',
      responsibleNameRaw: responsibleName,
      createdBy: item.createdBy || null,
      supersedesId: item.supersedesId || null,
      deletedAt: item.deletedAt || null,
      deletedBy: item.deletedBy || null,
      atts: attachments,
      links,
      dynamicFields,
      history,
      deal: !!dealLink,
      dealRef: dealLink ? String(dealLink.entityId) : null,
    };
  }

  typePermission(typeCode, key, fallback) {
    const permissions = this.serverPolicy && this.serverPolicy.permissions;
    if (!permissions || !typeCode) return !!fallback;
    const override = permissions.byType && permissions.byType[typeCode]
      ? permissions.byType[typeCode][key]
      : undefined;
    return override === undefined ? !!fallback : override === true;
  }

  canCreateType(type) {
    const permissions = this.serverPolicy && this.serverPolicy.permissions;
    if (!type || !permissions) return false;
    return this.typePermission(type.code, 'create', permissions.create === true);
  }

  canEditDocument(document) {
    const policy = this.serverPolicy;
    const permissions = policy && policy.permissions;
    if (!document || !policy || !permissions) return false;
    const userId = Number(policy.userId);
    const own = Number(document.createdBy) === userId
      || Number(document.responsibleId) === userId;
    const fallback = !!permissions.editAny || (!!permissions.editOwn && own);
    return this.typePermission(document.typeCode, 'edit', fallback);
  }

  canTransitionDocument(document) {
    const policy = this.serverPolicy;
    const permissions = policy && policy.permissions;
    if (!document || !policy || !permissions) return false;
    const userId = Number(policy.userId);
    const own = Number(document.createdBy) === userId
      || Number(document.responsibleId) === userId;
    const fallback = !!permissions.transitionAny || (!!permissions.transitionOwn && own);
    return this.typePermission(document.typeCode, 'transition', fallback);
  }

  canArchiveDocument(document, restore = false) {
    const permissions = this.serverPolicy && this.serverPolicy.permissions;
    if (!document || !permissions) return false;
    return this.typePermission(
      document.typeCode,
      'archive',
      restore ? permissions.restore === true : permissions.softDelete === true,
    );
  }

  canSupersedeDocument(document) {
    const type = document ? this.typeMeta(document.section, document.type) : null;
    return !!document
      && this.canEditDocument(document)
      && this.canCreateType(type)
      && this.typePermission(document.typeCode, 'archive', true);
  }

  documentEditFieldValue(field, document) {
    const current = (document.dynamicFields || []).find(item => item.key === field.key);
    const value = current ? current.rawValue : null;
    if (value === null || value === undefined) return '';
    if (field.dataType === 'boolean') return value ? 'Да' : 'Нет';
    if (field.dataType === 'date') return String(value).slice(0, 10);
    return String(value);
  }

  createDocumentEditState(document) {
    const type = this.typeMeta(document.section, document.type);
    const fieldVals = {};
    (type && type.fields ? type.fields : []).forEach(field => {
      fieldVals[field.key] = this.documentEditFieldValue(field, document);
    });
    return {
      title: document.title || '',
      number: document.numberRaw || '',
      date: document.documentDateRaw || '',
      amount: document.amountRaw || '',
      currency: document.currency || 'RUB',
      legalEntityName: document.legalEntityNameRaw || '',
      counterpartyName: document.counterpartyNameRaw || '',
      dealStageId: document.dealStageIdRaw || '',
      responsibleId: document.responsibleId ? String(document.responsibleId) : '',
      comment: document.comment || '',
      fieldVals,
    };
  }

  beginDocumentEdit(document) {
    if (!this.canEditDocument(document)) return;
    this.setState({
      rowMenuId: null,
      drawerEditing: true,
      drawerEditSaving: false,
      drawerEditError: '',
      drawerEdit: this.createDocumentEditState(document),
      drawerLinkOpen: false,
    });
  }

  cancelDocumentEdit() {
    this.setState({
      drawerEditing: false,
      drawerEditSaving: false,
      drawerEditError: '',
      drawerEdit: null,
    });
  }

  updateDocumentEdit(key, value) {
    const edit = this.state.drawerEdit;
    if (!edit) return;
    this.setState({
      drawerEdit: { ...edit, [key]: value },
      drawerEditError: '',
    });
  }

  updateDocumentEditField(key, value) {
    const edit = this.state.drawerEdit;
    if (!edit) return;
    this.setState({
      drawerEdit: {
        ...edit,
        fieldVals: { ...(edit.fieldVals || {}), [key]: value },
      },
      drawerEditError: '',
    });
  }

  normalizedDocumentFieldValue(field, rawValue) {
    const value = rawValue === null || rawValue === undefined
      ? ''
      : String(rawValue).trim();
    if (!value) return null;
    if (field.dataType === 'date') return this.toIsoDocumentDate(value);
    if (field.dataType === 'number' || field.dataType === 'money') {
      return value.replace(/\s/g, '').replace(',', '.');
    }
    if (field.dataType === 'boolean') return value === 'Да';
    return value;
  }

  async saveDocumentEdit() {
    const id = this.state.drawerId;
    const edit = this.state.drawerEdit;
    const current = this.docs.find(document => document.id === id);
    if (!id || !edit || !current || this.state.drawerEditSaving) return;

    const title = String(edit.title || '').trim();
    const documentDate = this.toIsoDocumentDate(edit.date);
    if (!title) {
      this.setState({ drawerEditError: 'Укажите название документа.' });
      return;
    }
    if (!documentDate) {
      this.setState({ drawerEditError: 'Укажите корректную дату документа.' });
      return;
    }

    const amount = String(edit.amount || '').replace(/\s/g, '').replace(',', '.');
    const currency = String(edit.currency || '').trim().toUpperCase();
    if (!current.moneyHidden && amount && !/^\d+(\.\d{1,2})?$/.test(amount)) {
      this.setState({ drawerEditError: 'Сумма должна быть положительным числом с двумя знаками после запятой.' });
      return;
    }
    if (!current.moneyHidden && current.isFinancial && (!amount || currency.length !== 3)) {
      this.setState({ drawerEditError: 'Для финансового документа обязательны сумма и валюта.' });
      return;
    }

    const responsibleId = Number(edit.responsibleId);
    if (!Number.isSafeInteger(responsibleId) || responsibleId <= 0) {
      this.setState({ drawerEditError: 'Выберите ответственного.' });
      return;
    }

    const type = this.typeMeta(current.section, current.type);
    const typeFields = type && type.fields ? type.fields : [];
    const fields = {};
    for (const field of typeFields) {
      const rawValue = (edit.fieldVals || {})[field.key];
      const normalized = this.normalizedDocumentFieldValue(field, rawValue);
      if (field.isRequired && (normalized === null || normalized === '')) {
        this.setState({ drawerEditError: `Заполните обязательное поле «${field.label}».` });
        return;
      }
      if (field.dataType === 'date' && rawValue && !normalized) {
        this.setState({ drawerEditError: `Укажите корректную дату в поле «${field.label}».` });
        return;
      }
      if ((field.dataType === 'number' || field.dataType === 'money')
        && normalized !== null && !/^-?\d+(\.\d+)?$/.test(normalized)) {
        this.setState({ drawerEditError: `Укажите число в поле «${field.label}».` });
        return;
      }
      fields[field.key] = normalized;
    }

    const responsible = (this.state.registryUsers.length
      ? this.state.registryUsers
      : (this.documentOptions.responsibles || []))
      .find(item => Number(item.id) === responsibleId);
    const legalEntityName = String(edit.legalEntityName || '').trim();
    const counterpartyName = String(edit.counterpartyName || '').trim();
    const payload = {
      title,
      number: String(edit.number || '').trim() || null,
      documentDate,
      legalEntityId: legalEntityName === current.legalEntityNameRaw
        ? current.legalEntityId
        : null,
      legalEntityName: legalEntityName || null,
      counterpartyId: counterpartyName === current.counterpartyNameRaw
        ? current.counterpartyId
        : null,
      counterpartyName: counterpartyName || null,
      dealStageId: String(edit.dealStageId || '').trim() || null,
      comment: String(edit.comment || '').trim() || null,
      responsibleId,
      responsibleName: responsible
        ? responsible.name
        : (responsibleId === Number(current.responsibleId) ? current.responsibleNameRaw || null : null),
      fields,
      ...(!current.moneyHidden ? {
        amount: amount || null,
        currency: currency || null,
      } : {}),
    };

    this.setState({ drawerEditSaving: true, drawerEditError: '' });
    try {
      const response = await this.api(`/api/v1/registry/documents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      const index = this.docs.findIndex(document => document.id === id);
      if (index !== -1) this.docs[index] = this.toDocument(response, current);
      this.setState({
        drawerEditing: false,
        drawerEditSaving: false,
        drawerEditError: '',
        drawerEdit: null,
      });
      await this.loadDocumentOptions();
      this.forceUpdate();
    } catch (error) {
      this.setState({
        drawerEditSaving: false,
        drawerEditError: error instanceof Error ? error.message : 'Не удалось сохранить документ.',
      });
    }
  }

  async openDocument(id, startEditing = false) {
    const requestId = (this.documentOpenRequestId || 0) + 1;
    this.documentOpenRequestId = requestId;
    this.setState({
      rowMenuId: null,
    });
    try {
      const deletedQuery = this.state.screen === 'archive' ? '?deleted=only' : '';
      const payload = await this.api(`/api/v1/registry/documents/${id}${deletedQuery}`);
      if (requestId !== this.documentOpenRequestId) return;
      const index = this.docs.findIndex(document => document.id === id);
      if (index !== -1) {
        this.docs[index] = this.toDocument(payload, this.docs[index]);
        const document = this.docs[index];
        const editing = startEditing && this.canEditDocument(document);
        this.setState({
          drawerId: id,
          drawerHistoryOpen: false,
          drawerEditing: editing,
          drawerEditSaving: false,
          drawerEditError: '',
          drawerEdit: editing ? this.createDocumentEditState(document) : null,
          drawerLinkOpen: false,
          responsibleMenuOpen: null,
        });
      }
    } catch (error) {
      if (requestId !== this.documentOpenRequestId) return;
      console.error('Failed to load registry document', error);
    }
  }

  async transitionDocument(id, status) {
    const current = this.docs.find(document => document.id === id);
    if (!current || !this.canTransitionDocument(current)) return;
    if (status === 'archived' && !this.canArchiveDocument(current)) return;
    try {
      const payload = await this.api(`/api/v1/registry/documents/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      const index = this.docs.findIndex(document => document.id === id);
      if (index !== -1) {
        this.docs[index] = this.toDocument(payload, this.docs[index]);
        this.forceUpdate();
      }
      if (status === 'archived') {
        this.setState({ drawerId: null, rowMenuId: null, sel: {} });
        await Promise.all([this.loadDocuments(), this.loadDocumentOptions()]);
      }
    } catch (error) {
      console.error('Failed to transition registry document', error);
    }
  }

  typeMeta(sectionCode, typeLabel) {
    return this.TYPE_META[sectionCode]
      ? this.TYPE_META[sectionCode][typeLabel] || null
      : null;
  }

  wizardStepValidation(wz, type, step = wz.step) {
    const missing = [];
    const invalid = [];

    if (step === 1) {
      if (!wz.sectionCode) missing.push('Раздел');
      if (!wz.typeLabel) missing.push('Тип документа');
      if (type && !this.canCreateType(type)) {
        invalid.push('Тип документа — создание запрещено политикой роли');
      }
    }

    if (step === 2) {
      const rawDate = String(wz.date || '').trim();
      if (!rawDate) missing.push('Дата документа');
      else if (!this.toIsoDocumentDate(rawDate)) invalid.push('Дата документа — используйте формат дд.мм.гггг');

      const responsibleId = Number(wz.responsibleId);
      if (!Number.isSafeInteger(responsibleId) || responsibleId <= 0) {
        missing.push('Ответственный');
      }

      if (type && type.isFinancial && !this.roleHidesMoney(type.code)) {
        const amount = String(wz.amount || '').replace(/\s/g, '').replace(',', '.');
        if (!amount) missing.push('Сумма');
        else if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
          invalid.push('Сумма — укажите число, не более двух знаков после запятой');
        }
        if (!/^[A-Z]{3}$/.test(String(wz.currency || '').trim().toUpperCase())) {
          missing.push('Валюта');
        }
      }

      for (const field of type && type.fields ? type.fields : []) {
        const rawValue = (wz.fieldVals || {})[field.key];
        const value = rawValue === null || rawValue === undefined
          ? ''
          : String(rawValue).trim();
        if (field.isRequired && !value) {
          missing.push(field.label);
          continue;
        }
        if (!value) continue;
        if (field.dataType === 'date' && !this.toIsoDocumentDate(value)) {
          invalid.push(`${field.label} — используйте формат дд.мм.гггг`);
        }
        if (field.dataType === 'number') {
          const normalized = value.replace(/\s/g, '').replace(',', '.');
          if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
            invalid.push(`${field.label} — укажите число`);
          }
        }
        if (field.dataType === 'money') {
          const normalized = value.replace(/\s/g, '').replace(',', '.');
          if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
            invalid.push(`${field.label} — укажите сумму, не более двух знаков после запятой`);
          }
        }
      }
    }

    const parts = [];
    if (missing.length) {
      parts.push(`Заполните обязательные поля: ${missing.map(label => `«${label}»`).join(', ')}.`);
    }
    if (invalid.length) {
      parts.push(`Исправьте заполнение: ${invalid.join('; ')}.`);
    }
    return {
      valid: parts.length === 0,
      message: parts.join(' '),
    };
  }

  wizardApiErrorMessage(error, type) {
    const details = error && error.details;
    const typeFields = type && type.fields ? type.fields : [];
    const fieldLabelByKey = new Map(typeFields.map(field => [field.key, field.label]));

    if (
      (error && error.code === 'required_document_fields_missing')
      && details && Array.isArray(details.keys)
    ) {
      const labels = details.keys.map(key => fieldLabelByKey.get(key) || key);
      return `Заполните обязательные поля: ${labels.map(label => `«${label}»`).join(', ')}.`;
    }

    if (
      (error && error.code === 'invalid_document_field_value')
      && details && details.key
    ) {
      const label = fieldLabelByKey.get(details.key) || details.key;
      return `Исправьте заполнение поля «${label}».`;
    }

    if (error && error.code === 'validation_error' && Array.isArray(details)) {
      const coreLabels = {
        sectionCode: 'Раздел',
        typeCode: 'Тип документа',
        title: 'Название документа',
        number: 'Номер',
        documentDate: 'Дата документа',
        amount: 'Сумма',
        currency: 'Валюта',
        responsibleId: 'Ответственный',
        counterpartyName: 'Контрагент',
      };
      const labels = [];
      details.forEach(issue => {
        const path = issue && Array.isArray(issue.path) ? issue.path : [];
        const first = path[0];
        const fieldKey = first === 'fields' ? path[1] : null;
        const label = fieldKey
          ? (fieldLabelByKey.get(fieldKey) || fieldKey)
          : coreLabels[first];
        if (label && !labels.includes(label)) labels.push(label);
      });
      if (labels.length) {
        return `Проверьте заполнение полей: ${labels.map(label => `«${label}»`).join(', ')}.`;
      }
    }

    return error instanceof Error ? error.message : 'Не удалось создать документ.';
  }

  roleHidesMoney(typeCode = null) {
    if (this.serverPolicy) {
      const override = typeCode
        && this.serverPolicy.permissions
        && this.serverPolicy.permissions.byType
        && this.serverPolicy.permissions.byType[typeCode]
        ? this.serverPolicy.permissions.byType[typeCode].finance
        : undefined;
      if (override !== undefined) return !override;
      return !!this.serverPolicy.hideMoney
        || (this.serverPolicy.hiddenFields || []).includes('amount')
        || (this.serverPolicy.hiddenFields || []).includes('currency');
    }
    const role = this.ROLES[this.state.role];
    return !!(role && role.hideMoney);
  }

  availableStatusOptions(document) {
    const type = this.typeMeta(document.section, document.type);
    const lifecycle = type ? this.LIFECYCLE_BY_CODE[type.lifecycleCode] : null;
    if (!lifecycle) return [document.status];
    const targetCodes = new Set(
      lifecycle.config.transitions
        .filter(transition => transition.from === document.status)
        .map(transition => transition.to),
    );
    targetCodes.add(document.status);
    return lifecycle.config.states
      .map(state => state.code)
      .filter(code => targetCodes.has(code));
  }

  async createDocumentFromWizard(wz) {
    const type = this.typeMeta(wz.sectionCode, wz.typeLabel);
    if (!type || !this.canCreateType(type)) {
      this.setState({ wizardError: 'Для этого типа документов создание запрещено политикой роли.' });
      return;
    }
    const validation = this.wizardStepValidation(wz, type, 2);
    if (!validation.valid) {
      this.setState({
        wz: { ...wz, step: 2 },
        wizardError: validation.message,
      });
      return;
    }
    const fields = {};
    const typeFieldByKey = new Map((type.fields || []).map(field => [field.key, field]));
    Object.entries(wz.fieldVals || {}).forEach(([key, value]) => {
      const field = typeFieldByKey.get(key);
      if (!field || value === '') return;
      if (field.dataType === 'date') fields[key] = this.toIsoDocumentDate(value);
      else if (field.dataType === 'number' || field.dataType === 'money') fields[key] = String(value).replace(/\s/g, '').replace(',', '.');
      else if (field.dataType === 'boolean') fields[key] = value === true || value === 'Да';
      else fields[key] = value;
    });
    const normalizedAmount = String(wz.amount || '').replace(/\s/g, '').replace(',', '.');
    const input = {
      sectionCode: wz.sectionCode,
      typeCode: type.code,
      number: wz.number || null,
      title: wz.supersedesId && wz.sourceTitle
        ? wz.sourceTitle
        : wz.typeLabel + (wz.counterparty ? ' · ' + wz.counterparty : ''),
      documentDate: this.toIsoDocumentDate(wz.date),
      supersedesId: wz.supersedesId || undefined,
      legalEntityId: wz.legalEntityId || undefined,
      legalEntityName: wz.legalEntityName || undefined,
      counterpartyId: wz.counterpartyId && wz.counterparty === wz.sourceCounterpartyName
        ? wz.counterpartyId
        : undefined,
      counterpartyName: wz.counterparty || null,
      dealStageId: wz.dealStageId || undefined,
      comment: wz.comment || undefined,
      responsibleId: wz.responsibleId ? Number(wz.responsibleId) : undefined,
      responsibleName: wz.responsibleName || undefined,
      links: this.wizardDocumentLinks(wz),
      fields,
      ...(!this.roleHidesMoney(type.code) ? {
        amount: normalizedAmount || null,
        currency: normalizedAmount ? wz.currency : null,
      } : {}),
    };
    this.setState({ wizardError: '' });
    try {
      let payload = await this.api('/api/v1/registry/documents', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (wz.file) {
        try {
          const attachment = await this.uploadFileToDocument(payload.id, wz.file);
          payload = { ...payload, attachments: [...(payload.attachments || []), attachment] };
        } catch (uploadError) {
          await this.api(`/api/v1/registry/documents/${payload.id}/abandon`, { method: 'POST' })
            .catch(cleanupError => console.error('Failed to abandon incomplete registry document', cleanupError));
          throw uploadError;
        }
      } else if (wz.externalLink) {
        try {
          const attachment = await this.createExternalLink(payload.id, wz.externalLink);
          payload = { ...payload, attachments: [...(payload.attachments || []), attachment] };
        } catch (linkError) {
          await this.api(`/api/v1/registry/documents/${payload.id}/abandon`, { method: 'POST' })
            .catch(cleanupError => console.error('Failed to abandon incomplete registry document', cleanupError));
          throw linkError;
        }
      }
      const document = this.toDocument(payload);
      this.docs = [document, ...this.docs.filter(item => item.id !== document.id)];
      if (this.placementEntity) {
        await this.loadContextDocuments();
      } else {
        await Promise.all([this.loadDocuments(), this.loadDocumentOptions()]);
      }
      this.setState({ wizardOpen: false, wizardError: '' });
      await this.openDocument(document.id);
    } catch (error) {
      console.error('Failed to create registry document', error);
      const validationError = [
        'validation_error',
        'required_document_fields_missing',
        'invalid_document_field_value',
        'financial_fields_required',
      ].includes(error && error.code);
      this.setState({
        wz: validationError ? { ...wz, step: 2 } : wz,
        wizardError: this.wizardApiErrorMessage(error, type),
      });
    }
  }

  creationContextLinks() {
    const context = this.entityContext;
    if (!context || !this.placementEntity) return [];
    if (this.placementEntity.entityType === 'deal') {
      const links = [{
        entityType: 'deal',
        entityId: context.deal ? context.deal.id : this.placementEntity.entityId,
        entityTitle: context.deal ? context.deal.title : context.entityTitle,
      }];
      if (context.company) {
        links.push({
          entityType: 'company',
          entityId: context.company.id,
          entityTitle: context.company.title,
        });
      }
      return links;
    }
    return [{
      entityType: 'company',
      entityId: context.company ? context.company.id : this.placementEntity.entityId,
      entityTitle: context.company ? context.company.title : context.entityTitle,
    }];
  }

  STATUS = {
    draft: { label: 'Черновик', c: '#71717a', bg: '#f4f4f5' },
    on_review: { label: 'На согласовании', c: '#b45309', bg: '#fdf2e3' },
    awaiting: { label: 'Ожидает оплаты', c: '#2563eb', bg: '#eef2ff' },
    signed: { label: 'Подписан', c: '#15803d', bg: '#e7f5ec' },
    active: { label: 'Активен', c: '#15803d', bg: '#e7f5ec' },
    overdue: { label: 'Просрочен', c: '#dc2626', bg: '#fdeaea' },
    expired: { label: 'Просрочен', c: '#dc2626', bg: '#fdeaea' },
    archived: { label: 'В архиве', c: '#a1a1aa', bg: '#f4f4f5' },
  };

  ROLES = {
    sales: { label: 'Менеджер продаж', sections: ['client', 'internal'], hideMoney: true, hint: 'Только клиентские и внутренние; суммы скрыты для защиты маржи.' },
    accountant: { label: 'Бухгалтер', sections: ['client', 'supplier'], hideMoney: false, hint: 'Финансовый блок: счета, акты, УПД, инвойсы.' },
    lawyer: { label: 'Юрист', sections: ['client', 'legal'], hideMoney: true, hint: 'Клиентские и юридические; суммы скрыты.' },
    logistics: { label: 'Закупка / логистика', sections: ['supplier', 'logistics', 'customs'], hideMoney: false, hint: 'Документы поставщика, логистики и таможни.' },
    admin: { label: 'Администратор', sections: 'all', hideMoney: false, hint: 'Полный доступ + настройка справочников и ролей.' },
  };

  MATRIX_STATUS = {
    ready:   { icon: '✓', c: '#15803d', bg: '#e7f5ec' },
    partial: { icon: '⚠', c: '#b45309', bg: '#fdf2e3' },
    blocker: { icon: '✕', c: '#dc2626', bg: '#fdeaea' },
    waiting: { icon: '◷', c: '#2563eb', bg: '#eef2ff' },
    none:    { icon: '—', c: '#c4c4c8', bg: 'transparent' },
  };
  MATRIX_LEGEND = [['ready', 'готов'], ['partial', 'частично'], ['blocker', 'блокер'], ['waiting', 'ожидается'], ['none', 'не требуется']];

  SUMMARY_COLS = [
    ['draft', 'Черновик', '#71717a', '#f4f4f5'],
    ['on_review', 'Согласование', '#b45309', '#fdf2e3'],
    ['awaiting', 'Ожидает оплаты', '#2563eb', '#eef2ff'],
    ['done', 'Подписан·Актив', '#15803d', '#e7f5ec'],
    ['expired', 'Просрочен', '#dc2626', '#fdeaea'],
    ['archived', 'Архив', '#a1a1aa', '#f4f4f5'],
  ];
  STATUS_TO_COL = { draft: 'draft', on_review: 'on_review', awaiting: 'awaiting', signed: 'done', active: 'done', overdue: 'expired', expired: 'expired', archived: 'archived' };

  TRAINING = [
    ['Работа с документами', 'Создание, редактирование, статусы, вложения и новые редакции документов.', 'Статья', '📄'],
    ['Поиск и представления', 'Фильтры, колонки, личные и общие представления, экспорт текущего набора.', 'Статья', '📄'],
    ['Документы в сделке и компании', 'Работа с реестром во вкладках карточек сделки и компании Bitrix24.', 'Видео', '▶'],
    ['Настройка реестра', 'Разделы, типы документов, жизненные циклы, роли и назначение пользователей.', 'Видео', '▶'],
  ];

  buildMatrix(docs, keyPrefix) {
    const cols = this.SUMMARY_COLS;
    const stages = cols.map(c => ({ label: c[1], style: 'text-align:center;font-size:9.5px;letter-spacing:.2px;text-transform:uppercase;color:#a1a1aa;font-weight:600;line-height:1.2;' }));
    const rows = this.SECTIONS.filter(s => this.visibleSections().includes(s.code)).map(s => {
      const sd = (docs || []).filter(d => d.section === s.code);
      const cells = cols.map(([key, label, c, bg]) => {
        const n = sd.filter(d => this.STATUS_TO_COL[d.status] === key).length;
        return { icon: n ? String(n) : '—', style: `display:flex;align-items:center;justify-content:center;height:34px;border-radius:8px;font-size:13px;font-weight:${n ? '600' : '400'};color:${n ? c : '#c4c4c8'};background:${n ? bg : '#fafafa'};` };
      });
      return { label: s.label, c: s.c, cells, onOpen: () => this.openGroup((keyPrefix || 'deal_') + s.code) };
    });
    return { stages, rows };
  }

  docs = [];

  ensureDocs() {
    if (!Array.isArray(this.docs)) this.docs = [];
  }
  fmtAmount(doc) {
    if (doc.moneyHidden) return '—';
    if (!doc.amount) return '—';
    const sym = { RUB: '₽', USD: '$', EUR: '€', CNY: '¥' }[doc.currency] || '';
    const n = doc.amount.toLocaleString('ru-RU');
    return doc.currency === 'RUB' ? n + ' ₽' : sym + n;
  }

  visibleSections() {
    if (this.serverPolicy) return this.serverPolicy.visibleSectionCodes;
    const role = this.ROLES[this.state.role] || this.ROLES.admin;
    const sc = role.sections;
    return sc === 'all' ? this.SECTIONS.map(s => s.code) : sc;
  }

  scopedDocs() {
    this.ensureDocs();
    const vis = this.visibleSections();
    return this.docs.filter(d => vis.includes(d.section));
  }

  gridColsStr() {
    const c = this.state.cols;
    let s = '44px minmax(200px,1.6fr)';
    if (c.section) s += ' 130px';
    if (c.counterparty) s += ' 140px';
    if (c.status) s += ' 140px';
    if (c.amount) s += ' 100px';
    if (c.docDate) s += ' 90px';
    if (c.responsible) s += ' 120px';
    s += ' 36px';
    return s;
  }

  registryControls(scoped) {
    const S = this.state, F = S.filters, C = S.cols;
    const setF = (patch, delay = 0) => this.updateRegistryFilters(patch, delay);
    const statusKeys = this.state.screen === 'archive'
      ? ['draft', 'on_review', 'awaiting', 'signed', 'active', 'overdue', 'archived']
      : ['draft', 'on_review', 'awaiting', 'signed', 'active', 'overdue'];
    const filterStatusChips = statusKeys.map(k => {
      const m = this.STATUS[k]; const on = !!F.statuses[k];
      return { label: m.label, onToggle: () => { const st = { ...F.statuses }; if (st[k]) delete st[k]; else st[k] = true; setF({ statuses: st }); },
        style: `border:1px solid ${on ? m.c : '#e4e4e7'};background:${on ? m.bg : '#fff'};color:${on ? m.c : '#71717a'};border-radius:20px;padding:3px 10px;font-size:11px;font-weight:500;cursor:pointer;` };
    });
    const visSec = this.visibleSections();
    const filterSectionChips = this.SECTIONS.filter(s => visSec.includes(s.code)).map(s => {
      const on = !!F.sections[s.code];
      return { label: s.label, onToggle: () => { const ss = { ...F.sections }; if (ss[s.code]) delete ss[s.code]; else ss[s.code] = true; setF({ sections: ss }); },
        style: `border:1px solid ${on ? s.c : '#e4e4e7'};background:${on ? s.bg : '#fff'};color:${on ? s.c : '#71717a'};border-radius:20px;padding:3px 10px;font-size:11px;font-weight:500;cursor:pointer;` };
    });
    const typeOptions = [];
    const typeCodes = new Set();
    this.SECTIONS.filter(section => visSec.includes(section.code)).forEach(section => {
      Object.values(this.TYPE_META[section.code] || {}).forEach(type => {
        if (typeCodes.has(type.code)) return;
        typeCodes.add(type.code);
        typeOptions.push({ v: type.code, l: type.name });
      });
    });
    const filterTypeOptions = [{ v: 'all', l: 'Все типы' }].concat(typeOptions);
    const filterRespOptions = [{ v: 'all', l: 'Все' }].concat(
      (this.documentOptions.responsibles || []).map(item => ({
        v: String(item.id),
        l: item.name,
      })),
    );
    const activeCount = Object.keys(F.sections).filter(k => F.sections[k]).length + Object.keys(F.statuses).filter(k => F.statuses[k]).length + (F.type !== 'all' ? 1 : 0) + (F.responsible !== 'all' ? 1 : 0) + (F.cp.trim() ? 1 : 0) + (F.from.trim() || F.to.trim() ? 1 : 0);
    const colDefs = [['section', 'Раздел'], ['counterparty', 'Контрагент'], ['status', 'Статус'], ['amount', 'Сумма'], ['docDate', 'Дата'], ['responsible', 'Ответственный']];
    const columnToggles = colDefs.map(([k, label]) => { const on = !!C[k];
      return { label, mark: on ? '✓' : '', onToggle: () => {
        const cols = { ...this.state.cols, [k]: !this.state.cols[k] };
        this.persistColumnPreferences(cols);
        this.setState({ cols, activeSavedViewId: null });
      },
        boxStyle: `display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;border:1.5px solid ${on ? '#4f46e5' : '#d4d4d8'};background:${on ? '#4f46e5' : '#fff'};color:#fff;font-size:11px;` }; });
    const btn = (active) => `background:${active ? '#eef2ff' : 'none'};border:1px solid ${active ? '#c7cdf7' : '#e4e4e7'};border-radius:7px;padding:5px 11px;font-size:11.5px;color:${active ? '#4f46e5' : '#52525b'};cursor:pointer;margin:6px 0;font-weight:${active ? '600' : '400'};`;
    return {
      filterOpen: S.filterOpen, colsOpen: S.colsOpen,
      toggleFilter: () => this.setState({ filterOpen: !this.state.filterOpen, colsOpen: false }),
      toggleCols: () => this.setState({ colsOpen: !this.state.colsOpen, filterOpen: false }),
      closePopovers: () => this.setState({ filterOpen: false, colsOpen: false }),
      filterBtnStyle: btn(S.filterOpen || activeCount > 0), colsBtnStyle: btn(S.colsOpen),
      filterBadge: activeCount > 0 ? ' · ' + activeCount : '',
      filterStatusChips, filterSectionChips, filterTypeOptions, filterRespOptions,
      filterType: F.type, filterResp: F.responsible, filterCp: F.cp, filterFrom: F.from, filterTo: F.to,
      setFilterType: (e) => setF({ type: e.target.value }), setFilterResp: (e) => setF({ responsible: e.target.value }),
      setFilterCp: (e) => setF({ cp: e.target.value }, 250), setFilterFrom: (e) => setF({ from: e.target.value }, 250), setFilterTo: (e) => setF({ to: e.target.value }, 250),
      resetFilters: () => setF({ sections: {}, statuses: {}, type: 'all', responsible: 'all', cp: '', from: '', to: '' }),
      columnToggles,
      colSection: C.section, colCounterparty: C.counterparty, colStatus: C.status, colAmount: C.amount, colDocDate: C.docDate, colResponsible: C.responsible,
      headerGridStyle: `position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: ${this.gridColsStr()}; background: #fff; box-shadow: inset 0 -1px 0 #ededed; color: #a1a1aa; font-size: 10.5px;`,
    };
  }

  filteredRows() {
    return this.scopedDocs();
  }

  enrich(d) {
    const sec = this.SECTIONS.find(s => s.code === d.section) || { label: d.section, c: '#64748b', bg: '#eef1f5' };
    const st = this.STATUS[d.status] || { label: d.status, c: '#71717a', bg: '#f4f4f5' };
    const sel = !!this.state.sel[d.id];
    const archiveMode = this.state.screen === 'archive';
    const canEdit = !archiveMode && this.canEditDocument(d);
    const canDelete = !archiveMode && this.canArchiveDocument(d);
    const canRestore = archiveMode && !!d.deletedAt && this.canArchiveDocument(d, true);
    const selectable = !archiveMode || !!d.deletedAt;
    const menuOpen = this.state.rowMenuId === d.id;
    return {
      id: d.id, num: d.num, title: d.title, counterparty: d.counterparty || '—',
      dealRefLabel: d.dealRef ? '#' + d.dealRef : '—',
      responsible: d.responsible, docDate: d.docDate,
      sectionLabel: sec.label, sectionC: sec.c, sectionBg: sec.bg,
      statusLabel: st.label, statusC: st.c, statusBg: st.bg,
      amountStr: this.fmtAmount(d),
      attachIcon: d.atts.length ? (d.atts.some(item => item.icon === '📎') ? '📎' : '🔗') : '○',
      canEdit, canDelete, canRestore, hasActions: canEdit || canDelete || canRestore, menuOpen,
      onOpen: () => { void this.openDocument(d.id); },
      onToggleMenu: (event) => {
        if (event && event.preventDefault) event.preventDefault();
        if (event && event.stopPropagation) event.stopPropagation();
        this.setState({ rowMenuId: menuOpen ? null : d.id });
      },
      onEdit: (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        if (canEdit) void this.openDocument(d.id, true);
      },
      onDelete: (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        if (canDelete) void this.deleteDocument(d.id);
      },
      onRestore: (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        if (canRestore) void this.restoreDocument(d.id);
      },
      onToggleSel: (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (!selectable) return;
        const s = { ...this.state.sel };
        if (s[d.id]) delete s[d.id]; else s[d.id] = true;
        this.setState({ sel: s });
      },
      checkMark: sel ? '✓' : '',
      checkStyle: `display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;border:1.5px solid ${sel ? '#4f46e5' : '#d4d4d8'};background:${sel ? '#4f46e5' : (selectable ? '#fff' : '#f4f4f5')};color:#fff;font-size:11px;cursor:${selectable ? 'pointer' : 'default'};opacity:${selectable ? '1' : '.55'};`,
      rowStyle: `border-bottom:1px solid #f4f4f5;cursor:pointer;background:${sel ? '#f5f5ff' : '#fff'};`,
      rowGridStyle: `position:relative;display:grid;grid-template-columns:${this.gridColsStr()};border-bottom:1px solid #f4f4f5;cursor:pointer;background:${sel ? '#f5f5ff' : '#fff'};`,
    };
  }

  renderVals() {
    this.ensureDocs();
    const S = this.state;
    const registryLoadFailed = !S.registryLoading && !!S.registryLoadError;
    const archiveMode = S.screen === 'archive';
    const activeRegistry = S.screen === 'registry';
    const role = this.ROLES[S.role] || {
      label: (this.serverPolicy && this.serverPolicy.roleName) || S.role,
      sections: (this.serverPolicy && this.serverPolicy.visibleSectionCodes) || [],
      hideMoney: !!(this.serverPolicy && this.serverPolicy.hideMoney),
      hint: 'Настраиваемая роль реестра.',
    };
    const scoped = this.scopedDocs();

    const selSecsArr = Object.keys(S.filters.sections).filter(k => S.filters.sections[k]);
    const noSecSel = selSecsArr.length === 0;
    const documentOptions = this.documentOptions;
    const sidebarSections = this.SECTIONS.filter(s => this.visibleSections().includes(s.code)).map(s => {
      const count = documentOptions.sections[s.code] || 0;
      const active = !!S.filters.sections[s.code];
      const dropKey = `registry_section_${s.code}`;
      const dropActive = S.dragTargetKey === dropKey;
      return {
        code: s.code, label: s.label, c: s.c, count,
        dropKey,
        dropHint: dropActive ? 'Отпустите файлы' : '',
        onPick: () => { const ss = { ...S.filters.sections }; if (ss[s.code]) delete ss[s.code]; else ss[s.code] = true; this.updateRegistryFilters({ sections: ss }); },
        onDragEnter: event => this.handleFileDragOver(event, dropKey),
        onDragOver: event => this.handleFileDragOver(event, dropKey),
        onDragLeave: event => this.handleFileDragLeave(event, dropKey),
        onDrop: event => this.handleSectionFileDrop(event, s.code, [], dropKey),
        style: `display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:${dropActive ? s.bg : (active ? '#eef2ff' : 'transparent')};color:${dropActive ? s.c : (active ? '#4f46e5' : '#52525b')};font-weight:${dropActive || active ? '600' : '400'};border:1px solid ${dropActive ? s.c : 'transparent'};border-radius:7px;padding:7px 9px;font-size:12.5px;cursor:pointer;transition:border-color .18s,background .18s,color .18s;`,
      };
    });

    const rows = this.filteredRows().map(d => this.enrich(d));
    const registryUsers = (S.registryUsers && S.registryUsers.length)
      ? S.registryUsers
      : (S.adminUsers && S.adminUsers.length)
        ? S.adminUsers
        : (documentOptions.responsibles || []).map(item => ({ id: item.id, name: item.name }));
    const uniqueRegistryUsers = [...new Map(
      registryUsers
        .filter(user => Number(user.id) > 0)
        .map(user => [Number(user.id), { id: Number(user.id), name: user.name || `Пользователь #${user.id}` }]),
    ).values()];
    const bulkResponsibleOptions = [
      { id: '', name: 'Выберите ответственного' },
      ...uniqueRegistryUsers,
    ].map(user => ({
      ...user,
      onPick: () => this.setState({
        bulkResponsibleId: String(user.id || ''),
        bulkError: '',
        responsibleMenuOpen: null,
      }),
    }));
    const permissions = this.serverPolicy && this.serverPolicy.permissions
      ? this.serverPolicy.permissions
      : {};
    const selectedDocuments = scoped.filter(document => S.sel[document.id]);
    const visibleTypeMetas = this.SECTIONS
      .filter(section => this.visibleSections().includes(section.code))
      .flatMap(section => (this.TYPES[section.code] || [])
        .map(label => this.typeMeta(section.code, label))
        .filter(Boolean));
    const canExportRegistry = visibleTypeMetas.some(type =>
      this.typePermission(type.code, 'export', permissions.export === true));

    const mkView = (key, label, count) => ({
      label, count,
      onPick: () => this.updateRegistryView(key),
      canManage: false,
      style: `background:none;border:none;border-bottom:2px solid ${!S.activeSavedViewId && S.view === key ? '#4f46e5' : 'transparent'};color:${!S.activeSavedViewId && S.view === key ? '#18181b' : '#a1a1aa'};font-weight:${!S.activeSavedViewId && S.view === key ? '600' : '500'};padding:12px 11px;font-size:12.5px;cursor:pointer;display:flex;align-items:center;gap:6px;`,
    });
    const savedViews = archiveMode ? [] : [
      mkView('all', 'Все', documentOptions.views.all || 0),
      mkView('mine', 'Мои', documentOptions.views.mine || 0),
      mkView('awaiting', 'В работе', documentOptions.views.work || 0),
      mkView('draft', 'Черновики', documentOptions.views.draft || 0),
      ...(S.customSavedViews || []).map(view => ({
        label: view.name,
        count: view.isShared ? 'общий' : '',
        canManage: view.canManage,
        onPick: () => this.applySavedView(view),
        onEdit: event => {
          if (event && event.stopPropagation) event.stopPropagation();
          this.openSavedViewEditor(view);
        },
        style: `background:none;border:none;border-bottom:2px solid ${S.activeSavedViewId === view.id ? '#4f46e5' : 'transparent'};color:${S.activeSavedViewId === view.id ? '#18181b' : '#a1a1aa'};font-weight:${S.activeSavedViewId === view.id ? '600' : '500'};padding:12px 8px;font-size:12.5px;cursor:pointer;display:flex;align-items:center;gap:6px;`,
      })),
    ];
    const editingSavedView = (S.customSavedViews || [])
      .find(view => view.id === S.savedViewEditingId) || null;

    const dealDocs = S.screen === 'deal' ? scoped : scoped.filter(d => d.deal);
    const embeddedGroups = this.SECTIONS.filter(s => this.visibleSections().includes(s.code)).map(s => {
      const ds = dealDocs.filter(d => d.section === s.code);
      const gkey = 'deal_' + s.code;
      const dropKey = 'deal_drop_' + s.code;
      const open = !S.collapsedGroups[gkey];
      const dropActive = S.dragTargetKey === dropKey;
      return {
        code: s.code, label: s.label, c: s.c, count: ds.length + ' док.', docs: ds.map(d => this.enrich(d)),
        dropKey,
        dropHint: dropActive ? 'Отпустите файлы для загрузки' : '',
        open, caret: open ? '▾' : '▸', onToggle: () => this.toggleGroup(gkey),
        onDragEnter: event => this.handleFileDragOver(event, dropKey),
        onDragOver: event => this.handleFileDragOver(event, dropKey),
        onDragLeave: event => this.handleFileDragLeave(event, dropKey),
        onDrop: event => this.handleSectionFileDrop(event, s.code, [], dropKey),
        style: `border:1px solid ${dropActive ? s.c : '#ededed'};border-radius:10px;overflow:hidden;background:${dropActive ? s.bg : '#fff'};transition:border-color .18s,background .18s;`,
      };
    }).filter(g => g.docs.length > 0);

    const dm = this.buildMatrix(dealDocs, 'deal_');
    const dealStages = dm.stages;
    const dealMatrix = dm.rows;

    const isLocalCompanyDemo = S.screen === 'company'
      && !this.placementEntity
      && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
    const contextDeals = this.entityContext && Array.isArray(this.entityContext.deals)
      ? this.entityContext.deals
      : (isLocalCompanyDemo ? [{
          id: '1234', title: 'DEMO · Проверка drag-and-drop',
          stageName: 'Демо', stageColor: '#2563eb',
        }] : []);
    const companyContextLink = this.entityContext && this.entityContext.company
      ? {
          entityType: 'company',
          entityId: this.entityContext.company.id,
          entityTitle: this.entityContext.company.title,
        }
      : (isLocalCompanyDemo ? {
          entityType: 'company', entityId: '77', entityTitle: 'DEMO · Компания',
        } : null);
    const companyDeals = contextDeals.map(dl => {
      const ddocs = scoped.filter(d => d.dealRef === String(dl.id));
      const mm = this.buildMatrix(ddocs, 'co_' + dl.id + '_');
      const groups = this.SECTIONS.filter(s => this.visibleSections().includes(s.code)).map(s => {
        const gd = ddocs.filter(d => d.section === s.code);
        const gkey = 'co_' + dl.id + '_' + s.code;
        const dropKey = 'company_drop_' + dl.id + '_' + s.code;
        const open = !S.collapsedGroups[gkey];
        const dropActive = S.dragTargetKey === dropKey;
        return {
          code: s.code, label: s.label, c: s.c, count: gd.length + ' док.', docs: gd.map(d => this.enrich(d)),
          dealId: dl.id,
          dealTitle: dl.title,
          companyId: companyContextLink ? companyContextLink.entityId : '',
          companyTitle: companyContextLink ? companyContextLink.entityTitle : '',
          dropKey,
          dropHint: dropActive ? 'Отпустите файлы для загрузки' : '',
          open, caret: open ? '▾' : '▸', onToggle: () => this.toggleGroup(gkey),
          onDragEnter: event => this.handleFileDragOver(event, dropKey),
          onDragOver: event => this.handleFileDragOver(event, dropKey),
          onDragLeave: event => this.handleFileDragLeave(event, dropKey),
          onDrop: event => this.handleSectionFileDrop(event, s.code, [
            { entityType: 'deal', entityId: dl.id, entityTitle: dl.title },
            ...(companyContextLink ? [companyContextLink] : []),
          ], dropKey),
          style: `border:1px solid ${dropActive ? s.c : '#ededed'};border-radius:10px;overflow:hidden;background:${dropActive ? s.bg : '#fff'};transition:border-color .12s,background .12s;`,
        };
      }).filter(g => isLocalCompanyDemo ? g.code === 'supplier' : g.docs.length > 0);
      const expanded = isLocalCompanyDemo
        ? S.expandedDeals[dl.id] !== false
        : !!S.expandedDeals[dl.id];
      return {
        id: dl.id, title: '#' + dl.id + ' · ' + dl.title, stage: dl.stageName, stageColor: dl.stageColor,
        expanded, caret: expanded ? '▾' : '▸', docCount: ddocs.length + ' док.',
        onToggle: () => {
          const e = { ...S.expandedDeals };
          if (isLocalCompanyDemo) e[dl.id] = !expanded;
          else if (e[dl.id]) delete e[dl.id];
          else e[dl.id] = true;
          this.setState({ expandedDeals: e });
        },
        headStyle: `display:flex;align-items:center;gap:12px;padding:13px 16px;cursor:pointer;background:${expanded ? '#fafafa' : '#fff'};`,
        stages: mm.stages, rows: mm.rows, groups,
      };
    });
    const placementContextMissing = !!this.placementContextType && !this.placementEntity;
    const placementContextReady = !!this.placementEntity;
    const companyName = this.entityContext && this.entityContext.company
      ? this.entityContext.company.title
      : (isLocalCompanyDemo
          ? 'DEMO · Компания'
          : (placementContextMissing && this.placementContextType === 'company'
              ? 'Новая компания'
              : 'Компания не выбрана'));
    const companyDocTotal = S.screen === 'company'
      ? scoped.length
      : (documentOptions.scopeTotal || 0);
    const coDocs = scoped;
    const coTypeOrder = []; const coByType = {};
    coDocs.forEach(d => { if (!coByType[d.type]) { coByType[d.type] = []; coTypeOrder.push(d.type); } coByType[d.type].push(d); });
    const companyDocsByType = coTypeOrder.map(t => {
      const sec = this.SECTIONS.find(s => s.code === coByType[t][0].section);
      return { type: t, c: sec ? sec.c : '#a1a1aa', count: coByType[t].length + ' док.', docs: coByType[t].map(d => this.enrich(d)) };
    });
    const dealContext = this.entityContext && this.entityContext.deal
      ? this.entityContext.deal
      : null;
    const dealId = dealContext
      ? dealContext.id
      : (this.placementEntity && this.placementEntity.entityType === 'deal' ? this.placementEntity.entityId : '—');
    const dealTitle = dealContext
      ? dealContext.title
      : (placementContextMissing && this.placementContextType === 'deal'
          ? 'Новая сделка'
          : 'Сделка не выбрана');
    const dealCompanyName = this.entityContext && this.entityContext.company
      ? this.entityContext.company.title
      : '';
    const dealHeaderTitle = placementContextMissing && this.placementContextType === 'deal'
      ? dealTitle
      : `#${dealId} · ${dealTitle}${dealCompanyName ? ' для ' + dealCompanyName : ''}`;
    const dealStageName = dealContext ? dealContext.stageName : 'Не указана';
    const dealStageColor = dealContext ? dealContext.stageColor : '#d97706';
    const dealContextLabel = `привязаны к сделке #${dealId}${dealCompanyName ? ' и к ' + dealCompanyName + ' (через компанию Bitrix24)' : ''}`;
    const cvSeg = (on) => `border:none;border-radius:6px;padding:5px 13px;font-size:12px;font-weight:600;cursor:pointer;background:${on ? '#fff' : 'transparent'};color:${on ? '#18181b' : '#71717a'};box-shadow:${on ? '0 1px 2px rgba(0,0,0,.08)' : 'none'};`;
    const matrixLegend = this.MATRIX_LEGEND.map(([code, label]) => {
      const m = this.MATRIX_STATUS[code];
      return { label, icon: m.icon, chip: `display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;font-size:11px;color:${m.c};background:${m.bg === 'transparent' ? '#f4f4f5' : m.bg};` };
    });

    let doc = null;
    if (S.drawerId) {
      const dd = this.docs.find(x => x.id === S.drawerId);
      if (dd) {
        const sec = this.SECTIONS.find(s => s.code === dd.section);
        const type = this.typeMeta(dd.section, dd.type);
        const edit = S.drawerEdit || this.createDocumentEditState(dd);
        const editFields = (type && type.fields ? type.fields : []).map(field => {
          const isSelect = field.dataType === 'select' || field.dataType === 'boolean';
          return {
            key: field.key,
            label: field.label,
            requiredMark: field.isRequired ? ' *' : '',
            isSelect,
            isInput: !isSelect,
            inputType: field.dataType === 'date' ? 'date' : 'text',
            options: field.dataType === 'boolean' ? ['Да', 'Нет'] : (field.options || []),
            value: (edit.fieldVals || {})[field.key] || '',
            onInput: event => this.updateDocumentEditField(field.key, event.target.value),
          };
        });
        const responsibleSource = S.registryUsers.length
          ? S.registryUsers
          : (documentOptions.responsibles || []);
        const responsibleOptions = responsibleSource.map(item => ({
          value: String(item.id),
          label: item.name || `Пользователь #${item.id}`,
          onPick: () => {
            this.updateDocumentEdit('responsibleId', String(item.id));
            this.setState({ responsibleMenuOpen: null });
          },
        }));
        if (dd.responsibleId && !responsibleOptions.some(item => item.value === String(dd.responsibleId))) {
          responsibleOptions.unshift({
            value: String(dd.responsibleId),
            label: dd.responsibleNameRaw || `Пользователь #${dd.responsibleId}`,
            onPick: () => {
              this.updateDocumentEdit('responsibleId', String(dd.responsibleId));
              this.setState({ responsibleMenuOpen: null });
            },
          });
        }
        const documentReadOnly = archiveMode || dd.status === 'archived' || !!dd.deletedAt;
        const canModifyContent = !documentReadOnly && this.canEditDocument(dd);
        const canTransition = !documentReadOnly && this.canTransitionDocument(dd);
        const statusOptions = (canTransition ? this.availableStatusOptions(dd) : [dd.status])
          .filter(code => code !== 'archived' || code === dd.status || this.canArchiveDocument(dd))
          .map(code => {
          const meta = this.STATUS[code] || { label: code, c: '#71717a', bg: '#f4f4f5' }; const active = dd.status === code;
          return { code, label: meta.label, onSet: () => { if (!active) void this.transitionDocument(dd.id, code); },
            style: `border:1px solid ${active ? meta.c : '#e4e4e7'};background:${active ? meta.bg : '#fff'};color:${active ? meta.c : '#71717a'};border-radius:7px;padding:4px 10px;font-size:11px;font-weight:500;cursor:${canTransition ? 'pointer' : 'default'};` };
        });
        doc = {
          id: dd.id,
          num: dd.num, title: dd.title, typeLabel: dd.type, number: dd.num,
          sectionLabel: sec.label, sectionC: sec.c, sectionBg: sec.bg,
          docDate: dd.docDate, amountStr: this.fmtAmount(dd),
          legalEntity: dd.legalEntity, counterparty: dd.counterparty || '—', responsible: dd.responsible,
          counterpartyLinked: !!this.bitrixCompanyUrl(dd.counterpartyId),
          counterpartyUnlinked: !this.bitrixCompanyUrl(dd.counterpartyId),
          counterpartyUrl: this.bitrixCompanyUrl(dd.counterpartyId),
          dealStage: dd.dealStageIdRaw || '—', comment: dd.comment || '—',
          moneyVisible: !dd.moneyHidden,
          canEdit: canModifyContent,
          onEdit: () => this.beginDocumentEdit(dd),
          canSupersede: !documentReadOnly && this.canSupersedeDocument(dd),
          onSupersede: () => this.openSupersedingWizard(dd),
          canRestore: archiveMode && !!dd.deletedAt && this.canArchiveDocument(dd, true),
          onRestore: () => { void this.restoreDocument(dd.id); },
          edit,
          editFields,
          editHasFields: editFields.length > 0,
          responsibleOptions,
          canModifyContent,
          attCount: dd.atts.length, linkCount: dd.links.length,
          attachments: dd.atts.map(attachment => ({
            ...attachment,
            meta: `${attachment.meta}${attachment.isCurrent ? '' : ' · предыдущая версия'}`,
            canReplace: canModifyContent && attachment.kind === 'file' && attachment.isCurrent,
            canDelete: canModifyContent,
            onOpen: () => { void this.openAttachment(dd.id, attachment.id); },
            onReplace: () => { void this.replaceDocumentAttachment(dd.id, attachment.id); },
            onDelete: () => { void this.deleteAttachment(dd.id, attachment.id); },
          })),
          links: dd.links,
          onManageLinks: () => { void this.manageDocumentLinks(dd.id, dd.links); },
          fields: dd.dynamicFields,
          history: dd.history,
          historyCount: dd.history.length,
          onHistory: () => this.setState({ drawerHistoryOpen: true }),
          statusOptions,
        };
      }
    }

    const wz = S.wz;
    const wzTypeMeta = this.typeMeta(wz.sectionCode, wz.typeLabel);
    const dataTypeLabels = { text: 'Текст', number: 'Число', date: 'Дата', money: 'Сумма', select: 'Список', boolean: 'Да/Нет', file: 'Файл' };
    const wizardTypeFields = (wzTypeMeta && wzTypeMeta.fields ? wzTypeMeta.fields : []).map(field => {
      const isSelect = field.dataType === 'select' || field.dataType === 'boolean';
      const options = field.dataType === 'boolean' ? ['Да', 'Нет'] : (field.options || []);
      return {
        name: field.label,
        requiredMark: field.isRequired ? ' *' : '',
        dtype: dataTypeLabels[field.dataType] || field.dataType,
        isSelect,
        isText: !isSelect,
        inputType: field.dataType === 'date' ? 'date' : 'text',
        options,
        value: (wz.fieldVals || {})[field.key] || '',
        valueShown: (wz.fieldVals || {})[field.key]
          ? (field.dataType === 'date'
              ? this.formatDocumentDate((wz.fieldVals || {})[field.key])
              : (wz.fieldVals || {})[field.key])
          : '—',
        onInput: (e) => this.setState({
          wz: { ...wz, fieldVals: { ...(wz.fieldVals || {}), [field.key]: e.target.value } },
          wizardError: '',
        }),
      };
    });
    const wizardSections = this.SECTIONS
      .filter(section => this.visibleSections().includes(section.code))
      .filter(section => (this.TYPES[section.code] || []).some(label => {
        const type = this.typeMeta(section.code, label);
        return type && this.canCreateType(type);
      }))
      .map(s => ({
      label: s.label, c: s.c, onPick: () => this.setState({
        wz: { ...wz, sectionCode: s.code, typeLabel: null },
        wizardError: '',
      }),
      style: `text-align:left;background:${wz.sectionCode === s.code ? '#eef2ff' : '#fff'};border:1.5px solid ${wz.sectionCode === s.code ? '#4f46e5' : '#ededed'};border-radius:9px;padding:11px 12px;cursor:pointer;`,
    }));
    const wizardMoneyVisible = !this.roleHidesMoney(wzTypeMeta && wzTypeMeta.code);
    const wizardResponsibleSource = S.registryUsers.length
      ? S.registryUsers
      : (documentOptions.responsibles || []);
    const wizardResponsibleOptions = wizardResponsibleSource.map(item => ({
      value: String(item.id),
      label: item.name || `Пользователь #${item.id}`,
      onPick: () => this.setState({
        wz: {
          ...this.state.wz,
          responsibleId: String(item.id),
          responsibleName: item.name || `Пользователь #${item.id}`,
        },
        responsibleMenuOpen: null,
        wizardError: '',
      }),
    }));
    if (wz.responsibleId && !wizardResponsibleOptions.some(item => item.value === String(wz.responsibleId))) {
      wizardResponsibleOptions.unshift({
        value: String(wz.responsibleId),
        label: wz.responsibleName || `Пользователь #${wz.responsibleId}`,
        onPick: () => this.setState({
          wz: {
            ...this.state.wz,
            responsibleId: String(wz.responsibleId),
            responsibleName: wz.responsibleName || `Пользователь #${wz.responsibleId}`,
          },
          responsibleMenuOpen: null,
          wizardError: '',
        }),
      });
    }
    const wizardTypes = wz.sectionCode ? this.TYPES[wz.sectionCode]
      .filter(t => {
        const type = this.typeMeta(wz.sectionCode, t);
        return type
          && this.canCreateType(type)
          && (wizardMoneyVisible || !type.isFinancial);
      })
      .map(t => ({
        label: t, onPick: () => this.setState({
          wz: { ...wz, typeLabel: t },
          wizardError: '',
        }),
        style: `background:${wz.typeLabel === t ? '#4f46e5' : '#fafafa'};color:${wz.typeLabel === t ? '#fff' : '#3f3f46'};border:1px solid ${wz.typeLabel === t ? '#4f46e5' : '#ededed'};border-radius:20px;padding:6px 13px;font-size:12px;cursor:pointer;`,
      })) : [];
    const wizardSteps = [1, 2, 3].map(n => ({ n: String(n),
      style: `width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;${wz.step === n ? 'background:#4f46e5;color:#fff;' : (wz.step > n ? 'background:#e7f5ec;color:#15803d;' : 'background:#f4f4f5;color:#a1a1aa;')}` }));
    const wzSec = this.SECTIONS.find(s => s.code === wz.sectionCode);
    const wizardValidation = this.wizardStepValidation(wz, wzTypeMeta, wz.step);
    const wzCanNext = wizardValidation.valid;
    const wizardLinks = this.wizardDocumentLinks(wz).map(link => ({
      label: link.entityType === 'deal'
        ? `Сделка #${link.entityId} «${link.entityTitle}»`
        : `Компания ${link.entityTitle}`,
      style: link.entityType === 'deal'
        ? 'display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;background:#eef2ff;color:#4f46e5;font-size:11.5px;font-weight:500;'
        : 'display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;background:#f4f4f5;color:#52525b;font-size:11.5px;font-weight:500;',
    }));

    const isAdmin = S.screen === 'admin';
    const adminAllowed = !!(
      this.serverPolicy
      && this.serverPolicy.permissions
      && this.serverPolicy.permissions.administer
    );
    const adminTabsDef = [
      ['sections', 'Разделы'], ['types', 'Типы документов'], ['lifecycles', 'Жизненные циклы'], ['roles', 'Роли и доступ'],
    ];
    const adminTabs = adminTabsDef.map(([key, label]) => ({
      label,
      onPick: () => {
        this.setState({ adminTab: key });
        void this.loadAdministrationData();
        if (key === 'roles') void this.loadAdminAccess();
      },
      style: `background:none;border:none;border-bottom:2px solid ${S.adminTab === key ? '#4f46e5' : 'transparent'};color:${S.adminTab === key ? '#18181b' : '#a1a1aa'};font-weight:${S.adminTab === key ? '600' : '500'};padding:12px 12px;font-size:12.5px;cursor:pointer;`,
    }));
    const adminSectionSource = S.adminSections.length ? S.adminSections : this.SECTIONS.map(section => ({
      code: section.code, name: section.label, color: section.c,
      typeCount: (this.TYPES[section.code] || []).length, isActive: true, sortOrder: 100,
    }));
    const adminSectionRows = adminSectionSource.map(section => ({
      code: section.code,
      label: section.name,
      descriptionLabel: this.textValue(section.description) || '—',
      c: section.color || '#64748b',
      typeCount: section.typeCount || 0,
      activeLabel: section.isActive === false ? 'Нет' : 'Да',
      activeColor: section.isActive === false ? '#a1a1aa' : '#15803d',
      onEdit: () => this.openSectionEditor(section),
    }));
    const adminTypeRows = (S.adminTypes || []).map(type => {
      const lifecycle = (S.adminLifecyclesData || []).find(item => item.code === type.lifecycleCode);
      return {
        code: type.code,
        section: type.sectionName,
        c: type.sectionColor || '#64748b',
        label: type.name,
        lifecycle: lifecycle ? lifecycle.name : 'Не назначен',
        content: `${(type.fields || []).length} полей${type.isActive === false ? ' · отключён' : ''}`,
        onEdit: () => this.openTypeEditor(type),
      };
    });
    const stMeta = (code) => { const m = this.STATUS[code]; return { label: m.label, c: m.c, bg: m.bg }; };
    const adminLifecycles = (S.adminLifecyclesData || []).map(lifecycle => ({
      code: lifecycle.code,
      label: lifecycle.name,
      statusLabel: lifecycle.isActive === false ? 'отключён' : '',
      states: (lifecycle.config.states || []).map((state, index) => ({
        ...stMeta(state.code),
        label: state.label,
        c: state.color || stMeta(state.code).c,
        arrow: index < lifecycle.config.states.length - 1 ? '→' : '',
      })),
      onEdit: () => this.openLifecycleEditor(lifecycle),
    }));
    const moneyTag = (hide) => hide ? { moneyLabel: 'суммы скрыты', moneyC: '#dc2626', moneyBg: '#fdeaea' } : { moneyLabel: 'суммы видны', moneyC: '#15803d', moneyBg: '#e7f5ec' };
    const adminRoleRows = (S.adminPolicies || []).map(policy => {
      const fallback = this.ROLES[policy.roleCode] || {};
      const scopeLabel = (policy.visibleSectionCodes || []).length === adminSectionRows.filter(section => section.activeLabel === 'Да').length
        ? 'все разделы'
        : `${(policy.visibleSectionCodes || []).length} раздела(ов)`;
      return {
        code: policy.roleCode,
        label: policy.roleName,
        isActive: policy.isActive !== false,
        summary: fallback.hint || 'Настраиваемая политика доступа.',
        scopeLabel,
        ...moneyTag(policy.hideMoney),
        onEdit: () => this.openRoleEditor(policy),
      };
    });
    const adminRoleOptions = [
      { code: '', label: 'Доступ не назначен' },
      ...adminRoleRows.filter(item => item.code !== 'admin' && item.isActive).map(item => ({ code: item.code, label: item.label })),
    ];
    const developmentRoleOptions = adminRoleRows.length
      ? adminRoleRows.filter(item => item.isActive).map(item => ({ code: item.code, label: item.label }))
      : Object.entries(this.ROLES).map(([code, item]) => ({ code, label: item.label }));
    const adminUserRows = (S.adminUsers || []).map(user => {
      const isBitrixAdmin = !!user.isBitrixAdmin;
      return {
        id: user.id,
        name: user.name,
        details: [user.position, user.email].filter(Boolean).join(' · '),
        bitrixAdmin: isBitrixAdmin,
        roleEditable: !isBitrixAdmin,
        roleCode: isBitrixAdmin ? 'admin' : (S.adminUserRoles[String(user.id)] || ''),
        roleOptions: adminRoleOptions,
        onRole: event => this.setAdminUserRole(user.id, event.target.value),
      };
    });

    const trainingItems = this.TRAINING.map(([title, desc, kind, icon]) => ({ title, desc, kind, icon }));

    const nt = S.newType;
    const dataTypes = ['Текст', 'Число', 'Дата', 'Сумма', 'Список', 'Да/Нет', 'Файл'];
    const newTypeFields = nt.fields.map((f, i) => ({
      name: f.name, dtype: f.dtype,
      reqStyle: `width:18px;height:18px;border-radius:5px;border:1.5px solid ${f.required ? '#4f46e5' : '#d4d4d8'};background:${f.required ? '#4f46e5' : '#fff'};color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;cursor:pointer;flex:none;`,
      reqMark: f.required ? '✓' : '',
      onName: (e) => this.ntField(i, 'name', e.target.value),
      onType: (e) => this.ntField(i, 'dtype', e.target.value),
      onReq: () => this.ntField(i, 'required', !f.required),
      onRemove: () => this.ntRemoveField(i),
    }));
    const libraryChips = [['Срок оплаты', 'Дата'], ['Условия оплаты', 'Список'], ['Базис поставки', 'Список'], ['Ставка НДС', 'Список'], ['№ ГТД', 'Текст'], ['Срок поставки', 'Дата'], ['Предмет договора', 'Текст'], ['Период оказания услуг', 'Текст']].map(([name, dtype]) => ({ name, onAdd: () => this.ntAddField(name, dtype) }));
    const sectionEdit = S.sectionEdit || { name: '', description: '', color: '#64748b', sortOrder: 100, isActive: true };
    const lifecycleEdit = S.lifecycleEdit || { name: '', isActive: true, initialStatus: 'draft', states: [], transitions: [] };
    const lifecycleStateRows = lifecycleEdit.states.map((state, index) => ({
      ...state,
      terminalMark: state.terminal ? '✓' : '',
      onLabel: event => { const states = lifecycleEdit.states.map((item, i) => i === index ? { ...item, label: event.target.value } : item); this.setState({ lifecycleEdit: { ...lifecycleEdit, states } }); },
      onColor: event => { const states = lifecycleEdit.states.map((item, i) => i === index ? { ...item, color: event.target.value } : item); this.setState({ lifecycleEdit: { ...lifecycleEdit, states } }); },
      onTerminal: () => { const states = lifecycleEdit.states.map((item, i) => i === index ? { ...item, terminal: !item.terminal } : item); this.setState({ lifecycleEdit: { ...lifecycleEdit, states } }); },
      onRemove: () => this.setState({ lifecycleEdit: { ...lifecycleEdit, states: lifecycleEdit.states.filter((_, i) => i !== index) } }),
    }));
    const lifecycleTransitionRows = lifecycleEdit.transitions.map((transition, index) => {
      const selectedRoles = Array.isArray(transition.roles) ? transition.roles : [];
      const setRoles = roles => {
        const transitions = lifecycleEdit.transitions.map((item, i) => i === index ? { ...item, roles } : item);
        this.setState({ lifecycleEdit: { ...lifecycleEdit, transitions } });
      };
      return {
        ...transition,
        attachmentMark: transition.requiresAttachment ? '✓' : '',
        stateOptions: lifecycleEdit.states,
        allRolesMark: selectedRoles.length ? '' : '✓',
        allRolesStyle: `padding:4px 7px;border:1px solid ${selectedRoles.length ? '#e4e4e7' : '#a5b4fc'};border-radius:6px;background:${selectedRoles.length ? '#fff' : '#eef2ff'};color:${selectedRoles.length ? '#52525b' : '#4f46e5'};font-size:10px;cursor:pointer;`,
        roleOptions: adminRoleRows.filter(role => role.isActive).map(role => {
          const selected = selectedRoles.includes(role.code);
          return {
            label: role.label,
            mark: selected ? '✓' : '',
            style: `padding:4px 7px;border:1px solid ${selected ? '#a5b4fc' : '#e4e4e7'};border-radius:6px;background:${selected ? '#eef2ff' : '#fff'};color:${selected ? '#4f46e5' : '#52525b'};font-size:10px;cursor:pointer;`,
            onToggle: () => setRoles(selected
              ? selectedRoles.filter(roleCode => roleCode !== role.code)
              : [...selectedRoles, role.code]),
          };
        }),
        onAllRoles: () => setRoles([]),
        onFrom: event => { const transitions = lifecycleEdit.transitions.map((item, i) => i === index ? { ...item, from: event.target.value } : item); this.setState({ lifecycleEdit: { ...lifecycleEdit, transitions } }); },
        onTo: event => { const transitions = lifecycleEdit.transitions.map((item, i) => i === index ? { ...item, to: event.target.value } : item); this.setState({ lifecycleEdit: { ...lifecycleEdit, transitions } }); },
        onAttachment: () => { const transitions = lifecycleEdit.transitions.map((item, i) => i === index ? { ...item, requiresAttachment: !item.requiresAttachment } : item); this.setState({ lifecycleEdit: { ...lifecycleEdit, transitions } }); },
        onRemove: () => this.setState({ lifecycleEdit: { ...lifecycleEdit, transitions: lifecycleEdit.transitions.filter((_, i) => i !== index) } }),
      };
    });
    const roleEdit = S.roleEdit || { roleName: '', visibleSectionCodes: [], allTypes: true, visibleTypeCodes: [], hiddenFields: [], permissions: {}, hideMoney: false, isActive: true };
    const toggleInList = (items, value) => items.includes(value) ? items.filter(item => item !== value) : [...items, value];
    const roleSectionOptions = adminSectionSource.filter(section => section.isActive !== false).map(section => ({
      code: section.code, label: section.name, checked: roleEdit.visibleSectionCodes.includes(section.code), mark: roleEdit.visibleSectionCodes.includes(section.code) ? '✓' : '',
      onToggle: () => {
        const visibleSectionCodes = toggleInList(roleEdit.visibleSectionCodes, section.code);
        const allowedTypeCodes = new Set((S.adminTypes || [])
          .filter(type => visibleSectionCodes.includes(type.sectionCode))
          .map(type => type.code));
        const byType = Object.fromEntries(Object.entries(roleEdit.permissions.byType || {})
          .filter(([typeCode]) => allowedTypeCodes.has(typeCode)));
        this.setState({
          roleEdit: {
            ...roleEdit,
            visibleSectionCodes,
            visibleTypeCodes: roleEdit.visibleTypeCodes.filter(typeCode => allowedTypeCodes.has(typeCode)),
            permissions: { ...roleEdit.permissions, byType },
          },
        });
      },
    }));
    const roleTypeDefaults = type => ({
      view: roleEdit.allTypes || roleEdit.visibleTypeCodes.includes(type.code),
      create: roleEdit.permissions.create === true,
      edit: roleEdit.permissions.editAny === true || roleEdit.permissions.editOwn === true,
      transition: roleEdit.permissions.transitionAny === true || roleEdit.permissions.transitionOwn === true,
      archive: roleEdit.permissions.softDelete === true || roleEdit.permissions.restore === true,
      export: roleEdit.permissions.export === true,
      finance: roleEdit.hideMoney !== true,
    });
    const roleTypeOptions = (S.adminTypes || []).filter(type => type.isActive !== false && roleEdit.visibleSectionCodes.includes(type.sectionCode)).map(type => {
      const checked = roleEdit.visibleTypeCodes.includes(type.code);
      return {
        code: type.code, label: `${type.sectionName} · ${type.name}`, checked, mark: checked ? '✓' : '',
        onToggle: () => {
          const nextChecked = !checked;
          const byType = roleEdit.permissions.byType || {};
          const current = { ...roleTypeDefaults(type), ...(byType[type.code] || {}) };
          this.setState({
            roleEdit: {
              ...roleEdit,
              visibleTypeCodes: toggleInList(roleEdit.visibleTypeCodes, type.code),
              permissions: {
                ...roleEdit.permissions,
                byType: { ...byType, [type.code]: { ...current, view: nextChecked } },
              },
            },
          });
        },
      };
    });
    const fieldOptionsByKey = new Map([['amount', 'Сумма'], ['currency', 'Валюта']]);
    (S.adminTypes || []).forEach(type => (type.fields || []).forEach(field => fieldOptionsByKey.set(field.key, field.name)));
    const roleFieldOptions = [...fieldOptionsByKey].map(([key, label]) => ({
      key, label, checked: roleEdit.hiddenFields.includes(key), mark: roleEdit.hiddenFields.includes(key) ? '✓' : '',
      onToggle: () => this.setState({ roleEdit: { ...roleEdit, hiddenFields: toggleInList(roleEdit.hiddenFields, key) } }),
    }));
    const permissionLabels = { create: 'Создание', editOwn: 'Правка своих', editAny: 'Правка всех', transitionOwn: 'Статусы своих', transitionAny: 'Статусы всех', softDelete: 'Удаление', restore: 'Восстановление', export: 'XLSX', administer: 'Администрирование' };
    const rolePermissionOptions = Object.entries(permissionLabels)
      .filter(([key]) => key !== 'administer' || S.editingRoleCode === 'admin')
      .map(([key, label]) => ({
      key, label, checked: roleEdit.permissions[key] === true, mark: roleEdit.permissions[key] === true ? '✓' : '',
      onToggle: () => this.setState({ roleEdit: { ...roleEdit, permissions: { ...roleEdit.permissions, [key]: !roleEdit.permissions[key] } } }),
      }));
    const typePermissionLabels = [
      ['view', 'Просмотр'],
      ['create', 'Создание'],
      ['edit', 'Редактирование'],
      ['transition', 'Статусы'],
      ['archive', 'Архив'],
      ['export', 'Экспорт'],
      ['finance', 'Финансы'],
    ];
    const roleTypePolicyRows = S.editingRoleCode === 'admin' ? [] : (S.adminTypes || [])
      .filter(type => type.isActive !== false && roleEdit.visibleSectionCodes.includes(type.sectionCode))
      .map(type => {
        const defaults = roleTypeDefaults(type);
        const byType = roleEdit.permissions.byType || {};
        const current = { ...defaults, ...(byType[type.code] || {}) };
        return {
          code: type.code,
          name: type.name,
          sectionName: type.sectionName,
          actions: typePermissionLabels.map(([key, label]) => {
            const checked = current[key] === true;
            return {
              key,
              label,
              mark: checked ? '✓' : '',
              style: `min-height:34px;padding:6px 7px;border:1px solid ${checked ? '#a5b4fc' : '#e4e4e7'};border-radius:7px;background:${checked ? '#eef2ff' : '#fff'};color:${checked ? '#4338ca' : '#71717a'};font-size:10.5px;text-align:left;cursor:pointer;`,
              onToggle: () => {
                const nextChecked = !checked;
                const visibleTypeCodes = key === 'view'
                  ? (nextChecked
                      ? [...new Set([...roleEdit.visibleTypeCodes, type.code])]
                      : roleEdit.visibleTypeCodes.filter(typeCode => typeCode !== type.code))
                  : roleEdit.visibleTypeCodes;
                this.setState({
                  roleEdit: {
                    ...roleEdit,
                    visibleTypeCodes,
                    permissions: {
                      ...roleEdit.permissions,
                      byType: {
                        ...byType,
                        [type.code]: { ...current, [key]: nextChecked },
                      },
                    },
                  },
                });
              },
            };
          }),
        };
      });
    const bulkUploadSectionOptions = this.SECTIONS
      .filter(section => this.visibleSections().includes(section.code))
      .filter(section => (this.TYPES[section.code] || []).some(label => {
        const type = this.typeMeta(section.code, label);
        return type && this.canCreateType(type);
      }))
      .map(section => ({ code: section.code, label: section.label }));
    const bulkUploadCommonTypeOptions = S.bulkUploadCommonSection
      ? (this.TYPES[S.bulkUploadCommonSection] || [])
          .filter(label => this.canCreateType(this.typeMeta(S.bulkUploadCommonSection, label)))
          .map(label => ({ label }))
      : [];
    const bulkUploadResponsibleOptions = uniqueRegistryUsers.map(user => ({
      value: String(user.id),
      label: user.name,
    }));
    const bulkUploadRows = (S.bulkUploadRows || []).map(row => {
      const validation = this.bulkUploadValidation(row);
      const rowType = this.typeMeta(row.sectionCode, row.typeLabel);
      const typeFields = (rowType && rowType.fields ? rowType.fields : []).map(field => {
        const isSelect = field.dataType === 'select' || field.dataType === 'boolean';
        return {
          key: field.key,
          label: field.label,
          requiredMark: field.isRequired ? ' *' : '',
          isSelect,
          isInput: !isSelect,
          inputType: field.dataType === 'date' ? 'date' : 'text',
          options: field.dataType === 'boolean' ? ['Да', 'Нет'] : (field.options || []),
          value: (row.fieldVals || {})[field.key] || '',
          onInput: event => this.updateBulkUploadRow(row.id, {
            fieldVals: { ...(row.fieldVals || {}), [field.key]: event.target.value },
            status: 'ready',
          }),
        };
      });
      const statusLabels = {
        ready: validation || 'Готов к загрузке',
        uploading: 'Загружается…',
        success: 'Документ создан',
        error: row.error || validation || 'Нужно исправить строку',
      };
      const statusColors = {
        ready: validation ? '#b45309' : '#52525b',
        uploading: '#4f46e5',
        success: '#15803d',
        error: '#b91c1c',
      };
      return {
        ...row,
        fileName: row.file && row.file.name ? row.file.name : 'Файл',
        fileSize: row.file && row.file.size
          ? `${Math.max(1, Math.ceil(row.file.size / 1024))} КБ`
          : '',
        typeOptions: row.sectionCode
          ? (this.TYPES[row.sectionCode] || [])
              .filter(label => this.canCreateType(this.typeMeta(row.sectionCode, label)))
              .map(label => ({ label }))
          : [],
        typeFields,
        hasTypeFields: typeFields.length > 0,
        counterpartyShown: row.counterpartyName || 'Выбрать компанию Bitrix24',
        statusLabel: statusLabels[row.status] || statusLabels.ready,
        statusStyle: `font-size:10.5px;color:${statusColors[row.status] || statusColors.ready};line-height:1.35;`,
        isUploading: row.status === 'uploading',
        isSuccess: row.status === 'success',
        hasError: row.status === 'error' || (!!validation && row.status !== 'success'),
        canRetry: row.status === 'error' && !S.bulkUploadBusy,
        onTitle: event => this.updateBulkUploadRow(row.id, { title: event.target.value, status: 'ready' }),
        onSection: event => this.updateBulkUploadRow(row.id, { sectionCode: event.target.value, typeLabel: '', fieldVals: {}, status: 'ready' }),
        onType: event => this.updateBulkUploadRow(row.id, { typeLabel: event.target.value, fieldVals: {}, status: 'ready' }),
        onDate: event => this.updateBulkUploadRow(row.id, { documentDate: event.target.value, status: 'ready' }),
        onAmount: event => this.updateBulkUploadRow(row.id, { amount: event.target.value, status: 'ready' }),
        onCurrency: event => this.updateBulkUploadRow(row.id, { currency: event.target.value, status: 'ready' }),
        onResponsible: event => {
          const user = uniqueRegistryUsers.find(item => String(item.id) === event.target.value);
          this.updateBulkUploadRow(row.id, {
            responsibleId: event.target.value,
            responsibleName: user ? user.name : '',
            status: 'ready',
          });
        },
        onCompany: () => { void this.pickBulkUploadCompany(row.id); },
        onRemove: () => this.removeBulkUploadRow(row.id),
        onRetry: () => { void this.createBulkUpload([row.id]); },
      };
    });
    const bulkUploadIncomplete = bulkUploadRows.filter(row => !row.isSuccess);
    const bulkUploadComplete = bulkUploadRows.length > 0 && bulkUploadIncomplete.length === 0;

    return {
      // nav
      showSidebar: !this.placementContextType,
      isRegistry: activeRegistry || archiveMode, isActiveRegistry: activeRegistry, isArchive: archiveMode,
      isDeal: S.screen === 'deal', isCompany: S.screen === 'company',
      placementContextMissing,
      placementContextReady,
      goRegistry: () => {
        this.setState({
          screen: 'registry',
          view: 'all',
          search: '',
          registryPage: 0,
          sel: {},
          rowMenuId: null,
          drawerId: null,
          filters: { sections: {}, statuses: {}, type: 'all', responsible: 'all', cp: '', from: '', to: '' },
        });
        this.scheduleDocumentsReload();
      },
      goArchive: () => {
        this.setState({
          screen: 'archive',
          view: 'all',
          search: '',
          registryPage: 0,
          sel: {},
          rowMenuId: null,
          drawerId: null,
          filters: { sections: {}, statuses: {}, type: 'all', responsible: 'all', cp: '', from: '', to: '' },
        });
        this.scheduleDocumentsReload();
      },
      goDeal: () => this.setState({ screen: 'deal' }),
      goCompany: () => this.setState({ screen: 'company' }),
      goAdmin: () => {
        this.setState({ screen: 'admin' });
        if (adminAllowed) {
          void this.loadAdministrationData();
          void this.loadAdminAccess();
        }
      },
      navRegistryStyle: this.navStyle(S.screen === 'registry'),
      navArchiveStyle: this.navStyle(archiveMode),
      navDealStyle: this.navStyle(S.screen === 'deal'),
      navCompanyStyle: this.navStyle(S.screen === 'company'),
      navAdminStyle: this.navStyle(S.screen === 'admin'),
      companyDeals, companyName, companyDocTotal, companyDocsByType,
      dealHeaderTitle, dealStageName, dealStageColor, dealContextLabel,
      companyIsDeals: S.companyView === 'deals', companyIsDocs: S.companyView === 'docs',
      setCompanyDeals: () => this.setState({ companyView: 'deals' }),
      setCompanyDocs: () => this.setState({ companyView: 'docs' }),
      cvDealsStyle: cvSeg(S.companyView === 'deals'), cvDocsStyle: cvSeg(S.companyView === 'docs'),
      adminLockIcon: adminAllowed ? '' : '🔒',
      isAdmin, adminAllowed, adminDenied: !adminAllowed,
      becomeAdmin: () => this.setState({ role: 'admin', activeSection: 'all' }),
      adminTabs, adminSectionRows, adminTypeRows, adminLifecycles, adminRoleRows,
      adminDataLoading: S.adminDataLoading,
      adminDataError: S.adminDataError,
      adminDataHasError: !!S.adminDataError,
      sectionTotal: adminSectionRows.length,
      openSectionModal: () => this.openSectionEditor(),
      sectionModalOpen: S.sectionModalOpen,
      sectionModalTitle: S.editingSectionCode ? 'Редактирование раздела' : 'Новый раздел',
      sectionName: sectionEdit.name,
      sectionDescription: this.textValue(sectionEdit.description),
      sectionColor: sectionEdit.color,
      sectionSortOrder: String(sectionEdit.sortOrder),
      sectionActive: sectionEdit.isActive,
      sectionActiveLabel: sectionEdit.isActive ? 'Да' : 'Нет',
      sectionCanDeactivate: !!S.editingSectionCode,
      sectionCanDelete: !!S.editingSectionCode,
      setSectionName: event => this.setState({ sectionEdit: { ...sectionEdit, name: event.target.value } }),
      setSectionDescription: event => this.setState({ sectionEdit: { ...sectionEdit, description: event.target.value } }),
      setSectionColor: event => this.setState({ sectionEdit: { ...sectionEdit, color: event.target.value } }),
      setSectionSortOrder: event => this.setState({ sectionEdit: { ...sectionEdit, sortOrder: event.target.value } }),
      toggleSectionActive: () => this.setState({ sectionEdit: { ...sectionEdit, isActive: !sectionEdit.isActive } }),
      closeSectionModal: () => this.setState({ sectionModalOpen: false, adminEditError: '' }),
      saveSection: () => { void this.saveSection(); },
      deleteSection: () => { void this.deleteSection(); },
      lifecycleModalOpen: S.lifecycleModalOpen,
      lifecycleModalTitle: S.editingLifecycleCode ? 'Редактирование жизненного цикла' : 'Новый жизненный цикл',
      openLifecycleModal: () => this.openLifecycleEditor(),
      closeLifecycleModal: () => this.setState({ lifecycleModalOpen: false, adminEditError: '' }),
      lifecycleName: lifecycleEdit.name,
      lifecycleActive: lifecycleEdit.isActive,
      lifecycleActiveLabel: lifecycleEdit.isActive ? 'Да' : 'Нет',
      lifecycleCanDeactivate: !!S.editingLifecycleCode,
      lifecycleCanDelete: !!S.editingLifecycleCode,
      lifecycleInitialStatus: lifecycleEdit.initialStatus,
      lifecycleStateRows,
      lifecycleTransitionRows,
      lifecycleStateOptions: lifecycleEdit.states,
      setLifecycleName: event => this.setState({ lifecycleEdit: { ...lifecycleEdit, name: event.target.value } }),
      setLifecycleInitial: event => this.setState({ lifecycleEdit: { ...lifecycleEdit, initialStatus: event.target.value } }),
      toggleLifecycleActive: () => this.setState({ lifecycleEdit: { ...lifecycleEdit, isActive: !lifecycleEdit.isActive } }),
      addLifecycleState: () => {
        const usedCodes = new Set(lifecycleEdit.states.map(state => state.code));
        let sequence = lifecycleEdit.states.length + 1;
        while (usedCodes.has(`state_${sequence}`)) sequence += 1;
        this.setState({ lifecycleEdit: { ...lifecycleEdit, states: [...lifecycleEdit.states, { code: `state_${sequence}`, label: '', color: '#71717a', terminal: false }] } });
      },
      addLifecycleTransition: () => this.setState({ lifecycleEdit: { ...lifecycleEdit, transitions: [...lifecycleEdit.transitions, { from: lifecycleEdit.initialStatus, to: lifecycleEdit.initialStatus, roles: [], requiresAttachment: false }] } }),
      saveLifecycle: () => { void this.saveLifecycle(); },
      deleteLifecycle: () => { void this.deleteLifecycle(); },
      roleModalOpen: S.roleModalOpen,
      roleModalTitle: S.editingRoleCode ? 'Редактирование роли' : 'Новая роль',
      openRoleModal: () => this.openRoleEditor(),
      closeRoleModal: () => this.setState({ roleModalOpen: false, adminEditError: '' }),
      roleName: roleEdit.roleName,
      roleActive: roleEdit.isActive,
      roleActiveLabel: roleEdit.isActive ? 'Да' : 'Нет',
      roleHideMoney: roleEdit.hideMoney,
      roleHideMoneyLabel: roleEdit.hideMoney ? 'Да' : 'Нет',
      roleAllTypes: roleEdit.allTypes,
      roleCustomTypes: !roleEdit.allTypes,
      roleAllTypesLabel: roleEdit.allTypes ? 'Да' : 'Нет',
      roleCanDelete: !!S.editingRoleCode && S.editingRoleCode !== 'admin',
      roleSectionOptions,
      roleTypeOptions,
      roleFieldOptions,
      rolePermissionOptions,
      roleTypePolicyRows,
      roleTypeMatrixVisible: roleTypePolicyRows.length > 0,
      setRoleName: event => this.setState({ roleEdit: { ...roleEdit, roleName: event.target.value } }),
      toggleRoleActive: () => this.setState({ roleEdit: { ...roleEdit, isActive: !roleEdit.isActive } }),
      toggleRoleHideMoney: () => this.setState({ roleEdit: { ...roleEdit, hideMoney: !roleEdit.hideMoney } }),
      toggleRoleAllTypes: () => {
        const allTypes = !roleEdit.allTypes;
        const visibleTypeCodes = allTypes
          ? roleEdit.visibleTypeCodes
          : (S.adminTypes || [])
              .filter(type => type.isActive !== false && roleEdit.visibleSectionCodes.includes(type.sectionCode))
              .filter(type => (roleEdit.permissions.byType || {})[type.code]?.view !== false)
              .map(type => type.code);
        this.setState({ roleEdit: { ...roleEdit, allTypes, visibleTypeCodes } });
      },
      saveRolePolicy: () => { void this.saveRolePolicy(); },
      deleteRolePolicy: () => { void this.deleteRolePolicy(); },
      adminEditError: S.adminEditError,
      adminEditHasError: !!S.adminEditError,
      adminUserRows,
      adminUsersEmpty: !S.adminAccessLoading && adminUserRows.length === 0,
      adminAccessLoading: S.adminAccessLoading,
      adminAccessSaving: S.adminAccessSaving,
      adminAccessError: S.adminAccessError,
      adminAccessHasError: !!S.adminAccessError,
      adminAccessSaved: S.adminAccessSaved,
      retryAdminAccess: () => { void this.loadAdminAccess(); },
      saveAdminAccess: () => { void this.saveAdminAccess(); },
      adminAccessSaveLabel: S.adminAccessSaving ? 'Сохранение…' : 'Сохранить назначения',
      adminAccessSaveStyle: `background:${S.adminAccessSaving ? '#c7c5ef' : '#4f46e5'};color:#fff;border:none;border-radius:7px;padding:7px 13px;font-size:11.5px;font-weight:600;cursor:${S.adminAccessSaving ? 'default' : 'pointer'};`,
      typeTotal: adminTypeRows.length,
      admSections: S.adminTab === 'sections', admTypes: S.adminTab === 'types',
      admLifecycles: S.adminTab === 'lifecycles', admRoles: S.adminTab === 'roles',
      trainingItems,
      helpOpen: S.helpOpen,
      openHelp: () => this.setState({ helpOpen: true }),
      closeHelp: () => this.setState({ helpOpen: false }),
      typeModalOpen: S.typeModalOpen,
      openTypeModal: () => this.openTypeEditor(),
      closeTypeModal: () => this.setState({ typeModalOpen: false, adminEditError: '' }),
      typeModalTitle: nt.code ? 'Редактирование типа документа' : 'Новый тип документа',
      ntCreateLabel: nt.code ? 'Сохранить тип' : 'Создать тип',
      ntCreate: () => { void this.saveDocumentType(nt); },
      ntSection: nt.section, ntLabel: nt.label, ntLifecycle: nt.lifecycle, ntFieldCount: nt.fields.length,
      ntDescription: this.textValue(nt.description),
      ntSortOrder: String(nt.sortOrder || 100),
      ntActive: nt.isActive !== false,
      ntActiveLabel: nt.isActive !== false ? 'Да' : 'Нет',
      ntCanDeactivate: !!nt.code,
      ntCanDelete: !!nt.code,
      ntSetSection: (e) => this.setState({ newType: { ...nt, section: e.target.value } }),
      ntSetLabel: (e) => this.setState({ newType: { ...nt, label: e.target.value } }),
      ntSetLifecycle: (e) => this.setState({ newType: { ...nt, lifecycle: e.target.value } }),
      ntSetDescription: (e) => this.setState({ newType: { ...nt, description: e.target.value } }),
      ntSetSortOrder: (e) => this.setState({ newType: { ...nt, sortOrder: e.target.value } }),
      ntToggleActive: () => this.setState({ newType: { ...nt, isActive: !nt.isActive } }),
      deleteDocumentType: () => { void this.deleteDocumentType(); },
      ntAddBlank: () => this.ntAddField('', 'Текст'),
      newTypeFields, libraryChips, dataTypes,
      ntSectionOptions: adminSectionSource.filter(section => section.isActive !== false).map(section => ({ code: section.code, label: section.name })),
      ntLifecycleOptions: (S.adminLifecyclesData || []).filter(lifecycle => lifecycle.isActive !== false).map(lifecycle => ({ code: lifecycle.code, label: lifecycle.name })),
      ntCreateStyle: `background:${nt.label.trim() ? '#4f46e5' : '#c7c5ef'};color:#fff;border:none;border-radius:8px;padding:9px 18px;font-size:12.5px;font-weight:600;cursor:${nt.label.trim() ? 'pointer' : 'not-allowed'};`,
      role: S.role, roleLabel: role.label, roleHint: role.hint,
      registryLoading: S.registryLoading,
      registryLoadFailed,
      registryReady: S.registryReady && !S.registryLoading,
      registryLoadError: S.registryLoadError,
      retryRegistry: () => { void this.initializeRegistry(); },
      accessDenied: S.accessDenied,
      accessGranted: !S.accessDenied,
      developmentRoleSwitcher: !(this.bitrixContext && this.bitrixContext.auth),
      developmentRoleOptions,
      fixedRole: !!(this.bitrixContext && this.bitrixContext.auth),
      setRole: (e) => { void this.switchDevelopmentRole(e.target.value); },
      confirmOpen: !!S.confirmDialog,
      confirmTitle: S.confirmDialog ? S.confirmDialog.title : '',
      confirmMessage: S.confirmDialog ? S.confirmDialog.message : '',
      confirmLabel: S.confirmDialog ? S.confirmDialog.confirmLabel : 'Удалить',
      confirmButtonStyle: S.confirmDialog && S.confirmDialog.confirmLabel === 'Восстановить'
        ? 'background:#4f46e5;border:1px solid #4f46e5;border-radius:7px;padding:8px 14px;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;'
        : 'background:#dc2626;border:1px solid #dc2626;border-radius:7px;padding:8px 14px;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;',
      cancelConfirmation: () => this.resolveConfirmation(false),
      acceptConfirmation: () => this.resolveConfirmation(true),
      sidebarSections,
      totalCount: documentOptions.scopeTotal || 0,
      archiveCount: documentOptions.archiveTotal || 0,
      dealCount: dealDocs.length,
      pickAll: () => this.updateRegistryFilters({ sections: {} }),
      secAllStyle: `display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:${noSecSel ? '#eef2ff' : 'transparent'};color:${noSecSel ? '#4f46e5' : '#52525b'};font-weight:${noSecSel ? '600' : '400'};border:none;border-radius:7px;padding:7px 9px;font-size:12.5px;cursor:pointer;`,
      headerTitle: archiveMode ? 'Архив' : (noSecSel ? 'Все документы' : (selSecsArr.length === 1 ? this.SECTIONS.find(s => s.code === selSecsArr[0]).label : 'Выбрано разделов: ' + selSecsArr.length)),
      headerSub: archiveMode
        ? 'Документы в архиве · ' + this.documentsMeta.total
        : 'Полноэкранный реестр · ' + (documentOptions.scopeTotal || 0) + ' документов в зоне видимости роли',
      emptyMessage: archiveMode ? 'Архив пуст.' : 'Документы не найдены. Измените фильтр или создайте новый.',
      search: S.search, setSearch: (e) => this.updateRegistrySearch(e.target.value),
      ...this.registryControls(scoped),
      filterResultLabel: this.documentsMeta.total + ' найдено',
      savedViews, rows, rowCount: rows.length, isEmpty: rows.length === 0,
      filteredTotal: this.documentsMeta.total,
      canExportRegistry,
      exportRegistry: () => { void this.exportRegistry(); },
      savedViewEditorOpen: S.savedViewEditorOpen,
      savedViewName: S.savedViewName,
      savedViewShared: S.savedViewShared,
      savedViewCanShare: adminAllowed,
      savedViewError: S.savedViewError,
      savedViewHasError: !!S.savedViewError,
      savedViewSaveLabel: S.savedViewSaving ? 'Сохранение…' : (S.savedViewEditingId ? 'Обновить' : 'Сохранить'),
      savedViewCanDelete: !!(editingSavedView && editingSavedView.canManage),
      openSavedViewEditor: () => this.openSavedViewEditor(),
      closeSavedViewEditor: () => this.setState({ savedViewEditorOpen: false, savedViewEditingId: null, savedViewError: '' }),
      setSavedViewName: event => this.setState({ savedViewName: event.target.value, savedViewError: '' }),
      toggleSavedViewShared: () => this.setState({ savedViewShared: !S.savedViewShared }),
      saveCurrentView: () => { void this.saveCurrentView(); },
      deleteEditingSavedView: () => { if (editingSavedView) void this.deleteSavedView(editingSavedView); },
      pageLabel: 'стр. ' + (S.registryPage + 1) + ' / ' + Math.max(1, Math.ceil(this.documentsMeta.total / this.documentPageSize)),
      singlePage: this.documentsMeta.total <= this.documentPageSize,
      multiplePages: this.documentsMeta.total > this.documentPageSize,
      previousPage: () => this.goToRegistryPage(S.registryPage - 1),
      nextPage: () => this.goToRegistryPage(S.registryPage + 1),
      previousPageStyle: `background:none;border:none;color:${S.registryPage > 0 ? '#52525b' : '#d4d4d8'};font-size:16px;line-height:1;padding:2px 4px;cursor:${S.registryPage > 0 ? 'pointer' : 'default'};`,
      nextPageStyle: `background:none;border:none;color:${S.registryPage + 1 < Math.ceil(this.documentsMeta.total / this.documentPageSize) ? '#52525b' : '#d4d4d8'};font-size:16px;line-height:1;padding:2px 4px;cursor:${S.registryPage + 1 < Math.ceil(this.documentsMeta.total / this.documentPageSize) ? 'pointer' : 'default'};`,
      hasSelection: Object.keys(S.sel).length > 0, noSelection: Object.keys(S.sel).length === 0,
      selectedCount: Object.keys(S.sel).length,
      clearSel: () => this.setState({ sel: {}, bulkAssignOpen: false, bulkError: '', responsibleMenuOpen: null }),
      bulkAssignOpen: S.bulkAssignOpen,
      bulkResponsibleId: S.bulkResponsibleId,
      bulkResponsibleOptions,
      bulkResponsibleLabel: (bulkResponsibleOptions.find(item => String(item.id) === String(S.bulkResponsibleId)) || bulkResponsibleOptions[0]).name,
      bulkResponsibleMenuOpen: S.responsibleMenuOpen === 'bulk',
      bulkBusy: S.bulkBusy,
      bulkHasError: !!S.bulkError,
      bulkError: S.bulkError,
      canBulkAssign: !archiveMode
        && selectedDocuments.length > 0
        && selectedDocuments.every(document => this.canEditDocument(document)),
      canBulkDelete: !archiveMode
        && selectedDocuments.length > 0
        && selectedDocuments.every(document => this.canArchiveDocument(document)),
      canBulkRestore: archiveMode
        && selectedDocuments.length > 0
        && selectedDocuments.every(document => this.canArchiveDocument(document, true)),
      openBulkAssign: () => this.setState({
        bulkAssignOpen: !S.bulkAssignOpen,
        bulkError: '',
        responsibleMenuOpen: S.bulkAssignOpen ? null : 'bulk',
      }),
      toggleBulkResponsible: () => this.setState({
        responsibleMenuOpen: S.responsibleMenuOpen === 'bulk' ? null : 'bulk',
      }),
      applyBulkAssign: () => { void this.bulkAssignDocuments(); },
      applyBulkDelete: () => { void this.bulkDeleteDocuments(); },
      applyBulkRestore: () => { void this.bulkRestoreDocuments(); },
      dealStages, dealMatrix, matrixLegend,
      embeddedGroups, dealSigned: dealDocs.filter(d => d.status === 'signed' || d.status === 'active').length,
      dealReview: dealDocs.filter(d => d.status === 'on_review' || d.status === 'awaiting').length,
      dealDraft: dealDocs.filter(d => d.status === 'draft').length,
      drawerOpen: !!doc,
      drawerHistoryOpen: !!doc && S.drawerHistoryOpen,
      drawerViewing: !!doc && !S.drawerEditing,
      drawerEditing: !!doc && S.drawerEditing,
      doc,
      closeDoc: () => {
        this.documentOpenRequestId = (this.documentOpenRequestId || 0) + 1;
        this.setState({
          rowMenuId: null,
          drawerId: null,
          drawerHistoryOpen: false,
          drawerEditing: false,
          drawerEditSaving: false,
          drawerEditError: '',
          drawerEdit: null,
          responsibleMenuOpen: null,
          drawerLinkOpen: false,
          drawerLinkName: '',
          drawerLinkUrl: '',
          drawerLinkError: '',
        });
      },
      closeDrawerHistory: () => this.setState({ drawerHistoryOpen: false }),
      cancelDocumentEdit: () => this.cancelDocumentEdit(),
      saveDocumentEdit: () => { void this.saveDocumentEdit(); },
      drawerEditSaving: S.drawerEditSaving,
      drawerEditError: S.drawerEditError,
      drawerEditHasError: !!S.drawerEditError,
      drawerEditSaveLabel: S.drawerEditSaving ? 'Сохранение…' : 'Сохранить',
      drawerEditSaveStyle: `background:${S.drawerEditSaving ? '#a5b4fc' : '#4f46e5'};border:1px solid ${S.drawerEditSaving ? '#a5b4fc' : '#4f46e5'};border-radius:7px;padding:7px 13px;color:#fff;font-size:11.5px;font-weight:600;cursor:${S.drawerEditSaving ? 'wait' : 'pointer'};`,
      drawerEditTitle: doc ? doc.edit.title : '',
      drawerEditNumber: doc ? doc.edit.number : '',
      drawerEditDate: doc ? doc.edit.date : '',
      drawerEditAmount: doc ? doc.edit.amount : '',
      drawerEditCurrency: doc ? doc.edit.currency : 'RUB',
      drawerEditLegalEntity: doc ? doc.edit.legalEntityName : '',
      drawerEditCounterparty: doc ? doc.edit.counterpartyName : '',
      drawerEditDealStage: doc ? doc.edit.dealStageId : '',
      drawerEditResponsible: doc ? doc.edit.responsibleId : '',
      drawerEditComment: doc ? doc.edit.comment : '',
      drawerEditMoneyVisible: !!(doc && doc.moneyVisible),
      drawerEditFields: doc ? doc.editFields : [],
      drawerEditHasFields: !!(doc && doc.editHasFields),
      drawerEditResponsibleOptions: doc ? doc.responsibleOptions : [],
      drawerEditResponsibleLabel: doc
        ? ((doc.responsibleOptions.find(item => item.value === String(doc.edit.responsibleId)) || {}).label
          || `Пользователь #${doc.edit.responsibleId}`)
        : 'Выберите ответственного',
      drawerEditResponsibleMenuOpen: S.responsibleMenuOpen === 'edit',
      setDrawerEditTitle: event => this.updateDocumentEdit('title', event.target.value),
      setDrawerEditNumber: event => this.updateDocumentEdit('number', event.target.value),
      setDrawerEditDate: event => this.updateDocumentEdit('date', event.target.value),
      setDrawerEditAmount: event => this.updateDocumentEdit('amount', event.target.value),
      setDrawerEditCurrency: event => this.updateDocumentEdit('currency', event.target.value),
      setDrawerEditLegalEntity: event => this.updateDocumentEdit('legalEntityName', event.target.value),
      setDrawerEditCounterparty: event => this.updateDocumentEdit('counterpartyName', event.target.value),
      setDrawerEditDealStage: event => this.updateDocumentEdit('dealStageId', event.target.value),
      toggleDrawerEditResponsible: () => this.setState({
        responsibleMenuOpen: S.responsibleMenuOpen === 'edit' ? null : 'edit',
      }),
      setDrawerEditComment: event => this.updateDocumentEdit('comment', event.target.value),
      addDrawerFile: () => { if (S.drawerId) void this.addFileToDocument(S.drawerId); },
      openDrawerLink: () => this.setState({ drawerLinkOpen: true, drawerLinkError: '' }),
      closeDrawerLink: () => this.setState({ drawerLinkOpen: false, drawerLinkName: '', drawerLinkUrl: '', drawerLinkError: '' }),
      saveDrawerLink: () => { if (S.drawerId) void this.saveDrawerLink(S.drawerId); },
      drawerLinkOpen: S.drawerLinkOpen,
      drawerLinkName: S.drawerLinkName,
      drawerLinkUrl: S.drawerLinkUrl,
      drawerLinkError: S.drawerLinkError,
      drawerLinkHasError: !!S.drawerLinkError,
      setDrawerLinkName: (event) => this.setState({ drawerLinkName: event.target.value }),
      setDrawerLinkUrl: (event) => this.setState({ drawerLinkUrl: event.target.value, drawerLinkError: '' }),
      statusOptions: doc ? doc.statusOptions : [],
      bulkUploadOpen: S.bulkUploadOpen,
      openBulkUpload: () => this.openBulkUpload(),
      closeBulkUpload: () => {
        if (!S.bulkUploadBusy) this.setState({ bulkUploadOpen: false, bulkUploadError: '', bulkUploadDragActive: false });
      },
      bulkUploadRows,
      bulkUploadHasRows: bulkUploadRows.length > 0,
      bulkUploadIsEmpty: bulkUploadRows.length === 0,
      bulkUploadCount: `${bulkUploadRows.length} файл${bulkUploadRows.length === 1 ? '' : bulkUploadRows.length < 5 ? 'а' : 'ов'}`,
      bulkUploadSectionOptions,
      bulkUploadCommonTypeOptions,
      bulkUploadResponsibleOptions,
      bulkUploadCommonSection: S.bulkUploadCommonSection,
      bulkUploadCommonType: S.bulkUploadCommonType,
      bulkUploadCommonCompanyName: S.bulkUploadCommonCompanyName || 'Компания не выбрана',
      bulkUploadCommonResponsibleId: S.bulkUploadCommonResponsibleId,
      bulkUploadBusy: S.bulkUploadBusy,
      bulkUploadComplete,
      bulkUploadHasError: !!S.bulkUploadError,
      bulkUploadError: S.bulkUploadError,
      bulkUploadDropStyle: `border:2px dashed ${S.bulkUploadDragActive ? '#4f46e5' : '#c7d2fe'};background:${S.bulkUploadDragActive ? '#eef2ff' : '#fafaff'};border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:12px;transition:border-color .18s,background .18s;`,
      bulkUploadDropLabel: S.bulkUploadDragActive ? 'Отпустите файлы для загрузки' : 'Перетащите файлы сюда',
      bulkUploadPrimaryLabel: bulkUploadComplete
        ? 'Закрыть'
        : (S.bulkUploadBusy ? 'Загрузка…' : `Загрузить ${bulkUploadIncomplete.length}`),
      setBulkUploadCommonSection: event => this.setState({
        bulkUploadCommonSection: event.target.value,
        bulkUploadCommonType: '',
        bulkUploadError: '',
      }),
      setBulkUploadCommonType: event => this.setState({ bulkUploadCommonType: event.target.value, bulkUploadError: '' }),
      setBulkUploadCommonResponsible: event => {
        const user = uniqueRegistryUsers.find(item => String(item.id) === event.target.value);
        this.setState({
          bulkUploadCommonResponsibleId: event.target.value,
          bulkUploadCommonResponsibleName: user ? user.name : '',
          bulkUploadError: '',
        });
      },
      pickBulkUploadCompany: () => { void this.pickBulkUploadCompany(); },
      applyBulkUploadCommon: () => this.applyBulkUploadCommon(),
      pickBulkUploadFiles: async () => this.appendBulkUploadFiles(await this.chooseFiles()),
      bulkUploadDragEnter: event => { if (event) event.preventDefault(); this.setState({ bulkUploadDragActive: true }); },
      bulkUploadDragOver: event => { if (event) event.preventDefault(); if (event && event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; },
      bulkUploadDragLeave: event => {
        if (!event || !event.currentTarget || !event.relatedTarget || !event.currentTarget.contains(event.relatedTarget)) {
          this.setState({ bulkUploadDragActive: false });
        }
      },
      bulkUploadDrop: event => {
        if (!event || !event.dataTransfer) return;
        event.preventDefault();
        event.stopPropagation();
        this.setState({ bulkUploadDragActive: false });
        this.appendBulkUploadFiles(event.dataTransfer.files || []);
      },
      applyBulkUpload: () => {
        if (bulkUploadComplete) this.setState({ bulkUploadOpen: false });
        else void this.createBulkUpload();
      },
      wizardOpen: S.wizardOpen,
      openWizard: () => this.setState({
        wizardOpen: true,
        wizardError: '',
        responsibleMenuOpen: null,
        wz: {
          step: 1,
          sectionCode: null,
          typeLabel: null,
          number: '',
          date: '',
          amount: '',
          currency: 'RUB',
          counterparty: '',
          ...this.defaultResponsibleSelection(),
          fieldVals: {},
          links: [],
          file: null,
          externalLink: null,
          linkEditorOpen: false,
          linkName: '',
          linkUrl: '',
          linkError: '',
          supersedesId: null,
        },
      }),
      closeWizard: () => this.setState({ wizardOpen: false, wizardError: '', responsibleMenuOpen: null }),
      wizardTitle: wz.supersedesId ? 'Новая редакция документа' : 'Новый документ',
      wizardError: S.wizardError,
      wizardHasError: !!S.wizardError,
      wizardSteps, wizardSections, wizardTypes, wizardLinks,
      wizardMoneyVisible,
      wzManageLinks: () => { void this.manageWizardLinks(); },
      wizardTypeFields, wzHasTypeFields: wizardTypeFields.length > 0,
      wzStep1: wz.step === 1, wzStep2: wz.step === 2, wzStep3: wz.step === 3,
      wzHasSection: !!wz.sectionCode,
      wzTypeLabel: wz.typeLabel || '—', wzSectionLabel: wzSec ? wzSec.label : '—',
      wzNumber: wz.number, wzDate: wz.date, wzAmount: wz.amount, wzCurrency: wz.currency, wzCounterparty: wz.counterparty,
      wzDateShown: wz.date ? this.formatDocumentDate(wz.date) : '—',
      wzResponsible: wz.responsibleId || '',
      wzResponsibleOptions: wizardResponsibleOptions,
      wzMoneyRequiredMark: wzTypeMeta && wzTypeMeta.isFinancial ? ' *' : '',
      wzResponsibleShown: wz.responsibleName || (wz.responsibleId ? `Пользователь #${wz.responsibleId}` : '—'),
      wzResponsibleMenuOpen: S.responsibleMenuOpen === 'wizard',
      toggleWzResponsible: () => this.setState({
        responsibleMenuOpen: S.responsibleMenuOpen === 'wizard' ? null : 'wizard',
      }),
      wzFileLabel: wz.file ? ('📎 ' + (wz.file.name.length > 34 ? wz.file.name.slice(0, 31) + '…' : wz.file.name)) : '⬆ Загрузить файл',
      wzLinkLabel: wz.externalLink
        ? ('🔗 ' + ((wz.externalLink.name || new URL(wz.externalLink.url).hostname).slice(0, 30)))
        : '🔗 Указать ссылку',
      wzLinkEditorOpen: !!wz.linkEditorOpen,
      wzLinkName: wz.linkName || '',
      wzLinkUrl: wz.linkUrl || '',
      wzLinkError: wz.linkError || '',
      wzLinkHasError: !!wz.linkError,
      wzNumberShown: wz.number || '—', wzAmountShown: wz.amount ? (wz.amount + ' ' + wz.currency) : '—', wzCounterpartyShown: wz.counterparty || '—',
      wzSetNumber: (e) => this.setState({ wz: { ...wz, number: e.target.value }, wizardError: '' }),
      wzSetDate: (e) => this.setState({ wz: { ...wz, date: e.target.value }, wizardError: '' }),
      wzSetAmount: (e) => this.setState({ wz: { ...wz, amount: e.target.value }, wizardError: '' }),
      wzSetCurrency: (e) => this.setState({ wz: { ...wz, currency: e.target.value }, wizardError: '' }),
      wzSetCounterparty: (e) => this.setState({ wz: { ...wz, counterparty: e.target.value }, wizardError: '' }),
      wzPickFile: async () => { const file = await this.chooseFile(); if (file) this.setState({ wz: { ...this.state.wz, file, externalLink: null, linkEditorOpen: false, linkName: '', linkUrl: '', linkError: '' } }); },
      wzOpenLink: () => this.setState({ wz: { ...wz, file: null, linkEditorOpen: true, linkName: wz.externalLink ? wz.externalLink.name || '' : '', linkUrl: wz.externalLink ? wz.externalLink.url : '', linkError: '' } }),
      wzSetLinkName: (event) => this.setState({ wz: { ...wz, linkName: event.target.value } }),
      wzSetLinkUrl: (event) => this.setState({ wz: { ...wz, linkUrl: event.target.value, linkError: '' } }),
      wzSaveLink: () => {
        const url = this.normalizeExternalLink(wz.linkUrl);
        if (!url) {
          this.setState({ wz: { ...wz, linkError: 'Укажите корректную ссылку, начинающуюся с https://' } });
          return;
        }
        this.setState({ wz: { ...wz, file: null, externalLink: { name: String(wz.linkName || '').trim(), url }, linkEditorOpen: false, linkError: '' } });
      },
      wzCancelLink: () => this.setState({ wz: { ...wz, linkEditorOpen: false, linkError: '' } }),
      wzClearContent: () => this.setState({ wz: { ...wz, file: null, externalLink: null, linkEditorOpen: false, linkName: '', linkUrl: '', linkError: '' } }),
      wzDragOver: (event) => this.handleFileDragOver(event),
      wzDropFile: (event) => { if (!event || !event.dataTransfer) return; event.preventDefault(); const file = event.dataTransfer.files && event.dataTransfer.files[0]; if (file) this.setState({ wz: { ...this.state.wz, file, externalLink: null, linkEditorOpen: false, linkName: '', linkUrl: '', linkError: '' } }); },
      wzBack: () => { if (wz.step > (wz.supersedesId ? 2 : 1)) this.setState({ wz: { ...wz, step: wz.step - 1 } }); },
      wzBackStyle: `background:none;border:1px solid #e4e4e7;border-radius:8px;padding:9px 16px;font-size:12.5px;color:#52525b;cursor:pointer;visibility:${wz.step > (wz.supersedesId ? 2 : 1) ? 'visible' : 'hidden'};`,
      wzPrimaryLabel: wz.step < 3 ? 'Далее →' : (wz.supersedesId ? 'Создать редакцию' : 'Создать документ'),
      wzPrimaryStyle: 'background:#4f46e5;color:#fff;border:none;border-radius:8px;padding:9px 18px;font-size:12.5px;font-weight:600;cursor:pointer;',
      wzPrimary: () => {
        if (!wzCanNext) {
          this.setState({ wizardError: wizardValidation.message });
          return;
        }
        if (wz.step < 3) {
          this.setState({ wz: { ...wz, step: wz.step + 1 }, wizardError: '' });
          return;
        }
        void this.createDocumentFromWizard(wz);
      },
    };
  }

  toggleGroup(key) { const c = { ...this.state.collapsedGroups }; if (c[key]) delete c[key]; else c[key] = true; this.setState({ collapsedGroups: c }); }
  openGroup(key) { const c = { ...this.state.collapsedGroups }; delete c[key]; this.setState({ collapsedGroups: c }); }

  ntField(i, key, val) { const nt = { ...this.state.newType, fields: this.state.newType.fields.map((f, j) => j === i ? { ...f, [key]: val } : f) }; this.setState({ newType: nt }); }
  ntAddField(name, dtype) { const nt = { ...this.state.newType, fields: [...this.state.newType.fields, { name: name || '', dtype: dtype || 'Текст', required: false }] }; this.setState({ newType: nt }); }
  ntRemoveField(i) { const nt = { ...this.state.newType, fields: this.state.newType.fields.filter((_, j) => j !== i) }; this.setState({ newType: nt }); }

  navStyle(active) {
    return `display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:${active ? '#4f46e5' : 'transparent'};color:${active ? '#fff' : '#52525b'};border:none;border-radius:7px;padding:8px 10px;font-size:12.5px;font-weight:500;cursor:pointer;`;
  }
}
