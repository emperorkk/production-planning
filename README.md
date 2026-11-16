# Production Planning — Vlachos Bros

Two web apps for a Soft1 ERP environment, served by one **Cloudflare Worker** with one Soft1 login:

- **Προγραμματισμός** (`production-planner.html`) — desktop Gantt production planner.
- **Διαχείριση παραγωγής** (`production.html`) — mobile-first, installable (PWA) app: running jobs, machine idle time, production / customer order search, machine (RSRC) editing.

Access level is picked on the login page: *Προγραμματισμός + Διαχείριση* (Soft1 appId 1199) or *Διαχείριση παραγωγής* only (appId 1200). Desktop + full access lands on the planner; phones and production-only access land on the production app (the planner is desktop-only).

```
browser ──/api/data, /api/save──▶ Worker ──/s1services/JS/Foxline.planning/<fn>──▶ Soft1
```

- **All SQL lives in the Soft1 AJS web service** `soft1/Foxline.planning.js`. The browser only calls datasets by name; it never sends SQL.
- Auth = Soft1 Web Accounts login (`login.html`).
- Opening `public/production-planner.html` as a local file runs **mock mode** (demo data, no Soft1).

> ⚠️ **Embedded mode (Soft1 `x=external` page) is DEPRECATED** — frozen in `legacy/embedded/`, no further updates. All operations go through the Worker.

---

## Repository layout

```
public/                           ← served as static assets by the Worker
├── login.html                    ← web-only login page
├── production-planner.html       ← main app
├── calendar.html                 ← production calendar editor (CCCFXPCAL)
├── production.html               ← Διαχείριση παραγωγής (mobile-first, burger menu, PWA)
├── production.webmanifest, sw.js ← PWA install (network-only service worker)
└── src/
    ├── app-shell.js / .css       ← shared chrome: app switcher · 🔑 change password · Έξοδος
    ├── production-app.js / production.css ← Διαχείριση παραγωγής (Vlachos Bros red/black)
    ├── soft1-bridge.js           ← web | mock — /api/data + /api/save
    ├── data-service.js           ← dataset calls + row mapping (no SQL)
    ├── scheduler-engine.js       ← conflict / deadline / utilisation logic
    ├── gantt-renderer.js         ← SVG/DOM Gantt chart
    ├── drag-drop-manager.js      ← HTML5 DnD + resize
    ├── excel-exporter.js         ← SheetJS wrapper
    ├── ui-controller.js          ← top-level state & event wiring
    ├── login.js                  ← login page handler (web-only)
    ├── styles.css
    └── lib/xlsx.min.js

worker/                           ← Cloudflare Worker (nodejs_compat)
├── index.js                      ← entry — routes, static assets, auth gate
├── soft1-client.js               ← Soft1 Web Services HTTP client
├── session.js                    ← KV-backed sessions (random id)
├── access.js                     ← access levels (full 1199 / production 1200), landing, mobile detection
└── routes/
    ├── auth.js                   ← /api/login, /api/logout, /api/me
    ├── data.js                   ← /api/data (named datasets), /api/save (structured schedule write)
    ├── record.js                 ← /api/record (native getData, RSRC)
    ├── calendar.js               ← /api/calendar (production calendar CCCFXPCAL)
    └── production.js             ← /api/machine (native setData RSRC)

soft1/Foxline.planning.js         ← Soft1 AJS web service — ALL planner SQL lives here

legacy/embedded/                  ← DEPRECATED x=external planner — frozen, no further updates

wrangler.jsonc                    ← Worker config + KV + env vars
package.json                      ← npm scripts (dev, deploy, tail)
scripts/sync-to-softone.mjs       ← LEGACY: copies legacy/embedded/ → C:\SoftOne\Vlachos Bros\
```

---

## Setup — Cloudflare Worker

1. Install deps and sign in to Cloudflare:
   ```bash
   npm install
   npx wrangler login
   ```

2. Create the KV namespace for sessions and paste its id into `wrangler.jsonc`:
   ```bash
   npx wrangler kv namespace create SESSIONS
   ```

3. Set the Soft1 endpoint and any secrets:
   ```bash
   # Edit wrangler.jsonc → vars.SOFT1_API_URL to your S1Services URL
   # and vars.SOFT1_APP_ID to the Soft1 web-services appId (Vlachos Bros: 1199)
   ```

4. In Soft1, create the AJS web service **Foxline.planning** from `soft1/Foxline.planning.js`.
   The Worker calls `<SOFT1_API_URL>/JS/Foxline.planning/<fn>` with `{ clientID, ...params }`:

   | Function | Params | Returns |
   |---|---|---|
   | `Ping` | — | `{ success, user, company }` |
   | `GetMachines` | — | `{ success, count, data }` |
   | `GetPhaseMachines` | — | 〃 |
   | `GetOrdersInWeek` | `weekStart`, `weekEnd` (YYYY-MM-DD) | 〃 |
   | `GetUnscheduledOrders` | `offset`, `pageSize` | 〃 |
   | `GetProductionOrders` | `weekStart`, `weekEnd` | 〃 |
   | `GetShifts` | `monday` (YYYY-MM-DD) | 〃 |
   | `GetMtrlTree` | — | 〃 |
   | `GetOrderDetails` | `findoc` | 〃 |
   | `GetProduction` | `findocs` ('1,2,3') | 〃 (rolls, producedQty, lots per order) |
   | `GetProductionRolls` | `findoc` | 〃 (one row per roll) |
   | `SaveSchedule` | `orders: [{findoc, machine, start, end, origMachine, origStart, origEnd}]` (YYYY-MM-DD HH:MM) | `{ success, saved, skipped, conflicts, errors }` |
   | `GetCalendarWeek` | `monday` | `{ success, exists, header, data }` |
   | `GetCalendarWeeks` | `from`, `to` | `{ success, data }` |
   | `CreateCalendarWeek` | `monday`, `copy` | `{ success, id, code, copiedFrom }` |
   | `SaveCalendarWeek` | `monday`, `lines: [{rsrc, s}]` | `{ success, updated, inserted, errors }` |
   | `FillMissingWeeks` | `from`, `to` | `{ success, created, skipped, errors }` |

5. Run locally:
   ```bash
   npm run dev
   ```
   Open http://localhost:8787 — redirects to `/login.html`.

6. Deploy to Cloudflare:
   ```bash
   npm run deploy
   ```

---

## Legacy — Embedded (Soft1 x=external) — DEPRECATED

The embedded planner is frozen in `legacy/embedded/` and receives **no further updates**.
It is kept only for reference/fallback. To reinstall that frozen copy into Soft1:

```bash
npm run sync-embedded-legacy
```

---

## Security notes

- No SQL crosses the wire. `/api/data` only forwards whitelisted dataset names + params; each AJS function validates its params (dates, ints) and takes the company from `X.SYS.COMPANY`. Any Soft1 user can call the AJS endpoint directly, so the AJS checks are the real boundary.
- `/api/save` accepts structured orders only. `Foxline.planning/SaveSchedule` builds the UPDATEs itself, validates types, and refuses completed (`MTRSTS=1`), foreign-company or non-5171 documents.
- `/api/change-password` calls the native Soft1 `changePassword` (session clientID + appId); passwords are never logged or stored.
- Session cookies are `HttpOnly; Secure; SameSite=Lax`. Real session body lives in KV, so logout deletes it server-side.
- The Soft1 `clientID` never leaves the Worker; the browser only sees an opaque session id.

---

## Data model (quick reference)

Each **production order** (`FINDOC`) = one production phase = one Gantt block. Fields come from:
- `F.FINDOC` → id
- `D.STAGE` → phase (eligible machines via `SPCOSTGROUP` many-to-many)
- `F.CCCFXRSRC` → assigned machine
- `L0.DATE01` / `L0.DATE02` → planned start/end
- `L0.QTY1` / `L0.QTY2` → kilos / linear metres
- `D.MTRSTS` → status (-1=created, 0=released, 1=completed/locked)

Block duration on machine M = `M.SETUPTIME + (L0.QTY2 / M.MPRDQTY) + M.WAITTIME` minutes.

Shifts (per machine, per day, up to 3) come from `CCCFXPCAL + CCCFXPCALLNS`.
