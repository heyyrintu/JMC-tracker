/**
 * Prisma data layer — single PrismaClient instance for the whole app, plus the
 * settings key/value helpers that used to live in db.js.
 *
 * The previous SQLite layer was synchronous (db.prepare().get/all/run); Prisma
 * is async, so every consumer awaits these helpers. `settings.value` is now a
 * jsonb column, so getSetting returns the parsed object directly (no JSON.parse).
 */
'use strict';
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

// Reuse a single client across hot-reloads in dev to avoid exhausting the
// Postgres connection pool.
const globalForPrisma = globalThis;
const prisma = globalForPrisma.__jmcPrisma || new PrismaClient();
if (!globalForPrisma.__jmcPrisma) globalForPrisma.__jmcPrisma = prisma;

async function getSetting(key, fallback = null) {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await prisma.setting.upsert({
    where: { key },
    update: { value, updatedAt: new Date() },
    create: { key, value },
  });
}

module.exports = { prisma, getSetting, setSetting };
