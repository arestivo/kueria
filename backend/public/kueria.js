// === Constants ===
const API_URL = 'api';
const SESSION_STORAGE_KEY = 'keria.session';
let sessionId = null;

// === State ===
const state = {
  connected: false,
  credentials: {},
  schemas: [],
  selectedSchema: 'public',
  tables: []
};

// === DOM Cache ===
const DOM = {
  loginScreen: document.getElementById('loginScreen'),
  mainInterface: document.getElementById('mainInterface'),
  resultsContainer: document.getElementById('resultsContainer'),
  connectionInfo: document.getElementById('connectionInfo'),
  queryEditor: document.getElementById('queryEditor'),
  executeBtn: document.getElementById('executeBtn'),
  toggleBtn: document.getElementById('toggleMaximizeBtn'),
  maximizeIcon: document.getElementById('maximizeIcon'),
  topbar: document.getElementById('topbar'),
  messageBanner: document.getElementById('messageBanner'),
  loginMessage: document.getElementById('loginMessage'),
  schemaList: document.getElementById('schemaList'),
  tablesList: document.getElementById('tablesList'),
  currentSchema: document.getElementById('currentSchema'),
  statementResults: document.getElementById('statementResults'),
  resultsInfo: document.getElementById('resultsInfo'),
  username: document.getElementById('username'),
  password: document.getElementById('password'),
  connectBtn: document.getElementById('connectBtn'),
  newSchemaName: document.getElementById('newSchemaName')
};

// Additional DOM refs that are sometimes queried directly elsewhere
Object.assign(DOM, {
  disconnectBtn: document.getElementById('disconnectBtn'),
  createSchemaBtn: document.getElementById('createSchemaBtn'),
  refreshTablesBtn: document.getElementById('refreshTablesBtn'),
  clearQueryBtn: document.getElementById('clearQueryBtn')
});

// Use the visible editor when available, keeping the textarea fallback in sync.
const QueryEditor = {
  codeMirror: null,

  getValue() {
    return this.codeMirror ? this.codeMirror.getValue() : DOM.queryEditor.value;
  },

  setValue(value) {
    if (this.codeMirror) this.codeMirror.setValue(value);
    DOM.queryEditor.value = value;
  }
};

// === Utility Helpers ===
const UI = {
  showMessage(text, type, target = DOM.messageBanner) {
    target.className = `mb-4 p-4 rounded-lg flex items-center gap-2 ${
      type === 'error'
        ? 'bg-red-50 text-red-700 border border-red-200'
        : 'bg-green-50 text-green-700 border border-green-200'
    }`;
    target.textContent = text;
    target.classList.remove('hidden');
    setTimeout(() => target.classList.add('hidden'), 5000);
  },

  showLoginMessage(text, type) {
    this.showMessage(text, type, DOM.loginMessage);
  },

  toggleButtonLoading(btn, loadingText, loading) {
    if (!btn) return;
    if (loading) {
      btn.dataset.originalText = btn.innerHTML;
      btn.innerHTML = loadingText;
      btn.disabled = true;
    } else {
      btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
      btn.disabled = false;
    }
  }
};

// === Networking Helper ===
async function apiFetch(path, options = {}) {
  try {
    const response = await fetch(`${API_URL}/${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    return await response.json();
  } catch (err) {
    throw new Error(err.message || 'Network error');
  }
}

// === Connection Management ===
const ConnectionManager = {
  showConnected(username) {
    state.connected = true;
    state.credentials = { username };
    DOM.password.value = '';
    DOM.loginScreen.classList.add('hidden');
    DOM.mainInterface.classList.remove('hidden');
    QueryEditor.codeMirror?.refresh();
    DOM.connectionInfo.textContent = `${username}@postgres/${username}`;
  },

  async restore() {
    let saved;
    try { saved = sessionStorage.getItem(SESSION_STORAGE_KEY); } catch { return; }
    if (!saved) return;
    UI.toggleButtonLoading(DOM.connectBtn, 'Connecting...', true);
    try {
      const data = await apiFetch(`session/${encodeURIComponent(saved)}`);
      if (!data.success) {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        return;
      }
      sessionId = saved;
      this.showConnected(data.username);
      await SchemaManager.loadSchemas();
    } catch (err) {
      UI.showLoginMessage('Could not restore connection: ' + err.message, 'error');
    } finally {
      UI.toggleButtonLoading(DOM.connectBtn, 'Connect', false);
    }
  },

  async connect() {
    const username = DOM.username.value.trim();
    const password = DOM.password.value;

    if (!username || !password)
      return UI.showLoginMessage('Please fill in username and password', 'error');

    UI.toggleButtonLoading(DOM.connectBtn, 'Connecting...', true);

    try {
      const data = await apiFetch('connect', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });

      if (!data.success)
        return UI.showLoginMessage(data.error || 'Connection failed', 'error');

      sessionId = data.sessionId;
      try { sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId); } catch {}
      this.showConnected(username);

      await SchemaManager.loadSchemas();
      UI.showMessage('Connected successfully!', 'success');
    } catch (err) {
      UI.showLoginMessage('Connection failed: ' + err.message, 'error');
    } finally {
      UI.toggleButtonLoading(DOM.connectBtn, 'Connect', false);
    }
  },

  async disconnect() {
    if (sessionId) {
      try {
        await apiFetch('disconnect', {
          method: 'POST',
          body: JSON.stringify({ sessionId })
        });
      } catch (err) {
        console.error('Disconnect error:', err);
      }
    }

    sessionId = null;
    try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
    Object.assign(state, { connected: false, credentials: {}, schemas: [], tables: [], selectedSchema: 'public' });
    ResultsView.set(false);
    DOM.statementResults.replaceChildren();
    DOM.currentSchema.textContent = 'public';

    DOM.mainInterface.classList.add('hidden');
    DOM.loginScreen.classList.remove('hidden');
    DOM.resultsContainer.classList.add('hidden');
    QueryEditor.setValue('');
    QueryEditor.codeMirror?.clearHistory();
    DOM.password.value = '';
  }
};

// === Schema Management ===
const SchemaManager = {
  async loadSchemas() {
    const requestedSession = sessionId;
    try {
      const data = await apiFetch(`schemas/${requestedSession}`);
      if (requestedSession !== sessionId) return;
      if (!data.success) throw new Error(data.error);

      state.schemas = data.schemas;
      if (!state.schemas.includes(state.selectedSchema)) {
        state.selectedSchema = state.schemas.includes('public') ? 'public' : state.schemas[0] || 'public';
        DOM.currentSchema.textContent = state.selectedSchema;
      }
      this.renderSchemas();
      await TableManager.loadTables();
    } catch (err) {
      UI.showMessage('Failed to load schemas: ' + err.message, 'error');
    }
  },

  async createSchema() {
    const name = DOM.newSchemaName.value.trim();
    if (!name) return UI.showMessage('Schema name cannot be empty', 'error');

    try {
      const data = await apiFetch(`schemas/${sessionId}`, {
        method: 'POST',
        body: JSON.stringify({ schemaName: name })
      });
      if (!data.success) throw new Error(data.error);

      DOM.newSchemaName.value = '';
      await this.loadSchemas();
      this.selectSchema(name);
      UI.showMessage(data.message, 'success');
    } catch (err) {
      UI.showMessage('Failed to create schema: ' + err.message, 'error');
    }
  },

  async deleteSchema(schema) {
    if (!confirm(`Delete schema "${schema}"? This cannot be undone.`)) return;
    try {
      const data = await apiFetch(`schemas/${sessionId}/${encodeURIComponent(schema)}`, { method: 'DELETE' });
      if (!data.success) throw new Error(data.error);

      await this.loadSchemas();
      if (state.selectedSchema === schema) this.selectSchema('public');
      UI.showMessage(data.message, 'success');
    } catch (err) {
      UI.showMessage('Failed to delete schema: ' + err.message, 'error');
    }
  },

  renderSchemas() {
    const items = state.schemas.map(schema => {
      const item = document.createElement('div');
      item.className = `schema-item flex items-center justify-between p-2 rounded-md cursor-pointer transition ${
        state.selectedSchema === schema
          ? 'bg-indigo-50 border-2 border-indigo-500'
          : 'bg-gray-50 hover:bg-gray-100 border-2 border-transparent'
      }`;
      const select = document.createElement('button');
      select.className = 'text-sm font-medium text-left flex-1';
      select.textContent = schema;
      select.addEventListener('click', () => this.selectSchema(schema));
      item.append(select);
      if (!['public', 'pg_catalog', 'information_schema'].includes(schema)) {
        const remove = document.createElement('button');
        remove.className = 'p-1 text-red-600 hover:bg-red-50 rounded text-xl leading-none';
        remove.title = 'Delete schema';
        remove.textContent = '×';
        remove.addEventListener('click', () => this.deleteSchema(schema));
        item.append(remove);
      }
      return item;
    });
    DOM.schemaList.replaceChildren(...items);
  },

  selectSchema(schema) {
    state.selectedSchema = schema;
    DOM.currentSchema.textContent = schema;
    this.renderSchemas();
    TableManager.loadTables();
  }
};

// === Table Management ===
const TableManager = {
  async loadTables() {
    const requestedSession = sessionId;
    const requestedSchema = state.selectedSchema;
    try {
      const data = await apiFetch(`tables/${requestedSession}/${encodeURIComponent(requestedSchema)}`);
      if (requestedSession !== sessionId || requestedSchema !== state.selectedSchema) return;
      if (!data.success) throw new Error(data.error);

      state.tables = data.tables;
      this.renderTables();
    } catch (err) {
      UI.showMessage('Failed to load tables: ' + err.message, 'error');
    }
  },

  renderTables() {
    if (!state.tables.length) {
      DOM.tablesList.innerHTML = '<p class="text-sm text-gray-500 text-center py-4">No tables</p>';
      return;
    }
    DOM.tablesList.replaceChildren(...state.tables.map(table => {
      const button = document.createElement('button');
      button.className = 'w-full text-left text-xs px-3 py-2 bg-gray-50 hover:bg-indigo-50 rounded-md transition flex items-center justify-between';
      const name = document.createElement('span');
      name.className = 'font-medium text-gray-700';
      name.textContent = table.table_name;
      const count = document.createElement('span');
      count.className = 'text-gray-400 text-xs';
      count.textContent = `${table.column_count} cols`;
      button.append(name, count);
      button.addEventListener('click', () => this.selectTable(table.table_name));
      return button;
    }));
  },

  async selectTable(name) {
    const quote = identifier => '"' + identifier.replace(/"/g, '""') + '"';
    const query = `SELECT * FROM ${quote(state.selectedSchema)}.${quote(name)} LIMIT 100;`;
    await QueryManager.executeDirect(query);
  }
};

// === Query Management ===
const QueryManager = {
  async execute() {
    const query = QueryEditor.getValue();
    if (!query.trim()) return UI.showMessage('Query cannot be empty', 'error');
    await this._execute(query);
  },

  async executeDirect(query) {
    await this._execute(query, true);
  },

  async _execute(query, silent = false) {
    if (DOM.executeBtn.disabled) return;
    const requestedSession = sessionId;
    UI.toggleButtonLoading(DOM.executeBtn, 'Executing...', true);

    try {
      const data = await apiFetch(`query/${requestedSession}`, {
        method: 'POST',
        body: JSON.stringify({ query, schema: state.selectedSchema })
      });
      if (requestedSession !== sessionId) return;

      // Assume server returns structured JSON; if success=false, render server-provided error fields
      if (!data.success) {
        // Consolidate error display into the top banner. Include message, detail and hint (but hide code/position).
        const pieces = [];
        pieces.push(data.message || data.error || 'Query failed');
        if (data.detail) pieces.push(data.detail);
        if (data.hint) pieces.push('Hint: ' + data.hint);
        if (data.timeout) pieces.push('(timeout)');

        UI.showMessage('Query error: ' + pieces.join(' — '), 'error');
        // Hide results panel; do not duplicate details there
        ResultsView.set(false);
        DOM.resultsContainer.classList.add('hidden');
        // If a position was provided, still move the caret silently
        if (!silent && QueryEditor.getValue() === query) renderQueryErrorDetails(data);
        return;
      }

      this.displayResults(data);
      await SchemaManager.loadSchemas();
    } catch (err) {
      // Network or unexpected error
      console.error('Query request failed:', err);
      UI.showMessage('Query error: ' + (err.message || String(err)), 'error');
      ResultsView.set(false);
      DOM.resultsContainer.classList.add('hidden');
    } finally {
      UI.toggleButtonLoading(DOM.executeBtn, 'Execute', false);
    }
  },

  displayResults(data) {
    const results = data.results || [];
    DOM.statementResults.replaceChildren(...results.map((result, statementIndex) => {
      const section = document.createElement('section');
      section.className = 'mb-6';
      const summary = document.createElement('p');
      summary.className = 'font-medium text-gray-700 mb-2';
      summary.textContent = `${statementIndex + 1}. ${result.command || 'Statement'} — ${result.rowCount ?? 0} ${result.columns.length ? 'rows' : 'rows affected'}`;
      section.append(summary);
      if (result.truncated) {
        const notice = document.createElement('p');
        notice.className = 'text-sm text-yellow-700 mb-2';
        notice.textContent = `Showing ${result.rows.length} of ${result.rowCount} rows (display limit reached).`;
        section.append(notice);
      }
      if (!result.columns.length) return section;
      const table = document.createElement('table');
      table.className = 'w-full text-sm';
      const head = document.createElement('thead');
      const headings = document.createElement('tr');
      headings.className = 'bg-gray-50 border-b';
      result.columns.forEach(column => {
        const cell = document.createElement('th');
        cell.className = 'px-4 py-3 text-left font-semibold text-gray-700';
        cell.title = column.type || String(column.dataTypeID || '');
        cell.textContent = column.name;
        headings.append(cell);
      });
      head.append(headings);
      const body = document.createElement('tbody');
      result.rows.forEach(row => {
        const tr = document.createElement('tr');
        tr.className = 'border-b hover:bg-gray-50';
        result.columns.forEach((column, index) => {
          const cell = document.createElement('td');
          cell.className = 'px-4 py-3 text-gray-600';
          const value = row[index];
          cell.textContent = value == null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
          if (value == null) cell.classList.add('italic', 'text-gray-400');
          tr.append(cell);
        });
        body.append(tr);
      });
      if (!result.rows.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = result.columns.length;
        cell.className = 'px-4 py-3 text-gray-500 italic';
        cell.textContent = 'No rows';
        row.append(cell);
        body.append(row);
      }
      table.append(head, body);
      section.append(table);
      return section;
    }));
    const transaction = data.transactionStatus === 'T' ? ' • transaction open' : '';
    DOM.resultsInfo.textContent = `${results.length} statement(s) • ${data.executionTime}${transaction}`;
    DOM.resultsContainer.classList.remove('hidden');
  }
};

// Render structured query error details returned by the server
function renderQueryErrorDetails(err) {
  // Errors are now shown in the top banner; keep this helper minimal: silently move caret if position provided.
  if (err && err.position && DOM.queryEditor) {
    const posNum = parseInt(err.position, 10);
    if (!Number.isNaN(posNum) && posNum > 0) setQueryEditorCaret(posNum - 1);
  }
}

// PostgreSQL positions count characters; editor offsets count UTF-16 code units.
function setQueryEditorCaret(index) {
  try {
    const el = DOM.queryEditor;
    if (!el) return;
    const text = QueryEditor.getValue();
    const idx = Array.from(text).slice(0, Math.max(0, index)).join('').length;
    const editor = QueryEditor.codeMirror;
    if (editor) {
      const position = editor.posFromIndex(idx);
      editor.setCursor(position);
      editor.scrollIntoView(position);
      editor.focus();
      return;
    }
    el.focus();
    // For modern browsers, set selection range
    if (typeof el.setSelectionRange === 'function') {
      el.setSelectionRange(idx, idx);
    } else {
      // Fallback: place cursor at end
      el.value = text;
    }
  } catch (e) {
    console.error('Failed to set query editor caret:', e);
  }
}

// === Results Maximize Handling ===
const ResultsView = {
  toggle() {
    const container = DOM.resultsContainer;
    if (!container) return;
    this.set(!container.classList.contains('results-maximized'));
  },

  set(maximize) {
    const container = DOM.resultsContainer;
    const btn = DOM.toggleBtn;
    const icon = DOM.maximizeIcon;
    if (!container || !btn || !icon) return;

    if (maximize) {
      container.classList.add('results-maximized');
      document.body.classList.add('no-scroll');

      const rect = DOM.topbar?.getBoundingClientRect();
      const topPx = rect ? Math.ceil(rect.bottom) + 8 : 16;
      Object.assign(container.style, {
        top: `${topPx}px`,
        left: '1rem',
        right: '1rem',
        bottom: '1rem'
      });

      btn.setAttribute('title', 'Unmaximize results');
      btn.setAttribute('aria-pressed', 'true');
      icon.classList.replace('fa-expand', 'fa-compress');
    } else {
      container.classList.remove('results-maximized');
      document.body.classList.remove('no-scroll');
      btn.setAttribute('title', 'Maximize results');
      btn.setAttribute('aria-pressed', 'false');
      icon.classList.replace('fa-compress', 'fa-expand');
      Object.assign(container.style, { top: '', left: '', right: '', bottom: '' });
    }
  }
};

DOM.newSchemaName?.addEventListener('keypress', e => e.key === 'Enter' && SchemaManager.createSchema());
DOM.username?.addEventListener('keypress', e => e.key === 'Enter' && ConnectionManager.connect());
DOM.password?.addEventListener('keypress', e => e.key === 'Enter' && ConnectionManager.connect());
DOM.toggleBtn?.addEventListener('click', () => ResultsView.toggle());

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && DOM.resultsContainer.classList.contains('results-maximized')) {
    ResultsView.set(false);
  }
});

DOM.connectBtn?.addEventListener("click", () => ConnectionManager.connect());
DOM.disconnectBtn?.addEventListener("click", () => ConnectionManager.disconnect());
DOM.createSchemaBtn?.addEventListener("click", () => SchemaManager.createSchema());
DOM.refreshTablesBtn?.addEventListener("click", () => TableManager.loadTables());
DOM.executeBtn?.addEventListener("click", () => QueryManager.execute());
DOM.clearQueryBtn?.addEventListener("click", () => QueryEditor.setValue(''));

DOM.queryEditor?.addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "Enter") QueryManager.execute();});
ConnectionManager.restore();
