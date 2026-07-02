# JMC Ops Tracker → Android App (Capacitor) — Design Spec

**Date:** 2026-07-02
**Author:** Rintu + Claude
**Status:** Draft for review
**Branch (suggested):** `feature/android-capacitor`

---

## 1. Goal

Ship the existing JMC Operations Tracker as a real **Android app**, distributed **internally/privately** to Drona + JMC staff, reusing the current web UI rather than rewriting it. The app is a first-class product, not a webview toy: it uses the **native camera**, **push notifications**, **offline entry + sync**, and **biometric login**.

## 2. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| D1 | App technology | **Capacitor** (Android target; iOS deferred, ~90% reusable later) |
| D2 | UI load model | **Bundle the existing `public/` UI inside the app**; call the server's JSON API cross-origin |
| D3 | Auth for the app | **Bearer token** (reusing the `Session` table), alongside the web app's existing cookie sessions |
| D4 | Native features (v1) | **All four:** native camera, push, offline entry+sync, biometric |
| D5 | Distribution | **Play Internal Testing** (private); direct-APK sideload as fallback |
| D6 | Delivery shape | **Big-bang v1** — everything in the first internal release |
| D7 | API hosting | **`https://jmc.dronavaluechain.com`** (already HTTPS); `API_BASE` is a build constant set to this |
| D8 | Repo | **Single repo** — `public/` stays the shared UI for web + app; add `android/`, `capacitor.config.ts`, a `mobile/` build step |
| D9 | App id | **`com.drona.jmc`** (confirmed) |
| D10 | Play + Firebase | **Not yet created** — account + Firebase project setup is part of WS7 |
| D11 | Offline scope | **Operator daily-entry workflow only** (confirmed); admin/MIS/billing/workers stay online-only |

## 3. Current-state facts (verified inventory)

These drive every task below; line numbers are current as of this spec.

**Backend (`server.js`, ~1437 lines, Express + Prisma/Postgres):**
- **No CORS anywhere** — the `cors` package isn't installed and no CORS/OPTIONS handling exists. Cross-origin calls from the WebView are blocked until we add it.
- **Auth is 100% cookie-based.** `currentUser()` reads `req.cookies.sid` (server.js:99); login mints `crypto.randomBytes(24)` → inserts into `sessions` → sets the `sid` cookie (server.js:163-165). `SESSION_COOKIE` is `httpOnly, sameSite:'lax', secure:IS_PROD, maxAge 12h` (server.js:131). Server-side TTL = 12h via `created_at > now() - interval '12 hours'`. No `Authorization` header path exists.
- **Security headers / CSP** set globally (server.js:44-61); `connect-src 'self'` only matters if we pointed the WebView at the live site (we don't — we bundle).
- **Uploads are auth-gated + role-gated** at `GET /uploads/:file` (server.js:76-84); worker-PII prefixes (`wdoc_/wphoto_/offer_`) restricted to Drona HR roles. Files are returned to the client as **relative** `/uploads/...` URLs.
- **File uploads are base64 data-URLs inside JSON** (not multipart); the effective size ceiling is `express.json({ limit:'20mb' })` (server.js:63), with per-file guards (6 MB images).
- **Push trigger points already isolated** — `alerts.notifyRealtime(...)` is called exactly 3 times: `ENTRY_SUBMITTED` (server.js:443), `PNL_NEGATIVE` on approval (server.js:543), `MP_REQUEST` (server.js:570).
- Startup in `start()` (server.js:1428-1436): `seed()` → `alerts.startScheduler()` → `app.listen`.

**Frontend (`public/app.js` 1966 lines, `index.html` 19 lines — monolithic vanilla JS, no build step, no modules):**
- **Single API choke point:** `api(path, opts)` at app.js:23-33 → `fetch('/api'+path)`, headers `Content-Type: application/json` only, no `Authorization`, no `credentials`, no 401 handling.
- **State-driven routing** (no hash/History); `State.route` + `ROUTES` map; role-gated nav; login decided by `boot()` calling `/me`.
- **Auth state is in-memory only** — no `localStorage`/`token`/`cookie` reads anywhere. Reloads re-hit `/me` and rely on the cookie.
- **Image capture sites (native-camera targets):**
  - Daily-entry proof photo — `<input type=file capture=environment>` (app.js:584); handler resizes via `resizeImage()` (app.js:307) → `POST /api/entries/:id/attachments {dataUrl,caption}`.
  - Worker passport photo (app.js:1576) → `/api/workers/:id/photo`.
  - Worker documents (image **or PDF**) (app.js:1608) via `fileToUpload()` (app.js:324) → `/api/workers/:id/documents`.
  - QR scan `scanQR()` (app.js:382-405) uses `getUserMedia` + `BarcodeDetector` — unreliable in WebView; already degrades to a toast.
- **Calls that BYPASS `api()`** (won't carry a Bearer header, will 401 cross-origin):
  - `window.open('/api/reports/monthly.pdf?...')` (app.js:1464), `window.open('/api/invoice.pdf?...')` (app.js:1465), offer-letter `window.open(r.url)` (app.js:1740).
  - `<img src>` / `<a href>` using API-returned relative `/uploads/...` URLs (attachments, worker photo/docs, offer letter, compliance docs) — will 404/401 against the WebView origin.
  - CSV exports via `Blob` + `a.click()` — may not save in a WebView.
- **No PWA assets** (no manifest/service worker). `index.html` already has `viewport-fit=cover` + `theme-color` (good for Capacitor). Google Fonts are network-loaded (bundle locally for offline first-launch).

**Schema (`prisma/schema.prisma`, Postgres):** Int autoincrement PKs, PascalCase models `@@map`'d to snake_case tables, camelCase fields `@map`'d, `createdAt/updatedAt` timestamptz (no `@updatedAt`; bumped via raw SQL), business dates stored as `String 'YYYY-MM-DD'`. `Session` PK is `token String @id`. **No device/push token table exists.**

## 4. Architecture

```
+-------------------------- Android app (Capacitor) --------------------------+
|  WebView (origin https://localhost)                                         |
|    public/ UI (bundled)  --->  api() shim: API_BASE + Bearer token          |
|    native camera / biometric / push / offline queue  ---> Capacitor plugins |
|    IndexedDB: offline entry snapshots + photo queue + cached reference cfg  |
+-----------------------------------+-----------------------------------------+
                                    | HTTPS + Authorization: Bearer <token>
                                    v
+-------------------- Existing Express server (same domain) ------------------+
|  + CORS (allowlist app origins)     + Bearer auth in currentUser()/auth()   |
|  + longer-lived revocable mobile token (Session.expires_at/kind)            |
|  + /uploads & *.pdf accept token (query/header) for cross-origin loads      |
|  + DeviceToken table + FCM sender fanned out from the 3 notifyRealtime evts  |
|  Postgres (Prisma)                                                          |
+-----------------------------------------------------------------------------+
```

Four change layers, detailed below: **(A) Backend enablers**, **(B) Frontend shim**, **(C) Capacitor shell + native features**, **(D) Offline engine**.

### 4.A Backend enablers (surgical; security-sensitive)

1. **CORS.** Add `cors` with an explicit allowlist of the WebView origins (`https://localhost`, and `http://localhost`/`capacitor://localhost` for older schemes), allowed headers `Authorization, Content-Type`, methods `GET,POST,PUT,DELETE,OPTIONS`. Token-based, so `credentials:true` is not required. Register before routes.
2. **Bearer auth (reuse `Session`).** `currentUser()` reads the token from `Authorization: Bearer <t>` **first**, then falls back to the `sid` cookie — web behavior unchanged. Validate against `sessions` on expiry.
3. **Longer-lived, revocable mobile token.** Migration adds `Session.expires_at DateTime` and `Session.kind String @default("web")`. `/api/login` accepts a client hint (header `X-Client-Platform: android`), sets `kind='mobile'`, `expires_at = now() + 30 days` (sliding: bump on use), and **returns the token in the response body** (web ignores it, keeps using the cookie). Revocation stays: logout deletes the row; admin/session-prune still work.
4. **Cross-origin file access.** Extend `GET /uploads/:file` and the PDF endpoints (`/api/reports/monthly.pdf`, `/api/invoice.pdf`) to accept the same token via `?access_token=` **in addition to** the header, so `<img>`/`window.open` work. Keep the existing role gate. (Tradeoff: token-in-URL can appear in logs — acceptable for an internal app; the more-secure alternative, fetch-blob with the header, is used for the big PDFs — see 4.B.)
5. **Push infra.** New `DeviceToken` model (§5). New `lib/push.js` using the **Firebase Admin SDK** (service-account creds via env). New `POST /api/devices` (auth) to register/refresh a token; `DELETE /api/devices` on logout. Extend `alerts.notifyRealtime()` to also fan out FCM to the relevant recipients' active device tokens — reusing the existing 3 trigger points, no new hook sites. Stale-token pruning: deactivate on `messaging/registration-token-not-registered`.

### 4.B Frontend shim (concentrated in `api()` + ~8 URL sites)

1. **`api()` rewrite** (app.js:23): `fetch(API_BASE + '/api' + path, { headers: { 'Content-Type':'application/json', ...(TOKEN && {Authorization:'Bearer '+TOKEN}) }, ... })`. `API_BASE` is injected at build time — empty for the web build, `https://jmc.dronavaluechain.com` for the app build.
2. **Token lifecycle.** Store the token in **Capacitor Preferences** (Keystore-backed secure storage for the token — see §7). Load into a module var at boot; set it on login success (app.js:152); clear on logout (app.js:236) instead of relying on cookie-clear+reload.
3. **401 interceptor** in `api()`: on 401, clear the stored token and call `renderLogin()` (today an expired session mid-use only shows error toasts).
4. **Native camera path.** Feature-detect `window.Capacitor`. When present, the three capture sites call `@capacitor/camera` and feed the result **into the existing `resizeImage()`/`fileToUpload()` helpers** → the base64-JSON upload endpoints are reused unchanged. Web build keeps the `<input type=file>` path.
5. **QR scan.** Replace `scanQR()` with `@capacitor-mlkit/barcode-scanning` when native; keep the web fallback. Writes into the same target input.
6. **Non-`api()` URL sites.**
   - **Inline images** (`<img src="/uploads/...">`): prefix with `API_BASE` and append `?access_token=`, OR fetch-blob->objectURL. Use the query-token approach for thumbnails.
   - **PDF/report opens** (app.js:1464-1465, 1740): fetch-with-Bearer -> Blob -> **Capacitor Filesystem write + Share/FileOpener** (avoids token-in-URL for big reports and works in-WebView).
   - **CSV exports**: same Filesystem+Share pattern instead of `a.click()`.
7. **Android hardware back button.** Intercept via `@capacitor/app` `backButton` to navigate `State.route`/close modals instead of exiting.
8. **Local fonts.** Bundle Archivo / IBM Plex locally so first-launch/offline isn't dependent on `fonts.googleapis.com`.

### 4.C Capacitor shell + native features

- **Project:** `npm i @capacitor/core @capacitor/cli @capacitor/android`; `capacitor.config.ts` with `appId` (e.g. `com.drona.jmc`), `appName`, `webDir: 'www'`, `server.androidScheme: 'https'`. `npx cap add android` creates `android/`.
- **Build step (`mobile/build.mjs` + npm script `build:mobile`):** assemble `www/` from `public/`, inject `API_BASE` + an app-appropriate `<meta http-equiv=CSP>` (`connect-src` -> API domain; `img-src` includes the API domain), and the local fonts. Keeps `public/` pristine for the web deploy.
- **Plugins:** `@capacitor/camera`, `@capacitor/push-notifications` (+ Firebase / `google-services.json`), a biometric plugin (`@aparajita/capacitor-biometric-auth`), `@capacitor/preferences`, `@capacitor/network`, `@capacitor/filesystem`, `@capacitor/share`, `@capacitor-mlkit/barcode-scanning`, `@capacitor/app`.
- **Biometric login:** after first password login, persist the token in secure storage; on subsequent launches, gate unlock behind fingerprint/face (`BiometricAuth`). Fallback to password. The 30-day mobile token means operators rarely retype credentials.
- **Push registration:** on login, register for push, obtain the FCM token, `POST /api/devices`. Handle foreground/background notification taps -> deep-link into `State.route`.

### 4.D Offline engine (largest lift)

**Scope:** offline covers the **operator field workflow** — daily-entry create/edit + proof photos, plus cached reference data. Admin/HQ surfaces (MIS, billing, workers, approvals) remain **online-only** (they're not used on the floor). This boundary is deliberate and keeps the sync model tractable.

**Why it's tractable:** `POST /api/entries` is **upsert-by-`work_date` and idempotent**. So the offline model is *"keep the latest local snapshot per work-date; replay on reconnect"* (last-write-wins per date) — **not** an operation log.

- **Store:** IndexedDB (no native plugin needed; reliable in WebView). Three stores: `pendingEntries` (keyed by `work_date`), `pendingPhotos` (keyed by `work_date`, holds base64 + caption), `refCache` (config/pdi-parts/approved-manpower/current-day entry).
- **Detection:** `@capacitor/network`; a global online/offline banner in the shell.
- **Write path (offline):** entry saves write to `pendingEntries[work_date]` (overwrite); photos append to `pendingPhotos[work_date]`. UI shows "saved locally · will sync".
- **Sync (on reconnect / app resume):** for each `work_date` -> `POST /api/entries` (get server entry id) -> then POST each queued photo to `/api/entries/:id/attachments` (ordering matters: entry first). On success, clear that date's queue.
- **Submit-for-approval is online-only in v1** (a deliberate networked action). Offline users can save drafts + photos; submit requires connectivity (clear messaging).
- **Conflict:** if a queued date is locked server-side (approved/submitted while offline -> `409`), surface a clear "couldn't sync — day is locked by JMC" prompt and keep the local copy for the operator to reconcile; don't silently drop.
- **Reads:** cached reference config + current-day entry render offline with a "showing cached data" indicator; refresh when online.

## 5. Data model change

Add one model + a back-relation (matches existing conventions):

```prisma
model DeviceToken {
  id          Int       @id @default(autoincrement())
  userId      Int       @map("user_id")
  token       String    @unique                 // FCM registration token
  platform    String?                            // ANDROID | IOS | WEB
  deviceInfo  String?   @map("device_info")
  active      Boolean   @default(true)
  lastSeenAt  DateTime? @map("last_seen_at")
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @default(now()) @map("updated_at")
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId], map: "idx_device_tokens_user")
  @@map("device_tokens")
}
// User: add `deviceTokens DeviceToken[]`
```

Plus `Session`: add `expiresAt DateTime? @map("expires_at")` and `kind String @default("web")`. Two Prisma migrations (`device_tokens`, `session_mobile_fields`); `migrate deploy` is already wired into `start:prod`.

## 6. Distribution & release

- **Google Play Developer account** ($25 one-time) -> **Internal testing** track (up to 100 testers by email; no public review friction). Direct-APK sideload documented as the no-account fallback.
- **Signing:** Play App Signing + a locally-held upload keystore (kept out of git; documented in a secrets note).
- **Firebase project** for FCM: register the Android app, add `google-services.json`, generate an Admin SDK service account for the server (`lib/push.js` reads creds from env).
- **Versioning:** `versionCode`/`versionName` bump script; release notes per internal build.

## 7. Security considerations (PII-heavy app)

- **Token at rest:** store the bearer token in Android Keystore-backed secure storage, not plaintext Preferences.
- **CORS allowlist is explicit** (no wildcard); only the WebView origins.
- **Upload token-in-query** is scoped to the internal app and the existing role gate still applies; big PDFs use header+blob to avoid URL logging. Revisit with short-lived signed URLs if ever public.
- **Worker-PII role gating is unchanged** — enforced server-side, so the app inherits it.
- **Mobile token TTL (30d, sliding)** is longer than web (12h) but fully revocable server-side; biometric gate guards the on-device token. Optional hardening: certificate pinning (deferred — noted, not v1).
- **Login/OTP throttles** are in-memory per-IP; unchanged. Note: behind one proxy hop (`trust proxy: 1`).

## 8. Testing strategy

- **Backend:** unit tests for the Bearer-or-cookie `currentUser()` path, mobile-token expiry, CORS preflight, and `/uploads` token-in-query gate (extend the existing `node --test`).
- **Sync engine:** unit tests for the last-write-wins queue + photo-after-entry ordering + locked-day 409 handling (pure functions, no device needed).
- **Device smoke tests (internal track):** login->biometric->offline save->reconnect sync->push receipt->native camera->PDF open, on 2–3 real Android versions.

## 9. Delivery plan (big-bang v1, parallelizable workstreams)

Released together, but built as independent workstreams that integrate at the end:

- **WS1 — Backend enablers:** CORS, Bearer auth, `Session` migration, `DeviceToken` migration, upload/PDF token access. *(Testable via curl before any app exists.)*
- **WS2 — Capacitor shell + build:** project, config, `build:mobile`, local fonts, hardware-back, boots the bundled UI against staging.
- **WS3 — Frontend shim:** `api()` API_BASE+Bearer+401, token storage, non-`api()` URL fixes.
- **WS4 — Native features:** camera (3 sites), biometric, push register + tap-routing, barcode.
- **WS5 — Push server:** `lib/push.js` + `/api/devices` + FCM fan-out from `notifyRealtime`.
- **WS6 — Offline engine:** IndexedDB stores, network detection, sync + conflict handling.
- **WS7 — Release:** Play account, Firebase, signing, internal-track build, device smoke tests.

Integration order: WS1+WS2 first (foundation), then WS3->WS4/WS5/WS6 in parallel, WS7 last.

## 10. Out of scope (v1)

iOS build; public Play listing; offline for admin/MIS/billing/workers surfaces; certificate pinning; replacing `window.prompt/confirm` with custom modals (WebView supports them); real-time (websocket) in-app updates.

## 11. Confirmed parameters

- **API domain / `API_BASE`:** `https://jmc.dronavaluechain.com`.
- **Android `appId`:** `com.drona.jmc`.
- **Google Play + Firebase:** not yet created — provisioning both is part of WS7 (Drona-owned).
- **Offline scope:** operator daily-entry workflow only; admin/MIS/billing/workers remain online-only.
