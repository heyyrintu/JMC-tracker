/**
 * Idempotent seed for the Postgres database (replaces db.js seed()).
 * Inserts default settings, the PDI parts master and the four demo users only
 * when they are missing — safe to run repeatedly and safe to run after the
 * SQLite import (it never clobbers existing rows).
 *
 *   npm run seed
 */
'use strict';
const bcrypt = require('bcryptjs');
const config = require('../config');
const pdiSeed = require('../pdi-parts');
const { prisma, getSetting, setSetting } = require('../lib/prisma');

async function ensureSetting(key, value) {
  if ((await getSetting(key)) === null) await setSetting(key, value);
}

async function seed() {
  await ensureSetting('rates', config.RATES);
  await ensureSetting('mg', config.MG);
  await ensureSetting('approved_manpower', config.APPROVED_MANPOWER);
  await ensureSetting('show_billing', config.SHOW_BILLING);
  await ensureSetting('transport_rates', config.TRANSPORT_RATES);
  await ensureSetting('costs', config.COSTS);
  await ensureSetting('invoice', config.INVOICE);
  await ensureSetting('ppm_target', config.PPM_TARGET);
  await ensureSetting('defect_types', config.DEFECT_TYPES);
  await ensureSetting('mg_billing', config.MG_BILLING);
  await ensureSetting('leave_policy', config.LEAVE_POLICY);
  await ensureSetting('alerts', config.ALERTS);

  // PDI parts master — load the imported sheet once.
  if ((await prisma.pdiPart.count()) === 0) {
    const data = [
      ...pdiSeed.CHASSIS.map((p) => ({ partNo: p, category: 'CHASSIS' })),
      ...pdiSeed.BUS_BODY.map((p) => ({ partNo: p, category: 'BUS_BODY' })),
    ];
    await prisma.pdiPart.createMany({ data, skipDuplicates: true });
  }

  const defaults = [
    { name: 'System Admin',  username: 'admin',    password: 'admin123', role: 'ADMIN',        company: 'DRONA' },
    { name: 'Site Operator', username: 'operator', password: 'oper123',  role: 'OPERATOR',     company: 'DRONA' },
    { name: 'Drona HQ',      username: 'hq',       password: 'hq123',    role: 'HQ',           company: 'DRONA' },
    { name: 'JMC Approver',  username: 'jmc',      password: 'jmc123',   role: 'JMC_APPROVER', company: 'JMC' },
  ];
  let created = 0;
  for (const u of defaults) {
    const exists = await prisma.user.findUnique({ where: { username: u.username } });
    if (!exists) {
      await prisma.user.create({
        data: { name: u.name, username: u.username, passwordHash: bcrypt.hashSync(u.password, 10), role: u.role, company: u.company },
      });
      created++;
    }
  }
  console.log(`Seed complete. Users created: ${created}.`);
}

module.exports = { seed };

if (require.main === module) {
  seed()
    .catch((e) => { console.error('Seed failed:', e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
