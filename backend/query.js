const { Client, Query } = require('pg');

async function waitAfterError(client) {
  // Errors arrive before ReadyForQuery. An empty query waits for that protocol
  // cycle without changing the transaction, even when it is already aborted.
  try { await client.query(''); } catch {}
}

async function cancelQuery(client, config) {
  const cancellation = new Client({
    ...config, connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 3000
  });
  cancellation.on('error', () => {});
  try {
    await cancellation.connect();
    await cancellation.query('SELECT pg_catalog.pg_cancel_backend($1)', [client.processID]);
  } catch (error) {
    // A failed cancellation must not leave a query running on a reusable session.
    await client.end();
    throw error;
  } finally {
    await cancellation.end();
  }
}

async function runQuery(client, config, text, limits) {
  let rowCount = 0, bytes = 0, timedOut = false, cancellation;
  const collected = new Map(), truncated = new Set();
  const query = new Query({ text, rowMode: 'array' });
  const result = new Promise((resolve, reject) => {
    query.on('row', (row, statement) => {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (rowCount >= limits.rows || bytes + size > limits.bytes) {
        truncated.add(statement);
        return;
      }
      rowCount++;
      bytes += size;
      if (!collected.has(statement)) collected.set(statement, []);
      collected.get(statement).push(row);
    });
    query.once('error', reject);
    query.once('end', resolve);
    client.query(query);
  });
  const deadline = setTimeout(() => {
    timedOut = true;
    // Keep this promise handled even while the original query is still running.
    cancellation = cancelQuery(client, config).catch(error => {
      console.error('Query cancellation failed:', error);
    });
  }, limits.timeout);
  try {
    const raw = await result;
    if (timedOut) throw Object.assign(new Error('Query exceeded the time limit'), { code: '57014' });
    return (Array.isArray(raw) ? raw : [raw]).map(statement => ({
      ...statement,
      rows: collected.get(statement) || [],
      truncated: truncated.has(statement)
    }));
  } catch (error) {
    clearTimeout(deadline);
    if (cancellation) await cancellation;
    await waitAfterError(client);
    throw error;
  } finally {
    clearTimeout(deadline);
    // Prevent a late cancellation from affecting the next Execute request.
    if (cancellation) await cancellation;
  }
}

module.exports = { runQuery, waitAfterError };
