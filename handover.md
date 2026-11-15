# HANDOVER — Production Planning (Vlachos Bros)

> Read this first. It contains everything a new chat session needs to pick up where the previous one left off.

---

## 1. What this project is

A visual **production-scheduling planner** for Vlachos Bros, a factory running SoftOne ERP. The user is **Konstantinos (kkourentzes@gmail.com)**, aka GitHub `emperorkk`.

The planner lets a shop-floor scheduler drag production orders onto a weekly Gantt grid of machines, respects shift calendars and phase-machine eligibility, computes block duration from machine speed + setup/wait times, and writes the plan back to Soft1. All UI is in **Greek**.

**Architecture (Worker-only since 2026-11-15):**

```
browser ──/api/data {dataset, params}──▶ Worker ──/s1services/JS/Foxline.planning/<Get...>──▶ Soft1
        ──/api/save {orders[]}────────▶        ──/s1services/JS/Foxline.planning/SaveSchedule─▶
```

- Auth: Soft1 Web Accounts login (`login.html` → built-in `login` + `authenticate` services).
- **All SQL lives in `soft1/Foxline.planning.js`** (Soft1 AJS web service). The browser never sends SQL.
- `file://` open of `public/production-planner.html` = **mock mode** (demo data).

> ⚠️ **Embedded mode (Soft1 `x=external` / `window.external` COM) is DEPRECATED.** Frozen in `legacy/embedded/` — **no further updates**. Do not port new features there.

---

## 2. Repository

- **GitHub:** https://github.com/emperorkk/production-planning (the username is `emperorkk` — no separators; `emperor_kk` and `emperor-kk` both fail to resolve)
- **Local clone:** `C:\Users\konst\production-planning\`
- **Legacy embedded deploy target (deprecated):** `C:\SoftOne\Vlachos Bros\` (SoftOne install dir — do NOT `git init` there; it has hundreds of binaries)
- **Git config:** user `kkourentzes@gmail.com`, Windows cert store (`http.sslBackend=schannel`) required for push
- **Attribution footer on commits:** `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` (from the harness reminder)

### Layout

```
public/                           ← Worker's static assets root
├── login.html                    ← Soft1 Web Account login form (web mode only)
├── production-planner.html       ← main app (both modes use this entry)
└── src/
    ├── soft1-bridge.js           ← web | mock; dataset(name, params) + saveSchedule(orders); ALL async
    ├── data-service.js           ← dataset calls + row mapping + shift explode (NO SQL)
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
├── session.js                    ← KV-backed sessions (random id), HttpOnly cookie
└── routes/
    ├── auth.js                   ← /api/login, /api/logout, /api/me
    └── data.js                   ← /api/data (dataset whitelist), /api/save (structured orders)
soft1/
└── Foxline.planning.js           ← Soft1 AJS web service — ALL SQL (Get* datasets + SaveSchedule) — paste into Soft1
legacy/embedded/                  ← DEPRECATED x=external planner — FROZEN, no further updates
wrangler.jsonc                    ← Worker config (KV + env vars)
package.json                      ← npm scripts: dev | deploy | tail | sync-embedded-legacy
scripts/sync-to-softone.mjs       ← LEGACY: mirror legacy/embedded/ → C:\SoftOne\Vlachos Bros\
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
- ✅ **Worker-only** — embedded mode deprecated & frozen in `legacy/embedded/`; bridge is web | mock
- ✅ **AJS web service `soft1/Foxline.planning.js`** — named datasets (SQL moved out of the browser) + batched `SaveSchedule`
- ✅ **GitHub repo** initial commit pushed to https://github.com/emperorkk/production-planning

### Pending (needs user action before Worker can go live)
1. ~~**Fill `wrangler.jsonc`:**~~ DONE — `SOFT1_API_URL = https://01104398142024.oncloud.gr/s1services`; `SOFT1_COMPANY`/`SOFT1_BRANCH` left empty on purpose → falls back to first company/branch returned by `/login`; `account_id` set to **ONECODE Support** (`af6abc318e022147698714a45b9ba92e`)
2. ~~**Create KV namespace**~~ DONE — `production-planning-SESSIONS` (`2bf8852d955c4bcbb1def4e4d3ccef37`) on ONECODE Support
3. **Deploy the Soft1 AJS web service `Foxline.planning`** — source in `soft1/Foxline.planning.js`. Reached at `https://01104398142024.oncloud.gr/s1services/JS/Foxline.planning/<fn>` with body `{ clientID, ...params }`:

   | Function | Params | Returns |
   |---|---|---|
   | `Ping` | — | `{ success, user, company }` |
   | `GetMachines` | — | `{ success, count, data:[rows] }` |
   | `GetPhaseMachines` | — | 〃 |
   | `GetOrdersInWeek` | `weekStart`, `weekEnd` (YYYY-MM-DD) | 〃 |
   | `GetUnscheduledOrders` | `offset`, `pageSize` (≤1000) | 〃 |
   | `GetProductionOrders` | `weekStart`, `weekEnd` | 〃 |
   | `GetShifts` | `monday` (YYYY-MM-DD) | 〃 |
   | `GetMtrlTree` | — | 〃 |
   | `SaveSchedule` | `orders:[{findoc, machine\|null, start\|null, end\|null}]` (YYYY-MM-DD HH:MM) | `{ success, saved, skipped, errors[] }` |

   - Company always from `X.SYS.COMPANY`; params validated (ISO dates / ints) before going into SQL.
   - Colons inside SQL string literals are rewritten as `'+CHAR(58)+'` (Soft1 treats `:x` as a param marker).
   - `SaveSchedule` builds both UPDATEs server-side (dates via `DATEADD(MINUTE, n, 'YYYYMMDD')`), skips `MTRSTS=1`, checks `SOSOURCE=5171` + company.
   - The built-in `SqlData` service is NOT used (it only runs stored SQL by name).
4. ~~**appId**~~ DONE — `SOFT1_APP_ID = 1199` in `wrangler.jsonc` vars
5. **Test the login flow end-to-end** — the exact field names returned by `/login` / `/authenticate` may vary per Soft1 version. The client in `worker/soft1-client.js` assumes the standard shape; adjust if needed.

### Known limitations / future work
- **Date math in queries** uses `GETDATE()` (MSSQL) directly in `Foxline.planning.js`.
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

### Update the Soft1 AJS service
After editing `soft1/Foxline.planning.js`, paste it into the `Foxline.planning` script in Soft1. (Worker deploys don't touch it.)

### Legacy embedded (DEPRECATED — frozen, no further updates)
```bash
npm run sync-embedded-legacy   # copies legacy/embedded/* → C:\SoftOne\Vlachos Bros\
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
8. **Bridge is async** — if you see a non-awaited `Soft1Bridge.dataset()` / `saveSchedule()` call, that's a bug.
9. **Embedded is frozen** — `legacy/embedded/` must not receive new features or fixes. Everything goes to `public/` + `worker/` + `soft1/`.
10. **New dataset = 3 places**: function in `soft1/Foxline.planning.js` + entry (name → allowed params) in `DATASETS` in `worker/routes/data.js` + caller in `data-service.js`. Unlisted names/params are rejected by the Worker.
11. **AJS = ES3** — no `JSON.parse`, arrow functions or `Array.isArray`; use `eval(ds.JSON)` for dataset → rows (as in `Production.scale`).
12. **Unverified:** whether `ds.JSON` keeps column-alias case (`plannedStartDataTime`, `average_speed_in_metres_per_minute`) and its datetime string format. Check the first `GetMachines` / `GetOrdersInWeek` response.

---

## 9. User preferences learned

- **ALWAYS bump `package.json` "version" on every merge to main** (patch = fix, minor = feature). It's shown on the live site (login page + planner toolbar, via `/api/version`) so the user can tell which build is deployed. Mention the new version when reporting the merge.

- **Terse responses** — short status, no trailing summaries unless asked
- **Ask before major refactors** — the user says "Provide feedback before moving on to making any changes" when a design question is on the table; honour that pattern
- **User edits SQL queries manually** (now in `soft1/Foxline.planning.js`) — they'll paste updated queries in chat, often with inline tweaks (e.g. adding `ISNULL(LS.DELIVDATE, L0.DELIVDATE)` or correcting `A.RSRC` → `L.RSRC`); apply their exact SQL rather than rewriting it
- **Greek UI labels throughout** (Πρόγραμμα Παραγωγής, Μη Προγραμματισμένες, Αυτόματο, Έξοδος, etc.)
- **One file-naming quirk:** `xlsx.mini.min.js` had to be renamed to `xlsx.min.js` to match the HTML reference

---

## 10. Where to start for common next tasks

| Task | Where to look / change |
|---|---|
| Add / change a query | `soft1/Foxline.planning.js` (new `Get...` function) → `worker/routes/data.js` `DATASETS` → `public/src/data-service.js` caller. Changing only the SQL of an existing dataset = AJS only |
| Add a new write-back field | `soft1/Foxline.planning.js` → `SaveSchedule` AND `worker/routes/data.js` → `validOrder` AND `public/src/data-service.js` → `saveOrders` payload |
| Change the shift calculation | `public/src/data-service.js` → `SHIFT_TIMES` + `_explodeShifts()` |
| Change block appearance | `public/src/gantt-renderer.js` → `renderBlocks()` + CSS in `styles.css` |
| Change drop validation | `public/src/ui-controller.js` → `DragDropManager.on('drop', ...)` handler |
| Add a new Worker route | `worker/index.js` route table + `worker/routes/*.js` |
| Soft1 Web Services call shape | `worker/soft1-client.js` → `callService()` wraps all POSTs |

---

## 11. Immediate next step the user is likely to ask about

- **Get the Worker deployed** — walk the user through the 3 setup steps (§4 Pending) with their actual S1Services URL
- **Validate the login flow** against real Soft1 — the login/authenticate response shape in `loginAndAuthenticate()` is best-effort; may need tweaks once we see real responses
- **Deploy `soft1/Foxline.planning.js`** on Soft1 and test `Ping` → `GetMachines` → `GetOrdersInWeek` → `SaveSchedule`
- **Possibly add Cloudflare Access** in front of the Worker for extra auth layer before the Soft1 login (CF Access = org SSO, then Soft1 login = app-level)
