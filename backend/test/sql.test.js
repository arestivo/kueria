const { test } = require('node:test');
const assert = require('node:assert/strict');
const { countStatements, isValidIdentifier, quoteIdentifier } = require('../sql');

test('statement count respects quoted strings, identifiers, dollar quotes, and nested comments', () => {
  assert.equal(countStatements('SELECT 1; SELECT 2;'), 2);
  assert.equal(countStatements("SELECT ';', 'it''s;'; SELECT 2"), 2);
  assert.equal(countStatements('SELECT "semi;colon";'), 1);
  assert.equal(countStatements("SELECT E'it\\'s;'; SELECT 2;"), 2);
  assert.equal(countStatements('DO $body$ BEGIN PERFORM 1; PERFORM 2; END $body$; SELECT 2'), 2);
  assert.equal(countStatements('/* first /* nested; */ comment; */ -- ignore;\nSELECT 1;'), 1);
  assert.equal(countStatements(';; -- comment\n/* comment */'), 0);
});

test('database identifiers support quoted names and enforce PostgreSQL byte limits', () => {
  for (const name of ['Mixed Case', 'a/b', "a'b", '<img src=x>', '"quoted"']) {
    assert(isValidIdentifier(name));
  }
  assert.equal(quoteIdentifier('a"b'), '"a""b"');
  for (const name of ['', null, 123, 'a\0b', 'é'.repeat(32)]) assert(!isValidIdentifier(name));
});
