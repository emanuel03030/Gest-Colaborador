// Data SDK - API remota + cache local persistente + fila de sincronizacao offline
//
// Regras (corrigidas):
//  1. O servidor (SQLite) e a fonte de verdade. O localStorage e um CACHE/rede de seguranca.
//  2. O cache local NUNCA e sobrescrito por uma lista vazia quando o servidor nao responde.
//  3. Toda alteracao feita sem servidor entra numa fila (pendingOps) e e reenviada
//     automaticamente quando a conexao voltar. Nada e perdido ao recarregar/relogar.
//  4. A URL do servidor e descoberta automaticamente (config.js, login, mesma origem, :3000, :3001).
window.dataSdk = {
  data: [],
  handler: null,
  mode: 'local',            // 'api' | 'local'
  loaded: false,
  storageAvailable: true,
  storageKey: 'CollaboratorData::shared',
  pendingOpsKey: 'CollaboratorData::pendingOps',
  failedOpsKey: 'CollaboratorData::failedOps',
  pendingOps: [],
  apiBaseUrl: '',
  apiReconnectIntervalMs: 5000,
  _eventSource: null,
  _apiRecoveryTimer: null,
  _apiRecoveryRunning: false,
  _queueSyncRunning: false,
  _unloadBound: false,

  // ───────────────────────── Inicializacao ─────────────────────────
  init: async function(handler) {
    this.handler = handler;
    this.storageAvailable = this.checkStorageAvailability();

    this.migrateLegacyStorageKeys();
    this.setupCrossTabSync();
    this.setupUnloadGuard();
    this.loadPendingOpsFromLocal();

    // 1) Mostra imediatamente o que ja estava salvo neste navegador (sem apagar nada).
    const cached = this.loadFromLocal();
    if (cached.isOk && this.data.length > 0) {
      this.notifyDataChanged();
    }

    // 2) Descobre o servidor e sincroniza (envia pendencias -> baixa o estado oficial).
    const base = await this.resolveApiBase();
    if (base) {
      this.apiBaseUrl = base;
      this.mode = 'api';
      const synced = await this.syncWithApi();
      if (synced.isOk) {
        this.loaded = true;
        this.subscribeToEvents();
        this.startApiRecoveryMonitor();
        this.notifyDataChanged();
        return { isOk: true, mode: this.mode, syncedPendingOps: synced.replayed || 0 };
      }
      console.warn('[DataSDK] Servidor respondeu, mas a sincronizacao falhou:', synced.error && synced.error.message);
    }

    // 3) Sem servidor: segue com o cache local (modo offline) e tenta reconectar sozinho.
    this.mode = 'local';
    this.loaded = true;
    this.startApiRecoveryMonitor();
    this.notifyDataChanged();
    return {
      isOk: true,
      mode: 'local',
      offline: true,
      warning: 'Servidor indisponível. Usando os dados salvos neste navegador; as alterações serão enviadas quando a conexão voltar.'
    };
  },

  // ───────────────────────── CRUD ─────────────────────────
  create: async function(item) {
    const safeItem = { ...item, __backendId: item && item.__backendId ? item.__backendId : this.generateId() };

    if (this.mode !== 'api') {
      return this.applyOfflineCreate(safeItem, true, 'Servidor indisponível');
    }

    const remote = await this.request('/api/records', {
      method: 'POST',
      body: JSON.stringify(safeItem)
    });

    if (remote.isOk) {
      this.data.push(remote.data || safeItem);
      this.persistMirrorToLocal();
      this.notifyDataChanged();
      return { isOk: true, mode: this.mode };
    }

    if (this.shouldFallbackToOffline(remote)) {
      return this.applyOfflineCreate(safeItem, true, remote.error && remote.error.message);
    }
    return remote;
  },

  update: async function(item) {
    const index = this.data.findIndex((d) => d.__backendId === item.__backendId);
    if (index === -1) {
      return { isOk: false, error: { message: 'Item not found' } };
    }

    const safeItem = { ...item };

    if (this.mode !== 'api') {
      return this.applyOfflineUpdate(index, safeItem, true, 'Servidor indisponível');
    }

    const remote = await this.request('/api/records/' + encodeURIComponent(safeItem.__backendId), {
      method: 'PUT',
      body: JSON.stringify(safeItem)
    });

    if (remote.isOk) {
      this.data[index] = remote.data || safeItem;
      this.persistMirrorToLocal();
      this.notifyDataChanged();
      return { isOk: true, mode: this.mode };
    }

    if (this.shouldFallbackToOffline(remote)) {
      return this.applyOfflineUpdate(index, safeItem, true, remote.error && remote.error.message);
    }
    return remote;
  },

  delete: async function(item) {
    const index = this.data.findIndex((d) => d.__backendId === item.__backendId);
    if (index === -1) {
      return { isOk: false, error: { message: 'Item not found' } };
    }

    if (this.mode !== 'api') {
      return this.applyOfflineDelete(index, item, true, 'Servidor indisponível');
    }

    const remote = await this.request('/api/records/' + encodeURIComponent(item.__backendId), {
      method: 'DELETE'
    });

    if (remote.isOk) {
      this.data.splice(index, 1);
      this.persistMirrorToLocal();
      this.notifyDataChanged();
      return { isOk: true, mode: this.mode };
    }

    if (this.shouldFallbackToOffline(remote)) {
      return this.applyOfflineDelete(index, item, true, remote.error && remote.error.message);
    }
    return remote;
  },

  // ───────────────────────── Operacoes offline ─────────────────────────
  applyOfflineCreate: function(item, queueForSync, reasonMessage) {
    this.mode = 'local';
    this.data.push(item);

    const saved = this.saveToLocal();
    if (!saved.isOk) {
      this.data.pop();
      return saved;
    }

    if (queueForSync) {
      this.enqueuePendingOp({ op: 'create', item: { ...item } });
    }

    this.notifyDataChanged();
    return {
      isOk: true,
      mode: this.mode,
      queued: !!queueForSync,
      warning: reasonMessage ? ('API indisponivel. Operacao enfileirada: ' + reasonMessage) : undefined
    };
  },

  applyOfflineUpdate: function(index, item, queueForSync, reasonMessage) {
    this.mode = 'local';
    const previous = this.data[index];
    this.data[index] = { ...item };

    const saved = this.saveToLocal();
    if (!saved.isOk) {
      this.data[index] = previous;
      return saved;
    }

    if (queueForSync) {
      this.enqueuePendingOp({ op: 'update', item: { ...item } });
    }

    this.notifyDataChanged();
    return {
      isOk: true,
      mode: this.mode,
      queued: !!queueForSync,
      warning: reasonMessage ? ('API indisponivel. Operacao enfileirada: ' + reasonMessage) : undefined
    };
  },

  applyOfflineDelete: function(index, item, queueForSync, reasonMessage) {
    this.mode = 'local';
    const removed = this.data[index];
    this.data.splice(index, 1);

    const saved = this.saveToLocal();
    if (!saved.isOk) {
      this.data.splice(index, 0, removed);
      return saved;
    }

    if (queueForSync) {
      this.enqueuePendingOp({ op: 'delete', item: { __backendId: item.__backendId } });
    }

    this.notifyDataChanged();
    return {
      isOk: true,
      mode: this.mode,
      queued: !!queueForSync,
      warning: reasonMessage ? ('API indisponivel. Operacao enfileirada: ' + reasonMessage) : undefined
    };
  },

  // ───────────────────────── Sincronizacao ─────────────────────────
  syncWithApi: async function() {
    if (this.mode !== 'api') {
      return { isOk: false, error: { message: 'API mode not active' } };
    }

    const replay = await this.flushPendingOps();
    if (!replay.isOk) {
      return replay;
    }

    const remoteLoad = await this.loadFromApi();
    if (!remoteLoad.isOk) {
      return remoteLoad;
    }

    return { isOk: true, replayed: replay.replayed || 0 };
  },

  flushPendingOps: async function() {
    if (this.mode !== 'api') {
      return { isOk: false, error: { message: 'API mode not active' } };
    }

    if (this._queueSyncRunning) {
      return { isOk: true, replayed: 0, skipped: true };
    }

    this._queueSyncRunning = true;
    let replayed = 0;

    try {
      while (this.pendingOps.length > 0) {
        const op = this.pendingOps[0];
        const result = await this.replayPendingOp(op);

        if (!result.isOk) {
          // Falha temporaria (rede, 5xx, sessao expirada, limite): mantem na fila e tenta depois.
          const temporary = result.status === 0 || result.status >= 500 ||
            result.status === 401 || result.status === 429;
          if (temporary) {
            return result;
          }
          // Operacao invalida de forma permanente: guarda numa lista de falhas (nao trava a fila
          // e nao se perde — fica em localStorage para conferencia) e segue para a proxima.
          this.archiveFailedOp(op, result);
        }

        this.pendingOps.shift();
        this.savePendingOpsToLocal();
        replayed += 1;
      }

      return { isOk: true, replayed: replayed };
    } finally {
      this._queueSyncRunning = false;
      this.emitStatus();
    }
  },

  archiveFailedOp: function(op, result) {
    if (!this.storageAvailable) return;
    try {
      const raw = localStorage.getItem(this.failedOpsKey);
      const list = raw ? JSON.parse(raw) : [];
      list.push({
        op: op,
        status: result && result.status,
        message: result && result.error && result.error.message,
        failedAt: Date.now()
      });
      localStorage.setItem(this.failedOpsKey, JSON.stringify(list.slice(-200)));
    } catch (_) { /* ignore */ }
    console.warn('[DataSDK] Operação rejeitada pelo servidor e movida para failedOps:', op, result);
  },

  replayPendingOp: async function(op) {
    const opType = op && op.op;
    const item = (op && op.item) || {};
    const id = String(item.__backendId || '');

    if (!opType) {
      return { isOk: true };
    }

    if (opType === 'create') {
      const created = await this.request('/api/records', {
        method: 'POST',
        body: JSON.stringify(item)
      });

      if (created.isOk) {
        return { isOk: true };
      }

      // Registro ja existe no backend: converte para update.
      if (created.status === 409 || created.status === 400) {
        const updated = await this.request('/api/records/' + encodeURIComponent(id), {
          method: 'PUT',
          body: JSON.stringify(item)
        });
        return updated.isOk ? { isOk: true } : updated;
      }

      return created;
    }

    if (opType === 'update') {
      const updated = await this.request('/api/records/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify(item)
      });

      if (updated.isOk) {
        return { isOk: true };
      }

      // Registro nao existe no backend: converte para create.
      if (updated.status === 404) {
        const created = await this.request('/api/records', {
          method: 'POST',
          body: JSON.stringify(item)
        });
        return created.isOk ? { isOk: true } : created;
      }

      return updated;
    }

    if (opType === 'delete') {
      const removed = await this.request('/api/records/' + encodeURIComponent(id), {
        method: 'DELETE'
      });

      // Se o registro nao existe mais, considera sincronizado.
      if (removed.isOk || removed.status === 404) {
        return { isOk: true };
      }

      return removed;
    }

    return { isOk: true };
  },

  enqueuePendingOp: function(op) {
    if (!op || !op.op) return;

    this.pendingOps.push({
      op: op.op,
      item: op.item || {},
      queuedAt: Date.now()
    });
    this.savePendingOpsToLocal();
    this.emitStatus();
  },

  loadPendingOpsFromLocal: function() {
    if (!this.storageAvailable) {
      this.pendingOps = [];
      return;
    }

    try {
      const stored = localStorage.getItem(this.pendingOpsKey);
      if (!stored) {
        this.pendingOps = [];
        return;
      }

      const parsed = JSON.parse(stored);
      this.pendingOps = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      this.pendingOps = [];
    }
  },

  savePendingOpsToLocal: function() {
    if (!this.storageAvailable) {
      return { isOk: false, error: { message: 'Local storage unavailable' } };
    }

    try {
      localStorage.setItem(this.pendingOpsKey, JSON.stringify(this.pendingOps));
      return { isOk: true };
    } catch (err) {
      return { isOk: false, error: { message: err && err.message ? err.message : 'Failed to persist pending operations' } };
    }
  },

  loadFromApi: async function() {
    const response = await this.request('/api/records', { method: 'GET' });
    if (!response.isOk) {
      return response;
    }

    this.data = Array.isArray(response.data) ? response.data : [];
    this.persistMirrorToLocal();
    return { isOk: true };
  },

  loadFromLocal: function() {
    if (!this.storageAvailable) {
      this.data = [];
      return { isOk: true };
    }
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (!stored) {
        this.data = [];
        return { isOk: true };
      }

      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) {
        return { isOk: false, error: { message: 'Stored payload is not an array' } };
      }

      this.data = parsed;
      return { isOk: true };
    } catch (err) {
      return { isOk: false, error: { message: err && err.message ? err.message : 'Invalid JSON in localStorage' } };
    }
  },

  save: function() {
    return this.saveToLocal();
  },

  saveToLocal: function() {
    if (!this.storageAvailable) {
      return { isOk: false, error: { message: 'Local storage unavailable' } };
    }

    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.data));
      return { isOk: true };
    } catch (err) {
      return { isOk: false, error: { message: err && err.message ? err.message : 'Failed to persist data' } };
    }
  },

  // Espelho local do estado do servidor. So e chamado quando o dado e confiavel
  // (resposta do servidor ou alteracao do usuario) — nunca por um "notify" generico.
  persistMirrorToLocal: function() {
    if (!this.storageAvailable) return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.data));
    } catch (err) {
      // ignorar falha de mirror
    }
  },

  notifyDataChanged: function() {
    if (this.handler && this.handler.onDataChanged) {
      this.handler.onDataChanged(this.data);
    }
    this.emitStatus();
  },

  // Alimenta o indicador de sincronizacao do index.html (evento 'dataSdk:status').
  emitStatus: function() {
    try {
      let token = '';
      try { token = sessionStorage.getItem('authToken') || ''; } catch (_) { /* ignore */ }
      window.dispatchEvent(new CustomEvent('dataSdk:status', {
        detail: {
          authenticated: !!token,
          mode: this.mode === 'api' ? 'server' : 'local',
          pending: this.pendingOps.length,
          loaded: this.loaded
        }
      }));
    } catch (_) { /* ignore */ }
  },

  checkStorageAvailability: function() {
    try {
      const testKey = '__dataSdkTest__';
      localStorage.setItem(testKey, '1');
      localStorage.removeItem(testKey);
      return true;
    } catch (err) {
      return false;
    }
  },

  getCurrentUser: function() {
    try {
      return String(sessionStorage.getItem('loggedUser') || 'anonymous').trim().toUpperCase().replace(/[^A-Z0-9._-]/g, '_');
    } catch (_) {
      return 'anonymous';
    }
  },

  apiUnavailableResult: function() {
    return {
      isOk: true,
      mode: 'local',
      queued: true,
      warning: 'Servidor indisponível. A alteração foi salva localmente e será sincronizada quando a conexão voltar.'
    };
  },

  migrateLegacyStorageKeys: function() {
    if (!this.storageAvailable) return;
    try {
      const legacyStorageKey = 'employeeData::shared';
      const legacyPendingOpsKey = 'employeeData::pendingOps';

      if (!localStorage.getItem(this.storageKey)) {
        const legacyData = localStorage.getItem(legacyStorageKey);
        if (legacyData) {
          localStorage.setItem(this.storageKey, legacyData);
        }
      }

      if (!localStorage.getItem(this.pendingOpsKey)) {
        const legacyPendingOps = localStorage.getItem(legacyPendingOpsKey);
        if (legacyPendingOps) {
          localStorage.setItem(this.pendingOpsKey, legacyPendingOps);
        }
      }
    } catch (err) {
      // Ignora falhas de migracao para nao interromper a inicializacao.
    }
  },

  // ───────────────────────── Descoberta do servidor ─────────────────────────
  // Ordem: config.js -> URL usada no login -> mesma origem -> :3000 -> :3001.
  getApiCandidates: function() {
    const list = [];
    const add = function(u) {
      u = String(u || '').trim().replace(/\/+$/, '');
      if (u && list.indexOf(u) === -1) list.push(u);
    };

    try { add(window.__DATA_API_BASE_URL); } catch (_) {}
    try {
      const cfg = window.__AUTH_CONFIG || {};
      add(cfg.API_BASE_URL); add(cfg.AUTH_SERVER_URL);
    } catch (_) {}
    try { add(sessionStorage.getItem('apiBase')); } catch (_) {}

    const http = typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
    if (http) add(location.origin);
    const host = http && location.hostname ? location.hostname : 'localhost';
    add('http://' + host + ':3000'); add('http://' + host + ':3001');
    add('http://localhost:3000'); add('http://localhost:3001');
    return list;
  },

  probeApi: async function(base) {
    const controller = new AbortController();
    const timeout = setTimeout(function() { controller.abort(); }, 2000);
    try {
      const response = await fetch(base + '/health', { method: 'GET', signal: controller.signal });
      if (!response.ok) return false;
      const json = await response.json().catch(function() { return null; });
      return !!(json && json.ok);
    } catch (err) {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  },

  resolveApiBase: async function() {
    const candidates = this.getApiCandidates();
    // Tenta primeiro a ultima base que funcionou (evita varrer tudo a cada 5 s).
    if (this.apiBaseUrl && candidates.indexOf(this.apiBaseUrl) === -1) candidates.unshift(this.apiBaseUrl);
    for (let i = 0; i < candidates.length; i++) {
      if (await this.probeApi(candidates[i])) {
        try { sessionStorage.setItem('apiBase', candidates[i]); } catch (_) {}
        return candidates[i];
      }
    }
    return '';
  },

  getApiBaseUrl: function() {
    return this.apiBaseUrl || this.getApiCandidates()[0] || '';
  },

  checkApiAvailability: async function() {
    const base = await this.resolveApiBase();
    if (base) this.apiBaseUrl = base;
    return !!base;
  },

  startApiRecoveryMonitor: function() {
    if (this._apiRecoveryTimer) return;
    var self = this;
    this._apiRecoveryTimer = setInterval(function() {
      self.tryRecoverApiMode();
    }, this.apiReconnectIntervalMs);
  },

  tryRecoverApiMode: async function() {
    if (this.mode === 'api' || this._apiRecoveryRunning) {
      return;
    }

    this._apiRecoveryRunning = true;
    try {
      const apiReady = await this.checkApiAvailability();
      if (!apiReady) {
        return;
      }

      this.mode = 'api';
      const synced = await this.syncWithApi();
      if (!synced.isOk) {
        this.mode = 'local';
        return;
      }

      this.loaded = true;
      this.subscribeToEvents();
      this.notifyDataChanged();
    } finally {
      this._apiRecoveryRunning = false;
    }
  },

  shouldFallbackToOffline: function(requestResult) {
    if (!requestResult || requestResult.isOk) {
      return false;
    }

    // Falha de rede, servidor ou limite de requisicoes: guarda localmente e enfileira.
    return requestResult.status === 0 || requestResult.status >= 500 || requestResult.status === 429;
  },

  // ───────────────────────── HTTP ─────────────────────────
  request: async function(path, options) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (options && options.headers) {
        Object.assign(headers, options.headers);
      }

      // Anexa o token de sessão (JWT) em toda requisição.
      try {
        const authToken = sessionStorage.getItem('authToken');
        if (authToken) {
          headers['Authorization'] = 'Bearer ' + authToken;
        }
      } catch (_) { /* sessionStorage indisponível */ }

      const response = await fetch(this.apiBaseUrl + path, {
        ...options,
        headers: headers
      });

      const text = await response.text();
      let payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (err) {
          payload = {};
        }
      }

      if (response.status === 401) {
        // Sessão expirada/inválida: manda para o login. As alteracoes pendentes
        // continuam guardadas na fila local e sao enviadas apos o novo login.
        try {
          sessionStorage.removeItem('loggedUser');
          sessionStorage.removeItem('authToken');
        } catch (_) { /* ignore */ }
        if (typeof window !== 'undefined' && window.location && !/login\.html/i.test(window.location.pathname)) {
          window.location.replace('login.html?motivo=expirada');
        }
        return {
          isOk: false,
          status: 401,
          error: { message: (payload.error && payload.error.message) || 'Sessão expirada. Faça login novamente.' }
        };
      }

      if (!response.ok || payload.isOk === false) {
        return {
          isOk: false,
          status: response.status,
          error: {
            message: (payload.error && payload.error.message) || ('Request failed with status ' + response.status)
          }
        };
      }

      return { isOk: true, status: response.status, data: payload.data };
    } catch (err) {
      return {
        isOk: false,
        status: 0,
        error: { message: err && err.message ? err.message : 'Network error' }
      };
    }
  },

  generateId: function() {
    return Date.now().toString() + Math.random().toString(36).slice(2, 11);
  },

  // ───────────────────────── Tempo real (SSE) ─────────────────────────
  subscribeToEvents: function() {
    if (typeof EventSource === 'undefined') return;
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }

    var self = this;
    var token = '';
    try { token = sessionStorage.getItem('authToken') || ''; } catch (_) { /* ignore */ }
    var eventUrl = this.apiBaseUrl + '/api/events?token=' + encodeURIComponent(token);
    var es = new EventSource(eventUrl);

    es.onmessage = function(e) {
      try {
        var event = JSON.parse(e.data);
        if (event.type === 'dataChanged') {
          // Nao sobrescreve o estado enquanto ha alteracoes locais ainda nao enviadas.
          if (self.mode !== 'api' || self.pendingOps.length > 0 || self._queueSyncRunning) return;
          self.loadFromApi().then(function(result) {
            if (result.isOk) {
              self.notifyDataChanged();
            }
          });
        }
      } catch (err) {
        // ignora payload invalido
      }
    };

    es.onerror = function() {
      es.close();
      self._eventSource = null;
      setTimeout(function() {
        if (self.mode === 'api') {
          self.subscribeToEvents();
        }
      }, 5000);
    };

    this._eventSource = es;
  },

  // ───────────────────────── Abas e protecao ao fechar ─────────────────────────
  setupCrossTabSync: function() {
    var self = this;
    if (this._crossTabBound) return;
    this._crossTabBound = true;
    window.addEventListener('storage', function(e) {
      if (e.key === self.storageKey && e.newValue !== e.oldValue) {
        try {
          var newData = JSON.parse(e.newValue);
          if (Array.isArray(newData)) {
            self.data = newData;
            self.notifyDataChanged();
          }
        } catch (err) {
          // dados invalidos, ignorar
        }
      }

      if (e.key === self.pendingOpsKey && e.newValue !== e.oldValue) {
        self.loadPendingOpsFromLocal();
        self.emitStatus();
      }
    });
  },

  // Avisa antes de fechar a aba se ainda ha alteracoes que nao chegaram ao servidor.
  setupUnloadGuard: function() {
    var self = this;
    if (this._unloadBound) return;
    this._unloadBound = true;
    window.addEventListener('beforeunload', function(e) {
      if (self.pendingOps.length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  },

  // ───────────────────────── Backup manual ─────────────────────────
  // No console do navegador: dataSdk.exportBackup()  -> baixa um .json com tudo.
  exportBackup: function() {
    var payload = {
      exportedAt: new Date().toISOString(),
      records: this.data,
      pendingOps: this.pendingOps
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'backup-emporio-redepas-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return { isOk: true, count: this.data.length };
  }
};