// backend/server.js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const { countStatements, isValidIdentifier, quoteIdentifier } = require('./sql');
const { runQuery, waitAfterError } = require('./query');
const app = express();

app.use(express.json({ limit: '256kb' }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Store active connections per session
// connections: Map<sessionId, { pool, username, createdAt, expiresAt }>
const connections = new Map();
const closingPools = new Set();
const pendingLogins = new Map();

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

const MAX_SESSIONS = positiveInteger('MAX_SESSIONS', 40);
const MAX_SESSIONS_PER_USER = positiveInteger('MAX_SESSIONS_PER_USER', 2);
const MAX_SQL_BYTES = positiveInteger('MAX_SQL_BYTES', 65536);
const MAX_STATEMENTS = positiveInteger('MAX_STATEMENTS', 100);
const QUERY_LIMITS = {
  rows: positiveInteger('MAX_RESULT_ROWS', 1000),
  bytes: positiveInteger('MAX_RESULT_BYTES', 1048576),
  timeout: positiveInteger('QUERY_TIMEOUT_MS', 10000)
};

function closePool(pool) {
  const closing = (async () => {
    try {
      await pool.end();
    } catch (error) {
      console.error('Error closing pool:', error);
    }
  })();
  closingPools.add(closing);
  closing.then(() => closingPools.delete(closing));
  return closing;
}

function closeSession(sessionId) {
  const session = connections.get(sessionId);
  if (!session) return Promise.resolve();

  // Remove it before awaiting cleanup so it cannot be used or closed twice.
  connections.delete(sessionId);
  return closePool(session.pool);
}

async function sessionQuery(session, text, values) {
  const client = await session.pool.connect();
  try {
    return await client.query(text, values);
  } catch (error) {
    await waitAfterError(client);
    throw error;
  } finally {
    // pool.query destroys clients on SQL errors, which would lose transactions.
    client.release();
  }
}

// Session lifetime (ms)
const SESSION_TTL = 1000 * 60 * 60 * 12; // 12 hours
// Abandoned tabs must not hold a student's quota slots for the whole lifetime.
const SESSION_IDLE_TTL = 1000 * 60 * 30; // 30 minutes

function isExpired(session, now = Date.now()) {
  return session.expiresAt < now || session.lastActiveAt + SESSION_IDLE_TTL < now;
}

function sweepExpired() {
  const now = Date.now();
  return Promise.all([...connections]
    .filter(([, session]) => isExpired(session, now))
    .map(([id]) => closeSession(id)));
}

function getSession(req, res, allowBusy = false) {
  const session = connections.get(req.params.sessionId);
  if (!session || isExpired(session)) {
    if (session) void closeSession(req.params.sessionId);
    res.status(401).json({ success: false, error: 'Session expired. Please reconnect.' });
    return null;
  }
  session.lastActiveAt = Date.now();
  if (session.busy && !allowBusy) {
    res.status(409).json({ success: false, error: 'A query is already running. Please wait.' });
    return null;
  }
  return session;
}

const TYPE_FRIENDLY = {
  int2: 'smallint',
  int4: 'integer',
  int8: 'bigint',
  float4: 'real',
  float8: 'double precision',
  numeric: 'numeric',
  varchar: 'character varying',
  bpchar: 'character',
  text: 'text',
  bool: 'boolean',
  timestamp: 'timestamp without time zone',
  timestamptz: 'timestamp with time zone',
  date: 'date',
  time: 'time without time zone',
  timetz: 'time with time zone',
  bytea: 'bytea',
  json: 'json',
  jsonb: 'jsonb',
  uuid: 'uuid',
  inet: 'inet',
  cidr: 'cidr',
  macaddr: 'macaddr',
  bit: 'bit',
  varbit: 'bit varying',
  oid: 'oid',
  interval: 'interval'
};

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Connect endpoint
app.post('/api/connect', async (req, res) => {
  const { username, password } = req.body || {};
  
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ 
      success: false, 
      error: 'Username and password are required' 
    });
  }
  
  // Free quota held by expired sessions without waiting for the sweeper.
  void sweepExpired();
  const pendingCount = [...pendingLogins.values()].reduce((sum, count) => sum + count, 0);
  const userCount = [...connections.values()].filter(session => session.username === username).length;
  if (connections.size + closingPools.size + pendingCount >= MAX_SESSIONS ||
      userCount + (pendingLogins.get(username) || 0) >= MAX_SESSIONS_PER_USER) {
    return res.status(429).json({ success: false, error: 'Connection limit reached. Disconnect an unused session and try again.' });
  }
  pendingLogins.set(username, (pendingLogins.get(username) || 0) + 1);
  const sessionId = crypto.randomBytes(32).toString('hex');
  let pool;
  try {
    const config = {
      host: process.env.PGHOST || 'postgres',
      port: positiveInteger('PGPORT', 5432),
      database: username,
      user: username,
      password,
      // Keep one physical connection so transactions and session settings persist.
      max: 1,
      idleTimeoutMillis: 0,
      connectionTimeoutMillis: 5000,
      statement_timeout: QUERY_LIMITS.timeout,
      idle_in_transaction_session_timeout: 120000,
      application_name: 'kueria'
    };
    pool = new Pool(config);
    pool.on('error', (error) => {
      console.error('Idle database connection error:', error);
      void closeSession(sessionId);
    });
    pool.on('connect', client => {
      client.on('error', error => {
        console.error('Database connection error:', error);
        void closeSession(sessionId);
      });
      client.on('end', () => { void closeSession(sessionId); });
    });

    // Test connection; the admin role must never get a web SQL console.
    const client = await pool.connect();
    try {
      const result = await client.query("SELECT current_setting('is_superuser') = 'on' AS superuser");
      if (result.rows[0]?.superuser) throw new Error(`Refused superuser login for ${username}`);
    } finally {
      client.release();
    }

    // Generate session ID
    const now = Date.now();
    connections.set(sessionId, { pool, config, username, busy: false, createdAt: now, lastActiveAt: now, expiresAt: now + SESSION_TTL });

    res.json({ 
      success: true, 
      sessionId,
      message: 'Connected successfully' 
    });
  } catch (error) {
    console.error('Connection error:', error);
    if (pool) await closePool(pool);
    res.status(400).json({ success: false, error: 'Connection failed' });
  } finally {
    const remaining = pendingLogins.get(username) - 1;
    if (remaining) pendingLogins.set(username, remaining);
    else pendingLogins.delete(username);
  }
});

// Disconnect endpoint
app.post('/api/disconnect', async (req, res) => {
  const { sessionId } = req.body || {};
  await closeSession(sessionId);

  res.json({ success: true });
});

// Let a reloaded tab reuse its connection instead of consuming another slot.
app.get('/api/session/:sessionId', (req, res) => {
  const session = getSession(req, res, true);
  if (session) res.json({ success: true, username: session.username });
});

// Get schemas
app.get('/api/schemas/:sessionId', async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  try {
    const result = await sessionQuery(session, `
      SELECT schema_name 
      FROM information_schema.schemata 
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY schema_name
    `);
    
    res.json({ success: true, schemas: result.rows.map(r => r.schema_name) });
  } catch (error) {
    console.error('Get schemas error:', error);
    res.status(400).json({ success: false, error: 'Failed to fetch schemas' });
  }
});

// Get tables for a schema
app.get('/api/tables/:sessionId/:schemaName', async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const { schemaName } = req.params;

  if (!isValidIdentifier(schemaName)) {
    return res.status(400).json({ success: false, error: 'Invalid schema name' });
  }

  try {
    const result = await sessionQuery(session, `
      SELECT 
        table_name,
        (SELECT COUNT(*) 
         FROM information_schema.columns 
         WHERE table_schema = $1 AND table_name = t.table_name) as column_count
      FROM information_schema.tables t
      WHERE table_schema = $1 
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `, [schemaName]);
    
    res.json({ success: true, tables: result.rows });
  } catch (error) {
    console.error('Get tables error:', error);
    res.status(400).json({ success: false, error: 'Failed to fetch tables' });
  }
});

// Create schema
app.post('/api/schemas/:sessionId', async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const { schemaName } = req.body || {};

  try {
    // Quote valid PostgreSQL identifiers, including spaces and mixed case.
    if (!isValidIdentifier(schemaName)) {
      return res.status(400).json({ success: false, error: 'Invalid schema name. Use 1–63 bytes without null characters.' });
    }

    await sessionQuery(session, `CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    
    res.json({ success: true, message: `Schema "${schemaName}" created` });
  } catch (error) {
    console.error('Create schema error:', error);
    res.status(400).json({ success: false, error: 'Failed to create schema' });
  }
});

// Delete schema
app.delete('/api/schemas/:sessionId/:schemaName', async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const { schemaName } = req.params;

  try {
    // Prevent deleting system schemas
    if (['public', 'pg_catalog', 'information_schema', 'pg_toast'].includes(schemaName)) {
      return res.status(400).json({ success: false, error: 'Cannot delete system schema' });
    }

    if (!isValidIdentifier(schemaName)) {
      return res.status(400).json({ success: false, error: 'Invalid schema name' });
    }

    await sessionQuery(session, `DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`);
    
    res.json({ success: true, message: `Schema "${schemaName}" deleted` });
  } catch (error) {
    console.error('Delete schema error:', error);
    res.status(400).json({ success: false, error: 'Failed to delete schema' });
  }
});

// Execute a script on the session's single persistent connection.
app.post('/api/query/:sessionId', async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const { query, schema } = req.body || {};
  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ success: false, error: 'Query cannot be empty' });
  }
  if (Buffer.byteLength(query) > MAX_SQL_BYTES || countStatements(query) > MAX_STATEMENTS) {
    return res.status(413).json({ success: false, error: `Use at most ${MAX_SQL_BYTES} bytes and ${MAX_STATEMENTS} statements per script.` });
  }
  if (schema !== undefined && !isValidIdentifier(schema)) {
    return res.status(400).json({ success: false, error: 'Invalid schema name' });
  }

  session.busy = true;
  const startTime = Date.now();
  let client;
  try {
    client = await session.pool.connect();
    // An aborted transaction must be allowed to reach ROLLBACK without a SET first.
    if (schema && client.getTransactionStatus() !== 'E') {
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
    }
    const rawResults = await runQuery(client, session.config, query, QUERY_LIMITS);
    const oids = [...new Set(rawResults.flatMap(result => (result.fields || []).map(field => field.dataTypeID)))];
    const types = new Map();
    if (oids.length) {
      const result = await client.query('SELECT oid, typname FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])', [oids]);
      for (const type of result.rows) types.set(Number(type.oid), TYPE_FRIENDLY[type.typname] || type.typname);
    }
    const results = rawResults.map(result => ({
      columns: (result.fields || []).map(field => ({
        name: field.name, dataTypeID: field.dataTypeID, type: types.get(field.dataTypeID) || null
      })),
      rows: result.rows,
      rowCount: result.rowCount,
      command: result.command,
      truncated: result.truncated
    }));
    // Include metadata in the response limit, even for scripts with no data rows.
    if (Buffer.byteLength(JSON.stringify(results)) > QUERY_LIMITS.bytes + 65536) {
      return res.status(413).json({ success: false, error: 'Result metadata is too large. Select fewer columns or statements.' });
    }
    res.json({
      success: true, results,
      executionTime: `${Date.now() - startTime}ms`,
      transactionStatus: client.getTransactionStatus()
    });
  } catch (error) {
    console.error('Query error:', error);
    const clientError = {
      success: false,
      error: 'Query failed',
      message: error.message,
      code: error.code,
      detail: error.detail,
      hint: error.hint,
      position: error.position || error.cursorPosition,
      transactionStatus: client?.getTransactionStatus(),
      timeout: error.code === '57014' || /statement timeout/i.test(error.message || '')
    };
    res.status(400).json(clientError);
  } finally {
    if (client) client.release();
    session.busy = false;
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('Request error:', error);
  res.status(error.status || 500).json({
    success: false,
    error: error.status === 413 ? 'Request too large' : error.status === 400 ? 'Invalid JSON request' : 'Internal server error'
  });
});

const server = app.listen(positiveInteger('PORT', 3000), '0.0.0.0', () => {
  console.log(`Server running on port ${server.address().port}`);
});

// Periodic sweeper to close expired sessions
const sessionSweeper = setInterval(sweepExpired, 1000 * 60 * 5); // every 5 minutes

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  clearInterval(sessionSweeper);

  // Leave time for cleanup before Docker's default 10-second stop deadline.
  const deadline = setTimeout(() => {
    console.error('Shutdown timed out');
    process.exit(1);
  }, 8000);
  deadline.unref();

  try {
    // Stop accepting connections and let in-flight requests release their clients.
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    await Promise.all([...connections.keys()].map(closeSession));
    // Include cleanup already started by the expiry sweeper or disconnects.
    await Promise.all([...closingPools]);
    clearTimeout(deadline);
    process.exit(0);
  } catch (error) {
    console.error('Shutdown error:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
