const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '../public');
function page(t, withCodeMirror = false) {
  const dom = new JSDOM(fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'), {
    url: 'http://localhost:3000', runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  const context = dom.getInternalVMContext();
  let editor;
  if (withCodeMirror) dom.window.CodeMirror = { fromTextArea(textarea) {
    let value = textarea.value, change;
    editor = {
      history: [], refreshes: 0,
      getValue: () => value,
      setValue(next) { this.history.push(value); value = next; change?.(this); },
      save() { textarea.value = value; },
      on(event, fn) { if (event === 'change') change = fn; },
      setSize() {}, refresh() { this.refreshes++; }, clearHistory() { this.history = []; },
      posFromIndex(index) { const lines = value.slice(0, index).split('\n'); return { line: lines.length - 1, ch: lines.at(-1).length }; },
      setCursor(position) { this.cursor = position; },
      scrollIntoView(position) { this.scrolled = position; },
      focus() { this.focused = true; }
    };
    return editor;
  } };
  dom.window.fetch = async () => ({ json: async () => ({ success: true, schemas: ['public'], tables: [] }) });
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'kueria.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'cm-init.js'), 'utf8'), context);
  // Initialization waits for DOMContentLoaded while jsdom is still parsing.
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return { window: dom.window, document: dom.window.document, run: code => vm.runInContext(code, context), get editor() { return editor; } };
}

test('schema and table identifiers render as text and table previews quote names', async t => {
  const p = page(t);
  p.window.names = ['<img src=x onerror=alert(1)>', `Student's "schema" /`];
  p.run('state.schemas = window.names; SchemaManager.renderSchemas(); state.tables = [{table_name: window.names[0], column_count: 2}]; TableManager.renderTables();');
  assert.equal(p.document.querySelectorAll('img').length, 0);
  assert.equal(p.document.querySelectorAll('[onclick]').length, 0);
  assert(p.document.getElementById('schemaList').textContent.includes(p.window.names[0]));
  p.run('state.selectedSchema = window.names[1]; QueryManager.executeDirect = async query => {window.preview = query;};');
  p.document.querySelector('#tablesList button').click();
  assert.equal(p.window.preview, 'SELECT * FROM "Student\'s ""schema"" /"."<img src=x onerror=alert(1)>" LIMIT 100;');
});

test('multiple results retain duplicate columns and render values/type names safely', t => {
  const p = page(t);
  p.window.result = { executionTime: '1ms', transactionStatus: 'T', results: [
    { command: 'CREATE', columns: [], rows: [], rowCount: null },
    { command: 'SELECT', columns: [
      { name: 'x', type: '" onmouseover="alert(1)' }, { name: 'x', type: 'integer' }
    ], rows: [['<img src=x>', 2]], rowCount: 10, truncated: true }
  ] };
  p.run('QueryManager.displayResults(window.result)');
  assert.equal(p.document.querySelectorAll('#statementResults section').length, 2);
  assert.deepEqual([...p.document.querySelectorAll('td')].map(cell => cell.textContent), ['<img src=x>', '2']);
  assert.equal(p.document.querySelectorAll('img, [onmouseover]').length, 0);
  assert(p.document.getElementById('statementResults').textContent.includes('Showing 1 of 10 rows'));
  assert(p.document.getElementById('resultsInfo').textContent.includes('transaction open'));
});

for (const withCodeMirror of [false, true]) {
  test(`editor clearing and error positioning (${withCodeMirror ? 'CodeMirror' : 'textarea'})`, async t => {
    const p = page(t, withCodeMirror);
    p.document.getElementById('username').value = 'alice';
    p.document.getElementById('password').value = ' leading and trailing ';
    let password;
    p.window.fetch = async (url, options) => {
      if (url.endsWith('/connect')) password = JSON.parse(options.body).password;
      return { json: async () => ({ success: true, sessionId: 'test', schemas: ['public'], tables: [] }) };
    };
    await p.run('ConnectionManager.connect()');
    assert.equal(password, ' leading and trailing ');
    assert.equal(p.window.sessionStorage.getItem('kueria.session'), 'test');
    if (p.editor) assert.equal(p.editor.refreshes, 1);
    const sql = "\n SELECT '😀';\n SELEC 1;";
    p.window.sql = sql;
    p.run('QueryEditor.setValue(window.sql)');
    const index = sql.indexOf('SELEC 1');
    let sent;
    p.window.fetch = async (url, options) => {
      sent = JSON.parse(options.body).query;
      return { json: async () => ({ success: false, message: 'syntax error', position: String(Array.from(sql.slice(0, index)).length + 1) }) };
    };
    await p.run('QueryManager.execute()');
    assert.equal(sent, sql);
    if (p.editor) {
      assert.equal(p.editor.cursor.line, 2);
      assert.equal(p.editor.cursor.ch, 1);
      assert(p.editor.focused);
      assert.equal(p.editor.scrolled, p.editor.cursor);
    } else assert.equal(p.document.getElementById('queryEditor').selectionStart, index);
    p.document.getElementById('clearQueryBtn').click();
    assert.equal(p.run('QueryEditor.getValue()'), '');
    p.run('QueryEditor.setValue(window.sql); ResultsView.set(true)');
    p.window.fetch = async () => ({ json: async () => ({ success: true }) });
    await p.run('ConnectionManager.disconnect()');
    assert.equal(p.window.sessionStorage.getItem('kueria.session'), null);
    assert.equal(p.run('QueryEditor.getValue()'), '');
    assert.equal(p.document.getElementById('queryEditor').value, '');
    assert(!p.document.body.classList.contains('no-scroll'));
    if (p.editor) assert.equal(p.editor.history.length, 0);
  });
}

test('API validation errors remain visible without a PostgreSQL message', async t => {
  const p = page(t);
  p.window.fetch = async () => ({ json: async () => ({ success: false, error: 'Connection limit reached' }) });
  await p.run("QueryManager._execute('SELECT 1')");
  assert(p.document.getElementById('messageBanner').textContent.includes('Connection limit reached'));
});

test('reload restores the saved session without another login', async t => {
  const p = page(t);
  p.window.sessionStorage.setItem('kueria.session', 'saved-session');
  const requests = [];
  p.window.fetch = async url => {
    requests.push(url);
    return { json: async () => ({ success: true, username: 'alice', schemas: ['public'], tables: [] }) };
  };
  await p.run('ConnectionManager.restore()');
  assert(requests.includes('api/session/saved-session'));
  assert(!requests.includes('api/connect'));
  assert.equal(p.run('sessionId'), 'saved-session');
  assert(!p.document.getElementById('mainInterface').classList.contains('hidden'));
});
