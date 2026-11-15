# HANDOVER — Production Planning (Vlachos Bros)

> Read this first. It contains everything a new chat session needs to pick up where the previous one left off.

---

## 1. What this project is

A visual **production-scheduling planner** for Vlachos Bros, a factory running SoftOne ERP. The user is **Konstantinos (kkourentzes@gmail.com)**, aka GitHub `emperorkk`.

The planner lets a shop-floor scheduler drag production orders onto a weekly Gantt grid of machines, respects shift calendars and phase-machine eligibility, computes block duration from machine speed + setup/wait times, and writes the plan back to Soft1. All UI is in **Greek**.

Two rendering modes from one codebase:

| Mode | Where it runs | Soft1 access | Auth |
|---|---|---|---|
| **Embedded** | Inside Soft1 itself, launched as an `x=external` menu entry | `window.external` COM — sync `GetSqlDataSet` / `RUNSQL` | Current Soft1 session |
| **Web** | Cloudflare Worker (static assets + API) | `fetch('/api/sql')` → Worker → Soft1 Web Services over HTTPS | Soft1 Web Accounts login (login.html) |

---

## 2. Repository

- **GitHub:** https://github.com/emperorkk/production-planning (the username is `emperorkk` — no separators; `emperor_kk` and `emperor-kk` both fail to resolve)
- **Local clone:** `C:\Users\konst\production-planning\`
- **Embedded deploy target:** `C:\SoftOne\Vlachos Bros\` (SoftOne install dir — do NOT `git init` there; it has hundreds of binaries)
- **Git config:** user `kkourentzes@gmail.com`, Windows cert store (`http.sslBackend=schannel`) required for push
- **Attribution footer on commits:** `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` (from the harness reminder)

### Layout

```
public/                           ← Worker's static assets root
├── login.html                    ← Soft1 Web Account login form (web mode only)
├── production-planner.html       ← main app (both modes use this entry)
└── src/
    ├── soft1-bridge.js           ← auto-detects embedded | web | mock; ALL async
    ├── data-service.js           ← SQL definitions + async query wrappers
    ├── scheduler-engine.js       ← conflict / deadline / utilisation / auto-place
    ├── gantt-renderer.js         ← DOM-based Gantt (no framework, no SVG library)
    ├── drag-drop-manager.js      ← HTML5 DnD + edge resize
    ├── excel-exporter.js         ← SheetJS wrapper (3 sheets)
    ├── ui-controller.js          ← top-level state, event wiring, lazy loading
    ├── login.js                  ← login page handler (POSTs to /api/login)
    ├── styles.css
    └── lib/xlsx.min.js           ← SheetJS bundled (no CDN)
worker/
├── index.js                      ← entry — routes /api/*, auth-gates static
├── soft1-client.js               ← Soft1 Web Services HTTP client
├── session.js                    ← KV-backed signed sessions, HttpOnly cookie
└── routes/
    ├── auth.js                   ← /api/login, /api/logout, /api/me
    └── sql.js                    ← /api/sql (SELECT guard), /api/exec (whitelist)
wrangler.jsonc                    ← Worker config (KV + env vars)
package.json                      ← npm scripts: dev | deploy | tail | sync-embedded
scripts/sync-to-softone.mjs       ← mirror public/ → C:\SoftOne\Vlachos Bros\
README.md                         ← user-facing setup
handover.md                       ← this file
```

---

## 3. Data model — critical to understand before touching queries

### Order-centric (no multi-phase per order!)

Each row in Soft1 `FINDOC` with `SOSOURCE = 5171` is a **single production order = one production phase = one Gantt block**. There is no "parent order with 3 phases" — if a job needs Cut → Weld → Paint, those are **three independent FINDOCs** that share an `MTRL`. The `CCCFXPRNOMINAL` table defines the recipe/chain per MTRL (currently loaded but used only for future "combine runs" hints).

### Core shape

```js
order = {
  id:            String(FINDOC),
  description:   'M.CODE + " " + M.NAME',
  deliveryDate:  ISNULL(LS.DELIVDATE, L0.DELIVDATE),  // LS = parent sales order line
  kilos:         L0.QTY1,
  linearMetres:  L0.QTY2,
  plannedStart:  L0.DATE01,   // null = unscheduled
  plannedEnd:    L0.DATE02,
  status:        D.MTRSTS,    // -1 created | 0 released | 1 completed (locked)
  phase:         D.STAGE,     // FIXED — defines eligible machines
  machineId:     F.CCCFXRSRC, // pre-assigned OR planner-set; nullable
  mtrl:          L0.MTRL,
  salesOrderRef: L0.FINDOCS
}
```

### Phase ↔ machine eligibility (many-to-many)

From `SPCOSTGROUP` — a machine may belong to several phases:
```sql
SELECT CCCRSRC AS machine, CCCSTAGE AS phase,
       (SELECT NAME FROM STAGE WHERE COMPANY=SPCOSTGROUP AND STAGE=CCCSTAGE) AS phaseName
FROM SPCOSTGROUP WHERE CCCRSRC IS NOT NULL AND COMPANY = <company>
```

State holds `phaseMachines[phase] = [machineId,...]` and `phaseNames[phase] = displayName`. **Always display phase as `phaseName` not the raw code.**

### Machine duration formula

Block duration on machine M = **`M.SETUPTIME + (order.linearMetres / M.MPRDQTY) + M.WAITTIME` minutes.** Same order on a faster machine = shorter block. Computed live during dragover so the ghost resizes mid-drag.

```sql
SELECT RSRC AS id, NAME AS name, CCCFXSTAGE AS phase,
       SETUPTIME AS setuptime, WAITTIME AS waittime,
       MPRDQTY AS average_speed_in_metres_per_minute
FROM RSRC WHERE SODTYPE = 25 AND RSRCTYPE < 50 AND COMPANY = <company>
```

### Shifts — per machine, per day (NOT per machine group)

From `CCCFXPCAL` (header: week dates) + `CCCFXPCALLNS` (line: 21 boolean flags `S{day}{shift}` for 7 days × 3 shifts). **RSRC is on the LINES table (`L.RSRC`), not on the header.** Each row explodes into up to 21 shift records; shift 3 (22:00–24:00) also emits a carry-over 00:00–06:00 for the next day.

Default shift times (hardcoded in `data-service.js SHIFT_TIMES`):
- Shift 1 (Πρωινή): 06:00–14:00
- Shift 2 (Απογευματινή): 14:00–22:00
- Shift 3 (Νυχτερινή): 22:00–24:00 (+ 00:00–06:00 next day)

**Future:** user plans to add `STARTTIME`/`ENDTIME` columns on `CCCFXPCALLNS`. When that happens, replace the `SHIFT_TIMES` constant with per-row lookups — everything else stays.

If a machine has NO shift programme row for a week, it's **fully unavailable** (per user decision). Planner can add "provisional shifts" that live only in browser state — not written to Soft1 — and render with dashed orange borders + diagonal stripes.

### Production orders query (current working version)

```sql
SELECT F.FINDOC AS id, M.CODE + ' ' + M.NAME AS description,
       ISNULL(LS.DELIVDATE, L0.DELIVDATE) AS deliveryDate,
       L0.QTY1 AS kilos, L0.QTY2 AS linearMetres,
       L0.DATE01 AS plannedStartDataTime, L0.DATE02 AS plannedFinishDataTime,
       D.MTRSTS AS status, D.STAGE AS phase, F.CCCFXRSRC AS machine,
       L0.FINDOCS AS salesOrderRef, L0.MTRL AS mtrl
FROM FINDOC F
  INNER JOIN MTRDOC   D  ON D.FINDOC = F.FINDOC
  INNER JOIN MTRLINES L0 ON L0.FINDOC = F.FINDOC AND L0.MTRTYPE = 1
  LEFT  JOIN MTRLINES LS ON LS.FINDOC = L0.FINDOCS AND LS.MTRLINES = L0.MTRLINESS
  INNER JOIN MTRL     M  ON M.MTRL = L0.MTRL
WHERE F.SOSOURCE = 5171
  AND F.COMPANY = <company>
  AND ISNULL(LS.DELIVDATE, L0.DELIVDATE) >= GETDATE() - 180        -- 6-month floor
  AND (D.MTRSTS <> 1                                                -- non-completed
       OR L0.DATE01 BETWEEN '<weekStart> 00:00:00' AND '<weekEnd> 23:59:59'
       OR L0.DATE02 BETWEEN '<weekStart> 00:00:00' AND '<weekEnd> 23:59:59')
ORDER BY L0.DELIVDATE
```

At any time there are **1000–1500 open orders** → the UI loads in stages (see §6 "Performance").

### Write-back — two UPDATEs per changed order

```sql
UPDATE FINDOC   SET CCCFXRSRC = '<machineId>'|NULL             WHERE FINDOC = <id>
UPDATE MTRLINES SET DATE01 = '<start>'|NULL, DATE02 = '<end>'|NULL  WHERE FINDOC = <id> AND MTRTYPE = 1
```

**Completed orders (`status = 1`) are never written back** — the planner shows them as grey, immovable, lock-iconed blocks for context only.

---

## 4. Current status (as of 2026-11-15)

### Done
- ✅ Order-centric refactor (no more separate blocks / phases arrays)
- ✅ Real Soft1 queries wired in (machines, phases, orders, shifts, mtrl tree)
- ✅ Phase names via `STAGE` subquery in `SPCOSTGROUP` SELECT
- ✅ Phase-machine many-to-many eligibility
- ✅ Per-machine (not per-group) shifts, 7-day week, up to 3 shifts/day
- ✅ Provisional shifts (planner-local, not saved to Soft1): click no-shift band → modal, right-click shift band → remove
- ✅ Locked completed orders (status=1) with grey/lock-icon styling
- ✅ Pre-assigned pin (📌) for orders with CCCFXRSRC already set in DB
- ✅ Reassigned dashed-orange border when planner moves from original
- ✅ Dynamic duration = setup + (metres/speed) + wait, recomputed per target machine during dragover
- ✅ Conflict detection + rejection on drop (prevents overlaps that were causing stuck blocks)
- ✅ Issue panel with per-issue ✕ remove button (rescues stuck blocks)
- ✅ Deadline-violation marker (red triangle on blocks running past `deliveryDate`)
- ✅ Excel export (3 sheets: Schedule, Utilisation, Orders)
- ✅ Lazy load: metadata parallel, then week-orders, then unscheduled pages of 300
- ✅ 1970-epoch date filtering (null-DB values appeared as 01/01/1970)
- ✅ Out-of-week orders no longer render at the Gantt edge; also hidden from unscheduled panel
- ✅ O(1) lookup maps `orderById` / `machineById` for the 1000+ scale
- ✅ Light theme enforced (`color-scheme: light` + explicit colors) — Soft1 sometimes injects dark CSS
- ✅ **Cloudflare Worker scaffold** (wrangler.jsonc, worker/index.js, routes, Soft1 client, KV sessions)
- ✅ **Login page** (`public/login.html` + `src/login.js`) — Soft1 Web Accounts flow
- ✅ **Dual-mode bridge** — Soft1Bridge auto-detects embedded | web | mock; ALL methods async
- ✅ **GitHub repo** initial commit pushed to https://github.com/emperorkk/production-planning

### Pending (needs user action before Worker can go live)
1. **Fill `wrangler.jsonc`:** set `vars.SOFT1_API_URL` to the real S1Services endpoint (e.g. `https://xxx.oncloud.gr/s1services`), set `SOFT1_COMPANY` / `SOFT1_BRANCH`
2. **Create KV namespace:** `npx wrangler kv namespace create SESSIONS` → paste id into `wrangler.jsonc`
3. **Deploy Soft1 "JS" script named `RUNSQL`** on the Soft1 server:
   ```js
   try { X.RUNSQL(param1, null); return { success: true }; }
   catch (e) { return { success: false, error: e.message }; }
   ```
   This is what `/api/exec` calls to run the two whitelisted UPDATEs. Reads via `/api/sql` → `SqlData` service work without any server-side script.
4. **Optional:** `npx wrangler secret put SOFT1_APP_ID` if the default `703` isn't right for Vlachos Bros.
5. **Test the login flow end-to-end** — the exact field names returned by `/login` / `/authenticate` may vary per Soft1 version. The client in `worker/soft1-client.js` assumes the standard shape; adjust if needed.

### Known limitations / future work
- **Date math in queries** uses `GETDATE()` (MSSQL). `Soft1Bridge.nowFn()` picks between `GETDATE()` / `SYSDATE` / `NOW()` based on `dbType`, but in web mode `dbType` is hardcoded to 3 (MSSQL). If Vlachos Bros isn't on MSSQL this needs fixing.
- **`CCCFXPCALLNS`** currently doesn't have `STARTTIME`/`ENDTIME` columns — user plans to add them. When that happens, replace `SHIFT_TIMES` constant with per-row values.
- **Phase names** come from a subquery `(SELECT NAME FROM STAGE WHERE COMPANY=SPCOSTGROUP AND STAGE=CCCSTAGE)` — note the join against `SPCOSTGROUP` (table name used as implicit column alias). If results are wrong, verify this subquery against real schema.
- **Multi-phase "combine runs" hint** (same `PRDMTRL` can skip setup): `state.mtrlTree` is loaded from `CCCFXPRNOMINAL` but not yet consumed by any logic.
- **No audit trail / undo stack** — save is a one-shot write; previous plan is lost.
- **No real-time collaboration** — two planners editing the same week will overwrite each other.
- **Excel export** has no styling (just raw sheets + column widths).

---

## 5. How to work with it

### Local Worker dev
```bash
cd C:\Users\konst\production-planning
npm install
npm run dev       # wrangler dev — opens on http://localhost:8787
```

### Deploy Worker
```bash
npm run deploy    # wrangler deploy
npm run tail      # live logs
```

### Keep the embedded version in sync
After editing anything in `public/`, mirror it into the Soft1 install folder:
```bash
npm run sync-embedded   # copies public/* → C:\SoftOne\Vlachos Bros\ (skips login.html/login.js)
```

### Git
```bash
git push origin main      # schannel SSL required: git config --global http.sslBackend schannel
```

---

## 6. Performance decisions (for the 1000–1500 order scale)

- **Lazy load pipeline** in `ui-controller.js _loadData()`:
  1. Metadata (machines, phase-map, shifts) in parallel — `Promise.all`
  2. Week orders (small, fast)
  3. Unscheduled paged in batches of 300 (DATE01 IS NULL) via `_loadUnscheduledPage(offset)`
  4. MTRL tree loaded in background (not awaited)
- **Cancellation token** `_loadToken` — incremented on every week change so in-flight loaders abort cleanly
- **O(1) lookups** `state.orderById` / `state.machineById` built once per load — replaces O(n) `.find()` in hot paths
- **DocumentFragment** for the unscheduled panel; **500-row cap** with "X more — filter to find" hint
- **Virtualisation NOT implemented** — relies on the cap + search instead; may need actual virtual scrolling if cap feels too aggressive

---

## 7. UX decisions worth preserving

- **Drag an order onto an ineligible machine** → ghost shows `drop-blocked`, drop is refused silently
- **Drop causing overlap on same machine** → refused with toast naming the collider: *"Επικάλυψη με 359123 (10:00–14:30) — ακυρώθηκε"*
- **Issue panel ✕ button** → clears that order's machine/start/end (recovery for stuck blocks hidden under others)
- **Context menu** on a scheduled block: Edit duration, Remove from schedule
- **Right-click a provisional shift band** → confirm then delete
- **Toolbar pill** `⚠ N προσ. βάρδιες` when provisional shifts active; click to clear all
- **Mock-mode banner** appears when running outside Soft1 with no HTTP (file://)
- **Save button disabled** unless `state.dirty` — becomes enabled on first change
- **Beforeunload guard** prompts if dirty

---

## 8. Known gotchas (things that bit us previously)

1. **GitHub username has no separator**: `emperorkk` — NOT `emperor_kk` (invalid, no underscores on GitHub) and NOT `emperor-kk`.
2. **Git on Windows needs `schannel`** SSL backend or push fails with cert errors.
3. **Can't `git init` in `C:\SoftOne\Vlachos Bros\`** — it's the SoftOne install directory with hundreds of DLLs/EXEs.
4. **Shift query: `L.RSRC` not `A.RSRC`** — RSRC is on the LINES table (`CCCFXPCALLNS`), not the header. User caught this mid-refactor.
5. **Soft1 returns null dates as 01/01/1970** (unix epoch). `_parseDate` rejects anything with `getFullYear() < 1990`.
6. **Orders scheduled in OTHER weeks** must be filtered out of both the Gantt (would clamp to edge) and the unscheduled panel (would wrongly re-offer them). Done in both places.
7. **The `SPCOSTGROUP` subquery for phaseName** uses `WHERE COMPANY=SPCOSTGROUP` — this is Soft1 convention using table name as alias; it's not a typo.
8. **Embedded mode is sync COM; web mode is async fetch** — bridge wraps both as `async`. If you see a non-awaited `.query()` call somewhere, that's a bug.
9. **Soft1 `nowFn()` in web mode hardcodes MSSQL (`GETDATE()`)** — fine for Vlachos Bros but will break on other DBs.
10. **`/api/exec` whitelist is strict** — if you add new UPDATE statements to `data-service.js WRITE`, you must also update the `ALLOWED_PREFIXES` regex array in `worker/routes/sql.js`.

---

## 9. User preferences learned

- **Terse responses** — short status, no trailing summaries unless asked
- **Ask before major refactors** — the user says "Provide feedback before moving on to making any changes" when a design question is on the table; honour that pattern
- **User edits SQL queries manually** — they'll paste updated queries in chat, often with inline tweaks (e.g. adding `ISNULL(LS.DELIVDATE, L0.DELIVDATE)` or correcting `A.RSRC` → `L.RSRC`); apply their exact SQL rather than rewriting it
- **Greek UI labels throughout** (Πρόγραμμα Παραγωγής, Μη Προγραμματισμένες, Αυτόματο, Έξοδος, etc.)
- **One file-naming quirk:** `xlsx.mini.min.js` had to be renamed to `xlsx.min.js` to match the HTML reference

---

## 10. Where to start for common next tasks

| Task | Where to look / change |
|---|---|
| Add a new SELECT query | `public/src/data-service.js` → `QUERIES` object + a new async method on `DataService`; no Worker changes needed (any SELECT passes the guard) |
| Add a new write-back field | `public/src/data-service.js` → `WRITE` object AND `worker/routes/sql.js` → `ALLOWED_PREFIXES` regex |
| Change the shift calculation | `public/src/data-service.js` → `SHIFT_TIMES` + `_explodeShifts()` |
| Change block appearance | `public/src/gantt-renderer.js` → `renderBlocks()` + CSS in `styles.css` |
| Change drop validation | `public/src/ui-controller.js` → `DragDropManager.on('drop', ...)` handler |
| Add a new Worker route | `worker/index.js` route table + `worker/routes/*.js` |
| Soft1 Web Services call shape | `worker/soft1-client.js` → `callService()` wraps all POSTs |

---

## 11. Immediate next step the user is likely to ask about

- **Get the Worker deployed** — walk the user through the 3 setup steps (§4 Pending) with their actual S1Services URL
- **Validate the login flow** against real Soft1 — the login/authenticate response shape in `loginAndAuthenticate()` is best-effort; may need tweaks once we see real responses
- **Build the Soft1 `RUNSQL` script** — tiny 3-liner, but needs to be deployed on their Soft1 server for writes to work
- **Possibly add Cloudflare Access** in front of the Worker for extra auth layer before the Soft1 login (CF Access = org SSO, then Soft1 login = app-level)
