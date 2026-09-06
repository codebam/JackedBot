// SQL statement splitter for the test harness.
//
// Why this exists: `D1Database.exec()` mishandles this schema's multi-line
// statements, and a naive `sql.split(';')` shreds every trigger body — a
// `BEGIN ... END;` block legitimately contains inner semicolons, and each one must
// stay attached to its `CREATE TRIGGER`.
//
// So: strip comments, split on `;`, and re-join a chunk until the number of BEGIN
// and END keywords balance. Applied with `db.batch()`, i.e. one transaction.

export function splitSqlStatements(sql: string): string[] {
  const cleaned = sql
    .split('\n')
    // Drop trailing `-- ...` comments and whole-line ones. No `--` in this schema
    // appears inside a string literal, so line-scoped stripping is safe.
    .map((line) => line.replace(/\s*--.*$/, ''))
    .filter((line) => line.trim().length > 0)
    .join('\n');

  const statements: string[] = [];
  let buffer = '';

  for (const chunk of cleaned.split(';')) {
    buffer += chunk + ';';
    const upper = buffer.toUpperCase();
    const begins = (upper.match(/\bBEGIN\b/g) ?? []).length;
    const ends = (upper.match(/\bEND\b/g) ?? []).length;
    if (begins === ends) {
      const stmt = buffer.trim();
      if (stmt && stmt !== ';') statements.push(stmt);
      buffer = '';
    }
  }

  const tail = buffer.trim();
  if (tail && tail !== ';') statements.push(tail);
  return statements;
}
