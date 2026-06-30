# Deploying on Coolify

The app ships a **Dockerfile**, so deploy it as a Docker-based application.

## 1. Create the application
- New Resource → **Application** → your Git repo + branch.
- Build Pack: **Dockerfile** (Coolify auto-detects the `Dockerfile`).
- Port: **3000** (the container `EXPOSE`s 3000).

## 2. Environment variables
Set these in Coolify → the application → **Environment Variables**:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | `postgresql://USER:PASS@HOST:5432/DB` (add `?sslmode=require` for managed PG). Can point at a Coolify-managed Postgres or your existing server. |
| `NODE_ENV` | ✅ | `production` (already set in the image; keep it — it enables Secure cookies). |
| `SMTP_HOST` | optional | Email alerts. Leave unset to disable email (app still runs). |
| `SMTP_PORT` | optional | `587` (or `465` with `SMTP_SECURE=true`). |
| `SMTP_USER` / `SMTP_PASS` | optional | SMTP credentials. |
| `SMTP_SECURE` | optional | `true` for port 465. |
| `ALERT_FROM` | optional | e.g. `Drona ValueChain <alerts@yourdomain.com>`. |

`PORT` and `UPLOAD_DIR` are baked into the image (3000, `/app/uploads`) — no need to set them.

## 3. Persistent storage (important)
Uploads (proof photos, worker ID/bank documents, generated offer-letter PDFs) are written to disk. Without a volume they are **lost on every redeploy**.

- Coolify → the application → **Storages** → add a Persistent Storage:
  - **Mount Path:** `/app/uploads`

## 4. Database migrations
The container runs `npx prisma migrate deploy` on every start (see the Dockerfile `CMD`), so the schema is applied/updated automatically on each deploy. Default users + settings are seeded on first boot.

> First deploy against a **fresh** database: it creates all tables and seeds the
> 4 default logins (`admin/admin123`, etc.). **Change these immediately** in-app
> (each user → reset password) or via the Admin → Users screen.
>
> Migrating existing SQLite data instead? Run `npm run import:sqlite` once with
> `DATABASE_URL` + `SQLITE_PATH` set (see `scripts/import-from-sqlite.js`).

## 5. Health check
Point Coolify's health check at **`/healthz`** (returns `200 {"status":"ok"}`, or `503` if the DB is unreachable).

## 6. Domain / HTTPS
- Assign your domain in Coolify; it provisions HTTPS (Traefik + Let's Encrypt).
- The app sets `trust proxy` and `Secure` cookies in production, so it must be
  served over **HTTPS** (Coolify's default) for login to work.

## Local production smoke test
```bash
docker build -t jmc-app .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="postgresql://..." \
  -e NODE_ENV=production \
  -v jmc_uploads:/app/uploads \
  jmc-app
# then: curl localhost:3000/healthz
```
