const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { test } = require('node:test');
const { Client } = require('pg');

test('PostgreSQL and HTTP integration', { skip: !process.env.TEST_DATABASE_HOST, timeout: 30000 }, async t => {
  const admin = new Client({
    host: process.env.TEST_DATABASE_HOST, user: 'postgres', database: 'postgres',
    password: process.env.TEST_DATABASE_PASSWORD
  });
  await admin.connect();
  const username = `student_${Date.now()}`;
  const password = " leading space ' slash\\ trailing ";
  const literal = value => "'" + value.replace(/'/g, "''") + "'";
  const identifier = value => '"' + value.replace(/"/g, '""') + '"';
  await admin.query(`CREATE ROLE ${identifier(username)} LOGIN PASSWORD ${literal(password)}`);
  await admin.query(`CREATE DATABASE ${identifier(username)} OWNER ${identifier(username)}`);
  await admin.query(`REVOKE CONNECT ON DATABASE ${identifier(username)} FROM PUBLIC`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PGHOST: process.env.TEST_DATABASE_HOST, PORT: '3000',
      MAX_RESULT_ROWS: '5', MAX_RESULT_BYTES: '1024', MAX_STATEMENTS: '10',
      MAX_SQL_BYTES: '4096', QUERY_TIMEOUT_MS: '400' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const request = async (route, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:3000/api/${route}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { ...await response.json(), status: response.status };
  };
  let sessionId;
  const query = (sql, schema = 'public') => request(`query/${sessionId}`, { query: sql, schema });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await request('health', undefined, 'GET')).status === 200) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(ready, logs);
    const login = await request('connect', { username, password });
    assert.equal(login.success, true, JSON.stringify(login));
    sessionId = login.sessionId;
    const restored = await request(`session/${sessionId}`, undefined, 'GET');
    assert.equal(restored.username, username);

    await t.test('scripts return each result and preserve duplicate column names', async () => {
      const result = await query('SELECT 1 AS x, 2 AS x; SELECT 3 AS y;');
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.results.length, 2);
      assert.deepEqual(result.results[0].rows, [[1, 2]]);
      assert.deepEqual(result.results[1].rows, [[3]]);
      assert.deepEqual(result.results[0].columns.map(c => c.name), ['x', 'x']);
    });

    await t.test('transactions and backend identity survive separate requests', async () => {
      const before = await query('SELECT pg_backend_pid() AS pid');
      assert((await query('CREATE TABLE transaction_test (id integer)')).success);
      assert.equal((await query('BEGIN')).transactionStatus, 'T');
      assert((await query('INSERT INTO transaction_test VALUES (1)')).success);
      assert.equal((await query('SELECT * FROM transaction_test')).results[0].rows.length, 1);
      assert.equal((await query('ROLLBACK')).transactionStatus, 'I');
      assert.equal((await query('SELECT * FROM transaction_test')).results[0].rows.length, 0);
      const after = await query('SELECT pg_backend_pid() AS pid');
      assert.deepEqual(after.results[0].rows, before.results[0].rows);
    });

    await t.test('an aborted transaction can recover with ROLLBACK', async () => {
      await query('BEGIN');
      const failed = await query('SELECT 1 / 0');
      assert.equal(failed.code, '22012');
      assert.equal(failed.transactionStatus, 'E');
      // Browsing an aborted transaction must not destroy its connection.
      assert.equal((await request(`schemas/${sessionId}`, undefined, 'GET')).status, 400);
      const rollback = await query('ROLLBACK');
      assert.equal(rollback.success, true, JSON.stringify(rollback));
      assert.equal(rollback.transactionStatus, 'I');
      assert((await query('SELECT 1')).success);
      await query('BEGIN; SAVEPOINT before_error;');
      await query('SELECT 1 / 0');
      assert.equal((await query('ROLLBACK TO SAVEPOINT before_error')).transactionStatus, 'T');
      assert.equal((await query('COMMIT')).transactionStatus, 'I');
    });

    await t.test('quoted schema and table names work through the API', async () => {
      const schema = `Mixed ' "/<img src=x>`;
      const table = `Student's "table"`;
      assert((await request(`schemas/${sessionId}`, { schemaName: schema })).success);
      assert((await query(`CREATE TABLE ${identifier(table)} (id integer)`, schema)).success);
      const tables = await request(`tables/${sessionId}/${encodeURIComponent(schema)}`, undefined, 'GET');
      assert.equal(tables.tables[0].table_name, table);
      assert((await query(`SELECT * FROM ${identifier(schema)}.${identifier(table)}`, schema)).success);
      assert((await request(`schemas/${sessionId}/${encodeURIComponent(schema)}`, undefined, 'DELETE')).success);
    });

    await t.test('row and byte budgets truncate displayed data', async () => {
      const rows = await query('SELECT generate_series(1, 20)');
      assert.equal(rows.results[0].rows.length, 5);
      assert.equal(rows.results[0].rowCount, 20);
      assert(rows.results[0].truncated);
      const bytes = await query("SELECT repeat('x', 2048)");
      assert.deepEqual(bytes.results[0].rows, []);
      assert(bytes.results[0].truncated);
    });

    await t.test('bad request shapes and oversized scripts return useful errors', async () => {
      assert.equal((await request(`query/${sessionId}`, { query: {} })).status, 400);
      assert.equal((await query('SELECT 1;'.repeat(11))).status, 413);
      assert.equal((await query('SELECT 1 /*' + 'x'.repeat(4096) + '*/')).status, 413);
      assert((await query("SELECT 'pg_catalog CREATE FUNCTION COPY FROM' AS example")).success);
    });

    await t.test('the PostgreSQL administrator cannot log in through the web app', async () => {
      const refused = await request('connect', { username: 'postgres', password: process.env.TEST_DATABASE_PASSWORD });
      assert.equal(refused.success, false);
      assert.equal(refused.error, 'Connection failed');
    });

    await t.test('the deadline cancels queries even after SET statement_timeout = 0', async () => {
      const started = Date.now();
      const result = await query('SET statement_timeout = 0; SELECT pg_sleep(2)');
      assert.equal(result.timeout, true, JSON.stringify(result));
      assert(Date.now() - started < 1800);
      assert((await query('SELECT 1')).success);
    });

    await t.test('concurrent Execute requests cannot interleave', async () => {
      const first = query('SELECT pg_sleep(0.15)');
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal((await query('SELECT 2')).status, 409);
      assert((await first).success);
    });

    await t.test('the per-student session quota is released by Disconnect', async () => {
      const second = await request('connect', { username, password });
      assert(second.success);
      assert.equal((await request('connect', { username, password })).status, 429);
      await request('disconnect', { sessionId: second.sessionId });
      const replacement = await request('connect', { username, password });
      assert(replacement.success);
      await request('disconnect', { sessionId: replacement.sessionId });
    });

    await t.test('dead database connections invalidate the web session', async () => {
      await query('SELECT pg_terminate_backend(pg_backend_pid())');
      assert.equal((await query('SELECT 1')).status, 401);
    });

    const finalLogin = await request('connect', { username, password });
    assert(finalLogin.success);
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, logs);
    const active = await admin.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename = $1 AND application_name = 'kueria'", [username]);
    assert.equal(active.rows[0].count, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    await admin.query(`DROP DATABASE ${identifier(username)} WITH (FORCE)`);
    await admin.query(`DROP ROLE ${identifier(username)}`);
    await admin.end();
  }
});
