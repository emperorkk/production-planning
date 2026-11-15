# Production Planning — Vlachos Bros

Visual production-scheduling planner for a Soft1 ERP environment. Runs in **two modes** from one shared codebase:

| Mode | Served by | Data access | Auth |
|---|---|---|---|
| **Embedded** | Soft1 (opened as `x=external` page) | `window.external` COM → direct SQL | Soft1 session |
| **Web** | Cloudflare Worker | `fetch('/api/sql')` → Soft1 Web Services | Soft1 Web Accounts login |

Both modes render the same UI — the only file that changes behavior per environment is `public/src/soft1-bridge.js`, which auto-detects the mode at boot.

---

## Repository layout

```
public/                           ← served as static assets by the Worker
├── login.html                    ← web-only login page
├── production-planner.html       ← main app (both modes use this entry)
└── src/
    ├── soft1-bridge.js           ← mode detection (embedded | web | mock)
    ├── data-service.js           ← SQL definitions + query wrappers (async)
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
├── session.js                    ← KV-backed signed sessions
└── routes/
    ├── auth.js                   ← /api/login, /api/logout, /api/me
    └── sql.js                    ← /api/sql (SELECT only), /api/exec (whitelisted UPDATEs)

wrangler.jsonc                    ← Worker config + KV + env vars
package.json                      ← npm scripts (dev, deploy, tail)
scripts/sync-to-softone.mjs       ← copies public/ → C:\SoftOne\Vlachos Bros\ for embedded use
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
   npx wrangler secret put SOFT1_APP_ID        # Soft1 appId (default 703)
   ```

4. Deploy a Soft1 "JS" service script named **RUNSQL** on the server that runs:
   ```js
   try { X.RUNSQL(param1, null); return { success: true }; }
   catch (e) { return { success: false, error: e.message }; }
   ```
   This is what `/api/exec` calls for the two whitelisted `UPDATE` statements.

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

## Setup — Embedded (Soft1 x=external)

Any time you change files under `public/`, mirror them into the Soft1 installation folder:

```bash
npm run sync-embedded
```

The script copies `public/production-planner.html` and `public/src/` into `C:\SoftOne\Vlachos Bros\`, keeping the embedded version in sync with the repo.

Then open the page from inside Soft1 via a `x=external` menu entry pointing to `production-planner.html`.

---

## Security notes

- `/api/sql` accepts **only SELECT / WITH** queries. Anything else is rejected by the Worker *before* the Soft1 call.
- `/api/exec` only accepts the two exact `UPDATE` prefixes the planner needs for write-back (`FINDOC.CCCFXRSRC` and `MTRLINES.DATE01/02`).
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
