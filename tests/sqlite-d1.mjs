// A D1 binding stand-in on node:sqlite for route tests that need real SQL semantics: guarded INSERT … SELECT,
// CAS UPDATEs and batch atomicity. The real migrations are applied, batch() is one transaction like D1, and
// BLOB columns come back as arrays of byte numbers by default — the shape production D1 hands the Worker.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const DEMO_SEED = path.join(ROOT, 'seed', 'demo.sql');
const READS_ROWS = /^\s*(SELECT|WITH|PRAGMA|VALUES)\b/i;

export function createSqliteD1({ blobs = 'array', seed = true } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }
  if (seed) db.exec(readFileSync(DEMO_SEED, 'utf8'));
  const hooks = [];
  const log = { batches: [] };

  const toJs = value => {
    if (!(value instanceof Uint8Array) || blobs === 'uint8array') return value;
    if (blobs === 'arraybuffer') return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    return Array.from(value);
  };
  const toRow = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toJs(value)]));
  const toSql = value => {
    if (value === undefined) throw new TypeError('D1_TYPE_ERROR: Type undefined is not supported');
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return value;
  };
  const execute = (sql, params) => {
    const statement = db.prepare(sql);
    if (READS_ROWS.test(sql) || /\bRETURNING\b/i.test(sql)) {
      const results = statement.all(...params).map(toRow);
      return { success: true, results, meta: { changes: 0, rows_read: results.length } };
    }
    const info = statement.run(...params);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  };

  class PreparedStatement {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...params) { return new PreparedStatement(this.sql, params.map(toSql)); }
    async first(column) {
      const row = execute(this.sql, this.params).results[0] ?? null;
      if (column === undefined) return row;
      return row ? (row[column] ?? null) : null;
    }
    async all() { return execute(this.sql, this.params); }
    async run() { return execute(this.sql, this.params); }
    async raw() { return execute(this.sql, this.params).results.map(row => Object.values(row)); }
  }

  return {
    prepare: sql => new PreparedStatement(sql),
    async exec(sql) { db.exec(sql); return { count: 1, duration: 0 }; },
    async batch(statements) {
      const index = hooks.findIndex(hook => statements.some(statement => hook.pattern.test(statement.sql)));
      if (index !== -1) {
        const [hook] = hooks.splice(index, 1);
        await hook.run(statements);
      }
      log.batches.push(statements.map(statement => statement.sql));
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => execute(statement.sql, statement.params));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    // Runs `run` once, right before the first later batch with a statement matching `pattern` — after the route
    // has done its reads and immediately before its atomic write: the window a concurrent boss edit lands in.
    beforeBatch(pattern, run) { hooks.push({ pattern, run }); },
    pendingHooks: () => hooks.length,
    query: (sql, ...params) => db.prepare(sql).all(...params).map(row => ({ ...row })),
    sqlite: db,
    log,
  };
}
