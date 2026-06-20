# Drona ValueChain — JMC Operations Tracker

A full-stack web app to monitor and bill the Drona ↔ JMC 3PL operation:
**Loading, Unloading, QC/PDI and Transportation** — with daily entry by Drona,
**end-of-day approval by JMC**, and **HQ approval for extra-manpower requests**.

---

## What's inside

| Area | Detail |
|------|--------|
| **Roles** | Drona Operator (entry), JMC Approver (EOD sign-off), Drona HQ (manpower approvals), Drona Admin (rates, manpower, users) |
| **Manpower** | Approved baseline (MG) per category vs **actual daily count**; shortfalls flagged |
| **Loading** | Parts qty + manpower count + truck count (per part) |
| **Unloading** | Truck count + weight in **tons** + manpower (per ton) |
| **QC / PTL (PDI)** | Parts qty + inspector count, with **MG 600/day** flagging |
| **Transport** | Per-trip: from → to, vehicle type, timestamp, remarks |
| **Approvals** | Operator submits the day → JMC approves/rejects EOD (rejected days reopen for editing) |
| **Manpower requests** | Operator raises surge request → HQ approves/rejects |
| **Reports** | Monthly day-by-day table, totals, MG tracking, **CSV export** |
| **Money** | Revenue is calculated & stored but **hidden** for now (Admin → Settings → "Show billing" reveals it) |

Tech: **Node.js + Express + SQLite** (zero external services). Data persists in `data.sqlite`.

---

## Run it (local)

> Requires **Node.js 18+** installed (https://nodejs.org).

```bash
cd jmc_app
npm install        # first time only
npm start
```

Open **http://localhost:3000**

### Demo logins (change these in Settings → Users after first login)

| Role | Username | Password |
|------|----------|----------|
| Drona Admin | `admin` | `admin123` |
| Drona Operator | `operator` | `oper123` |
| Drona HQ | `hq` | `hq123` |
| JMC Approver | `jmc` | `jmc123` |

---

## Daily flow

1. **Operator** opens *Daily Entry*, picks the date, fills manpower + loading + unloading + QC + transport trips, **Submit for JMC approval**.
2. **JMC** opens *EOD Approvals*, reviews the day (sees dispatched-vs-billed, MG status, trips), then **Approve** or **Reject** with remarks.
3. If production rises, **Operator** raises an *Extra Manpower Request*; **HQ** approves/rejects it.
4. Anyone sees the **Dashboard** and **Reports** (quantities only) for any month.

---

## Going to production (so Drona + JMC use it live from anywhere)

This runs as a normal Node server. To host it for both companies:

1. **Put it on a server** — any VPS (AWS/DigitalOcean/Hetzner), or a platform like Render/Railway. Run `npm install && npm start`; keep it alive with `pm2` or a systemd service.
2. **Set a port** via `PORT` env var (e.g. `PORT=8080`).
3. **Use HTTPS** — put it behind Nginx/Caddy or the platform's TLS so cookies are secure.
4. **Scale the DB later** — SQLite is great for this load; if you outgrow it, the `db.js` schema maps cleanly to Postgres.
5. **Back up `data.sqlite`** (it holds all entries) — a nightly copy is enough.

Environment variables:
- `PORT` — server port (default 3000)
- `DB_PATH` — path to the SQLite file (default `./data.sqlite`)

---

## Default business rules (editable in Admin → Settings)

- Approved manpower: Loaders **4**, Unloaders **3**, QC Inspectors **2**, Supervisor/Head **1**
- QC MG: **600 parts/day** for **3 months**
- Rates (hidden until billing on): Loading ₹2.5/part · Unloading ₹125/ton · QC ₹9/part
- Transport known routes: JMC→VBCL ₹900 (19FT) / ₹450 (Tempo/Tractor), JMC→Pantnagar ₹15,000, JMC→Lucknow ₹25,000

---

## Files

```
jmc_app/
  server.js        Express API + auth + role permissions
  db.js            SQLite schema + seed
  config.js        Business defaults (rates, MG, manpower, roles)
  public/
    index.html
    styles.css     Design system
    app.js         Role-aware single-page UI
  README.md
```
