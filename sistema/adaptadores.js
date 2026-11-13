'use strict';
/* Dois jeitos de guardar os dados, com a mesma interface:
   - SQLite: arquivo no computador do caixa (funciona sem internet)
   - Postgres: banco na nuvem (Neon), usado na Vercel
   As consultas usam "?" como marcador; no Postgres viram $1, $2... */
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

function adaptadorSqlite(arquivo) {
  const { DatabaseSync } = require('node:sqlite');
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  /* uma conexão só: transações e leituras passam por uma fila para não se misturarem */
  const emTx = new AsyncLocalStorage();
  let fila = Promise.resolve();
  const naFila = fn => { const vez = fila.then(fn); fila = vez.catch(() => {}); return vez; };
  const roda = fn => emTx.getStore() ? fn() : naFila(fn);
  return {
    tipo: 'sqlite',
    tipos: { id: 'INTEGER PRIMARY KEY', big: 'INTEGER' },
    todos: (sql, p = []) => roda(async () => db.prepare(sql).all(...p)),
    um: (sql, p = []) => roda(async () => db.prepare(sql).get(...p)),
    rodar: (sql, p = []) => roda(async () => ({ changes: Number(db.prepare(sql).run(...p).changes) })),
    exec: sql => roda(async () => db.exec(sql)),
    transacao: fn => naFila(() => emTx.run(true, async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const r = await fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    })),
    fechar: async () => db.close(),
  };
}

function adaptadorPostgres(url) {
  const pg = require('pg');
  pg.types.setTypeParser(20, v => Number(v));    // bigint (datas em ms, contagens)
  pg.types.setTypeParser(1700, v => Number(v));  // numeric (somas)
  const pool = new pg.Pool({ connectionString: url, max: 4, idleTimeoutMillis: 10_000 });
  const tx = new AsyncLocalStorage();
  const conv = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
  const q = (sql, p) => (tx.getStore() || pool).query(conv(sql), p);
  return {
    tipo: 'postgres',
    tipos: { id: 'BIGSERIAL PRIMARY KEY', big: 'BIGINT' },
    todos: async (sql, p = []) => (await q(sql, p)).rows,
    um: async (sql, p = []) => (await q(sql, p)).rows[0],
    rodar: async (sql, p = []) => ({ changes: (await q(sql, p)).rowCount }),
    exec: async sql => { await (tx.getStore() || pool).query(sql); },
    transacao: async fn => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await tx.run(c, fn);
        await c.query('COMMIT');
        return r;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    fechar: () => pool.end(),
  };
}

module.exports = { adaptadorSqlite, adaptadorPostgres };
