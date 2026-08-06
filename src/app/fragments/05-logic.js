
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
      await this.openDeepLinkedDocument();
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
    if (event.data.type === 'registry-bitrix-open-path-response') {
      const waiter = this.openPathWaiters && this.openPathWaiters[event.data.requestId];
      if (!waiter) return;
      delete this.openPathWaiters[event.data.requestId];
      if (event.data.error) waiter.reject(new Error(event.data.error));
      else waiter.resolve();
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

  requestCrmSelection(links, entityTypes = ['deal', 'company'], multiple = true) {
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
        { type: 'registry-bitrix-select-crm-request', requestId, value, entityTypes, multiple },
        window.location.origin,
      );
    });
  }

  openBitrixPath(path) {
    if (!this.openPathWaiters) this.openPathWaiters = {};
    const requestId = `path-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        delete this.openPathWaiters[requestId];
        reject(new Error('Время ожидания Bitrix24 истекло.'));
      }, 15000);
      this.openPathWaiters[requestId] = {
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: error => { clearTimeout(timeout); reject(error); },
      };
      window.parent.postMessage(
        { type: 'registry-bitrix-open-path-request', requestId, path },
        window.location.origin,
      );
    });
  }

  async openCompany(companyId) {
    const id = this.positiveEntityId(companyId);
    if (!id) return;
    try {
      await this.openBitrixPath(`/crm/company/details/${id}/`);
    } catch (error) {
      const portalOrigin = this.bitrixPortalOrigin();
      if (portalOrigin) window.open(`${portalOrigin}/crm/company/details/${id}/`, '_blank', 'noopener,noreferrer');
      else console.error('Failed to open Bitrix24 company', error);
    }
  }

  async openDeal(dealId) {
    const id = this.positiveEntityId(dealId);
    if (!id) return;
    try {
      await this.openBitrixPath(`/crm/deal/details/${id}/`);
    } catch (error) {
      const portalOrigin = this.bitrixPortalOrigin();
      if (portalOrigin) window.open(`${portalOrigin}/crm/deal/details/${id}/`, '_blank', 'noopener,noreferrer');
      else console.error('Failed to open Bitrix24 deal', error);
    }
  }

  async openTask(taskId) {
    const id = this.positiveEntityId(taskId);
    if (!id) return;
    try {
      await this.openBitrixPath(`/company/personal/user/0/tasks/task/view/${id}/`);
    } catch (error) {
      console.error('Failed to open Bitrix24 task', error);
    }
  }

  internalDocumentLink(documentId) {
    const portalOrigin = this.bitrixPortalOrigin();
    const applicationId = this.bitrixContext && this.bitrixContext.application
      ? this.positiveEntityId(this.bitrixContext.application.id)
      : null;
    let url;
    if (portalOrigin && applicationId) {
      url = new URL(`/marketplace/app/${applicationId}/`, portalOrigin);
    } else {
      try {
        url = new URL(window.parent.location.href);
      } catch {
        url = new URL(window.location.href);
      }
    }
    // Never copy transient Bitrix OAuth parameters from the iframe URL.
    url.search = '';
    url.hash = '';
    url.searchParams.set('document', documentId);
    return url.toString();
  }

  async copyInternalDocumentLink(documentId) {
    try {
      await this.writeClipboardText(this.internalDocumentLink(documentId));
      this.setState({ internalLinkCopiedId: documentId, internalLinkCopyFailedId: null });
      setTimeout(() => {
        if (this.state.internalLinkCopiedId === documentId) this.setState({ internalLinkCopiedId: null });
      }, 2500);
    } catch (error) {
      console.error('Failed to copy internal registry link', error);
      this.setState({ internalLinkCopyFailedId: documentId, internalLinkCopiedId: null });
    }
  }

  bitrixPortalOrigin() {
    const raw = this.bitrixContext && this.bitrixContext.auth
      ? String(this.bitrixContext.auth.domain || '').trim()
      : '';
    if (!raw) return null;
    try {
      const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
      if (!parsed.hostname || parsed.hostname === 'https' || parsed.hostname === 'http') return null;
      return `https://${parsed.hostname.toLowerCase()}`;
    } catch {
      return null;
    }
  }

  async writeClipboardText(value) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        // Bitrix24 can deny the Clipboard API inside a nested iframe. Fall
        // through to the synchronous selection-based copy below.
      }
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    const copied = typeof document.execCommand === 'function'
      && document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Clipboard copy is unavailable.');
  }

  async openDeepLinkedDocument() {
    if (this.deepLinkHandled) return;
    this.deepLinkHandled = true;
    const id = new URLSearchParams(window.location.search).get('document');
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    await this.openDocument(id, false, true);
  }

  wizardContextDefaults() {
    const company = this.entityContext && this.entityContext.company;
    const deal = this.entityContext && this.entityContext.deal;
    return {
      counterparty: company ? company.title : '',
      counterpartyId: company ? company.id : null,
      sourceCounterpartyName: company ? company.title : '',
      dealStageId: deal && deal.stageId ? deal.stageId : '',
      dealStageName: deal && deal.stageName ? deal.stageName : '',
    };
  }

  async pickWizardCompany() {
    try {
      const current = this.state.wz.counterpartyId
        ? [{ entityType: 'company', entityId: this.state.wz.counterpartyId }]
        : [];
      const selected = await this.requestCrmSelection(current, ['company'], false);
      const companies = selected.filter(item => item.entityType === 'company');
      const company = companies[companies.length - 1];
      if (!company) return;
      this.setState({
        wz: {
          ...this.state.wz,
          counterparty: company.entityTitle,
          counterpartyId: company.entityId,
          sourceCounterpartyName: company.entityTitle,
        },
        wizardError: '',
      });
    } catch (error) {
      console.error('Failed to select Bitrix24 company', error);
    }
  }

  async pickDrawerCompany() {
    const edit = this.state.drawerEdit;
    if (!edit) return;
    try {
      const current = edit.counterpartyId
        ? [{ entityType: 'company', entityId: edit.counterpartyId }]
        : [];
      const selected = await this.requestCrmSelection(current, ['company'], false);
      const companies = selected.filter(item => item.entityType === 'company');
      const company = companies[companies.length - 1];
      if (!company) return;
      this.setState({
        drawerEdit: {
          ...edit,
          counterpartyId: company.entityId,
          counterpartyName: company.entityTitle,
        },
        drawerEditError: '',
      });
    } catch (error) {
      console.error('Failed to select Bitrix24 company', error);
    }
  }

  async searchWizardTasks(value) {
    const search = String(value || '').trim();
    const requestId = (this.taskSearchRequestId || 0) + 1;
    this.taskSearchRequestId = requestId;
    this.setState({ wz: { ...this.state.wz, taskSearch: value }, taskSearchLoading: true });
    try {
      const payload = await this.api(`/api/v1/registry/tasks?search=${encodeURIComponent(search)}&limit=20`);
      if (requestId !== this.taskSearchRequestId) return;
      this.setState({ taskSearchResults: payload.items || [], taskSearchLoading: false });
    } catch (error) {
      if (requestId !== this.taskSearchRequestId) return;
      this.setState({ taskSearchResults: [], taskSearchLoading: false });
      console.error('Failed to search Bitrix24 tasks', error);
    }
  }

  selectWizardTask(task) {
    const current = Array.isArray(this.state.wz.taskLinks) ? this.state.wz.taskLinks : [];
    const taskLinks = [...new Map([
      ...current,
      { taskId: Number(task.id), taskTitle: task.title },
    ].map(item => [String(item.taskId), item])).values()];
    this.setState({
      wz: { ...this.state.wz, taskLinks, taskSearch: '' },
      taskSearchResults: [],
      wizardError: '',
    });
  }

  removeWizardTask(taskId) {
    this.setState({
      wz: {
        ...this.state.wz,
        taskLinks: (this.state.wz.taskLinks || []).filter(item => Number(item.taskId) !== Number(taskId)),
      },
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

  async refreshDocumentAfterLinkChange(documentId) {
    if (this.placementEntity) {
      await this.loadContextDocuments();
      if (this.docs.some(document => document.id === documentId)) {
        await this.openDocument(documentId);
      } else {
        this.drawerDocument = null;
        this.setState({ drawerId: null });
      }
      return;
    }
    await this.openDocument(documentId);
  }

  async removeDocumentCrmLink(documentId, link) {
    if (!link || !link.id) return;
    const confirmed = await this.requestConfirmation({
      title: `Отвязать ${link.entityType === 'deal' ? 'сделку' : 'компанию'}?`,
      message: `Связь с «${link.title}» будет удалена. Сам документ и сущность Bitrix24 сохранятся.`,
      confirmLabel: 'Отвязать',
    });
    if (!confirmed) return;
    try {
      await this.api(`/api/v1/registry/documents/${documentId}/links/${link.id}`, {
        method: 'DELETE',
      });
      await this.refreshDocumentAfterLinkChange(documentId);
    } catch (error) {
      this.setState({
        drawerTaskError: error instanceof Error ? error.message : 'Не удалось удалить привязку.',
      });
    }
  }

  async removeDocumentTaskLink(documentId, link) {
    if (!link || !link.id) return;
    const confirmed = await this.requestConfirmation({
      title: 'Отвязать задачу?',
      message: `Связь с задачей «${link.taskTitle}» будет удалена. Сама задача Bitrix24 сохранится.`,
      confirmLabel: 'Отвязать',
    });
    if (!confirmed) return;
    try {
      await this.api(`/api/v1/registry/documents/${documentId}/tasks/${link.id}`, {
        method: 'DELETE',
      });
      await this.refreshDocumentAfterLinkChange(documentId);
    } catch (error) {
      this.setState({
        drawerTaskError: error instanceof Error ? error.message : 'Не удалось удалить привязку задачи.',
      });
    }
  }

  async searchDrawerTasks(value) {
    const search = String(value || '').trim();
    const requestId = (this.drawerTaskSearchRequestId || 0) + 1;
    this.drawerTaskSearchRequestId = requestId;
    this.setState({
      drawerTaskSearch: value,
      drawerTaskSearchLoading: true,
      drawerTaskError: '',
    });
    try {
      const payload = await this.api(`/api/v1/registry/tasks?search=${encodeURIComponent(search)}&limit=20`);
      if (requestId !== this.drawerTaskSearchRequestId) return;
      this.setState({
        drawerTaskResults: payload.items || [],
        drawerTaskSearchLoading: false,
      });
    } catch (error) {
      if (requestId !== this.drawerTaskSearchRequestId) return;
      this.setState({
        drawerTaskResults: [],
        drawerTaskSearchLoading: false,
        drawerTaskError: error instanceof Error ? error.message : 'Не удалось найти задачи Bitrix24.',
      });
    }
  }

  async addDocumentTaskLink(documentId, task) {
    if (!documentId || !task) return;
    try {
      await this.api(`/api/v1/registry/documents/${documentId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ taskId: Number(task.id), taskTitle: task.title }),
      });
      this.setState({
        drawerTaskSearch: '',
        drawerTaskResults: [],
        drawerTaskSearchLoading: false,
        drawerTaskError: '',
        drawerActionError: '',
      });
      await this.refreshDocumentAfterLinkChange(documentId);
    } catch (error) {
      this.setState({
        drawerTaskError: error instanceof Error ? error.message : 'Не удалось привязать задачу.',
      });
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
        fieldFilters: filters.dynamic || {},
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
    const columns = Object.fromEntries([
      ...['section', 'counterparty', 'status', 'amount', 'docDate', 'responsible']
        .map(code => [code, (view.columns || []).includes(code)]),
      ...(view.columns || []).filter(code => code.startsWith('field:')).map(code => [code, true]),
    ]);
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
        dynamic: filters.fieldFilters || {},
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
    const recipients = document ? this.archiveRecipientLabel(document) : '';
    const confirmed = await this.requestConfirmation({
      title: 'Переместить документ в архив?',
      message: document
        ? `Документ «${document.title}» будет перемещён в архив без удаления. Его можно восстановить.${recipients ? ` Уведомления получат: ${recipients}.` : ''}`
        : 'Документ будет перемещён в архив. Его можно будет восстановить.',
      confirmLabel: 'В архив',
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
      title: 'Переместить выбранные документы в архив?',
      message: `${documentIds.length} документ(ов) будут перемещены в архив без удаления. Их можно будет восстановить; создатели карточек и загрузившие текущие файлы получат уведомления.`,
      confirmLabel: 'В архив',
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
      return {
        ...Object.fromEntries(
        Object.entries(defaults).map(([key, fallback]) => [
          key,
          typeof stored[key] === 'boolean' ? stored[key] : fallback,
        ]),
        ),
        ...Object.fromEntries(Object.entries(stored)
          .filter(([key, value]) => key.startsWith('field:') && typeof value === 'boolean')),
      };
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
    if (!input.label.trim() || !Array.isArray(input.sections) || !input.sections.length) return;
    const dataTypes = {
      'Текст': 'text', 'Число': 'number', 'Дата': 'date', 'Сумма': 'money',
      'Список': 'select', 'Да/Нет': 'boolean', 'Файл': 'file',
    };
    try {
      await this.api(`/api/v1/registry/types${input.code ? '/' + input.code : ''}`, {
        method: input.code ? 'PUT' : 'POST',
        body: JSON.stringify({
          sectionCodes: input.sections,
          name: input.label,
          lifecycleCode: input.lifecycle,
          numberFormat: this.textValue(input.numberFormat).trim() || null,
          numberAutoGenerate: input.numberAutoGenerate === true,
          numberUniquenessEnabled: input.numberUniquenessEnabled === true,
          contentRequired: input.contentRequired !== false,
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
        adminFieldLibrary: types.fieldLibrary || [],
        adminLifecyclesData: lifecycles.items || [],
        adminPolicies: (roles.items || []).filter(role => role.roleCode !== 'manager'),
        adminDataLoading: false,
        adminDataLoaded: true,
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
        sections: (type.sectionCodes && type.sectionCodes.length) ? [...type.sectionCodes] : [type.sectionCode],
        label: type.name,
        lifecycle: type.lifecycleCode || 'simple',
        description: this.textValue(type.description),
        sortOrder: type.sortOrder,
        isActive: type.isActive !== false,
        numberFormat: type.numberFormat || '',
        numberAutoGenerate: type.numberAutoGenerate === true,
        numberUniquenessEnabled: type.numberUniquenessEnabled === true,
        contentRequired: type.contentRequired !== false,
        fields: (type.fields || []).map(field => ({
          key: field.key,
          name: field.name,
          dtype: dataTypeLabels[field.dataType] || 'Текст',
          required: field.isRequired === true,
          lockedSource: 'existing',
        })),
      } : {
        code: null,
        sections: [(this.state.adminSections[0] && this.state.adminSections[0].code) || 'client'],
        label: '',
        lifecycle: (this.state.adminLifecyclesData[0] && this.state.adminLifecyclesData[0].code) || 'simple',
        description: '',
        sortOrder: 100,
        isActive: true,
        numberFormat: '',
        numberAutoGenerate: false,
        numberUniquenessEnabled: false,
        contentRequired: true,
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
      return type && this.typeSectionCodes(type).some(sectionCode => visibleSections.has(sectionCode));
    });
    const byType = Object.fromEntries(
      Object.entries(input.permissions.byType || {}).filter(([typeCode]) => {
        const type = this.state.adminTypes.find(item => item.code === typeCode);
        return type && type.isActive !== false && this.typeSectionCodes(type).some(sectionCode => visibleSections.has(sectionCode));
      }),
    );
    try {
      await this.api(`/api/v1/registry/admin/role-policies${roleCode ? '/' + roleCode : ''}`, {
        method: roleCode ? 'PUT' : 'POST',
        body: JSON.stringify({
          roleName: input.roleName,
          visibleSectionCodes: input.visibleSectionCodes,
          visibleTypeCodes: input.allTypes ? null : visibleTypeCodes,
          hiddenFields: input.hiddenFields,
          permissions: { ...input.permissions, byType },
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
      const [payload, departmentPayload] = await Promise.all([
        this.api('/api/v1/registry/admin/user-roles'),
        this.api('/api/v1/registry/admin/department-roles'),
      ]);
      const assignments = {};
      const bitrixAdminIds = new Set(
        (payload.users || []).filter(user => user.isBitrixAdmin).map(user => String(user.id)),
      );
      (payload.items || []).forEach(item => {
        if (!bitrixAdminIds.has(String(item.userId))) {
          assignments[String(item.userId)] = item.roleCode;
        }
      });
      const departmentAssignments = {};
      (departmentPayload.items || []).forEach(item => {
        departmentAssignments[String(item.departmentId)] = {
          roleCode: item.roleCode,
          priority: Number(item.priority) || 100,
        };
      });
      this.setState({
        adminUsers: payload.users || [],
        registryUsers: this.state.registryUsers.length
          ? this.state.registryUsers
          : (payload.users || []),
        adminUserRoles: assignments,
        adminDepartments: departmentPayload.departments || [],
        adminDepartmentRoles: departmentAssignments,
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

  setAdminDepartmentRole(departmentId, roleCode) {
    const assignments = { ...this.state.adminDepartmentRoles };
    const key = String(departmentId);
    if (roleCode) {
      assignments[key] = {
        roleCode,
        priority: assignments[key] ? assignments[key].priority : 100,
      };
    } else {
      delete assignments[key];
    }
    this.setState({
      adminDepartmentRoles: assignments,
      adminAccessSaved: false,
      adminAccessError: '',
    });
  }

  setAdminDepartmentPriority(departmentId, value) {
    const key = String(departmentId);
    const current = this.state.adminDepartmentRoles[key];
    if (!current) return;
    const priority = Math.max(0, Math.min(1_000_000, Number(value) || 0));
    this.setState({
      adminDepartmentRoles: {
        ...this.state.adminDepartmentRoles,
        [key]: { ...current, priority },
      },
      adminAccessSaved: false,
      adminAccessError: '',
    });
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
    const departmentItems = Object.entries(this.state.adminDepartmentRoles)
      .filter(([, assignment]) => !!assignment.roleCode)
      .map(([departmentId, assignment]) => ({
        departmentId: Number(departmentId),
        roleCode: assignment.roleCode,
        priority: Number(assignment.priority) || 0,
      }));
    this.setState({ adminAccessSaving: true, adminAccessError: '', adminAccessSaved: false });
    try {
      await Promise.all([
        this.api('/api/v1/registry/admin/user-roles', {
          method: 'PUT',
          body: JSON.stringify({ items }),
        }),
        this.api('/api/v1/registry/admin/department-roles', {
          method: 'PUT',
          body: JSON.stringify({ items: departmentItems }),
        }),
      ]);
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
    this.entityContext = null;
    if (code === 'LEFT_MENU') this.setState({ screen: 'registry' });
    else this.forceUpdate();
  }

  clearContextDocuments() {
    this.entityContext = null;
    this.docs = [];
    this.documentsMeta = { total: 0, limit: 1000, offset: 0 };
    this.documentsSource = 'context_missing';
    this.dealSyncContextKey = null;
    this.setState({
      dealSyncBusy: false,
      dealSyncMessage: '',
      dealSyncError: '',
      contextDocumentsLoading: false,
      contextDocumentsError: '',
      contextSyncUnavailable: false,
    });
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
    drawerAdditionalOpen: false,
    drawerRelationsOpen: false,
    drawerLinksOpen: false,
    drawerStorageOpen: false,
    drawerAccessOpen: false,
    drawerTaskSearch: '',
    drawerTaskResults: [],
    drawerTaskSearchLoading: false,
    drawerTaskError: '',
    drawerActionError: '',
    expandedDocumentRelations: {},
    relationEditorOpen: false,
    relationEditorMode: 'child',
    relationEditorSearch: '',
    relationEditorCandidates: [],
    relationEditorSelectedId: null,
    relationEditorType: 'other',
    relationEditorLoading: false,
    relationEditorSaving: false,
    relationEditorError: '',
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
    filters: { sections: {}, statuses: {}, type: 'all', responsible: 'all', cp: '', from: '', to: '', dynamic: {} },
    dragTargetKey: null,
    bulkUploadOpen: false,
    bulkUploadRows: [],
    bulkUploadCommonSection: '',
    bulkUploadCommonType: '',
    bulkUploadCommonCompanyId: null,
    bulkUploadCommonCompanyName: '',
    bulkUploadCommonDealLinks: [],
    bulkUploadCommonTaskLinks: [],
    bulkUploadCommonTaskSearch: '',
    bulkUploadCommonTaskResults: [],
    bulkUploadCommonTaskLoading: false,
    bulkUploadCommonDocumentStatus: '',
    bulkUploadCommonResponsibleId: '',
    bulkUploadCommonResponsibleName: '',
    bulkUploadContextLinks: [],
    bulkUploadBusy: false,
    bulkUploadError: '',
    bulkUploadDragActive: false,
    bulkUploadHelpOpen: false,
    adminTab: 'sections',
    adminUsers: [],
    adminUserRoles: {},
    adminDepartments: [],
    adminDepartmentRoles: {},
    adminAccessLoading: false,
    adminAccessSaving: false,
    adminAccessError: '',
    adminAccessSaved: false,
    adminDataLoading: false,
    adminDataLoaded: false,
    adminDataError: '',
    adminSections: [],
    adminTypes: [],
    adminFieldLibrary: [],
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
    dealTotalCurrency: 'RUB',
    dealFinancialSummary: null,
    dealFinancialLoading: false,
    dealFinancialError: '',
    dealFinancialErrorCode: '',
    dealSyncBusy: false,
    dealSyncMessage: '',
    dealSyncError: '',
    contextDocumentsLoading: false,
    contextDocumentsError: '',
    contextSyncUnavailable: false,
    typeModalOpen: false,
    helpOpen: false,
    newType: { code: null, sections: ['client'], label: '', lifecycle: 'simple', description: '', sortOrder: 100, isActive: true, numberFormat: '', numberAutoGenerate: false, numberUniquenessEnabled: false, contentRequired: true, fields: [] },
    wizardOpen: false,
    wizardError: '',
    taskSearchResults: [],
    taskSearchLoading: false,
    internalLinkCopiedId: null,
    deepLinkError: '',
    wz: { step: 1, sectionCode: null, typeLabel: null, number: '', date: '', amount: '', currency: 'RUB', counterparty: '', counterpartyId: null, sourceCounterpartyName: '', dealStageId: '', dealStageName: '', comment: '', fieldVals: {}, links: [], taskLinks: [], taskSearch: '', file: null, externalLink: null, linkEditorOpen: false, linkName: '', linkUrl: '', linkError: '', supersedesId: null },
  };

  SECTIONS = [];
  TYPES = {};

  TYPE_META = {};
  LIFECYCLE_BY_CODE = {};
  serverPolicy = null;
  policyLoadError = null;
  registryInitializing = false;

  typeSectionCodes(type) {
    if (Array.isArray(type && type.sectionCodes) && type.sectionCodes.length) return type.sectionCodes;
    return type && type.sectionCode ? [type.sectionCode] : [];
  }

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
    const contextKey = `${this.placementEntity.entityType}:${this.placementEntity.entityId}`;
    if (this.dealSyncContextKey !== contextKey) {
      this.dealSyncContextKey = contextKey;
      this.setState({ dealSyncBusy: false, dealSyncMessage: '', dealSyncError: '' });
    }
    const requestId = (this.contextDocumentsRequestId || 0) + 1;
    this.contextDocumentsRequestId = requestId;
    this.setState({
      contextDocumentsLoading: true,
      contextDocumentsError: '',
      contextSyncUnavailable: false,
    });
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
      this.setState({
        contextDocumentsLoading: false,
        contextDocumentsError: '',
        contextSyncUnavailable: !!(payload.context && payload.context.syncUnavailable),
      });
      if (this.placementEntity.entityType === 'deal') {
        await this.loadDealFinancialSummary(this.state.dealTotalCurrency);
      } else {
        this.setState({
          dealFinancialSummary: null,
          dealFinancialLoading: false,
          dealFinancialError: '',
          dealFinancialErrorCode: '',
        });
      }
    } catch (error) {
      if (requestId !== this.contextDocumentsRequestId) return;
      this.documentsSource = 'error';
      console.error('Failed to load registry context documents', error);
      this.setState({
        contextDocumentsLoading: false,
        contextDocumentsError: error instanceof Error
          ? error.message
          : 'Не удалось загрузить документы из контекста Bitrix24.',
        contextSyncUnavailable: false,
      });
    }
  }

  async loadDealFinancialSummary(currency = this.state.dealTotalCurrency) {
    if (!this.placementEntity || this.placementEntity.entityType !== 'deal') return;
    const dealId = this.placementEntity.entityId;
    const requestId = (this.dealFinancialRequestId || 0) + 1;
    this.dealFinancialRequestId = requestId;
    this.setState({
      dealFinancialLoading: true,
      dealFinancialError: '',
      dealFinancialErrorCode: '',
    });
    try {
      const payload = await this.api(
        `/api/v1/registry/documents/deal/${dealId}/financial-summary?currency=${encodeURIComponent(currency)}`,
      );
      if (requestId !== this.dealFinancialRequestId) return;
      this.setState({
        dealFinancialSummary: payload,
        dealFinancialLoading: false,
        dealFinancialError: '',
        dealFinancialErrorCode: '',
      });
    } catch (error) {
      if (requestId !== this.dealFinancialRequestId) return;
      this.setState({
        dealFinancialSummary: null,
        dealFinancialLoading: false,
        dealFinancialError: error instanceof Error ? error.message : 'Не удалось рассчитать финансовый итог.',
        dealFinancialErrorCode: error && error.code ? error.code : 'unknown',
      });
    }
  }

  setDealTotalCurrency(currency) {
    this.setState({ dealTotalCurrency: currency });
    void this.loadDealFinancialSummary(currency);
  }

  async syncBitrixDealDocuments() {
    if (
      this.state.dealSyncBusy
      || !this.placementEntity
      || this.placementEntity.entityType !== 'deal'
    ) return;
    const dealId = this.placementEntity.entityId;
    this.setState({ dealSyncBusy: true, dealSyncMessage: '', dealSyncError: '' });
    try {
      const summary = await this.api(
        `/api/v1/registry/documents/deal/${dealId}/sync-bitrix`,
        { method: 'POST' },
      );
      this.setState({
        dealSyncBusy: false,
        dealSyncMessage: `Синхронизация завершена: создано ${summary.created}, обновлено ${summary.updated}, без изменений ${summary.unchanged}, дублей ${summary.duplicates}.`,
        dealSyncError: '',
      });
      await this.loadContextDocuments();
    } catch (error) {
      this.setState({
        dealSyncBusy: false,
        dealSyncMessage: '',
        dealSyncError: error instanceof Error
          ? error.message
          : 'Не удалось синхронизировать счета и коммерческие предложения.',
      });
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
    let downloadDocument = document;
    try {
      if (window.parent && window.parent !== window && window.parent.location.origin === window.location.origin) {
        downloadDocument = window.parent.document;
      }
    } catch {
      downloadDocument = document;
    }
    const link = downloadDocument.createElement('a');
    link.href = url;
    link.download = filename;
    link.target = '_self';
    link.style.display = 'none';
    downloadDocument.body.appendChild(link);
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
      input.addEventListener('change', () => resolve(Array.from(input.files || [])), { once: true });
      input.click();
    });
  }

  async uploadFileToDocument(documentId, file, replacesAttachmentId = null, fieldKey = null) {
    const initialized = await this.api(`/api/v1/registry/documents/${documentId}/attachments/file/init`, {
      method: 'POST',
      body: JSON.stringify({
        name: file.name,
        mimeType: file.type || undefined,
        sizeBytes: file.size,
        ...(fieldKey ? { fieldKey } : {}),
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

  async addFileToDocument(documentId, fieldKey = null) {
    const file = await this.chooseFile();
    if (!file) return;
    try {
      await this.uploadFileToDocument(documentId, file, null, fieldKey);
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

  openWizard(sectionCode = null, links = []) {
    const responsible = this.defaultResponsibleSelection();
    this.setState({
      wizardOpen: true,
      wizardError: '',
      responsibleMenuOpen: null,
      wz: {
        step: 1,
        sectionCode,
        typeLabel: null,
        number: '',
        date: '',
        amount: '',
        currency: 'RUB',
        ...this.wizardContextDefaults(),
        ...responsible,
        comment: '',
        fieldVals: {},
        links: Array.isArray(links) ? links : [],
        taskLinks: [],
        taskSearch: '',
        file: null,
        externalLink: null,
        linkEditorOpen: false,
        linkName: '',
        linkUrl: '',
        linkError: '',
        supersedesId: null,
      },
    });
  }

  openWizardForFile(file, sectionCode = null, links = []) {
    if (!file) return;
    const responsible = this.defaultResponsibleSelection();
    this.setState({
      wizardOpen: true,
      wizardError: '',
      responsibleMenuOpen: null,
      wz: { step: 1, sectionCode, typeLabel: null, number: '', date: '', amount: '', currency: 'RUB', ...this.wizardContextDefaults(), ...responsible, comment: '', fieldVals: {}, links, taskLinks: [], taskSearch: '', file, externalLink: null, linkEditorOpen: false, linkName: '', linkUrl: '', linkError: '', supersedesId: null },
    });
  }

  bulkDocumentTitle(file) {
    const name = String(file && file.name || 'Документ').trim();
    return name.replace(/\.[^.]+$/, '') || name;
  }

  bulkContextLinks(links = []) {
    const result = new Map();
    for (const link of [...this.creationContextLinks(), ...(Array.isArray(links) ? links : [])]) {
      if (!link || (link.entityType !== 'deal' && link.entityType !== 'company')) continue;
      result.set(`${link.entityType}:${link.entityId}`, link);
    }
    return [...result.values()];
  }

  bulkContextCompany(links = []) {
    return this.bulkContextLinks(links).find(link => link.entityType === 'company') || null;
  }

  openBulkUpload(files = [], sectionCode = null, links = []) {
    const contextLinks = this.bulkContextLinks(links);
    const company = this.bulkContextCompany(contextLinks);
    const responsible = this.defaultResponsibleSelection();
    this.setState({
      bulkUploadOpen: true,
      responsibleMenuOpen: null,
      bulkUploadRows: [],
      bulkUploadCommonSection: sectionCode || '',
      bulkUploadCommonType: '',
      bulkUploadCommonCompanyId: company ? Number(company.entityId) : null,
      bulkUploadCommonCompanyName: company ? company.entityTitle : '',
      bulkUploadCommonDealLinks: contextLinks.filter(link => link.entityType === 'deal'),
      bulkUploadCommonTaskLinks: [],
      bulkUploadCommonTaskSearch: '',
      bulkUploadCommonTaskResults: [],
      bulkUploadCommonTaskLoading: false,
      bulkUploadCommonDocumentStatus: '',
      bulkUploadCommonResponsibleId: responsible.responsibleId || '',
      bulkUploadCommonResponsibleName: responsible.responsibleName || '',
      bulkUploadContextLinks: contextLinks,
      bulkUploadBusy: false,
      bulkUploadError: '',
      bulkUploadDragActive: false,
      bulkUploadHelpOpen: false,
    });
    requestAnimationFrame(() => this.appendBulkUploadFiles(files, {
      sectionCode,
      links: contextLinks,
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
      : [
          ...(this.state.bulkUploadContextLinks || []).filter(link => link.entityType !== 'deal'),
          ...(this.state.bulkUploadCommonDealLinks || []),
        ];
    const commonTypeLabel = defaults.typeLabel !== undefined
      ? defaults.typeLabel
      : this.state.bulkUploadCommonType;
    const type = sectionCode && commonTypeLabel
      ? this.typeMeta(sectionCode, commonTypeLabel)
      : null;
    const statusOptions = this.bulkUploadStatusOptions(type);
    const date = new Date().toISOString().slice(0, 10);
    const deal = this.entityContext && this.entityContext.deal;
    const rows = selected.map((file, index) => ({
      id: `bulk-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
      idempotencyKey: crypto.randomUUID(),
      file,
      title: this.bulkDocumentTitle(file),
      number: '',
      numberMode: type ? (type.numberAutoGenerate === true ? 'auto' : 'manual') : null,
      sectionCode: sectionCode || '',
      typeLabel: type ? commonTypeLabel : '',
      documentDate: date,
      amount: '',
      currency: 'RUB',
      counterpartyId: company ? Number(company.entityId) : null,
      counterpartyName: company ? company.entityTitle : '',
      dealStageId: deal && deal.stageId ? deal.stageId : '',
      responsibleId: responsible.responsibleId || '',
      responsibleName: responsible.responsibleName || '',
      comment: '',
      fieldVals: {},
      links: Array.isArray(links) ? links : [],
      taskLinks: [...(this.state.bulkUploadCommonTaskLinks || [])],
      taskSearch: '',
      taskResults: [],
      taskSearchLoading: false,
      documentStatus: statusOptions.some(option => option.code === this.state.bulkUploadCommonDocumentStatus)
        ? this.state.bulkUploadCommonDocumentStatus
        : (statusOptions[0] ? statusOptions[0].code : ''),
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

  bulkUploadStatusOptions(type) {
    if (!type) return [];
    const lifecycle = this.LIFECYCLE_BY_CODE[type.lifecycleCode];
    if (!lifecycle || !lifecycle.config) return [];
    const config = lifecycle.config;
    const allowedCodes = new Set([config.initialStatus]);
    const permissions = this.serverPolicy && this.serverPolicy.permissions;
    const canTransition = !!permissions
      && (permissions.transitionAny === true || permissions.transitionOwn === true)
      && this.typePermissionAllowed(type.code, 'transition');
    if (canTransition) {
      for (const transition of config.transitions || []) {
        if (transition.from !== config.initialStatus || transition.requiresAttachment) continue;
        const roleCode = this.serverPolicy && this.serverPolicy.roleCode
          ? this.serverPolicy.roleCode
          : this.state.role;
        if (transition.roles && !transition.roles.includes(roleCode)) continue;
        if (transition.to === 'archived') continue;
        allowedCodes.add(transition.to);
      }
    }
    return (config.states || [])
      .filter(state => allowedCodes.has(state.code))
      .map(state => ({ code: state.code, label: state.label }));
  }

  async pickBulkUploadDeals(rowId = null) {
    const row = rowId
      ? (this.state.bulkUploadRows || []).find(item => item.id === rowId)
      : null;
    const links = row ? (row.links || []) : (this.state.bulkUploadCommonDealLinks || []);
    try {
      const selected = await this.requestCrmSelection(
        links.filter(link => link.entityType === 'deal'),
        ['deal'],
        true,
      );
      const deals = selected.filter(link => link.entityType === 'deal');
      if (rowId) {
        this.updateBulkUploadRow(rowId, {
          links: [...links.filter(link => link.entityType !== 'deal'), ...deals],
          status: 'ready',
        });
      } else {
        this.setState({ bulkUploadCommonDealLinks: deals, bulkUploadError: '' });
      }
    } catch (error) {
      this.setState({
        bulkUploadError: error instanceof Error
          ? error.message
          : 'Не удалось выбрать сделки Bitrix24.',
      });
    }
  }

  async searchBulkUploadTasks(value, rowId = null) {
    const search = String(value || '').trim();
    const requestKey = rowId || 'common';
    if (!this.bulkTaskSearchRequestIds) this.bulkTaskSearchRequestIds = {};
    const requestId = (this.bulkTaskSearchSequence || 0) + 1;
    this.bulkTaskSearchSequence = requestId;
    this.bulkTaskSearchRequestIds[requestKey] = requestId;
    if (rowId) {
      const row = (this.state.bulkUploadRows || []).find(item => item.id === rowId);
      this.updateBulkUploadRow(rowId, {
        taskSearch: value,
        taskResults: search ? (row && row.taskResults ? row.taskResults : []) : [],
        taskSearchLoading: !!search,
      });
    } else {
      this.setState({
        bulkUploadCommonTaskSearch: value,
        bulkUploadCommonTaskResults: search ? this.state.bulkUploadCommonTaskResults : [],
        bulkUploadCommonTaskLoading: !!search,
      });
    }
    if (!search) return;
    try {
      const payload = await this.api(`/api/v1/registry/tasks?search=${encodeURIComponent(search)}&limit=20`);
      if (this.bulkTaskSearchRequestIds[requestKey] !== requestId) return;
      if (rowId) {
        this.updateBulkUploadRow(rowId, { taskResults: payload.items || [], taskSearchLoading: false });
      } else {
        this.setState({ bulkUploadCommonTaskResults: payload.items || [], bulkUploadCommonTaskLoading: false });
      }
    } catch (error) {
      if (this.bulkTaskSearchRequestIds[requestKey] !== requestId) return;
      if (rowId) this.updateBulkUploadRow(rowId, { taskResults: [], taskSearchLoading: false });
      else this.setState({ bulkUploadCommonTaskResults: [], bulkUploadCommonTaskLoading: false });
      console.error('Failed to search Bitrix24 tasks for bulk upload', error);
    }
  }

  selectBulkUploadTask(task, rowId = null) {
    if (!task) return;
    const taskLink = { taskId: Number(task.id), taskTitle: task.title };
    if (rowId) {
      this.updateBulkUploadRow(rowId, {
        taskLinks: [taskLink],
        taskSearch: '',
        taskResults: [],
        taskSearchLoading: false,
        status: 'ready',
      });
    } else {
      this.setState({
        bulkUploadCommonTaskLinks: [taskLink],
        bulkUploadCommonTaskSearch: '',
        bulkUploadCommonTaskResults: [],
        bulkUploadCommonTaskLoading: false,
        bulkUploadError: '',
      });
    }
  }

  applyBulkUploadCommon() {
    const sectionCode = this.state.bulkUploadCommonSection || '';
    const typeLabel = this.state.bulkUploadCommonType || '';
    const typeAllowed = typeLabel && (this.TYPES[sectionCode] || []).includes(typeLabel);
    const commonType = typeAllowed ? this.typeMeta(sectionCode, typeLabel) : null;
    const commonStatusOptions = this.bulkUploadStatusOptions(commonType);
    const commonDocumentStatus = commonStatusOptions.some(
      option => option.code === this.state.bulkUploadCommonDocumentStatus,
    )
      ? this.state.bulkUploadCommonDocumentStatus
      : (commonStatusOptions[0] ? commonStatusOptions[0].code : '');
    this.setState({
      bulkUploadRows: (this.state.bulkUploadRows || []).map(row => {
        if (row.status === 'success') return row;
        const nextTypeLabel = typeAllowed ? typeLabel : (sectionCode ? '' : row.typeLabel);
        const fieldsChanged = (sectionCode && sectionCode !== row.sectionCode)
          || (typeAllowed && typeLabel !== row.typeLabel);
        return {
          ...row,
          ...(sectionCode ? { sectionCode } : {}),
          ...(typeAllowed ? { typeLabel } : (sectionCode ? { typeLabel: '' } : {})),
          ...(fieldsChanged ? {
            fieldVals: {},
            number: '',
            numberMode: commonType
              ? (commonType.numberAutoGenerate === true ? 'auto' : 'manual')
              : null,
          } : {}),
          ...(typeAllowed ? { documentStatus: commonDocumentStatus } : {}),
          ...(this.state.bulkUploadCommonCompanyId ? {
            counterpartyId: this.state.bulkUploadCommonCompanyId,
            counterpartyName: this.state.bulkUploadCommonCompanyName,
          } : {}),
          ...(this.state.bulkUploadCommonResponsibleId ? {
            responsibleId: this.state.bulkUploadCommonResponsibleId,
            responsibleName: this.state.bulkUploadCommonResponsibleName,
          } : {}),
          links: [
            ...(row.links || []).filter(link => link.entityType !== 'deal'),
            ...(this.state.bulkUploadCommonDealLinks || []),
          ],
          taskLinks: [...(this.state.bulkUploadCommonTaskLinks || [])],
          taskSearch: '',
          taskResults: [],
          typeLabel: nextTypeLabel,
          status: 'ready',
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
        currentId ? [{
          entityType: 'company',
          entityId: currentId,
          entityTitle: row ? row.counterpartyName : this.state.bulkUploadCommonCompanyName,
        }] : [],
        ['company'],
        false,
      );
      const companies = selected.filter(item => item.entityType === 'company');
      const company = companies[companies.length - 1];
      if (!company) return;
      if (rowId) {
        this.updateBulkUploadRow(rowId, {
          counterpartyId: company.entityId,
          counterpartyName: company.entityTitle,
          status: 'ready',
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
    if (type.isFinancial && this.roleHidesMoney(type.code)) {
      return 'Финансовый тип недоступен для роли со скрытыми суммами.';
    }
    if (!String(row.title || '').trim()) return 'Укажите название документа.';
    const statusOptions = this.bulkUploadStatusOptions(type);
    if (!row.documentStatus || !statusOptions.some(option => option.code === row.documentStatus)) {
      return 'Выберите доступный статус документа.';
    }
    if (!this.toIsoDocumentDate(row.documentDate)) return 'Укажите дату документа.';
    if (!Number(row.responsibleId)) return 'Выберите ответственного.';
    if (row.counterpartyName && !Number(row.counterpartyId)) {
      return 'Выберите компанию из справочника Bitrix24.';
    }
    const amount = String(row.amount || '').replace(/\s/g, '').replace(',', '.');
    if (type.isFinancial && !amount) return 'Укажите сумму финансового документа.';
    if (amount && !/^\d+(\.\d{1,2})?$/.test(amount)) return 'Укажите корректную сумму.';
    if (amount && !/^[A-Z]{3}$/.test(String(row.currency || ''))) return 'Выберите валюту.';
    for (const field of type.fields || []) {
      const rawValue = (row.fieldVals || {})[field.key];
      if (field.dataType === 'file') {
        if (field.isRequired && !(rawValue instanceof File)) {
          return `Добавьте файл в обязательное поле «${field.label}».`;
        }
        continue;
      }
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

  bulkUploadDocumentInput(row) {
    const type = this.typeMeta(row.sectionCode, row.typeLabel);
    const amount = String(row.amount || '').replace(/\s/g, '').replace(',', '.');
    const fields = {};
    for (const field of type.fields || []) {
      const rawValue = (row.fieldVals || {})[field.key];
      if (field.dataType === 'file') {
        if (rawValue instanceof File) fields[field.key] = { pendingUpload: true, name: rawValue.name };
      } else {
        const normalized = this.normalizedDocumentFieldValue(field, rawValue);
        if (normalized !== null) fields[field.key] = normalized;
      }
    }
    const links = [...new Map((row.links || [])
      .filter(link => link && (link.entityType === 'deal' || link.entityType === 'company'))
      .map(link => [`${link.entityType}:${link.entityId}`, link])).values()];
    return {
      sectionCode: row.sectionCode,
      typeCode: type.code,
      number: row.numberMode === 'auto'
        ? null
        : (String(row.number || '').trim() || null),
      title: String(row.title).trim(),
      documentDate: this.toIsoDocumentDate(row.documentDate),
      counterpartyId: row.counterpartyId || null,
      counterpartyName: row.counterpartyName || null,
      dealStageId: row.dealStageId || undefined,
      status: row.documentStatus || undefined,
      responsibleId: Number(row.responsibleId),
      responsibleName: row.responsibleName || undefined,
      comment: String(row.comment || '').trim() || undefined,
      links,
      taskLinks: row.taskLinks || [],
      fields,
      ...(!this.roleHidesMoney(type.code) ? {
        amount: amount || null,
        currency: amount ? row.currency : null,
      } : {}),
    };
  }

  async uploadBulkRowFiles(row, document) {
    const attachments = Array.isArray(document.attachments) ? document.attachments : [];
    const type = this.typeMeta(row.sectionCode, row.typeLabel);
    for (const field of type.fields || []) {
      const file = (row.fieldVals || {})[field.key];
      if (!(file instanceof File)) continue;
      if (attachments.some(attachment => attachment.fieldKey === field.key && attachment.isCurrent !== false)) continue;
      attachments.push(await this.uploadFileToDocument(document.id, file, null, field.key));
    }
    if (!attachments.some(attachment => !attachment.fieldKey && attachment.kind === 'file' && attachment.isCurrent !== false)) {
      attachments.push(await this.uploadFileToDocument(document.id, row.file));
    }
    return this.api(`/api/v1/registry/documents/${document.id}/finalize`, { method: 'POST' });
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
          if (selectedIds && !selectedIds.has(row.id)) return row;
          const error = this.bulkUploadValidation(row);
          return error ? { ...row, status: 'error', error } : row;
        }),
        bulkUploadError: 'Исправьте поля, отмеченные в строках.',
      });
      return;
    }
    this.setState({
      bulkUploadBusy: true,
      bulkUploadError: '',
      bulkUploadRows: (this.state.bulkUploadRows || []).map(row =>
        candidates.some(candidate => candidate.id === row.id)
          ? { ...row, status: 'uploading', error: '' }
          : row),
    });
    let prepared;
    try {
      prepared = await this.api('/api/v1/registry/documents/bulk/upload', {
        method: 'POST',
        body: JSON.stringify({
          items: candidates.map(row => ({
            clientRowId: row.id,
            idempotencyKey: row.idempotencyKey,
            document: this.bulkUploadDocumentInput(row),
          })),
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось подготовить пакет документов.';
      this.setState({
        bulkUploadBusy: false,
        bulkUploadError: message,
        bulkUploadRows: (this.state.bulkUploadRows || []).map(row =>
          candidates.some(candidate => candidate.id === row.id)
            ? { ...row, status: 'error', error: message }
            : row),
      });
      return;
    }

    const preparedById = new Map((prepared.items || []).map(item => [item.clientRowId, item]));
    for (const candidate of candidates) {
      const item = preparedById.get(candidate.id);
      if (!item || item.status !== 'ready' || !item.document) {
        this.updateBulkUploadRow(candidate.id, {
          status: 'error',
          error: item && item.error && item.error.message
            ? item.error.message
            : 'Сервер не подготовил строку массовой загрузки.',
        });
        continue;
      }
      try {
        const created = await this.uploadBulkRowFiles(candidate, item.document);
        this.updateBulkUploadRow(candidate.id, {
          status: 'success',
          documentId: created.id,
          error: '',
        });
      } catch (error) {
        await this.api(`/api/v1/registry/documents/${item.document.id}/abandon`, { method: 'POST' })
          .catch(cleanupError => console.error('Failed to compensate incomplete bulk document', cleanupError));
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
    if (!document || !this.canEditDocument(document) || document.status === 'archived') return;
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
        taskLinks: (document.taskLinks || []).map(link => ({
          taskId: Number(link.taskId),
          taskTitle: link.taskTitle,
        })),
        taskSearch: '',
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
    const bulkZone = target && target.closest
      ? target.closest('#bulk-drop-zone-v2')
      : null;
    if (bulkZone && this.state.bulkUploadOpen) {
      if (event.type === 'dragenter' || event.type === 'dragover' || event.type === 'drop') {
        event.preventDefault();
      }
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      if (event.type === 'dragenter' || event.type === 'dragover') {
        if (!this.state.bulkUploadDragActive) this.setState({ bulkUploadDragActive: true });
        return;
      }
      if (event.type === 'dragleave') {
        const related = event.relatedTarget;
        if (related && bulkZone.contains(related)) return;
        this.setState({ bulkUploadDragActive: false });
        return;
      }
      event.stopPropagation();
      const files = event.dataTransfer && event.dataTransfer.files
        ? Array.from(event.dataTransfer.files)
        : [];
      this.setState({ bulkUploadDragActive: false });
      this.appendBulkUploadFiles(files);
      return;
    }
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
            bg: this.statusBackground(state.code, state.color),
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
    const fieldFilters = Object.fromEntries(Object.entries(filters.dynamic || {})
      .filter(([, value]) => value !== '' && value !== null && value !== undefined));
    if (Object.keys(fieldFilters).length) params.set('fieldFilters', JSON.stringify(fieldFilters));
    params.set('limit', String(this.documentPageSize));
    params.set('offset', String(this.state.registryPage * this.documentPageSize));
    return params;
  }

  async exportRegistry() {
    const params = this.documentQueryParams();
    params.delete('limit');
    params.delete('offset');
    const dynamicColumnKeys = new Set(this.activeDynamicColumns().map(field => `field:${field.key}`));
    params.set('columns', Object.keys(this.state.cols)
      .filter(key => this.state.cols[key] && (!key.startsWith('field:') || dynamicColumnKeys.has(key)))
      .join(','));
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

  statusBackground(code, color = '') {
    return {
      draft: '#f4f4f5', on_review: '#fdf2e3', awaiting: '#eef2ff',
      signed: '#e7f5ec', active: '#e7f5ec', overdue: '#fdeaea',
      expired: '#fdeaea', archived: '#f4f4f5',
    }[code] || (/^#[0-9a-f]{6}$/i.test(color) ? `${color}18` : '#f4f4f5');
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
      relation_parent_added: 'Указан основной документ',
      relation_parent_changed: 'Основной документ изменён',
      relation_parent_removed: 'Связь с основным документом удалена',
      relation_child_added: 'Добавлен зависимый документ',
      relation_child_removed: 'Зависимый документ отвязан',
      bitrix_document_imported: 'Карточка импортирована из Bitrix24',
      bitrix_document_synchronized: 'Карточка обновлена из Bitrix24',
      archive_notifications_dispatched: 'Отправлены уведомления об архивировании',
      restore_notifications_dispatched: 'Отправлены уведомления о восстановлении',
      crm_entity_title_updated: 'Название CRM-сущности обновлено',
      crm_entity_deleted: 'CRM-сущность удалена',
    }[event] || event;
  }

  historyDetail(entry) {
    const before = entry && entry.before && typeof entry.before === 'object' ? entry.before : {};
    const after = entry && entry.after && typeof entry.after === 'object' ? entry.after : {};
    const metadata = entry && entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
    const statusLabel = code => (this.STATUS[code] && this.STATUS[code].label) || code || '—';
    const recipients = Array.isArray(metadata.notificationRecipientIds)
      ? metadata.notificationRecipientIds.map(id => `#${id}`).join(', ')
      : '';
    if (entry.event === 'archive_notifications_dispatched' || entry.event === 'restore_notifications_dispatched') {
      const deliveries = Array.isArray(metadata.deliveries)
        ? metadata.deliveries.map(item => `#${item.userId}: ${item.status === 'sent' ? 'доставлено' : (item.status === 'failed' ? 'ошибка' : 'нет сессии')}`).join(' · ')
        : '';
      return [recipients ? `Получатели: ${recipients}` : '', deliveries].filter(Boolean).join(' · ');
    }
    if (entry.event === 'document_deleted' || entry.event === 'document_restored') {
      return recipients ? `Получатели уведомления: ${recipients}` : '';
    }
    if (entry.event === 'status_changed') {
      return `${statusLabel(before.status)} → ${statusLabel(after.status)}${metadata.comment ? ` · ${metadata.comment}` : ''}`;
    }
    if (entry.event === 'responsible_changed') {
      const oldValue = before.responsibleName || (before.responsibleId ? `#${before.responsibleId}` : '—');
      const newValue = after.responsibleName || (after.responsibleId ? `#${after.responsibleId}` : '—');
      return `${oldValue} → ${newValue}`;
    }
    if (entry.event === 'attachment_added' || entry.event === 'attachment_replaced' || entry.event === 'attachment_deleted') {
      const attachment = entry.event === 'attachment_deleted' ? before : after;
      return [attachment.name, attachment.version ? `версия ${attachment.version}` : '', attachment.sizeBytes ? `${Math.ceil(Number(attachment.sizeBytes) / 1024)} КБ` : ''].filter(Boolean).join(' · ');
    }
    if (entry.event === 'link_added' || entry.event === 'link_removed') {
      const link = entry.event === 'link_removed' ? before : after;
      return [link.entityType === 'deal' ? 'Сделка' : 'Компания', link.entityTitle].filter(Boolean).join(' · ');
    }
    if (entry.event === 'bitrix_document_imported' || entry.event === 'bitrix_document_synchronized') {
      const source = after.source === 'bitrix_quote' ? 'Коммерческое предложение' : 'Счёт';
      return `${source} Bitrix24 · ID ${after.externalId || '—'}`;
    }
    if (entry.event === 'document_updated') {
      const labels = {
        number: 'Номер', title: 'Название', documentDate: 'Дата', counterpartyName: 'Компания',
        dealStageId: 'Стадия сделки', responsibleName: 'Ответственный', comment: 'Комментарий',
      };
      const changes = Object.keys(after)
        .filter(key => !['updatedAt', 'updatedBy', 'fields'].includes(key) && String(before[key] ?? '') !== String(after[key] ?? ''))
        .slice(0, 4)
        .map(key => `${labels[key] || key}: ${String(before[key] ?? '—')} → ${String(after[key] ?? '—')}`);
      return changes.join(' · ');
    }
    return '';
  }

  relationTypeLabel(type) {
    return {
      addendum: 'Доп. соглашение',
      appendix: 'Приложение',
      other: 'Связанный документ',
    }[type] || 'Связанный документ';
  }

  relationTypeForDocument(document) {
    const code = String(document && document.typeCode || '').toLowerCase();
    const label = String(document && (document.type || document.typeLabel) || '').toLowerCase();
    if (code.includes('addendum') || label.includes('соглаш')) return 'addendum';
    if (code.includes('appendix') || label.includes('прилож')) return 'appendix';
    return 'other';
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

  archiveRecipientLabel(document) {
    if (!document) return '';
    const recipientIds = [...new Set([
      Number(document.createdBy),
      ...(document.atts || [])
        .filter(attachment => attachment.kind === 'file' && attachment.isCurrent)
        .map(attachment => Number(attachment.createdBy)),
    ].filter(id => Number.isSafeInteger(id) && id > 0))];
    return recipientIds.map(id => this.responsibleNameById(id) || `Пользователь #${id}`).join(', ');
  }

  toDocument(item, previous = {}) {
    const typeMeta = this.TYPE_META[item.section.code]
      ? this.TYPE_META[item.section.code][item.type.name]
      : null;
    const typeFieldByKey = new Map(
      ((typeMeta && typeMeta.fields) || []).map(field => [field.key, field]),
    );
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
          version: attachment.version || 1,
          isCurrent: attachment.isCurrent !== false,
          replacesAttachmentId: attachment.replacesAttachmentId || null,
          fieldKey: attachment.fieldKey || null,
          fieldLabel: attachment.fieldKey && typeFieldByKey.has(attachment.fieldKey)
            ? typeFieldByKey.get(attachment.fieldKey).label
            : '',
          createdBy: attachment.createdBy ? Number(attachment.createdBy) : null,
          storageCopies: Array.isArray(attachment.storageCopies)
            ? attachment.storageCopies.map(copy => ({
                id: copy.id,
                dealId: Number(copy.dealId),
                dealTitle: copy.dealTitle,
                diskFileId: Number(copy.diskFileId),
                diskFolderId: Number(copy.diskFolderId),
                storagePath: copy.storagePath,
                url: copy.url || null,
                createdAt: copy.createdAt || null,
              }))
            : [],
        }))
      : (previous.atts || []);
    const links = Array.isArray(item.links)
      ? item.links.map(link => ({
          id: link.id,
          type: link.entityType === 'deal' ? 'Сделка' : 'Компания',
          title: link.entityTitle,
          entityType: link.entityType,
          entityId: link.entityId,
          dealClosed: link.entityType === 'deal'
            ? (link.dealClosed === true ? true : (link.dealClosed === false ? false : null))
            : null,
        }))
      : (previous.links || []);
    const taskLinks = Array.isArray(item.taskLinks)
      ? item.taskLinks.map(link => ({
          id: link.id,
          taskId: Number(link.taskId),
          taskTitle: link.taskTitle,
        }))
      : (previous.taskLinks || []);
    const dealLinks = links.filter(link => link.entityType === 'deal');
    const dealLink = dealLinks[0];
    const dynamicFields = Array.isArray(item.fields)
      ? item.fields.filter(field => field.dataType !== 'file').map(field => ({
          key: field.key,
          label: field.label,
          dataType: field.dataType,
          rawValue: field.value,
          value: this.formatDynamicField(field),
        }))
      : (previous.dynamicFields || []);
    const history = Array.isArray(item.history)
      ? item.history.map(entry => {
        const detail = this.historyDetail(entry);
        return {
          what: this.historyLabel(entry.event),
          who: entry.actorName
            || (entry.actorId ? this.responsibleNameById(entry.actorId) : '')
            || (entry.actorId ? `Пользователь #${entry.actorId}` : 'Система'),
          when: this.formatHistoryDate(entry.createdAt),
          detail,
          hasDetail: !!detail,
        };
      })
      : (previous.history || []);
    const mapRelation = relation => ({
      id: relation.id,
      num: relation.number || '—',
      title: relation.title,
      status: relation.status,
      section: relation.section && relation.section.code,
      sectionLabel: relation.section && relation.section.name,
      sectionColor: relation.section && relation.section.color,
      typeCode: relation.type && relation.type.code,
      typeLabel: relation.type && relation.type.name,
      relationType: relation.relationType || 'other',
    });
    const relations = item.relations
      ? {
          parent: item.relations.parent ? mapRelation(item.relations.parent) : null,
          children: Array.isArray(item.relations.children)
            ? item.relations.children.map(mapRelation)
            : [],
        }
      : (previous.relations || { parent: null, children: [] });
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
      externalSource: item.externalSource || null,
      externalEntityTypeId: item.externalEntityTypeId ? Number(item.externalEntityTypeId) : null,
      externalEntityId: item.externalEntityId ? Number(item.externalEntityId) : null,
      externalStatus: item.externalStatus || '',
      externalUpdatedAt: item.externalUpdatedAt || null,
      externalSyncedAt: item.externalSyncedAt || null,
      atts: attachments,
      links,
      taskLinks,
      dynamicFields,
      history,
      relations,
      deal: !!dealLink,
      dealRef: dealLink ? String(dealLink.entityId) : null,
      dealRefs: dealLinks.map(link => String(link.entityId)),
    };
  }

  canEditDocument(document) {
    const policy = this.serverPolicy;
    const permissions = policy && policy.permissions;
    if (!document || !policy || !permissions) return false;
    const userId = Number(policy.userId);
    const own = Number(document.createdBy) === userId
      || Number(document.responsibleId) === userId;
    const scopeAllowed = !!permissions.editAny || (!!permissions.editOwn && own);
    return scopeAllowed && this.typePermissionAllowed(document.typeCode, 'edit');
  }

  typePermissionOverride(typeCode, key) {
    const permissions = this.serverPolicy && this.serverPolicy.permissions;
    if (!permissions || !typeCode) return undefined;
    return permissions.byType && permissions.byType[typeCode]
      ? permissions.byType[typeCode][key]
      : undefined;
  }

  typePermissionAllowed(typeCode, key) {
    return this.typePermissionOverride(typeCode, key) !== false;
  }

  typePermissionGranted(typeCode, key, fallback) {
    const override = this.typePermissionOverride(typeCode, key);
    return override === undefined ? !!fallback : override === true;
  }

  policyTypePermission(policy, typeCode, key, fallback = true) {
    const byType = policy && policy.permissions && policy.permissions.byType;
    const override = byType && byType[typeCode] ? byType[typeCode][key] : undefined;
    return override === undefined ? fallback : override === true;
  }

  policyAccessLabel(policy, document) {
    if (!policy || !document || policy.isActive === false) return 'Нет доступа';
    if (policy.roleCode === 'admin') return 'Полный доступ';
    if (!(policy.visibleSectionCodes || []).includes(document.section)) return 'Нет доступа';
    if (Array.isArray(policy.visibleTypeCodes)
      && !policy.visibleTypeCodes.includes(document.typeCode)) return 'Нет доступа';
    if (!this.policyTypePermission(policy, document.typeCode, 'view', true)) return 'Нет доступа';
    const permissions = policy.permissions || {};
    const content = this.policyTypePermission(policy, document.typeCode, 'content', true);
    const editScope = permissions.editAny === true || permissions.editOwn === true;
    const edit = editScope && this.policyTypePermission(policy, document.typeCode, 'edit', true);
    if (edit && content) return 'Просмотр, скачивание и редактирование';
    if (edit) return 'Просмотр и редактирование реквизитов';
    if (content) return 'Просмотр и скачивание';
    return 'Только просмотр карточки';
  }

  documentAccessRoleRows(document, linkedDeals) {
    const isAdministrator = !!(
      this.serverPolicy
      && this.serverPolicy.permissions
      && this.serverPolicy.permissions.administer
    );
    const configuredPolicies = (this.state.adminPolicies || [])
      .filter(policy => policy.isActive !== false);
    const policies = isAdministrator
      ? [
          ...configuredPolicies,
          ...(this.serverPolicy && !configuredPolicies.some(
            policy => policy.roleCode === this.serverPolicy.roleCode,
          ) ? [this.serverPolicy] : []),
        ]
      : (this.serverPolicy ? [this.serverPolicy] : []);
    const hasOpenDeal = linkedDeals.some(link => link.dealClosed === false);
    const allDealsClosed = linkedDeals.length > 0
      && linkedDeals.every(link => link.dealClosed === true);
    return policies.map(policy => {
      const baseLabel = this.policyAccessLabel(policy, document);
      let detail = 'Политика реестра для этого типа документа.';
      let accessLabel = baseLabel;
      if (policy.roleCode === 'sales') {
        if (allDealsClosed) {
          accessLabel = 'Нет доступа к карточке и файлам';
          detail = 'Все связанные сделки закрыты: действует специальное ограничение менеджера продаж.';
        } else if (linkedDeals.length === 0) {
          detail = 'Сделка не связана: применяется только политика типа.';
        } else if (hasOpenDeal) {
          detail = 'Есть открытая сделка; окончательный доступ определяется политикой типа и CRM-правами пользователя.';
        } else {
          detail = 'Состояние не всех сделок определено; backend выполнит окончательную проверку.';
        }
      }
      return {
        code: policy.roleCode,
        label: policy.roleName || policy.roleCode,
        accessLabel,
        detail,
      };
    });
  }

  canCreateType(type) {
    const permissions = this.serverPolicy && this.serverPolicy.permissions;
    return !!(type && permissions && this.typePermissionGranted(
      type.code,
      'create',
      permissions.create === true,
    ));
  }

  canTransitionDocument(document) {
    const policy = this.serverPolicy;
    const permissions = policy && policy.permissions;
    if (!document || !policy || !permissions) return false;
    const userId = Number(policy.userId);
    const own = Number(document.createdBy) === userId
      || Number(document.responsibleId) === userId;
    const scopeAllowed = !!permissions.transitionAny || (!!permissions.transitionOwn && own);
    return scopeAllowed && this.typePermissionAllowed(document.typeCode, 'transition');
  }

  canModifyDocumentContent(document) {
    return this.canEditDocumentScope(document)
      && this.typePermissionAllowed(document.typeCode, 'content');
  }

  canEditDocumentScope(document) {
    const policy = this.serverPolicy;
    const permissions = policy && policy.permissions;
    if (!document || !policy || !permissions) return false;
    const userId = Number(policy.userId);
    const own = Number(document.createdBy) === userId
      || Number(document.responsibleId) === userId;
    return !!permissions.editAny || (!!permissions.editOwn && own);
  }

  canArchiveDocument(document) {
    const permissions = this.serverPolicy && this.serverPolicy.permissions;
    return !!(document && permissions && this.typePermissionGranted(
      document.typeCode,
      'archive',
      permissions.softDelete === true,
    ));
  }

  canRestoreDocument(document) {
    const permissions = this.serverPolicy && this.serverPolicy.permissions;
    return !!(document && permissions && this.typePermissionGranted(
      document.typeCode,
      'restore',
      permissions.restore === true,
    ));
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
      counterpartyId: document.counterpartyId || null,
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
    const current = this.docs.find(document => document.id === id)
      || (this.drawerDocument && this.drawerDocument.id === id ? this.drawerDocument : null);
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
      if (field.dataType === 'file') continue;
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
    const counterpartyName = String(edit.counterpartyName || '').trim();
    const payload = {
      title,
      number: String(edit.number || '').trim() || null,
      documentDate,
      counterpartyId: edit.counterpartyId || null,
      counterpartyName: counterpartyName || null,
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
      const updated = this.toDocument(response, current);
      this.drawerDocument = updated;
      if (index !== -1) this.docs[index] = updated;
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

  async openDocument(id, startEditing = false, surfaceError = false) {
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
      const previous = index === -1
        ? (this.drawerDocument && this.drawerDocument.id === id ? this.drawerDocument : {})
        : this.docs[index];
      const document = this.toDocument(payload, previous);
      this.drawerDocument = document;
      if (index !== -1) this.docs[index] = document;
      const editing = startEditing && this.canEditDocument(document);
      this.setState({
        drawerId: id,
        drawerHistoryOpen: false,
        drawerAdditionalOpen: false,
        drawerRelationsOpen: !!(
          document.relations
          && (document.relations.parent || (document.relations.children || []).length > 0)
        ),
        drawerLinksOpen: false,
        drawerStorageOpen: false,
        drawerAccessOpen: false,
        drawerTaskSearch: '',
        drawerTaskResults: [],
        drawerTaskSearchLoading: false,
        drawerTaskError: '',
        drawerActionError: '',
        drawerEditing: editing,
        drawerEditSaving: false,
        drawerEditError: '',
        drawerEdit: editing ? this.createDocumentEditState(document) : null,
        drawerLinkOpen: false,
        responsibleMenuOpen: null,
        deepLinkError: '',
      });
    } catch (error) {
      if (requestId !== this.documentOpenRequestId) return;
      console.error('Failed to load registry document', error);
      if (surfaceError) {
        const accessExplanation = error && error.status === 404
          ? 'Документ не входит в доступную область. Проверьте права Bitrix24 на связанные компании и сделки, политику роли реестра и состояние сделок: для менеджера доступ прекращается после закрытия всех связанных сделок.'
          : null;
        this.setState({ deepLinkError: accessExplanation || (error instanceof Error
          ? error.message
          : 'Документ по ссылке недоступен.') });
      }
    }
  }

  openRelationEditor(mode) {
    if (!this.state.drawerId) return;
    const current = this.docs.find(document => document.id === this.state.drawerId)
      || (this.drawerDocument && this.drawerDocument.id === this.state.drawerId
        ? this.drawerDocument
        : null);
    this.setState({
      relationEditorOpen: true,
      relationEditorMode: mode,
      relationEditorSearch: '',
      relationEditorCandidates: [],
      relationEditorSelectedId: null,
      relationEditorType: mode === 'parent' ? this.relationTypeForDocument(current) : 'other',
      relationEditorLoading: true,
      relationEditorSaving: false,
      relationEditorError: '',
    });
    void this.loadRelationCandidates('');
  }

  closeRelationEditor() {
    if (this.relationSearchTimer) clearTimeout(this.relationSearchTimer);
    this.setState({
      relationEditorOpen: false,
      relationEditorSearch: '',
      relationEditorCandidates: [],
      relationEditorSelectedId: null,
      relationEditorLoading: false,
      relationEditorSaving: false,
      relationEditorError: '',
    });
  }

  updateRelationSearch(value) {
    this.setState({
      relationEditorSearch: value,
      relationEditorSelectedId: null,
      relationEditorError: '',
    });
    if (this.relationSearchTimer) clearTimeout(this.relationSearchTimer);
    this.relationSearchTimer = setTimeout(() => {
      this.relationSearchTimer = null;
      void this.loadRelationCandidates(value);
    }, 250);
  }

  async loadRelationCandidates(search) {
    const requestId = (this.relationSearchRequestId || 0) + 1;
    this.relationSearchRequestId = requestId;
    this.setState({ relationEditorLoading: true, relationEditorError: '' });
    try {
      const params = new URLSearchParams({ limit: '20', offset: '0' });
      const normalized = String(search || '').trim();
      if (normalized) params.set('search', normalized);
      const payload = await this.api(`/api/v1/registry/documents?${params.toString()}`);
      if (requestId !== this.relationSearchRequestId || !this.state.relationEditorOpen) return;
      const currentId = this.state.drawerId;
      const candidates = (payload.items || [])
        .filter(item => item.id !== currentId)
        .map(item => this.toDocument(item));
      this.setState({ relationEditorCandidates: candidates, relationEditorLoading: false });
    } catch (error) {
      if (requestId !== this.relationSearchRequestId) return;
      this.setState({
        relationEditorLoading: false,
        relationEditorError: error instanceof Error
          ? error.message
          : 'Не удалось найти документы.',
      });
    }
  }

  selectRelationCandidate(document) {
    const child = this.state.relationEditorMode === 'child'
      ? document
      : (this.docs.find(item => item.id === this.state.drawerId)
        || (this.drawerDocument && this.drawerDocument.id === this.state.drawerId
          ? this.drawerDocument
          : null));
    this.setState({
      relationEditorSelectedId: document.id,
      relationEditorType: this.relationTypeForDocument(child),
      relationEditorError: '',
    });
  }

  async saveRelation() {
    const currentId = this.state.drawerId;
    const selectedId = this.state.relationEditorSelectedId;
    if (!currentId || !selectedId || this.state.relationEditorSaving) return;
    const childDocumentId = this.state.relationEditorMode === 'child' ? selectedId : currentId;
    const parentDocumentId = this.state.relationEditorMode === 'child' ? currentId : selectedId;
    this.setState({ relationEditorSaving: true, relationEditorError: '' });
    try {
      await this.api(`/api/v1/registry/documents/${childDocumentId}/relations/parent`, {
        method: 'PUT',
        body: JSON.stringify({
          parentDocumentId,
          relationType: this.state.relationEditorType,
        }),
      });
      this.closeRelationEditor();
      await this.loadDocuments();
      await this.openDocument(currentId);
    } catch (error) {
      this.setState({
        relationEditorSaving: false,
        relationEditorError: error instanceof Error
          ? error.message
          : 'Не удалось сохранить связь документов.',
      });
    }
  }

  async removeDocumentRelation(childDocumentId, title) {
    const currentId = this.state.drawerId;
    if (!currentId) return;
    const confirmed = await this.requestConfirmation({
      title: 'Удалить связь документов?',
      message: `Документ «${title}» останется в реестре, будет удалена только связь с основным документом.`,
      confirmLabel: 'Удалить связь',
    });
    if (!confirmed) return;
    try {
      await this.api(`/api/v1/registry/documents/${childDocumentId}/relations/parent`, {
        method: 'DELETE',
      });
      await this.loadDocuments();
      await this.openDocument(currentId);
    } catch (error) {
      console.error('Failed to remove document relation', error);
    }
  }

  async transitionDocument(id, status) {
    this.setState({ drawerActionError: '' });
    try {
      const payload = await this.api(`/api/v1/registry/documents/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      const index = this.docs.findIndex(document => document.id === id);
      const current = index !== -1
        ? this.docs[index]
        : (this.drawerDocument && this.drawerDocument.id === id ? this.drawerDocument : {});
      const updated = this.toDocument(payload, current);
      if (index !== -1) this.docs[index] = updated;
      if (this.state.drawerId === id) this.drawerDocument = updated;
      this.forceUpdate();
      if (status === 'archived') {
        this.setState({ drawerId: null, rowMenuId: null, sel: {} });
        await Promise.all([this.loadDocuments(), this.loadDocumentOptions()]);
      }
    } catch (error) {
      console.error('Failed to transition registry document', error);
      this.setState({
        drawerActionError: error instanceof Error ? error.message : 'Не удалось изменить статус документа.',
      });
    }
  }

  typeMeta(sectionCode, typeLabel) {
    return this.TYPE_META[sectionCode]
      ? this.TYPE_META[sectionCode][typeLabel] || null
      : null;
  }

  typeMetaByCode(typeCode) {
    for (const types of Object.values(this.TYPE_META || {})) {
      const found = Object.values(types || {}).find(type => type.code === typeCode);
      if (found) return found;
    }
    return null;
  }

  wizardStepValidation(wz, type, step = wz.step) {
    const missing = [];
    const invalid = [];

    if (step === 1) {
      if (!wz.sectionCode) missing.push('Раздел');
      if (!wz.typeLabel) missing.push('Тип документа');
    }

    if (step === 2) {
      const rawDate = String(wz.date || '').trim();
      if (!rawDate) missing.push('Дата документа');
      else if (!this.toIsoDocumentDate(rawDate)) invalid.push('Дата документа — используйте формат дд.мм.гггг');

      const responsibleId = Number(wz.responsibleId);
      if (!Number.isSafeInteger(responsibleId) || responsibleId <= 0) {
        missing.push('Ответственный');
      }
      if (wz.counterparty && !this.positiveEntityId(wz.counterpartyId)) {
        invalid.push('Компания-контрагент — выберите компанию из результатов Bitrix24');
      }
      if (type && type.contentRequired !== false && !wz.file && !wz.externalLink) {
        missing.push('Содержимое: файл или HTTPS-ссылка');
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
        if (field.dataType === 'file') {
          if (field.isRequired && !(rawValue instanceof File)) missing.push(field.label);
          continue;
        }
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
      const override = typeCode ? this.typePermissionOverride(typeCode, 'finance') : undefined;
      if (override !== undefined) return !override;
      return !!this.serverPolicy.hideMoney
        || (this.serverPolicy.hiddenFields || []).includes('amount')
        || (this.serverPolicy.hiddenFields || []).includes('currency');
    }
    const role = this.ROLES[this.state.role];
    return !!(role && role.hideMoney);
  }

  lifecycleForDocument(document) {
    const type = this.typeMeta(document.section, document.type);
    return type ? this.LIFECYCLE_BY_CODE[type.lifecycleCode] || null : null;
  }

  lifecycleStateForDocument(document, status = document && document.status) {
    const lifecycle = document ? this.lifecycleForDocument(document) : null;
    return lifecycle && lifecycle.config
      ? (lifecycle.config.states || []).find(state => state.code === status) || null
      : null;
  }

  statusMetaForDocument(document, status = document && document.status) {
    const state = this.lifecycleStateForDocument(document, status);
    if (state) {
      return {
        code: state.code,
        label: state.label,
        c: state.color || '#71717a',
        bg: this.statusBackground(state.code, state.color),
      };
    }
    return this.STATUS[status] || {
      code: status,
      label: status || 'Статус не указан',
      c: '#71717a',
      bg: '#f4f4f5',
    };
  }

  transitionUnavailableReason(document, type, transition) {
    const currentAttachments = (document.atts || []).filter(attachment => attachment.isCurrent !== false);
    const missingFileField = (type && type.fields || [])
      .filter(field => field.dataType === 'file' && field.isRequired)
      .find(field => !currentAttachments.some(attachment => attachment.fieldKey === field.key));
    if (missingFileField) return `Сначала добавьте файл в обязательное поле «${missingFileField.label}».`;
    if (type && type.contentRequired !== false
      && !currentAttachments.some(attachment => !attachment.fieldKey)) {
      return 'Сначала добавьте основной файл или HTTPS-ссылку.';
    }
    if (transition.requiresAttachment && currentAttachments.length === 0) {
      return 'Для этого перехода требуется вложение.';
    }
    return '';
  }

  availableStatusActions(document, canTransition) {
    const lifecycle = this.lifecycleForDocument(document);
    const type = this.typeMeta(document.section, document.type);
    const currentMeta = this.statusMetaForDocument(document);
    const actions = [{
      code: document.status,
      label: currentMeta.label,
      c: currentMeta.c,
      bg: currentMeta.bg,
      active: true,
      disabled: true,
      reason: 'Текущий статус',
    }];
    if (!canTransition || !lifecycle || !lifecycle.config) return actions;
    const roleCode = this.serverPolicy && this.serverPolicy.roleCode
      ? this.serverPolicy.roleCode
      : this.state.role;
    for (const transition of lifecycle.config.transitions || []) {
      if (transition.from !== document.status || transition.to === 'archived') continue;
      if (Array.isArray(transition.roles)
        && transition.roles.length > 0
        && !transition.roles.includes(roleCode)) continue;
      if (actions.some(action => action.code === transition.to)) continue;
      const meta = this.statusMetaForDocument(document, transition.to);
      const reason = this.transitionUnavailableReason(document, type, transition);
      actions.push({
        code: transition.to,
        label: meta.label,
        c: meta.c,
        bg: meta.bg,
        active: false,
        disabled: !!reason,
        reason,
      });
    }
    return actions;
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
      if (field.dataType === 'file') {
        if (value instanceof File) {
          fields[key] = { pendingUpload: true, name: value.name };
        }
        return;
      }
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
      counterpartyId: wz.counterpartyId || null,
      counterpartyName: wz.counterparty || null,
      dealStageId: wz.dealStageId || undefined,
      comment: wz.comment || undefined,
      responsibleId: wz.responsibleId ? Number(wz.responsibleId) : undefined,
      responsibleName: wz.responsibleName || undefined,
      links: this.wizardDocumentLinks(wz),
      taskLinks: wz.taskLinks || [],
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
      try {
        const dynamicFiles = (type.fields || [])
          .map(field => ({ field, file: (wz.fieldVals || {})[field.key] }))
          .filter(item => item.field.dataType === 'file' && item.file instanceof File);
        for (const item of dynamicFiles) {
          await this.uploadFileToDocument(payload.id, item.file, null, item.field.key);
        }
        if (wz.file) {
          const attachment = await this.uploadFileToDocument(payload.id, wz.file);
          payload = { ...payload, attachments: [...(payload.attachments || []), attachment] };
        } else if (wz.externalLink) {
          const attachment = await this.createExternalLink(payload.id, wz.externalLink);
          payload = { ...payload, attachments: [...(payload.attachments || []), attachment] };
        }
        payload = await this.api(`/api/v1/registry/documents/${payload.id}/finalize`, {
          method: 'POST',
        });
      } catch (contentError) {
        await this.api(`/api/v1/registry/documents/${payload.id}/abandon`, { method: 'POST' })
          .catch(cleanupError => console.error('Failed to abandon incomplete registry document', cleanupError));
        throw contentError;
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
        'counterparty_company_selection_required',
        'document_content_required',
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

  TRAINING = [
    ['Работа с документами', 'Создание, редактирование, статусы, вложения и новые редакции документов.', 'Статья', '📄'],
    ['Поиск и представления', 'Фильтры, колонки, личные и общие представления, экспорт текущего набора.', 'Статья', '📄'],
    ['Массовая загрузка и drag-and-drop', 'Загрузка нескольких файлов, выбор раздела и типа, удаление строки, исправление ошибок и повтор.', 'Статья', '📄'],
    ['Файлы, версии и архив', 'Замена файлов, история версий, хранение копий по сделкам, архивирование и восстановление.', 'Статья', '📄'],
    ['Документы в сделке и компании', 'Работа с реестром во вкладках карточек сделки и компании Bitrix24.', 'Видео', '▶'],
    ['Настройка реестра', 'Разделы, типы документов, жизненные циклы, роли и назначение пользователей.', 'Видео', '▶'],
  ];

  FUTURE_TRAINING = [
    {
      audience: 'Пользовательская инструкция',
      title: 'Работа с документами',
      description: 'Добавление документа из полного реестра, сделки и компании Bitrix24: одиночная и массовая загрузка.',
      status: 'Будет выпущена после стабилизации интерфейса',
      icon: 'П',
    },
    {
      audience: 'Административная инструкция',
      title: 'Настройка реестра',
      description: 'Разделы, типы и поля документов, обязательность, колонки, статусы, роли и права доступа.',
      status: 'Будет выпущена после стабилизации интерфейса',
      icon: 'А',
    },
  ];

  statusDefinitionsForDocuments(docs) {
    const source = Array.isArray(docs) ? docs : [];
    const lifecycles = [];
    const lifecycleCodes = new Set();
    source.forEach(document => {
      const lifecycle = this.lifecycleForDocument(document);
      if (lifecycle && !lifecycleCodes.has(lifecycle.code)) {
        lifecycleCodes.add(lifecycle.code);
        lifecycles.push(lifecycle);
      }
    });
    if (!lifecycles.length) {
      Object.values(this.LIFECYCLE_BY_CODE || {}).forEach(lifecycle => {
        if (lifecycle && !lifecycleCodes.has(lifecycle.code)) {
          lifecycleCodes.add(lifecycle.code);
          lifecycles.push(lifecycle);
        }
      });
    }
    const definitions = [];
    const keys = new Set();
    const append = state => {
      if (!state || state.code === 'archived') return;
      const key = `${state.code}\u0000${state.label}`;
      if (keys.has(key)) return;
      keys.add(key);
      definitions.push({
        key,
        code: state.code,
        label: state.label,
        c: state.color || '#71717a',
        bg: this.statusBackground(state.code, state.color),
      });
    };
    lifecycles.forEach(lifecycle => (lifecycle.config.states || []).forEach(append));
    source.forEach(document => {
      const meta = this.statusMetaForDocument(document);
      append({ code: document.status, label: meta.label, color: meta.c });
    });
    return definitions;
  }

  documentStatusDefinitionKey(document) {
    const meta = this.statusMetaForDocument(document);
    return `${document.status}\u0000${meta.label}`;
  }

  buildMatrix(docs, keyPrefix) {
    const cols = this.statusDefinitionsForDocuments(docs);
    const stages = cols.map(column => ({
      label: column.label,
      style: 'min-width:0;text-align:center;font-size:9.5px;letter-spacing:.2px;text-transform:uppercase;color:#a1a1aa;font-weight:600;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
    }));
    const rows = this.SECTIONS.filter(s => this.visibleSections().includes(s.code)).map(s => {
      const sd = (docs || []).filter(d => d.section === s.code);
      const cells = cols.map(column => {
        const n = sd.filter(d => this.documentStatusDefinitionKey(d) === column.key).length;
        return {
          label: column.label,
          count: n ? String(n) : '—',
          title: `${column.label}: ${n}`,
          style: `min-width:0;display:flex;align-items:center;justify-content:space-between;gap:7px;height:36px;padding:0 9px;border-radius:8px;font-size:11px;color:${n ? column.c : '#a1a1aa'};background:${n ? column.bg : '#fafafa'};`,
          countStyle: `flex:none;font-family:'IBM Plex Mono';font-size:12px;font-weight:${n ? '700' : '400'};`,
        };
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

  canCreateInSection(sectionCode) {
    return (this.TYPES[sectionCode] || []).some(label => {
      const type = this.typeMeta(sectionCode, label);
      return type && this.canCreateType(type)
        && (!type.isFinancial || !this.roleHidesMoney(type.code));
    });
  }

  registryMoneyAvailable() {
    return this.SECTIONS
      .filter(section => this.visibleSections().includes(section.code))
      .some(section => (this.TYPES[section.code] || []).some(label => {
        const type = this.typeMeta(section.code, label);
        return type && !this.roleHidesMoney(type.code);
      }));
  }

  scopedDocs() {
    this.ensureDocs();
    const vis = this.visibleSections();
    return this.docs.filter(d => vis.includes(d.section));
  }

  selectedRegistryType() {
    const typeCode = this.state.filters.type;
    if (!typeCode || typeCode === 'all') return null;
    for (const types of Object.values(this.TYPE_META || {})) {
      const found = Object.values(types || {}).find(type => type.code === typeCode);
      if (found) return found;
    }
    return null;
  }

  availableDynamicFields() {
    const type = this.selectedRegistryType();
    return type && Array.isArray(type.fields) ? type.fields : [];
  }

  activeDynamicColumns() {
    return this.availableDynamicFields().filter(field => this.state.cols[`field:${field.key}`]);
  }

  gridColsStr(columns = this.state.cols) {
    const c = columns;
    let s = '44px minmax(200px,1.6fr)';
    if (c.section) s += ' 130px';
    if (c.counterparty) s += ' 140px';
    if (c.status) s += ' 140px';
    if (c.amount) s += ' 100px';
    if (c.docDate) s += ' 90px';
    if (c.responsible) s += ' 120px';
    this.activeDynamicColumns().forEach(() => { s += ' 150px'; });
    s += ' 36px';
    return s;
  }

  registryControls(scoped) {
    const S = this.state, F = S.filters;
    const moneyAvailable = this.registryMoneyAvailable();
    const C = { ...S.cols, amount: S.cols.amount && moneyAvailable };
    const setF = (patch, delay = 0) => this.updateRegistryFilters(patch, delay);
    const statusDefinitions = [];
    const statusCodes = new Set();
    Object.values(this.LIFECYCLE_BY_CODE || {}).forEach(lifecycle => {
      (lifecycle.config.states || []).forEach(state => {
        if (this.state.screen !== 'archive' && state.code === 'archived') return;
        if (statusCodes.has(state.code)) return;
        statusCodes.add(state.code);
        statusDefinitions.push({
          code: state.code,
          label: state.label,
          c: state.color || '#71717a',
          bg: this.statusBackground(state.code, state.color),
        });
      });
    });
    const filterStatusChips = statusDefinitions.map(m => {
      const on = !!F.statuses[m.code];
      return { label: m.label, onToggle: () => { const st = { ...F.statuses }; if (st[m.code]) delete st[m.code]; else st[m.code] = true; setF({ statuses: st }); },
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
    const dynamicFields = this.availableDynamicFields();
    const dynamicFilterRows = dynamicFields
      .filter(field => field.dataType !== 'file')
      .map(field => {
        const isSelect = field.dataType === 'select' || field.dataType === 'boolean';
        const options = field.dataType === 'boolean'
          ? [{ value: 'true', label: 'Да' }, { value: 'false', label: 'Нет' }]
          : (field.options || []).map(value => ({ value: String(value), label: String(value) }));
        const current = (F.dynamic || {})[field.key];
        return {
          label: field.label,
          isSelect,
          isInput: !isSelect,
          inputType: field.dataType === 'date' ? 'date' : 'text',
          value: current === true ? 'true' : current === false ? 'false' : (current || ''),
          options,
          onInput: event => {
            const raw = event.target.value;
            const value = field.dataType === 'boolean'
              ? (raw === '' ? '' : raw === 'true')
              : raw;
            setF({ dynamic: { ...(F.dynamic || {}), [field.key]: value } }, 250);
          },
        };
      });
    const activeCount = Object.keys(F.sections).filter(k => F.sections[k]).length + Object.keys(F.statuses).filter(k => F.statuses[k]).length + (F.type !== 'all' ? 1 : 0) + (F.responsible !== 'all' ? 1 : 0) + (F.cp.trim() ? 1 : 0) + (F.from.trim() || F.to.trim() ? 1 : 0) + Object.values(F.dynamic || {}).filter(value => value !== '').length;
    const colDefs = [
      ['section', 'Раздел'], ['counterparty', 'Контрагент'], ['status', 'Статус'],
      ['amount', 'Сумма'], ['docDate', 'Дата'], ['responsible', 'Ответственный'],
      ...dynamicFields.map(field => [`field:${field.key}`, field.label]),
    ].filter(([key]) => key !== 'amount' || moneyAvailable);
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
      dynamicFilterRows,
      dynamicFiltersVisible: dynamicFilterRows.length > 0,
      filterType: F.type, filterResp: F.responsible, filterCp: F.cp, filterFrom: F.from, filterTo: F.to,
      setFilterType: (e) => setF({ type: e.target.value, dynamic: {} }), setFilterResp: (e) => setF({ responsible: e.target.value }),
      setFilterCp: (e) => setF({ cp: e.target.value }, 250), setFilterFrom: (e) => setF({ from: e.target.value }, 250), setFilterTo: (e) => setF({ to: e.target.value }, 250),
      resetFilters: () => setF({ sections: {}, statuses: {}, type: 'all', responsible: 'all', cp: '', from: '', to: '', dynamic: {} }),
      columnToggles,
      dynamicColumnHeaders: this.activeDynamicColumns().map(field => ({ label: field.label })),
      colSection: C.section, colCounterparty: C.counterparty, colStatus: C.status, colAmount: C.amount, colDocDate: C.docDate, colResponsible: C.responsible,
      headerGridStyle: `position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: ${this.gridColsStr(C)}; background: #fff; box-shadow: inset 0 -1px 0 #ededed; color: #a1a1aa; font-size: 10.5px;`,
    };
  }

  filteredRows() {
    return this.scopedDocs();
  }

  enrich(d) {
    const sec = this.SECTIONS.find(s => s.code === d.section) || { label: d.section, c: '#64748b', bg: '#eef1f5' };
    const st = this.statusMetaForDocument(d);
    const sel = !!this.state.sel[d.id];
    const archiveMode = this.state.screen === 'archive';
    const canEdit = !archiveMode && this.canEditDocument(d);
    const canDelete = !archiveMode && this.canArchiveDocument(d);
    const canRestore = archiveMode
      && (!!d.deletedAt || d.status === 'archived')
      && this.canRestoreDocument(d);
    const selectable = !archiveMode || !!d.deletedAt || d.status === 'archived';
    const menuOpen = this.state.rowMenuId === d.id;
    const relations = d.relations || { parent: null, children: [] };
    const relatedItems = [
      ...(relations.parent ? [{ ...relations.parent, directionLabel: 'Основной документ' }] : []),
      ...relations.children.map(item => ({
        ...item,
        directionLabel: this.relationTypeLabel(item.relationType),
      })),
    ].map(item => ({
      ...item,
      onOpen: event => {
        if (event && event.stopPropagation) event.stopPropagation();
        void this.openDocument(item.id);
      },
    }));
    const relationsExpanded = !!this.state.expandedDocumentRelations[d.id];
    return {
      id: d.id, num: d.num, title: d.title, counterparty: d.counterparty || '—',
      dealRefLabel: d.dealRefs && d.dealRefs.length
        ? d.dealRefs.map(id => '#' + id).join(', ')
        : '—',
      responsible: d.responsible, docDate: d.docDate,
      sectionLabel: sec.label, sectionC: sec.c, sectionBg: sec.bg,
      statusLabel: st.label, statusC: st.c, statusBg: st.bg,
      amountStr: this.fmtAmount(d),
      moneyVisible: !d.moneyHidden,
      dynamicCells: this.activeDynamicColumns().map(field => {
        const value = (d.dynamicFields || []).find(item => item.key === field.key);
        return { value: value ? value.value : '—' };
      }),
      attachIcon: d.atts.length ? (d.atts.some(item => item.icon === '📎') ? '📎' : '🔗') : '○',
      canEdit, canDelete, canRestore, hasActions: canEdit || canDelete || canRestore, menuOpen,
      hasRelations: relatedItems.length > 0,
      relationsExpanded,
      relationsExpandedAria: relationsExpanded ? 'true' : 'false',
      relatedItems,
      relationCount: relatedItems.length,
      relationToggleMark: relationsExpanded ? 'Свернуть ↑' : 'Показать ↓',
      onToggleRelations: event => {
        if (event && event.preventDefault) event.preventDefault();
        if (event && event.stopPropagation) event.stopPropagation();
        this.setState({
          expandedDocumentRelations: {
            ...this.state.expandedDocumentRelations,
            [d.id]: !relationsExpanded,
          },
        });
      },
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
      rowGridStyle: `position:relative;display:grid;grid-template-columns:${this.gridColsStr({ ...this.state.cols, amount: this.state.cols.amount && this.registryMoneyAvailable() })};border-bottom:1px solid #f4f4f5;cursor:pointer;background:${sel ? '#f5f5ff' : '#fff'};`,
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
    const relationEditorCandidates = (S.relationEditorCandidates || []).map(candidate => {
      const selected = candidate.id === S.relationEditorSelectedId;
      const section = this.SECTIONS.find(item => item.code === candidate.section);
      return {
        ...candidate,
        sectionColor: section ? section.c : '#a1a1aa',
        selectedAria: selected ? 'true' : 'false',
        selectedMark: selected ? 'Выбран ✓' : '',
        onPick: () => this.selectRelationCandidate(candidate),
        style: `width:100%;display:flex;align-items:center;gap:9px;margin-bottom:5px;padding:9px 11px;border:1px solid ${selected ? '#8b5cf6' : '#e4e4e7'};border-radius:8px;background:${selected ? '#f5f3ff' : '#fff'};color:#3f3f46;text-align:left;cursor:pointer;`,
      };
    });
    const relationEditorCanSave = !!S.relationEditorSelectedId
      && !S.relationEditorSaving;
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
    const selectedDocuments = this.docs.filter(document => S.sel[document.id]);
    const canExportRegistry = permissions.export === true
      || Object.values(permissions.byType || {}).some(item => item.export === true);
    const canCreateAnyDocument = this.SECTIONS.some(section =>
      this.canCreateInSection(section.code));

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
    const dealStatusCards = this.statusDefinitionsForDocuments(dealDocs)
      .map(status => ({
        ...status,
        count: dealDocs.filter(document => this.documentStatusDefinitionKey(document) === status.key).length,
      }))
      .filter(status => status.count > 0)
      .map(status => ({
        label: status.label,
        count: status.count,
        style: `min-width:150px;flex:1 1 170px;border:1px solid #ededed;border-radius:10px;padding:12px 14px;background:${status.bg};`,
        countStyle: `font-family:'Space Grotesk';font-weight:700;font-size:23px;margin-top:2px;color:${status.c};`,
      }));
    const embeddedGroups = this.SECTIONS.filter(s => this.visibleSections().includes(s.code)).map(s => {
      const ds = dealDocs.filter(d => d.section === s.code);
      const gkey = 'deal_' + s.code;
      const dropKey = 'deal_drop_' + s.code;
      const open = !S.collapsedGroups[gkey];
      const dropActive = S.dragTargetKey === dropKey;
      return {
        code: s.code, label: s.label, c: s.c, count: ds.length + ' док.', docs: ds.map(d => this.enrich(d)),
        canAdd: this.canCreateInSection(s.code),
        onAdd: event => {
          if (event && event.stopPropagation) event.stopPropagation();
          this.openWizard(s.code);
        },
        dropKey,
        dropHint: dropActive ? 'Отпустите файлы для загрузки' : '',
        open, caret: open ? '▾' : '▸', onToggle: () => this.toggleGroup(gkey),
        onDragEnter: event => this.handleFileDragOver(event, dropKey),
        onDragOver: event => this.handleFileDragOver(event, dropKey),
        onDragLeave: event => this.handleFileDragLeave(event, dropKey),
        onDrop: event => this.handleSectionFileDrop(event, s.code, [], dropKey),
        style: `border:1px solid ${dropActive ? s.c : '#ededed'};border-radius:10px;overflow:hidden;background:${dropActive ? s.bg : '#fff'};transition:border-color .18s,background .18s;`,
      };
    });

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
    const companyDropSections = companyContextLink && canCreateAnyDocument
      ? this.SECTIONS
          .filter(section => this.visibleSections().includes(section.code))
          .filter(section => (this.TYPES[section.code] || []).some(label => {
            const type = this.typeMeta(section.code, label);
            return type && this.canCreateType(type)
              && (!type.isFinancial || !this.roleHidesMoney(type.code));
          }))
          .map(section => {
            const dropKey = `company_global_drop_${section.code}`;
            const dropActive = S.dragTargetKey === dropKey;
            return {
              code: section.code,
              label: section.label,
              c: section.c,
              companyId: companyContextLink.entityId,
              companyTitle: companyContextLink.entityTitle,
              dropKey,
              dropHint: dropActive ? 'Отпустите файлы' : 'Перетащите файлы',
              onDragEnter: event => this.handleFileDragOver(event, dropKey),
              onDragOver: event => this.handleFileDragOver(event, dropKey),
              onDragLeave: event => this.handleFileDragLeave(event, dropKey),
              onDrop: event => this.handleSectionFileDrop(
                event,
                section.code,
                [companyContextLink],
                dropKey,
              ),
              style: `min-width:0;flex:1 1 calc(33.333% - 6px);display:flex;align-items:center;gap:7px;padding:8px 10px;border:1px ${dropActive ? 'solid' : 'dashed'} ${dropActive ? section.c : '#d4d4d8'};border-radius:8px;background:${dropActive ? section.bg : '#fafafa'};color:${dropActive ? section.c : '#52525b'};transition:border-color .12s,background .12s;`,
            };
          })
      : [];
    const companyDeals = contextDeals.map(dl => {
      const ddocs = scoped.filter(d => (d.dealRefs || []).includes(String(dl.id)));
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
          canAdd: this.canCreateInSection(s.code),
          onAdd: event => {
            if (event && event.stopPropagation) event.stopPropagation();
            this.openWizard(s.code, [
              { entityType: 'deal', entityId: dl.id, entityTitle: dl.title },
              ...(companyContextLink ? [companyContextLink] : []),
            ]);
          },
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
      }).filter(g => !isLocalCompanyDemo || g.code === 'supplier');
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
    const contextDocumentsLoading = placementContextReady && S.contextDocumentsLoading;
    const contextDocumentsFailed = placementContextReady && !!S.contextDocumentsError;
    const contextDocumentsAvailable = placementContextReady
      && !S.contextDocumentsLoading
      && !S.contextDocumentsError;
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
    const coTypeOrder = [];
    const coByType = new Map();
    coDocs.forEach(document => {
      const key = document.typeCode || `legacy:${document.type}`;
      if (!coByType.has(key)) {
        coByType.set(key, []);
        coTypeOrder.push(key);
      }
      coByType.get(key).push(document);
    });
    const companyMoneyVisible = coDocs.some(document => !document.moneyHidden);
    const companyDocsByType = coTypeOrder.map(typeCode => {
      const documents = coByType.get(typeCode);
      const meta = this.typeMetaByCode(typeCode);
      const sectionCodes = [...new Set(
        meta && Array.isArray(meta.sectionCodes) && meta.sectionCodes.length
          ? meta.sectionCodes
          : documents.map(document => document.section),
      )].filter(code => this.visibleSections().includes(code));
      const sectionTags = sectionCodes.map(code => {
        const section = this.SECTIONS.find(item => item.code === code);
        return {
          label: section ? section.label : code,
          c: section ? section.c : '#64748b',
          bg: section ? section.bg : '#f4f4f5',
        };
      });
      return {
        typeCode,
        type: meta ? meta.name : documents[0].type,
        c: sectionTags.length === 1 ? sectionTags[0].c : '#64748b',
        count: documents.length + ' док.',
        sections: sectionTags,
        docs: documents.map(document => ({
          ...this.enrich(document),
          showMoneyValue: companyMoneyVisible && !document.moneyHidden,
          showMoneyBlank: companyMoneyVisible && document.moneyHidden,
        })),
      };
    });
    const companyDocumentsGridStyle = companyMoneyVisible
      ? '44px minmax(200px,1.6fr) 130px 110px 140px 110px 90px'
      : '44px minmax(200px,1.6fr) 130px 110px 140px 90px';
    const companyHasDeals = companyDeals.length > 0;
    const companyHasDocuments = companyDocsByType.length > 0;
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
    const dealContextLabel = `показаны документы текущей сделки #${dealId}${dealCompanyName ? '; при создании компания «' + dealCompanyName + '» подставится автоматически' : ''}`;
    const financialSummary = S.dealFinancialSummary;
    const financialNumber = (value, digits = 2) => Number(value || 0).toLocaleString('ru-RU', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    const dealCalcRows = financialSummary && Array.isArray(financialSummary.details)
      ? financialSummary.details.map(item => ({
          title: item.title,
          number: item.number || '—',
          original: item.emptyAmount
            ? '0'
            : `${financialNumber(item.originalAmount)} ${item.originalCurrency}`,
          rate: item.emptyAmount
            ? '—'
            : `1 ${item.originalCurrency} = ${financialNumber(item.conversionRate, 4)} ${financialSummary.targetCurrency}`,
          rateDate: item.rateDate ? this.formatDocumentDate(item.rateDate) : '—',
          result: `${financialNumber(item.convertedAmount)} ${financialSummary.targetCurrency}`,
          zeroLabel: item.emptyAmount ? 'Нет суммы → 0' : '',
        }))
      : [];
    const dealFinancialDenied = S.dealFinancialErrorCode === 'deal_financial_summary_access_denied';
    const dealFinancialFailed = !!S.dealFinancialError && !dealFinancialDenied;
    const dealImportedDocs = dealDocs
      .filter(item => item.externalSource === 'bitrix_smart_invoice' || item.externalSource === 'bitrix_quote')
      .map(item => {
        const sourceLabel = item.externalSource === 'bitrix_smart_invoice'
          ? 'Счёт Bitrix24'
          : 'Коммерческое предложение Bitrix24';
        return {
          id: item.id,
          title: item.title,
          sourceLabel,
          externalIdLabel: `ID ${item.externalEntityId || '—'}`,
          number: item.num,
          amount: this.fmtAmount(item),
          status: item.externalStatus || 'Статус не указан',
          updated: item.externalUpdatedAt
            ? this.formatHistoryDate(item.externalUpdatedAt)
            : 'Дата изменения не указана',
          onOpen: () => { void this.openDocument(item.id); },
        };
      });
    const invoiceType = this.typeMeta('client', 'Счёт');
    const quoteType = this.typeMeta('client', 'Коммерческое предложение');
    const dealSyncAllowed = !!invoiceType && !!quoteType
      && this.canCreateType(invoiceType)
      && this.canCreateType(quoteType)
      && !this.roleHidesMoney(invoiceType.code)
      && !this.roleHidesMoney(quoteType.code);
    const dealSyncButtonStyle = `border:1px solid ${dealSyncAllowed && !S.dealSyncBusy ? '#93c5fd' : '#d4d4d8'};border-radius:8px;padding:7px 11px;background:${dealSyncAllowed && !S.dealSyncBusy ? '#fff' : '#f4f4f5'};color:${dealSyncAllowed && !S.dealSyncBusy ? '#1d4ed8' : '#a1a1aa'};font-size:11.5px;font-weight:650;cursor:${dealSyncAllowed && !S.dealSyncBusy ? 'pointer' : 'default'};white-space:nowrap;`;
    const cvSeg = (on) => `border:none;border-radius:6px;padding:5px 13px;font-size:12px;font-weight:600;cursor:pointer;background:${on ? '#fff' : 'transparent'};color:${on ? '#18181b' : '#71717a'};box-shadow:${on ? '0 1px 2px rgba(0,0,0,.08)' : 'none'};`;
    const matrixLegend = this.MATRIX_LEGEND.map(([code, label]) => {
      const m = this.MATRIX_STATUS[code];
      return { label, icon: m.icon, chip: `display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;font-size:11px;color:${m.c};background:${m.bg === 'transparent' ? '#f4f4f5' : m.bg};` };
    });

    let doc = null;
    if (S.drawerId) {
      const dd = this.docs.find(x => x.id === S.drawerId)
        || (this.drawerDocument && this.drawerDocument.id === S.drawerId
          ? this.drawerDocument
          : null);
      if (dd) {
        const sec = this.SECTIONS.find(s => s.code === dd.section);
        const type = this.typeMeta(dd.section, dd.type);
        const edit = S.drawerEdit || this.createDocumentEditState(dd);
        const editFields = (type && type.fields ? type.fields : [])
          .filter(field => field.dataType !== 'file')
          .map(field => {
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
        const canEdit = !documentReadOnly && this.canEditDocument(dd);
        const canModifyContent = !documentReadOnly && this.canModifyDocumentContent(dd);
        const canTransition = !documentReadOnly && this.canTransitionDocument(dd);
        const documentRelations = dd.relations || { parent: null, children: [] };
        const relationItem = (relation, directionLabel, childDocumentId) => ({
          ...relation,
          directionLabel,
          typeShown: relation.typeLabel || this.relationTypeLabel(relation.relationType),
          onOpen: () => { void this.openDocument(relation.id); },
          canRemove: canEdit,
          onRemove: () => { void this.removeDocumentRelation(childDocumentId, relation.title); },
        });
        const parentRelation = documentRelations.parent
          ? relationItem(documentRelations.parent, 'Основной документ', dd.id)
          : null;
        const childRelations = documentRelations.children.map(relation =>
          relationItem(
            relation,
            this.relationTypeLabel(relation.relationType),
            relation.id,
          ));
        const storageCopies = dd.atts
          .filter(attachment => attachment.kind === 'file' && attachment.isCurrent)
          .flatMap(attachment => (attachment.storageCopies || []).map(copy => ({
            ...copy,
            attachmentId: attachment.id,
            attachmentName: attachment.name,
            attachmentVersion: attachment.version,
            canOpen: !!copy.url,
            onOpen: () => {
              const url = this.normalizeExternalLink(copy.url);
              if (url) window.open(url, '_blank', 'noopener,noreferrer');
            },
          })));
        const linkedDeals = dd.links.filter(link => link.entityType === 'deal');
        const linkedDealsHaveOpen = linkedDeals.some(link => link.dealClosed === false);
        const linkedDealsAllClosed = linkedDeals.length > 0
          && linkedDeals.every(link => link.dealClosed === true);
        const dealAccessSummary = linkedDeals.length === 0
          ? 'Сделка не привязана'
          : (linkedDealsHaveOpen
              ? 'Есть открытая сделка'
              : (linkedDealsAllClosed
                  ? 'Все связанные сделки закрыты'
                  : 'Состояние не всех сделок удалось определить'));
        const dealAccessRows = linkedDeals.map(link => ({
          id: String(link.entityId),
          title: link.title || `Сделка #${link.entityId}`,
          stateLabel: link.dealClosed === true
            ? 'Закрыта'
            : (link.dealClosed === false ? 'Открыта' : 'Статус не определён'),
          stateStyle: link.dealClosed === true
            ? 'color:#71717a;background:#f4f4f5;'
            : (link.dealClosed === false
                ? 'color:#15803d;background:#e7f5ec;'
                : 'color:#b45309;background:#fff7ed;'),
          onOpen: () => { void this.openDeal(link.entityId); },
        }));
        const accessRoleRows = this.documentAccessRoleRows(dd, linkedDeals);
        const statusOptions = this.availableStatusActions(dd, canTransition).map(action => ({
          ...action,
          title: action.reason || `Перевести в статус «${action.label}»`,
          onSet: () => {
            if (!action.active && !action.disabled) void this.transitionDocument(dd.id, action.code);
          },
          style: `max-width:100%;border:1px solid ${action.active ? action.c : '#e4e4e7'};background:${action.active ? action.bg : '#fff'};color:${action.active ? action.c : (action.disabled ? '#a1a1aa' : '#71717a')};border-radius:7px;padding:4px 10px;font-size:11px;font-weight:500;cursor:${action.active ? 'default' : (action.disabled ? 'not-allowed' : 'pointer')};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:${action.disabled && !action.active ? '.72' : '1'};`,
        }));
        const currentFileAttachments = dd.atts
          .filter(attachment => attachment.kind === 'file' && attachment.isCurrent);
        const expectedStorageCopyCount = currentFileAttachments.length * linkedDeals.length;
        const actualStoragePairs = new Set(storageCopies.map(copy => `${copy.attachmentId}:${copy.dealId}`));
        const missingStorageCopyCount = Math.max(0, expectedStorageCopyCount - actualStoragePairs.size);
        const fileFields = (type && type.fields || []).filter(field => field.dataType === 'file');
        const fileFieldActions = fileFields
          .filter(field => !currentFileAttachments.some(attachment => attachment.fieldKey === field.key))
          .map(field => ({
            key: field.key,
            label: `＋ ${field.label}${field.isRequired ? ' *' : ''}`,
            title: `Добавить файл в поле «${field.label}»`,
            onAdd: () => { void this.addFileToDocument(dd.id, field.key); },
          }));
        const archiveRecipients = this.archiveRecipientLabel(dd);
        const taskResultRows = (S.drawerTaskResults || [])
          .filter(task => !(dd.taskLinks || []).some(link => Number(link.taskId) === Number(task.id)))
          .map(task => ({
            id: task.id,
            title: task.title,
            onPick: () => { void this.addDocumentTaskLink(dd.id, task); },
          }));
        doc = {
          id: dd.id,
          num: dd.num, title: dd.title, typeLabel: dd.type, number: dd.num,
          sectionLabel: sec.label, sectionC: sec.c, sectionBg: sec.bg,
          docDate: dd.docDate, amountStr: this.fmtAmount(dd),
          legalEntity: dd.legalEntity, counterparty: dd.counterparty || '—', responsible: dd.responsible,
          comment: dd.comment || '—',
          moneyVisible: !dd.moneyHidden,
          counterpartyCellStyle: `background:#fff;padding:9px 12px;${dd.moneyHidden ? 'grid-column:span 2;' : ''}`,
          counterpartyLinked: !!dd.counterpartyId,
          counterpartyMissing: !dd.counterpartyId,
          onOpenCompany: () => { if (dd.counterpartyId) void this.openCompany(dd.counterpartyId); },
          internalLink: this.internalDocumentLink(dd.id),
          onCopyInternalLink: () => { void this.copyInternalDocumentLink(dd.id); },
          internalLinkLabel: S.internalLinkCopiedId === dd.id
            ? 'Ссылка скопирована'
            : (S.internalLinkCopyFailedId === dd.id ? 'Не удалось скопировать' : 'Скопировать ссылку'),
          canEdit,
          onEdit: () => this.beginDocumentEdit(dd),
          canSupersede: canEdit && canModifyContent
            && this.canArchiveDocument(dd)
            && this.canCreateType({ code: dd.typeCode }),
          onSupersede: () => this.openSupersedingWizard(dd),
          canArchive: !documentReadOnly && this.canArchiveDocument(dd),
          onArchive: () => { void this.deleteDocument(dd.id); },
          archiveRecipientLabel: archiveRecipients,
          archiveHasRecipients: !!archiveRecipients,
          canRestore: archiveMode && (!!dd.deletedAt || dd.status === 'archived') && this.canRestoreDocument(dd),
          onRestore: () => { void this.restoreDocument(dd.id); },
          edit,
          editFields,
          editHasFields: editFields.length > 0,
          responsibleOptions,
          canModifyContent,
          attCount: dd.atts.filter(attachment => attachment.isCurrent).length,
          linkCount: dd.links.length + (dd.taskLinks || []).length,
          attachments: dd.atts.filter(attachment => attachment.isCurrent).map(attachment => ({
            ...attachment,
            meta: attachment.meta,
            hasFieldLabel: !!attachment.fieldLabel,
            canReplace: canModifyContent && attachment.kind === 'file' && attachment.isCurrent,
            canDelete: canModifyContent,
            onOpen: () => { void this.openAttachment(dd.id, attachment.id); },
            onReplace: () => { void this.replaceDocumentAttachment(dd.id, attachment.id); },
            onDelete: () => { void this.deleteAttachment(dd.id, attachment.id); },
          })),
          links: [
            ...dd.links.map(link => ({
              ...link,
              canRemove: canEdit,
              onOpen: () => {
                if (link.entityType === 'deal') void this.openDeal(link.entityId);
                else if (link.entityType === 'company') void this.openCompany(link.entityId);
              },
              onRemove: () => { void this.removeDocumentCrmLink(dd.id, link); },
            })),
            ...(dd.taskLinks || []).map(link => ({
              type: 'Задача',
              title: link.taskTitle,
              canRemove: canEdit,
              onOpen: () => { void this.openTask(link.taskId); },
              onRemove: () => { void this.removeDocumentTaskLink(dd.id, link); },
            })),
          ],
          onManageLinks: () => { void this.manageDocumentLinks(dd.id, dd.links); },
          hasParentRelation: !!parentRelation,
          parentRelationActionLabel: parentRelation ? 'Сменить основной документ' : '＋ Указать основной документ',
          parentRelation,
          childRelations,
          hasChildRelations: childRelations.length > 0,
          relationCount: childRelations.length + (parentRelation ? 1 : 0),
          relationsOpen: S.drawerRelationsOpen,
          relationsExpanded: S.drawerRelationsOpen ? 'true' : 'false',
          relationsOpenMark: S.drawerRelationsOpen ? 'Свернуть ↑' : 'Открыть ↓',
          onToggleRelations: () => this.setState({ drawerRelationsOpen: !S.drawerRelationsOpen }),
          canManageRelations: canEdit,
          onAddParentRelation: () => this.openRelationEditor('parent'),
          onAddChildRelation: () => this.openRelationEditor('child'),
          fields: dd.dynamicFields,
          hasAdditional: dd.dynamicFields.length > 0 || !!String(dd.comment || '').trim(),
          additionalCount: dd.dynamicFields.length + (String(dd.comment || '').trim() ? 1 : 0),
          additionalOpen: S.drawerAdditionalOpen,
          additionalExpanded: S.drawerAdditionalOpen ? 'true' : 'false',
          additionalOpenMark: S.drawerAdditionalOpen ? 'Свернуть ↑' : 'Открыть ↓',
          onToggleAdditional: () => this.setState({ drawerAdditionalOpen: !S.drawerAdditionalOpen }),
          hasStorageCopies: storageCopies.length > 0 || missingStorageCopyCount > 0,
          storageCopies,
          storageCopyCount: storageCopies.length,
          storageHasMissingCopies: missingStorageCopyCount > 0,
          storageMissingCopyLabel: missingStorageCopyCount === 1
            ? 'Не создана 1 ожидаемая физическая копия. Повторите синхронизацию или проверьте Bitrix24 Диск.'
            : `Не создано ${missingStorageCopyCount} ожидаемых физических копий. Повторите синхронизацию или проверьте Bitrix24 Диск.`,
          storageOpen: S.drawerStorageOpen,
          storageExpanded: S.drawerStorageOpen ? 'true' : 'false',
          storageOpenMark: S.drawerStorageOpen ? 'Свернуть ↑' : 'Показать пути ↓',
          onToggleStorage: () => this.setState({ drawerStorageOpen: !S.drawerStorageOpen }),
          linksOpen: S.drawerLinksOpen,
          linksExpanded: S.drawerLinksOpen ? 'true' : 'false',
          linksOpenMark: S.drawerLinksOpen ? 'Свернуть ↑' : 'Открыть ↓',
          onToggleLinks: () => this.setState({ drawerLinksOpen: !S.drawerLinksOpen }),
          canManageLinks: canEdit,
          taskSearch: S.drawerTaskSearch,
          taskSearchLoadingLabel: S.drawerTaskSearchLoading ? 'Поиск…' : 'Найти существующую задачу',
          taskResults: taskResultRows,
          taskHasResults: taskResultRows.length > 0,
          taskHasError: !!S.drawerTaskError,
          taskError: S.drawerTaskError,
          onTaskSearch: event => { void this.searchDrawerTasks(event.target.value); },
          accessSummary: dealAccessSummary,
          accessDeals: dealAccessRows,
          accessHasDeals: dealAccessRows.length > 0,
          showAccessPanel: dealAccessRows.length > 0,
          accessRoleRows,
          accessPolicyNote: 'Сначала проверяются права пользователя Bitrix24 на связанные CRM-сущности, затем политика реестра для роли и типа документа.',
          accessOpen: S.drawerAccessOpen,
          accessExpanded: S.drawerAccessOpen ? 'true' : 'false',
          accessOpenMark: S.drawerAccessOpen ? 'Свернуть ↑' : 'Подробнее ↓',
          onToggleAccess: () => this.setState({ drawerAccessOpen: !S.drawerAccessOpen }),
          versions: dd.atts
            .filter(attachment => attachment.kind === 'file')
            .map(attachment => ({
              ...attachment,
              meta: [attachment.meta, attachment.fieldLabel ? `поле «${attachment.fieldLabel}»` : ''].filter(Boolean).join(' · '),
              currentLabel: attachment.isCurrent ? 'Текущая' : 'Предыдущая',
              currentStyle: `padding:2px 7px;border-radius:10px;background:${attachment.isCurrent ? '#e7f5ec' : '#f4f4f5'};color:${attachment.isCurrent ? '#15803d' : '#71717a'};font-size:9.5px;font-weight:600;`,
              onOpen: () => { void this.openAttachment(dd.id, attachment.id); },
            })),
          versionCount: dd.atts.filter(attachment => attachment.kind === 'file').length,
          versionCountLabel: `${dd.atts.filter(attachment => attachment.kind === 'file').length} файловых версий`,
          history: dd.history,
          historyCount: dd.history.length,
          onHistory: () => this.setState({ drawerHistoryOpen: true }),
          statusOptions,
          actionHasError: !!S.drawerActionError,
          actionError: S.drawerActionError,
          fileFieldActions,
          hasFileFieldActions: fileFieldActions.length > 0,
        };
      }
    }

    const wz = S.wz;
    const wzTypeMeta = this.typeMeta(wz.sectionCode, wz.typeLabel);
    const dataTypeLabels = { text: 'Текст', number: 'Число', date: 'Дата', money: 'Сумма', select: 'Список', boolean: 'Да/Нет', file: 'Файл' };
    const wizardTypeFields = (wzTypeMeta && wzTypeMeta.fields ? wzTypeMeta.fields : []).map(field => {
      const isSelect = field.dataType === 'select' || field.dataType === 'boolean';
      const isFile = field.dataType === 'file';
      const options = field.dataType === 'boolean' ? ['Да', 'Нет'] : (field.options || []);
      const rawValue = (wz.fieldVals || {})[field.key];
      return {
        name: field.label,
        requiredMark: field.isRequired ? ' *' : '',
        dtype: dataTypeLabels[field.dataType] || field.dataType,
        isSelect,
        isFile,
        isText: !isSelect && !isFile,
        inputType: field.dataType === 'date' ? 'date' : 'text',
        options,
        value: rawValue || '',
        fileLabel: rawValue instanceof File ? `📎 ${rawValue.name}` : '⬆ Выбрать файл',
        valueShown: rawValue
          ? (field.dataType === 'date'
              ? this.formatDocumentDate(rawValue)
              : (isFile && rawValue instanceof File ? rawValue.name : rawValue))
          : '—',
        onInput: (e) => this.setState({
          wz: { ...wz, fieldVals: { ...(wz.fieldVals || {}), [field.key]: e.target.value } },
          wizardError: '',
        }),
        onPickFile: async () => {
          const file = await this.chooseFile();
          if (!file) return;
          this.setState({
            wz: {
              ...this.state.wz,
              fieldVals: { ...(this.state.wz.fieldVals || {}), [field.key]: file },
            },
            wizardError: '',
          });
        },
      };
    });
    const wizardSections = this.SECTIONS.filter(section =>
      (this.TYPES[section.code] || []).some(label => {
        const type = this.typeMeta(section.code, label);
        return type && this.canCreateType(type)
          && (!type.isFinancial || !this.roleHidesMoney(type.code));
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
        return type && this.canCreateType(type)
          && (!type.isFinancial || !this.roleHidesMoney(type.code));
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
    const wizardTasks = (wz.taskLinks || []).map(task => ({
      taskId: task.taskId,
      label: `Задача #${task.taskId} «${task.taskTitle}»`,
      onRemove: () => this.removeWizardTask(task.taskId),
    }));
    const wizardTaskResults = (S.taskSearchResults || []).map(task => ({
      label: `#${task.id} · ${task.title}`,
      onPick: () => this.selectWizardTask(task),
    }));

    const bulkUploadSectionOptions = this.SECTIONS.filter(section =>
      (this.TYPES[section.code] || []).some(label => {
        const type = this.typeMeta(section.code, label);
        return type && this.canCreateType(type)
          && (!type.isFinancial || !this.roleHidesMoney(type.code));
      }))
      .map(section => ({ code: section.code, label: section.label }));
    const bulkUploadCommonTypeOptions = S.bulkUploadCommonSection
      ? (this.TYPES[S.bulkUploadCommonSection] || [])
          .map(label => this.typeMeta(S.bulkUploadCommonSection, label))
          .filter(type => type && this.canCreateType(type)
            && (!type.isFinancial || !this.roleHidesMoney(type.code)))
          .map(type => ({ label: type.name }))
      : [];
    const bulkUploadCommonType = S.bulkUploadCommonSection && S.bulkUploadCommonType
      ? this.typeMeta(S.bulkUploadCommonSection, S.bulkUploadCommonType)
      : null;
    const bulkUploadCommonStatusOptions = this.bulkUploadStatusOptions(bulkUploadCommonType);
    const bulkDealLabel = links => {
      const deals = (links || []).filter(link => link.entityType === 'deal');
      if (!deals.length) return 'Выбрать сделки Bitrix24';
      if (deals.length === 1) return `Сделка #${deals[0].entityId} · ${deals[0].entityTitle}`;
      return `${deals.length} сделки(ок) выбрано`;
    };
    const bulkUploadCommonTaskResults = (S.bulkUploadCommonTaskResults || []).map(task => ({
      value: String(task.id),
      label: `#${task.id} · ${task.title}`,
      onPick: () => this.selectBulkUploadTask(task),
    }));
    const bulkResponsibleSource = S.registryUsers.length
      ? S.registryUsers
      : (documentOptions.responsibles || []);
    const bulkUploadResponsibleOptions = bulkResponsibleSource.map(item => ({
      value: String(item.id),
      label: item.name || `Пользователь #${item.id}`,
    }));
    if (S.bulkUploadCommonResponsibleId
      && !bulkUploadResponsibleOptions.some(item => item.value === String(S.bulkUploadCommonResponsibleId))) {
      bulkUploadResponsibleOptions.unshift({
        value: String(S.bulkUploadCommonResponsibleId),
        label: S.bulkUploadCommonResponsibleName || `Пользователь #${S.bulkUploadCommonResponsibleId}`,
      });
    }
    const bulkUploadCommonResponsibleOptions = [
      { value: '', label: 'Не выбран' },
      ...bulkUploadResponsibleOptions,
    ].map(option => ({
      ...option,
      onPick: () => this.setState({
        bulkUploadCommonResponsibleId: option.value,
        bulkUploadCommonResponsibleName: option.value ? option.label : '',
        responsibleMenuOpen: null,
        bulkUploadError: '',
      }),
    }));
    const bulkUploadRows = (S.bulkUploadRows || []).map(row => {
      const validation = this.bulkUploadValidation(row);
      const type = this.typeMeta(row.sectionCode, row.typeLabel);
      const numberAutomatic = !!type
        && type.numberAutoGenerate === true
        && row.numberMode !== 'manual';
      const numberManual = !!type && !numberAutomatic;
      const documentStatusOptions = this.bulkUploadStatusOptions(type);
      const typeOptions = row.sectionCode
        ? (this.TYPES[row.sectionCode] || [])
            .map(label => this.typeMeta(row.sectionCode, label))
            .filter(item => item && this.canCreateType(item)
              && (!item.isFinancial || !this.roleHidesMoney(item.code)))
            .map(item => ({ label: item.name }))
        : [];
      const typeFields = (type && type.fields ? type.fields : []).map(field => {
        const isSelect = field.dataType === 'select' || field.dataType === 'boolean';
        const isFile = field.dataType === 'file';
        const options = field.dataType === 'boolean' ? ['Да', 'Нет'] : (field.options || []);
        const rawValue = (row.fieldVals || {})[field.key];
        return {
          label: field.label,
          requiredMark: field.isRequired ? ' *' : '',
          isSelect,
          isFile,
          isInput: !isSelect && !isFile,
          inputType: field.dataType === 'date' ? 'date' : 'text',
          options,
          value: isFile ? '' : (rawValue || ''),
          fileLabel: rawValue instanceof File ? `📎 ${rawValue.name}` : '⬆ Выбрать файл',
          onInput: event => this.updateBulkUploadRow(row.id, {
            fieldVals: { ...(row.fieldVals || {}), [field.key]: event.target.value },
            status: 'ready',
          }),
          onPickFile: async () => {
            const file = await this.chooseFile();
            if (!file) return;
            const current = (this.state.bulkUploadRows || []).find(item => item.id === row.id);
            if (!current) return;
            this.updateBulkUploadRow(row.id, {
              fieldVals: { ...(current.fieldVals || {}), [field.key]: file },
              status: 'ready',
            });
          },
        };
      });
      const status = row.status || 'ready';
      const statusLabel = status === 'success'
        ? '✓ Документ создан'
        : (status === 'uploading'
            ? 'Загрузка…'
            : (status === 'error'
                ? 'Требуется исправление'
                : (validation || 'Готов к загрузке')));
      const statusColor = status === 'success'
        ? '#15803d'
        : (status === 'error' ? '#b91c1c' : (status === 'uploading' ? '#6d28d9' : (validation ? '#b45309' : '#52525b')));
      const statusBackground = status === 'success'
        ? '#e7f5ec'
        : (status === 'error' ? '#fef2f2' : (status === 'uploading' ? '#f3e8ff' : (validation ? '#fff7ed' : '#f4f4f5')));
      const rowResponsibleSource = [...bulkUploadResponsibleOptions];
      if (row.responsibleId
        && !rowResponsibleSource.some(item => item.value === String(row.responsibleId))) {
        rowResponsibleSource.unshift({
          value: String(row.responsibleId),
          label: row.responsibleName || `Пользователь #${row.responsibleId}`,
        });
      }
      const responsible = rowResponsibleSource.find(item => item.value === String(row.responsibleId));
      const rowResponsibleOptions = rowResponsibleSource.map(option => ({
        ...option,
        onPick: () => {
          this.updateBulkUploadRow(row.id, {
            responsibleId: option.value,
            responsibleName: option.label,
            status: 'ready',
          });
          this.setState({ responsibleMenuOpen: null });
        },
      }));
      return {
        ...row,
        fileName: row.file.name,
        fileSize: row.file.size >= 1024 * 1024
          ? `${(row.file.size / (1024 * 1024)).toFixed(1)} МБ`
          : `${Math.max(1, Math.ceil(row.file.size / 1024))} КБ`,
        typeOptions,
        typeFields,
        hasTypeFields: typeFields.length > 0,
        numberPending: !type,
        numberAutomatic,
        numberManual,
        moneyVisible: !!type && !this.roleHidesMoney(type.code),
        numberModeCode: !type ? 'pending' : (numberAutomatic ? 'auto' : 'manual'),
        numberAutoShown: type && type.numberFormat
          ? `Будет присвоен автоматически · ${type.numberFormat}`
          : 'Будет присвоен автоматически',
        numberHeading: numberManual
          ? (type && type.numberAutoGenerate === true ? 'Номер · вручную' : 'Номер · ручной ввод')
          : 'Номер',
        numberManualPlaceholder: type && type.numberFormat
          ? `Формат: ${type.numberFormat}`
          : 'Введите номер при необходимости',
        canUseAutomaticNumber: !!type && type.numberAutoGenerate === true,
        counterpartyShown: row.counterpartyName || 'Выберите компанию Bitrix24',
        dealShown: bulkDealLabel(row.links),
        taskShown: row.taskLinks && row.taskLinks.length
          ? `#${row.taskLinks[0].taskId} · ${row.taskLinks[0].taskTitle}`
          : '',
        hasTask: !!(row.taskLinks && row.taskLinks.length),
        taskSearch: row.taskSearch || '',
        taskSearchLoadingLabel: row.taskSearchLoading ? 'Поиск…' : 'Найти задачу в Bitrix24',
        taskResults: (row.taskResults || []).map(task => ({
          value: String(task.id),
          label: `#${task.id} · ${task.title}`,
          onPick: () => this.selectBulkUploadTask(task, row.id),
        })),
        hasTaskResults: !!(row.taskResults && row.taskResults.length),
        documentStatus: row.documentStatus || '',
        documentStatusOptions,
        statusDisabled: !type,
        responsibleShown: responsible ? responsible.label : 'Выберите ответственного',
        responsibleOptions: rowResponsibleOptions,
        responsibleMenuOpen: S.responsibleMenuOpen === `bulk-upload-row:${row.id}`,
        responsibleExpanded: S.responsibleMenuOpen === `bulk-upload-row:${row.id}` ? 'true' : 'false',
        statusLabel,
        statusStyle: `display:inline-block;max-width:100%;padding:4px 8px;border-radius:12px;background:${statusBackground};color:${statusColor};font-size:10.5px;line-height:1.35;overflow-wrap:anywhere;`,
        hasError: status === 'error' && !!(row.error || validation),
        errorShown: row.error || validation,
        canRetry: status === 'error',
        onRetry: () => { void this.createBulkUpload([row.id]); },
        onRemove: () => this.removeBulkUploadRow(row.id),
        onSection: event => this.updateBulkUploadRow(row.id, {
          sectionCode: event.target.value,
          typeLabel: '',
          fieldVals: {},
          number: '',
          numberMode: null,
          documentStatus: '',
          status: 'ready',
        }),
        onType: event => {
          const typeLabel = event.target.value;
          const selectedType = this.typeMeta(row.sectionCode, typeLabel);
          const selectedStatusOptions = this.bulkUploadStatusOptions(selectedType);
          this.updateBulkUploadRow(row.id, {
            typeLabel,
            fieldVals: {},
            number: '',
            numberMode: selectedType
              ? (selectedType.numberAutoGenerate === true ? 'auto' : 'manual')
              : null,
            documentStatus: selectedStatusOptions[0] ? selectedStatusOptions[0].code : '',
            status: 'ready',
          });
        },
        onTitle: event => this.updateBulkUploadRow(row.id, { title: event.target.value, status: 'ready' }),
        onNumber: event => this.updateBulkUploadRow(row.id, { number: event.target.value, numberMode: 'manual', status: 'ready' }),
        useManualNumber: () => this.updateBulkUploadRow(row.id, { number: '', numberMode: 'manual', status: 'ready' }),
        useAutomaticNumber: () => this.updateBulkUploadRow(row.id, { number: '', numberMode: 'auto', status: 'ready' }),
        onDate: event => this.updateBulkUploadRow(row.id, { documentDate: event.target.value, status: 'ready' }),
        onAmount: event => this.updateBulkUploadRow(row.id, { amount: event.target.value, status: 'ready' }),
        onCurrency: event => this.updateBulkUploadRow(row.id, { currency: event.target.value, status: 'ready' }),
        onCompany: () => { void this.pickBulkUploadCompany(row.id); },
        onDeals: () => { void this.pickBulkUploadDeals(row.id); },
        onTaskSearch: event => { void this.searchBulkUploadTasks(event.target.value, row.id); },
        clearTask: () => this.updateBulkUploadRow(row.id, {
          taskLinks: [], taskSearch: '', taskResults: [], taskSearchLoading: false, status: 'ready',
        }),
        onDocumentStatus: event => this.updateBulkUploadRow(row.id, {
          documentStatus: event.target.value,
          status: 'ready',
        }),
        toggleResponsible: () => this.setState({
          responsibleMenuOpen: S.responsibleMenuOpen === `bulk-upload-row:${row.id}`
            ? null
            : `bulk-upload-row:${row.id}`,
        }),
        onComment: event => this.updateBulkUploadRow(row.id, { comment: event.target.value, status: 'ready' }),
      };
    });
    const bulkUploadPendingCount = bulkUploadRows.filter(row => row.status !== 'success').length;

    const isAdmin = S.screen === 'admin';
    const adminAllowed = !!(
      this.serverPolicy
      && this.serverPolicy.permissions
      && this.serverPolicy.permissions.administer
    );
    const adminTabsDef = [
      ['sections', 'Разделы'], ['types', 'Типы документов'], ['lifecycles', 'Жизненные циклы'], ['roles', 'Роли и доступ'], ['training', 'Обучение'],
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
        section: (type.sectionNames && type.sectionNames.length) ? type.sectionNames.join(', ') : type.sectionName,
        c: type.sectionColor || '#64748b',
        label: type.name,
        lifecycle: lifecycle ? lifecycle.name : 'Не назначен',
        content: `${type.contentRequired === false ? 'можно позже' : 'файл / ссылка'} · ${(type.fields || []).length} полей${type.isActive === false ? ' · отключён' : ''}`,
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
    const adminDepartmentRows = (S.adminDepartments || []).map(department => {
      const assignment = S.adminDepartmentRoles[String(department.id)] || null;
      return {
        id: department.id,
        name: department.name,
        path: department.path || department.name,
        roleCode: assignment ? assignment.roleCode : '',
        priority: assignment ? String(assignment.priority) : '100',
        roleOptions: adminRoleOptions,
        hasRole: !!assignment,
        onRole: event => this.setAdminDepartmentRole(department.id, event.target.value),
        onPriority: event => this.setAdminDepartmentPriority(department.id, event.target.value),
      };
    });

    const trainingItems = this.TRAINING.map(([title, desc, kind, icon]) => ({ title, desc, kind, icon }));
    const futureTrainingItems = this.FUTURE_TRAINING.map(item => ({ ...item }));

    const nt = S.newType;
    const dataTypes = ['Текст', 'Число', 'Дата', 'Сумма', 'Список', 'Да/Нет', 'Файл'];
    const newTypeFields = nt.fields.map((f, i) => ({
      name: f.name, dtype: f.dtype,
      typeDisabled: !!f.lockedSource,
      typeStyle: `padding:7px 9px;border:1px solid ${f.lockedSource ? '#e4e4e7' : '#e4e4e7'};border-radius:7px;font-size:12.5px;background:${f.lockedSource ? '#f4f4f5' : '#fff'};color:${f.lockedSource ? '#71717a' : '#18181b'};cursor:${f.lockedSource ? 'not-allowed' : 'pointer'};`,
      typeHint: f.lockedSource ? 'Тип задан библиотекой полей и не может быть изменён' : '',
      reqStyle: `width:18px;height:18px;border-radius:5px;border:1.5px solid ${f.required ? '#4f46e5' : '#d4d4d8'};background:${f.required ? '#4f46e5' : '#fff'};color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;cursor:pointer;flex:none;`,
      reqMark: f.required ? '✓' : '',
      onName: (e) => this.ntField(i, 'name', e.target.value),
      onType: (e) => this.ntField(i, 'dtype', e.target.value),
      onReq: () => this.ntField(i, 'required', !f.required),
      onRemove: () => this.ntRemoveField(i),
    }));
    const dataTypeByCode = { text: 'Текст', number: 'Число', date: 'Дата', money: 'Сумма', select: 'Список', boolean: 'Да/Нет', file: 'Файл' };
    const libraryChips = (S.adminFieldLibrary || []).map(field => ({
      name: field.name,
      onAdd: () => this.ntAddField(field.name, dataTypeByCode[field.dataType] || 'Текст', field.key),
    }));
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
          .filter(type => this.typeSectionCodes(type).some(sectionCode => visibleSectionCodes.includes(sectionCode)))
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
      content: roleEdit.permissions.editAny === true || roleEdit.permissions.editOwn === true,
      archive: roleEdit.permissions.softDelete === true,
      restore: roleEdit.permissions.restore === true,
      export: roleEdit.permissions.export === true,
      finance: roleEdit.hideMoney !== true
        && !roleEdit.hiddenFields.includes('amount')
        && !roleEdit.hiddenFields.includes('currency'),
    });
    const roleTypeOptions = (S.adminTypes || [])
      .filter(type => type.isActive !== false && this.typeSectionCodes(type).some(sectionCode => roleEdit.visibleSectionCodes.includes(sectionCode)))
      .map(type => {
        const checked = roleEdit.visibleTypeCodes.includes(type.code);
        return {
          code: type.code,
          label: `${(type.sectionNames && type.sectionNames.length) ? type.sectionNames.join(', ') : type.sectionName} · ${type.name}`,
          checked,
          mark: checked ? '✓' : '',
          onToggle: () => {
            const nextChecked = !checked;
            const currentByType = roleEdit.permissions.byType || {};
            const current = { ...roleTypeDefaults(type), ...(currentByType[type.code] || {}) };
            this.setState({
              roleEdit: {
                ...roleEdit,
                visibleTypeCodes: toggleInList(roleEdit.visibleTypeCodes, type.code),
                permissions: {
                  ...roleEdit.permissions,
                  byType: {
                    ...currentByType,
                    [type.code]: { ...current, view: nextChecked },
                  },
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
    const permissionLabels = { create: 'Создание', editOwn: 'Правка своих', editAny: 'Правка всех', transitionOwn: 'Статусы своих', transitionAny: 'Статусы всех', softDelete: 'Архивирование', restore: 'Восстановление', export: 'XLSX', administer: 'Администрирование' };
    const rolePermissionOptions = Object.entries(permissionLabels)
      .filter(([key]) => key !== 'administer' || S.editingRoleCode === 'admin')
      .map(([key, label]) => ({
      key, label, checked: roleEdit.permissions[key] === true, mark: roleEdit.permissions[key] === true ? '✓' : '',
      onToggle: () => this.setState({ roleEdit: { ...roleEdit, permissions: { ...roleEdit.permissions, [key]: !roleEdit.permissions[key] } } }),
      }));
    const typePermissionLabels = [
      ['view', 'Просмотр'],
      ['create', 'Создание'],
      ['edit', 'Правка'],
      ['transition', 'Статусы'],
      ['content', 'Файлы'],
      ['archive', 'Архив'],
      ['restore', 'Восст.'],
      ['export', 'Экспорт'],
      ['finance', 'Финансы'],
    ];
    const roleTypePolicyRows = S.editingRoleCode === 'admin' ? [] : (S.adminTypes || [])
      .filter(type => type.isActive !== false && this.typeSectionCodes(type).some(sectionCode => roleEdit.visibleSectionCodes.includes(sectionCode)))
      .map(type => {
        const defaults = roleTypeDefaults(type);
        const currentByType = roleEdit.permissions.byType || {};
        const current = { ...defaults, ...(currentByType[type.code] || {}) };
        return {
          code: type.code,
          name: type.name,
          sectionName: (type.sectionNames && type.sectionNames.length) ? type.sectionNames.join(', ') : type.sectionName,
          actions: typePermissionLabels.map(([key, label]) => {
            const checked = current[key] === true;
            return {
              key,
              label,
              mark: checked ? '✓' : '',
              style: `min-height:34px;padding:6px 7px;border:1px solid ${checked ? '#a5b4fc' : '#e4e4e7'};border-radius:7px;background:${checked ? '#eef2ff' : '#fff'};color:${checked ? '#4338ca' : '#71717a'};font-size:10.5px;text-align:left;cursor:pointer;`,
              onToggle: () => {
                const nextChecked = !checked;
                const visibleTypeCodes = key === 'view' && !roleEdit.allTypes
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
                        ...currentByType,
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

    return {
      // nav
      showSidebar: !this.placementContextType,
      isRegistry: activeRegistry || archiveMode, isActiveRegistry: activeRegistry, isArchive: archiveMode,
      isDeal: S.screen === 'deal', isCompany: S.screen === 'company',
      placementContextMissing,
      placementContextReady,
      contextDocumentsLoading,
      contextDocumentsFailed,
      contextDocumentsAvailable,
      contextDocumentsError: S.contextDocumentsError,
      contextSyncUnavailable: contextDocumentsAvailable && S.contextSyncUnavailable,
      retryContextDocuments: () => { void this.loadContextDocuments(); },
      goRegistry: () => {
        this.setState({
          screen: 'registry',
          view: 'all',
          search: '',
          registryPage: 0,
          sel: {},
          rowMenuId: null,
          drawerId: null,
          filters: { sections: {}, statuses: {}, type: 'all', responsible: 'all', cp: '', from: '', to: '', dynamic: {} },
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
          filters: { sections: {}, statuses: {}, type: 'all', responsible: 'all', cp: '', from: '', to: '', dynamic: {} },
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
      companyMoneyVisible,
      companyDocumentsGridStyle: `display:grid;grid-template-columns:${companyDocumentsGridStyle};`,
      companyDropSections,
      companyHasDropSections: companyDropSections.length > 0,
      companyHasDeals,
      companyHasDocuments,
      companyDealsEmpty: !companyHasDeals,
      companyDocumentsEmpty: !companyHasDocuments,
      dealHeaderTitle, dealStageName, dealStageColor, dealContextLabel,
      companyIsDeals: S.companyView === 'deals', companyIsDocs: S.companyView === 'docs',
      setCompanyDeals: () => this.setState({ companyView: 'deals' }),
      setCompanyDocs: () => this.setState({ companyView: 'docs' }),
      cvDealsStyle: cvSeg(S.companyView === 'deals'), cvDocsStyle: cvSeg(S.companyView === 'docs'),
      adminLockIcon: adminAllowed ? '' : '🔒',
      isAdmin, adminAllowed, adminDenied: !adminAllowed,
      becomeAdmin: () => this.setState({ role: 'admin', activeSection: 'all' }),
      adminTabs, adminSectionRows, adminTypeRows, adminLifecycles, adminRoleRows,
      // Initial loading happens before the registry is shown. Subsequent
      // administration refreshes keep the already loaded layout in place.
      adminDataLoading: S.adminDataLoading && !S.adminDataLoaded,
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
              .filter(type => type.isActive !== false && this.typeSectionCodes(type).some(sectionCode => roleEdit.visibleSectionCodes.includes(sectionCode)))
              .filter(type => (roleEdit.permissions.byType || {})[type.code]?.view !== false)
              .map(type => type.code);
        this.setState({ roleEdit: { ...roleEdit, allTypes, visibleTypeCodes } });
      },
      saveRolePolicy: () => { void this.saveRolePolicy(); },
      deleteRolePolicy: () => { void this.deleteRolePolicy(); },
      adminEditError: S.adminEditError,
      adminEditHasError: !!S.adminEditError,
      adminUserRows,
      adminDepartmentRows,
      adminUsersEmpty: !S.adminAccessLoading && adminUserRows.length === 0,
      adminDepartmentsEmpty: !S.adminAccessLoading && adminDepartmentRows.length === 0,
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
      admTraining: S.adminTab === 'training',
      trainingItems,
      futureTrainingItems,
      helpOpen: S.helpOpen,
      openHelp: () => this.setState({ helpOpen: true }),
      closeHelp: () => this.setState({ helpOpen: false }),
      typeModalOpen: S.typeModalOpen,
      openTypeModal: () => this.openTypeEditor(),
      closeTypeModal: () => this.setState({ typeModalOpen: false, adminEditError: '' }),
      typeModalTitle: nt.code ? 'Редактирование типа документа' : 'Новый тип документа',
      ntCreateLabel: nt.code ? 'Сохранить тип' : 'Создать тип',
      ntCreate: () => { void this.saveDocumentType(nt); },
      ntLabel: nt.label, ntLifecycle: nt.lifecycle, ntFieldCount: nt.fields.length,
      ntDescription: this.textValue(nt.description),
      ntNumberFormat: this.textValue(nt.numberFormat),
      ntNumberAuto: nt.numberAutoGenerate === true,
      ntNumberAutoLabel: nt.numberAutoGenerate === true ? 'Да' : 'Нет',
      ntNumberUnique: nt.numberUniquenessEnabled === true,
      ntNumberUniqueLabel: nt.numberUniquenessEnabled === true ? 'Да' : 'Нет',
      ntContentRequired: nt.contentRequired !== false,
      ntContentRequiredLabel: nt.contentRequired !== false ? 'Файл или ссылка обязательны' : 'Можно добавить позже',
      ntSortOrder: String(nt.sortOrder || 100),
      ntActive: nt.isActive !== false,
      ntActiveLabel: nt.isActive !== false ? 'Да' : 'Нет',
      ntCanDeactivate: !!nt.code,
      ntCanDelete: !!nt.code,
      ntSetLabel: (e) => this.setState({ newType: { ...nt, label: e.target.value } }),
      ntSetLifecycle: (e) => this.setState({ newType: { ...nt, lifecycle: e.target.value } }),
      ntSetDescription: (e) => this.setState({ newType: { ...nt, description: e.target.value } }),
      ntSetNumberFormat: (e) => this.setState({ newType: { ...nt, numberFormat: e.target.value } }),
      ntToggleNumberAuto: () => this.setState({ newType: { ...nt, numberAutoGenerate: !nt.numberAutoGenerate } }),
      ntToggleNumberUnique: () => this.setState({ newType: { ...nt, numberUniquenessEnabled: !nt.numberUniquenessEnabled } }),
      ntToggleContentRequired: () => this.setState({ newType: { ...nt, contentRequired: nt.contentRequired === false } }),
      ntSetSortOrder: (e) => this.setState({ newType: { ...nt, sortOrder: e.target.value } }),
      ntToggleActive: () => this.setState({ newType: { ...nt, isActive: !nt.isActive } }),
      deleteDocumentType: () => { void this.deleteDocumentType(); },
      ntAddBlank: () => this.ntAddField('', 'Текст'),
      newTypeFields, libraryChips, dataTypes,
      ntSectionOptions: adminSectionSource.filter(section => section.isActive !== false).map(section => {
        const selected = (nt.sections || []).includes(section.code);
        return {
          code: section.code,
          label: section.name,
          mark: selected ? '✓' : '',
          style: `padding:7px 10px;border:1px solid ${selected ? '#a5b4fc' : '#e4e4e7'};border-radius:7px;background:${selected ? '#eef2ff' : '#fff'};color:${selected ? '#4338ca' : '#52525b'};font-size:11.5px;cursor:pointer;`,
          onToggle: () => {
            const sections = selected
              ? (nt.sections || []).filter(sectionCode => sectionCode !== section.code)
              : [...(nt.sections || []), section.code];
            if (sections.length) this.setState({ newType: { ...nt, sections } });
          },
        };
      }),
      ntLifecycleOptions: (S.adminLifecyclesData || []).filter(lifecycle => lifecycle.isActive !== false).map(lifecycle => ({ code: lifecycle.code, label: lifecycle.name })),
      ntCreateStyle: `background:${nt.label.trim() && (nt.sections || []).length ? '#4f46e5' : '#c7c5ef'};color:#fff;border:none;border-radius:8px;padding:9px 18px;font-size:12.5px;font-weight:600;cursor:${nt.label.trim() && (nt.sections || []).length ? 'pointer' : 'not-allowed'};`,
      role: S.role, roleLabel: role.label, roleHint: role.hint,
      registryLoading: S.registryLoading,
      registryLoadFailed,
      registryReady: S.registryReady && !S.registryLoading,
      registryLoadError: S.registryLoadError,
      deepLinkError: S.deepLinkError,
      deepLinkHasError: !!S.deepLinkError,
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
      canCreateAnyDocument,
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
        && selectedDocuments.every(document => this.canRestoreDocument(document)),
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
      embeddedGroups,
      dealStatusCards,
      dealFinancialLoading: S.dealFinancialLoading,
      dealFinancialVisible: !!financialSummary && !S.dealFinancialLoading,
      dealFinancialDenied,
      dealFinancialFailed,
      dealFinancialError: S.dealFinancialError,
      dealTotalCurrency: S.dealTotalCurrency,
      dealTotalLabel: financialSummary
        ? `${financialNumber(financialSummary.total)} ${financialSummary.targetCurrency}`
        : `0,00 ${S.dealTotalCurrency}`,
      dealCalcRows,
      dealFinancialDocumentCount: financialSummary ? financialSummary.documentCount : 0,
      setDealTotalCurrency: event => this.setDealTotalCurrency(event.target.value),
      retryDealFinancial: () => { void this.loadDealFinancialSummary(S.dealTotalCurrency); },
      dealImportedDocs,
      dealImportedCount: dealImportedDocs.length,
      dealImportedEmpty: dealImportedDocs.length === 0,
      dealSyncAllowed,
      dealSyncDenied: !dealSyncAllowed,
      dealSyncBusy: S.dealSyncBusy,
      dealSyncButtonLabel: S.dealSyncBusy ? '↻ Синхронизация…' : '↻ Синхронизировать',
      dealSyncButtonStyle,
      dealSyncHasMessage: !!S.dealSyncMessage,
      dealSyncMessage: S.dealSyncMessage,
      dealSyncHasError: !!S.dealSyncError,
      dealSyncError: S.dealSyncError,
      syncBitrixDealDocuments: () => { if (dealSyncAllowed) void this.syncBitrixDealDocuments(); },
      drawerOpen: !!doc,
      drawerHistoryOpen: !!doc && S.drawerHistoryOpen,
      relationEditorOpen: !!doc && S.relationEditorOpen,
      relationEditorTitle: S.relationEditorMode === 'parent'
        ? 'Выбрать основной документ'
        : 'Добавить зависимый документ',
      relationEditorHint: S.relationEditorMode === 'parent'
        ? 'Связь появится в обеих карточках; текущий документ станет зависимым.'
        : 'Выберите существующий документ. Он появится в этой карточке как зависимый.',
      relationEditorSearch: S.relationEditorSearch,
      relationEditorCandidates,
      relationEditorLoading: S.relationEditorLoading,
      relationEditorEmpty: !S.relationEditorLoading && relationEditorCandidates.length === 0,
      relationEditorType: S.relationEditorType,
      relationEditorError: S.relationEditorError,
      relationEditorHasError: !!S.relationEditorError,
      relationEditorSaveLabel: S.relationEditorSaving ? 'Сохранение…' : 'Сохранить связь',
      relationEditorSaveStyle: `padding:8px 14px;border:1px solid ${relationEditorCanSave ? '#4f46e5' : '#c7c5ef'};border-radius:8px;background:${relationEditorCanSave ? '#4f46e5' : '#c7c5ef'};color:#fff;font-size:11.5px;font-weight:600;cursor:${relationEditorCanSave ? 'pointer' : 'default'};`,
      closeRelationEditor: () => this.closeRelationEditor(),
      setRelationEditorSearch: event => this.updateRelationSearch(event.target.value),
      setRelationEditorType: event => this.setState({ relationEditorType: event.target.value, relationEditorError: '' }),
      saveRelation: () => { if (relationEditorCanSave) void this.saveRelation(); },
      drawerViewing: !!doc && !S.drawerEditing,
      drawerEditing: !!doc && S.drawerEditing,
      doc,
      closeDoc: () => {
        this.documentOpenRequestId = (this.documentOpenRequestId || 0) + 1;
        this.drawerDocument = null;
        this.setState({
          rowMenuId: null,
          drawerId: null,
          drawerHistoryOpen: false,
          drawerAdditionalOpen: false,
          drawerRelationsOpen: false,
          drawerLinksOpen: false,
          drawerStorageOpen: false,
          drawerAccessOpen: false,
          drawerTaskSearch: '',
          drawerTaskResults: [],
          drawerTaskSearchLoading: false,
          drawerTaskError: '',
          drawerActionError: '',
          relationEditorOpen: false,
          relationEditorCandidates: [],
          relationEditorSelectedId: null,
          relationEditorError: '',
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
      drawerEditCounterparty: doc ? (doc.edit.counterpartyName || 'Выберите компанию') : 'Выберите компанию',
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
      pickDrawerCompany: () => { void this.pickDrawerCompany(); },
      clearDrawerCompany: () => {
        if (!S.drawerEdit) return;
        this.setState({ drawerEdit: { ...S.drawerEdit, counterpartyId: null, counterpartyName: '' } });
      },
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
        if (!S.bulkUploadBusy) this.setState({
          bulkUploadOpen: false,
          bulkUploadRows: [],
          bulkUploadBusy: false,
          bulkUploadError: '',
          bulkUploadDragActive: false,
          bulkUploadHelpOpen: false,
          responsibleMenuOpen: null,
        });
      },
      bulkUploadRows,
      bulkUploadHasRows: bulkUploadRows.length > 0,
      bulkUploadIsEmpty: bulkUploadRows.length === 0,
      bulkUploadCount: `${bulkUploadRows.length} файл(ов)`,
      bulkUploadSectionOptions,
      bulkUploadCommonTypeOptions,
      bulkUploadResponsibleOptions,
      bulkUploadCommonSection: S.bulkUploadCommonSection,
      bulkUploadCommonType: S.bulkUploadCommonType,
      bulkUploadCommonCompanyName: S.bulkUploadCommonCompanyName || 'Выберите компанию Bitrix24',
      bulkUploadCommonDealShown: bulkDealLabel(S.bulkUploadCommonDealLinks),
      bulkUploadCommonTaskShown: S.bulkUploadCommonTaskLinks && S.bulkUploadCommonTaskLinks.length
        ? `#${S.bulkUploadCommonTaskLinks[0].taskId} · ${S.bulkUploadCommonTaskLinks[0].taskTitle}`
        : '',
      bulkUploadCommonHasTask: !!(S.bulkUploadCommonTaskLinks && S.bulkUploadCommonTaskLinks.length),
      bulkUploadCommonTaskSearch: S.bulkUploadCommonTaskSearch || '',
      bulkUploadCommonTaskSearchLoadingLabel: S.bulkUploadCommonTaskLoading ? 'Поиск…' : 'Найти задачу в Bitrix24',
      bulkUploadCommonTaskResults,
      bulkUploadCommonHasTaskResults: bulkUploadCommonTaskResults.length > 0,
      bulkUploadCommonDocumentStatus: S.bulkUploadCommonDocumentStatus || '',
      bulkUploadCommonStatusOptions,
      bulkUploadCommonStatusDisabled: !bulkUploadCommonType,
      bulkUploadCommonResponsibleId: String(S.bulkUploadCommonResponsibleId || ''),
      bulkUploadCommonResponsibleName: S.bulkUploadCommonResponsibleName || '',
      bulkUploadCommonResponsibleShown: S.bulkUploadCommonResponsibleName || 'Не выбран',
      bulkUploadCommonResponsibleOptions,
      bulkUploadCommonResponsibleMenuOpen: S.responsibleMenuOpen === 'bulk-upload-common',
      bulkUploadCommonResponsibleExpanded: S.responsibleMenuOpen === 'bulk-upload-common' ? 'true' : 'false',
      bulkUploadHelpOpen: S.bulkUploadHelpOpen,
      bulkUploadHelpExpanded: S.bulkUploadHelpOpen ? 'true' : 'false',
      toggleBulkUploadHelp: () => this.setState({ bulkUploadHelpOpen: !S.bulkUploadHelpOpen }),
      setBulkUploadCommonSection: event => this.setState({
        bulkUploadCommonSection: event.target.value,
        bulkUploadCommonType: '',
        bulkUploadCommonDocumentStatus: '',
        bulkUploadError: '',
      }),
      setBulkUploadCommonType: event => {
        const typeLabel = event.target.value;
        const type = this.typeMeta(S.bulkUploadCommonSection, typeLabel);
        const options = this.bulkUploadStatusOptions(type);
        this.setState({
          bulkUploadCommonType: typeLabel,
          bulkUploadCommonDocumentStatus: options[0] ? options[0].code : '',
          bulkUploadError: '',
        });
      },
      pickBulkUploadCompany: () => { void this.pickBulkUploadCompany(); },
      pickBulkUploadDeals: () => { void this.pickBulkUploadDeals(); },
      setBulkUploadCommonTaskSearch: event => { void this.searchBulkUploadTasks(event.target.value); },
      clearBulkUploadCommonTask: () => this.setState({
        bulkUploadCommonTaskLinks: [],
        bulkUploadCommonTaskSearch: '',
        bulkUploadCommonTaskResults: [],
        bulkUploadCommonTaskLoading: false,
        bulkUploadError: '',
      }),
      setBulkUploadCommonDocumentStatus: event => this.setState({
        bulkUploadCommonDocumentStatus: event.target.value,
        bulkUploadError: '',
      }),
      toggleBulkUploadCommonResponsible: () => this.setState({
        responsibleMenuOpen: S.responsibleMenuOpen === 'bulk-upload-common'
          ? null
          : 'bulk-upload-common',
      }),
      applyBulkUploadCommon: () => this.applyBulkUploadCommon(),
      pickBulkUploadFiles: async () => {
        const files = await this.chooseFiles();
        this.appendBulkUploadFiles(files);
      },
      bulkUploadDragEnter: event => {
        if (event) event.preventDefault();
        this.setState({ bulkUploadDragActive: true });
      },
      bulkUploadDragOver: event => {
        if (!event) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        if (!this.state.bulkUploadDragActive) this.setState({ bulkUploadDragActive: true });
      },
      bulkUploadDragLeave: event => {
        if (event && event.currentTarget && event.relatedTarget
          && event.currentTarget.contains(event.relatedTarget)) return;
        this.setState({ bulkUploadDragActive: false });
      },
      bulkUploadDrop: event => {
        if (!event || !event.dataTransfer) return;
        event.preventDefault();
        event.stopPropagation();
        this.setState({ bulkUploadDragActive: false });
        this.appendBulkUploadFiles(event.dataTransfer.files);
      },
      bulkUploadDropStyle: `display:flex;align-items:center;gap:12px;min-width:0;padding:${S.bulkUploadDragActive ? '18px' : '14px'};border:2px dashed ${S.bulkUploadDragActive ? '#6d28d9' : '#c7d2fe'};border-radius:10px;background:${S.bulkUploadDragActive ? '#f3e8ff' : '#f8faff'};transition:background .12s,border-color .12s,padding .12s;`,
      bulkUploadDropLabel: S.bulkUploadDragActive
        ? 'Отпустите файлы для загрузки'
        : 'Перетащите файлы сюда',
      bulkUploadHasError: !!S.bulkUploadError,
      bulkUploadError: S.bulkUploadError,
      bulkUploadPrimaryLabel: S.bulkUploadBusy
        ? 'Загрузка…'
        : (bulkUploadRows.length > 0 && bulkUploadPendingCount === 0 ? 'Готово' : 'Загрузить документы'),
      applyBulkUpload: () => {
        if (S.bulkUploadBusy) return;
        if (bulkUploadRows.length > 0 && bulkUploadPendingCount === 0) {
          this.setState({ bulkUploadOpen: false, bulkUploadRows: [], bulkUploadError: '' });
          return;
        }
        void this.createBulkUpload();
      },
      wizardOpen: S.wizardOpen,
      openWizard: () => this.openWizard(),
      closeWizard: () => this.setState({ wizardOpen: false, wizardError: '', responsibleMenuOpen: null }),
      wizardTitle: wz.supersedesId ? 'Новая редакция документа' : 'Новый документ',
      wizardError: S.wizardError,
      wizardHasError: !!S.wizardError,
      wizardSteps, wizardSections, wizardTypes, wizardLinks, wizardTasks, wizardTaskResults,
      wizardMoneyVisible,
      wzManageLinks: () => { void this.manageWizardLinks(); },
      wzPickCompany: () => { void this.pickWizardCompany(); },
      wzClearCompany: () => this.setState({
        wz: { ...wz, counterparty: '', counterpartyId: null, sourceCounterpartyName: '' },
        wizardError: '',
      }),
      wzCompanySelected: !!wz.counterpartyId,
      wzDealStageShown: wz.dealStageName || wz.dealStageId || 'Не указана',
      wzComment: wz.comment || '',
      wzSetComment: event => this.setState({ wz: { ...wz, comment: event.target.value } }),
      wzTaskSearch: wz.taskSearch || '',
      wzTaskSearchLoading: S.taskSearchLoading,
      wzTaskSearchLoadingLabel: S.taskSearchLoading ? 'Поиск…' : 'Введите название или номер задачи',
      wzHasTaskResults: wizardTaskResults.length > 0,
      wzSearchTasks: event => { void this.searchWizardTasks(event.target.value); },
      wizardTypeFields, wzHasTypeFields: wizardTypeFields.length > 0,
      wzNumberPlaceholder: wzTypeMeta && wzTypeMeta.numberFormat
        ? wzTypeMeta.numberFormat
        : 'Введите номер',
      wzNumberHint: wzTypeMeta && wzTypeMeta.numberAutoGenerate
        ? `Оставьте пустым для автоматической нумерации${wzTypeMeta.numberFormat ? ` по формату ${wzTypeMeta.numberFormat}` : ''}. Ручной ввод также доступен.`
        : (wzTypeMeta && wzTypeMeta.numberFormat ? `Формат: ${wzTypeMeta.numberFormat}` : ''),
      wzNumberHasHint: !!(wzTypeMeta && (wzTypeMeta.numberAutoGenerate || wzTypeMeta.numberFormat)),
      wzContentOptional: !!(wzTypeMeta && wzTypeMeta.contentRequired === false),
      wzContentRequirementLabel: wzTypeMeta && wzTypeMeta.contentRequired === false
        ? 'Содержимое можно добавить позже'
        : 'Добавьте файл или HTTPS-ссылку *',
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

  ntField(i, key, val) {
    const typeLabels = { text: 'Текст', number: 'Число', date: 'Дата', money: 'Сумма', select: 'Список', boolean: 'Да/Нет', file: 'Файл' };
    const fields = this.state.newType.fields.map((field, index) => {
      if (index !== i) return field;
      if (key !== 'name') return field.lockedSource && key === 'dtype' ? field : { ...field, [key]: val };
      const normalized = String(val || '').trim().toLocaleLowerCase('ru');
      const libraryField = (this.state.adminFieldLibrary || []).find(item =>
        String(item.name || '').trim().toLocaleLowerCase('ru') === normalized,
      );
      if (libraryField) {
        return {
          ...field,
          name: val,
          key: libraryField.key,
          dtype: typeLabels[libraryField.dataType] || 'Текст',
          lockedSource: field.lockedSource === 'existing' ? 'existing' : 'library',
        };
      }
      if (field.lockedSource === 'existing') return { ...field, name: val };
      const { key: _key, lockedSource: _lockedSource, ...editable } = field;
      return { ...editable, name: val };
    });
    this.setState({ newType: { ...this.state.newType, fields } });
  }
  ntAddField(name, dtype, key = null) { const nt = { ...this.state.newType, fields: [...this.state.newType.fields, { ...(key ? { key, lockedSource: 'library' } : {}), name: name || '', dtype: dtype || 'Текст', required: false }] }; this.setState({ newType: nt }); }
  ntRemoveField(i) { const nt = { ...this.state.newType, fields: this.state.newType.fields.filter((_, j) => j !== i) }; this.setState({ newType: nt }); }

  navStyle(active) {
    return `display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:${active ? '#4f46e5' : 'transparent'};color:${active ? '#fff' : '#52525b'};border:none;border-radius:7px;padding:8px 10px;font-size:12.5px;font-weight:500;cursor:pointer;`;
  }
}
