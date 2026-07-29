/**
 * Async, Prisma-backed query helper that mirrors the small better-sqlite3 API
 * the app used before (db.prepare(sql).get/all/run + db.transaction). Every call
 * now runs through Prisma Client's raw query interface against Postgres, so:
 *   - node:sqlite is fully removed,
 *   - result rows keep their snake_case column names (the frontend's contract),
 *   - the existing SQL strings move over with only dialect tweaks in server.js.
 *
 * Differences from better-sqlite3 that callers must respect:
 *   - get()/all()/run() are async — await them.
 *   - Positional '?' placeholders are rewritten to Postgres $1,$2,… for you.
 *   - run() returns { changes }. For a generated id, use get('… RETURNING id').
 *   - Postgres returns COUNT()/SUM() as BigInt; we coerce BigInt -> Number so
 *     JSON.stringify and JS arithmetic keep working unchanged.
 */
'use strict';
const { prisma } = require('./prisma');

function toPg(sql) { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); }

function deBig(v) {
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map(deBig);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    for (const k in v) v[k] = deBig(v[k]);
    return v;
  }
  return v;
}

function stmt(sql, runner) {
  const pg = toPg(sql);
  return {
    all: async (...p) => deBig(await runner.$queryRawUnsafe(pg, ...p)),
    get: async (...p) => { const r = await runner.$queryRawUnsafe(pg, ...p); return r[0] ? deBig(r[0]) : undefined; },
    run: async (...p) => ({ changes: await runner.$executeRawUnsafe(pg, ...p) }),
  };
}

const db = {
  prepare: (sql) => stmt(sql, prisma),
  // Interactive transaction. The callback receives a tx-bound db with the same
  // prepare() API; everything inside runs in one Postgres transaction.
  // `opts` is forwarded to prisma.$transaction — omit it for the usual short
  // handlers; bulk work (e.g. the Excel import, which can write a thousand rows
  // in one go) must raise `timeout` above Prisma's 5s default or it aborts.
  transaction: (fn, opts) => async (...args) =>
    prisma.$transaction(async (t) => fn({ prepare: (sql) => stmt(sql, t) }, ...args), opts),
};

module.exports = { db, prisma };
