const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const scripts = process.env.SCRIPT_DIR || path.join(__dirname, '../../scripts');
function runScript(t, name, args, env = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keria-scripts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, 'calls.jsonl');
  fs.writeFileSync(path.join(directory, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
const log = process.env.CALLS;
const count = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').length : 0;
fs.appendFileSync(log, JSON.stringify({args, stdin}) + '\\n');
if (Number(process.env.FAIL_AT) === count + 1) process.exit(1);
if (args.some(arg => arg.includes('SELECT CASE WHEN'))) console.log(process.env.ROLE_STATE || '');
if (args.some(arg => arg.includes('SELECT pg_get_userbyid'))) console.log(process.env.DB_OWNER || '');
`, { mode: 0o755 });
  const result = spawnSync('bash', [path.join(scripts, name), ...args], {
    encoding: 'utf8', input: '',
    env: { ...process.env, ...env, PATH: `${directory}:${process.env.PATH}`, CALLS: log }
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { ...result, calls };
}

test('SQL access validates first and invokes docker exactly once', t => {
  const result = runScript(t, 'sql-student.sh', ['alice']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0].args.slice(-4), ['-U', 'alice', '-d', 'alice']);
});

test('missing and reserved student names never invoke docker', t => {
  for (const args of [[], ['postgres'], ['template1'], ['pg_admin'], ['bad-name'], ['a'.repeat(64)]]) {
    const result = runScript(t, 'delete-student.sh', args);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 0);
  }
});

test('creation passes special passwords through psql variables', t => {
  const password = " quotes' \\ dollar$ and spaces ";
  const result = runScript(t, 'create-student.sh', ['alice', password]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 3);
  assert(result.calls[2].args.includes(`--set=password=${password}`));
  assert(result.calls[2].args.includes('ON_ERROR_STOP=1'));
  assert(result.calls[2].stdin.includes(":'password'"));
});

test('database read and write failures stop account creation', t => {
  for (const failure of [1, 2, 3]) {
    const result = runScript(t, 'create-student.sh', ['alice', 'password'], { FAIL_AT: String(failure) });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, failure);
  }
});

test('privileged roles and databases belonging to others are left alone', t => {
  for (const env of [{ ROLE_STATE: 'privileged' }, { DB_OWNER: 'someone_else' }]) {
    const result = runScript(t, 'delete-student.sh', ['alice'], env);
    assert.notEqual(result.status, 0);
    assert(!result.calls.some(call => call.stdin.includes('DROP')));
  }
});
