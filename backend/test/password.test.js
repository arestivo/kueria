const assert = require('node:assert/strict');
const { test } = require('node:test');
const { scramVerifier } = require('../password');

test('SCRAM verifiers use fresh salts and the same SASLprep as pg logins', () => {
  assert.match(scramVerifier('secret'), /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
  assert.notEqual(scramVerifier('secret'), scramVerifier('secret'));
  const salt = Buffer.alloc(16, 7);
  // Ligature (NFKC), non-ASCII space, and soft hyphen (mapped to nothing).
  assert.equal(scramVerifier('ﬁne pass­word', salt), scramVerifier('fine password', salt));
  assert.notEqual(scramVerifier('fine password', salt), scramVerifier('fine passwords', salt));
});
