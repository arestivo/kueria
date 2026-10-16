function quoteIdentifier(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function isValidIdentifier(name) {
  return typeof name === 'string' && name.length > 0 &&
    !name.includes('\0') && Buffer.byteLength(name) <= 63;
}

// Count statements without splitting semicolons inside PostgreSQL literals/comments.
function countStatements(sql) {
  let count = 0, content = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i], next = sql[i + 1];
    if (/\s/.test(ch)) continue;
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      for (i += 2; i < sql.length && depth; i++) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i++; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i++; }
      }
      i--;
      continue;
    }
    if (ch === ';') {
      if (content) count++;
      content = false;
      continue;
    }
    content = true;
    if (ch === "'" || ch === '"') {
      const escaped = ch === "'" && /[eE]/.test(sql[i - 1] || '') &&
        !/[\w$]/.test(sql[i - 2] || '');
      for (i++; i < sql.length; i++) {
        if (escaped && sql[i] === '\\') i++;
        else if (sql[i] === ch) {
          if (sql[i + 1] === ch) i++;
          else break;
        }
      }
    } else if (ch === '$' && !/[\w$]/.test(sql[i - 1] || '')) {
      const tag = sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length - 1;
      }
    }
  }
  return count + Number(content);
}

module.exports = { countStatements, isValidIdentifier, quoteIdentifier };
