const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Exercise the actual route and signal handlers without a database or listener.
function createServer({ loginFailure, closeWait, connectWait, superuser, env = {} } = {}) {
  const routes = new Map(), signals = new Map(), pools = [], clients = [], exits = [], timers = [];
  const errors = [];
  let now = Date.now(), sweep, intervalCleared = false, httpCloseCount = 0;
  class Pool extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.clients = [];
      this.endCount = 0;
      this.connectError = loginFailure === 'connect';
      this.queryError = loginFailure === 'setup';
      pools.push(this);
    }
    async connect() {
      if (connectWait) await connectWait;
      if (this.connectError) throw new Error('Connection failed');
      const client = Object.assign(new EventEmitter(), {
        getTransactionStatus() { return 'I'; },
        releases: 0,
        release() { this.releases++; },
        query: async () => {
          if (this.queryError) throw new Error('Query failed');
          return { fields: [], rows: superuser ? [{ superuser: true }] : [], rowCount: 0, command: 'SELECT' };
        }
      });
      this.clients.push(client);
      this.emit('connect', client);
      return client;
    }
    async end() {
      this.endCount++;
      if (this.endWait) await this.endWait;
      if (this.endError) throw new Error('Pool close failed');
    }
  }
  // Short-lived connections, used to change passwords.
  class Client extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.queries = [];
      clients.push(this);
    }
    async connect() {
      if (this.options.password !== 'password') throw Object.assign(new Error('Authentication failed'), { code: '28P01' });
    }
    async query(text) { this.queries.push(text); }
    escapeLiteral(value) { return `'${value.replace(/'/g, "''")}'`; }
    async end() { this.ended = true; }
  }
  const app = {
    use() {},
    listen() {
      return { close(callback) {
        httpCloseCount++;
        if (closeWait) closeWait.then(() => callback());
        else callback();
      } };
    }
  };
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (route, handler) => routes.set(`${method} ${route}`, handler);
  }
  const express = () => app;
  express.json = express.static = () => () => {};
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(source, {
    __dirname: path.join(__dirname, '..'), Date: Clock, Buffer,
    require(name) {
      if (name === 'express') return express;
      if (name === 'pg') return { Client, Pool };
      if (name === 'dotenv') return { config() {} };
      if (name === './sql') return require('../sql');
      if (name === './password') return require('../password');
      if (name === './query') return {
        runQuery: async (client, config, text) => [await client.query(text)], waitAfterError: async () => {}
      };
      return require(name);
    },
    console: { log() {}, error(...args) { errors.push(args); } },
    process: { env, on(signal, callback) { signals.set(signal, callback); }, exit(code) { exits.push(code); } },
    setInterval(callback) { sweep = callback; return 'sweeper'; },
    clearInterval(id) { assert.equal(id, 'sweeper'); intervalCleared = true; },
    setTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; }
  });
  async function request(route, body = {}, params = {}) {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; }
    };
    await routes.get(route)({ body, params }, response);
    return response;
  }
  return {
    pools, clients, exits, errors, timers, request,
    login: () => request('post /api/connect', { username: 'alice', password: 'password' }),
    signal: name => signals.get(name)(),
    advance(elapsed) { now += elapsed; },
    expire(elapsed = (12 * 60 + 1) * 60 * 1000) { now += elapsed; return sweep(); },
    get intervalCleared() { return intervalCleared; },
    get httpCloseCount() { return httpCloseCount; }
  };
}

for (const failure of ['connect', 'setup']) {
  test(`failed login cleans up after ${failure} failure`, async () => {
    const server = createServer({ loginFailure: failure });
    const response = await server.login();
    assert.equal(response.statusCode, 400);
    assert.equal(server.pools[0].endCount, 1);
    if (failure === 'setup') assert.equal(server.pools[0].clients[0].releases, 1);
  });
}

test('superuser logins are refused and their pool is closed', async () => {
  const server = createServer({ superuser: true });
  const response = await server.login();
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.success, false);
  assert.equal(server.pools[0].clients[0].releases, 1);
  assert.equal(server.pools[0].endCount, 1);
});

test('active sessions last at most twelve hours from login', async () => {
  const server = createServer();
  const { sessionId } = (await server.login()).body;
  const restore = () => server.request('get /api/session/:sessionId', {}, { sessionId });
  for (let step = 0; step < 35; step++) {
    await server.expire(20 * 60 * 1000);
    assert.equal((await restore()).statusCode, 200);
  }
  // 12h05m after login, but only 25 minutes after the last request.
  await server.expire(25 * 60 * 1000);
  assert.equal((await restore()).statusCode, 401);
  assert.equal(server.pools[0].endCount, 1);
});

test('sessions close after thirty idle minutes', async () => {
  const server = createServer();
  const { sessionId } = (await server.login()).body;
  const restore = () => server.request('get /api/session/:sessionId', {}, { sessionId });
  await server.expire(29 * 60 * 1000);
  assert.equal((await restore()).statusCode, 200);
  await server.expire(31 * 60 * 1000);
  assert.equal(server.pools[0].endCount, 1);
  assert.equal((await restore()).statusCode, 401);
});

test('logins reclaim quota from idle sessions before the sweeper runs', async () => {
  const server = createServer();
  await server.login();
  await server.login();
  assert.equal((await server.login()).statusCode, 429);
  server.advance(31 * 60 * 1000);
  assert((await server.login()).body.success);
  assert.deepEqual(server.pools.map(pool => pool.endCount), [1, 1, 0]);
});

test('password changes verify the current password and never send the new one in plaintext', async () => {
  const server = createServer();
  const { sessionId } = (await server.login()).body;
  const change = body => server.request('post /api/password/:sessionId', body, { sessionId });
  assert.equal((await change({ currentPassword: 'password', newPassword: 'short' })).statusCode, 400);
  assert.equal((await change({ currentPassword: 'wrong', newPassword: 'new secret' })).statusCode, 403);
  assert.equal(server.pools[0].options.password, 'password');
  const response = await change({ currentPassword: 'password', newPassword: "new secret'" });
  assert.equal(response.body.success, true);
  const statement = server.clients.at(-1).queries[0];
  assert.match(statement, /^ALTER ROLE CURRENT_USER PASSWORD 'SCRAM-SHA-256\$4096:[^']+'$/);
  assert(!statement.includes('new secret'));
  // Later query cancellations must authenticate with the new password.
  assert.equal(server.pools[0].options.password, "new secret'");
  assert(server.clients.every(client => client.ended));
});

test('successful login releases its client and handles idle pool errors', async () => {
  const server = createServer();
  assert.equal((await server.login()).body.success, true);
  assert.equal(server.pools[0].clients[0].releases, 1);
  assert.equal(server.pools[0].endCount, 0);
  server.pools[0].emit('error', new Error('Database restarted'));
  assert.equal(server.errors.length, 1);
});

test('query connection failures return JSON; acquired clients are always released', async () => {
  const server = createServer();
  const { sessionId } = (await server.login()).body;
  const pool = server.pools[0];
  pool.connectError = true;
  const query = () => server.request('post /api/query/:sessionId', { query: 'SELECT 1' }, { sessionId });
  assert.equal((await query()).statusCode, 400);
  pool.connectError = false;
  pool.queryError = true;
  assert.equal((await query()).statusCode, 400);
  assert.equal(pool.clients.at(-1).releases, 1);
  pool.queryError = false;
  assert.equal((await query()).body.success, true);
  assert.equal(pool.clients.at(-1).releases, 1);
});

test('disconnect invalidates the session immediately and closes it only once', async () => {
  const server = createServer();
  const { sessionId } = (await server.login()).body;
  const closing = deferred();
  server.pools[0].endWait = closing.promise;
  const first = server.request('post /api/disconnect', { sessionId });
  const response = await server.request('get /api/schemas/:sessionId', {}, { sessionId });
  assert.equal(response.statusCode, 401);
  await server.request('post /api/disconnect', { sessionId });
  await server.expire();
  assert.equal(server.pools[0].endCount, 1);
  closing.resolve();
  await first;
});

test('expiry cleans up every expired pool even if one close fails', async () => {
  const server = createServer();
  const { sessionId } = (await server.login()).body;
  await server.login();
  server.pools[0].endError = true;
  await server.expire();
  assert.deepEqual(server.pools.map(pool => pool.endCount), [1, 1]);
  assert.equal((await server.request('get /api/schemas/:sessionId', {}, { sessionId })).statusCode, 401);
  assert.equal(server.errors.length, 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} drains HTTP requests before closing all session pools`, async () => {
    const closing = deferred();
    const server = createServer({ closeWait: closing.promise });
    await server.login();
    await server.login();
    const shutdown = server.signal(signal);
    await server.signal(signal);
    assert.equal(server.httpCloseCount, 1);
    assert(server.intervalCleared);
    assert.deepEqual(server.pools.map(pool => pool.endCount), [0, 0]);
    assert.deepEqual(server.exits, []);
    closing.resolve();
    await shutdown;
    assert.deepEqual(server.pools.map(pool => pool.endCount), [1, 1]);
    assert.deepEqual(server.exits, [0]);
    assert(server.timers[0].cleared);
  });
}

test('shutdown also waits for pool cleanup already started by expiry', async () => {
  const server = createServer();
  await server.login();
  const closing = deferred();
  server.pools[0].endWait = closing.promise;
  const expiry = server.expire();
  const shutdown = server.signal('SIGTERM');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(server.exits, []);
  assert.equal(server.pools[0].endCount, 1);
  closing.resolve();
  await Promise.all([expiry, shutdown]);
  assert.deepEqual(server.exits, [0]);
});

test('shutdown deadline exits with failure if requests cannot finish', async () => {
  const server = createServer({ closeWait: deferred().promise });
  server.signal('SIGTERM');
  assert.equal(server.timers[0].delay, 8000);
  server.timers[0].callback();
  assert.deepEqual(server.exits, [1]);
});

test('sessions retain one connection and enforce both connection quotas', async () => {
  const server = createServer({ env: { MAX_SESSIONS: '1' } });
  const { sessionId } = (await server.login()).body;
  assert.equal(server.pools[0].options.max, 1);
  assert.equal(server.pools[0].options.idleTimeoutMillis, 0);
  assert.equal((await server.request('post /api/connect', { username: 'bob', password: 'pass' })).statusCode, 429);
  await server.request('post /api/disconnect', { sessionId });
  assert((await server.login()).body.success);
});

test('pending logins reserve capacity before connecting', async () => {
  const pending = deferred();
  const server = createServer({ connectWait: pending.promise });
  const first = server.login();
  const second = server.login();
  assert.equal((await server.login()).statusCode, 429);
  pending.resolve();
  assert((await first).body.success);
  assert((await second).body.success);
});
