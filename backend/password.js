const crypto = require('crypto');

const MIN_PASSWORD_LENGTH = 8;

// The SASLprep steps pg applies before a SCRAM login (pg/lib/crypto/sasl.js),
// so the stored verifier matches what the web app computes when connecting.
function saslprep(password) {
  return password
    .replace(/[   -​  　]/g, ' ')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[­͏᠆᠋-᠍‌‍⁠︀-️﻿]/g, '')
    .normalize('NFKC');
}

// Hash like psql's \password: PostgreSQL stores the verifier as is, so the
// plaintext never appears in a statement that could reach the server log.
function scramVerifier(password, salt = crypto.randomBytes(16), iterations = 4096) {
  const salted = crypto.pbkdf2Sync(saslprep(password), salt, iterations, 32, 'sha256');
  const hmac = text => crypto.createHmac('sha256', salted).update(text).digest();
  const storedKey = crypto.createHash('sha256').update(hmac('Client Key')).digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$` +
    `${storedKey.toString('base64')}:${hmac('Server Key').toString('base64')}`;
}

module.exports = { MIN_PASSWORD_LENGTH, scramVerifier };
