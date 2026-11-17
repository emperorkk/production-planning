# HANDOVER — Production Planning (Vlachos Bros)

> Read this first. It contains everything a new chat session needs to pick up where the previous one left off.
> **Current version: v0.8.1** (live on `main`, last updated 2026-11-17). Short rules for agents are in `CLAUDE.md`.

---

## 1. What this project is

Two apps behind one Worker + one Soft1 login: the **planner** (Προγραμματισμός, below) and **Διαχείριση παραγωγής** (`production.html`, mobile-first — see §6b).

A visual **production-scheduling planner** for Vlachos Bros (ΑΦΟΙ ΒΛΑΧΟΥ Α.Β.Ε.Ε., company 1000), a packaging factory running SoftOne ERP. The user is **Konstantinos (kkourentzes@gmail.com)**, GitHub `emperorkk`.

A shop-floor scheduler drags production orders onto a weekly Gantt grid of machines. The planner respects the machines' shift calendar and phase-machine eligibility, computes block duration from machine speed + setup/wait **in working time**, checks the phase chain, shows production progress (rolls/lots) and writes the plan back to Soft1. It also edits the Soft1 production calendar (shifts). **All UI is in Greek; all dates are dd/mm/yyyy.**

### Architecture (Worker-only)

```
browser (public/*)                Cloudflare Worker (worker/*)                 Soft1 (oncloud)
─────────────────                 ────────────────────────────                 ───────────────
login.html ──/api/login──────────▶ login + authenticate (built-in services) ──▶ /s1services
planner    ──/api/data {dataset}──▶ whitelist → /JS/Foxline.planning/<Get…> ──▶ custom AJS (all SQL)
           ──/api/save {orders}──▶ shape check → …/SaveSchedule
           ──/api/calendar {…}───▶ action whitelist → …/Get|Create|Save…CalendarWeek, FillMissingWeeks
           ──/api/record {RSRC}──▶ native getData (OBJECT=RSRC, fixed LOCATEINFO)
           ──/api/change-password ─▶ native changePassword {clientID, appId, OLD, NEW}
           ──/api/me, /api/version, /api/logout
production ──/api/data {Pm…}────▶ PRODUCTION_DATASETS → /JS/Foxline.planning/Pm… ─▶ custom AJS
 .html     ──/api/machine ───────▶ native setData OBJECT=RSRC (SETUPTIME, MPRDQTY only)
           ──/api/move ──────────▶ …/SaveSchedule (dates only, same machine, optimistic lock required)
```

**Access levels** (`worker/access.js`, chosen on the login page, stored in the session):
| access | Soft1 appId | Can use |
|---|---|---|
| `full` | `SOFT1_APP_ID` 1199 | planner + calendar + production app |
| `production` | `SOFT1_APP_ID_PRODUCTION` 1200 | production app only — planner pages redirect to `/production.html`; `/api/save`, `/api/calendar` and planner datasets → 403 |

Sessions from before v0.8 (no `access`) count as `full`. The session's appId is used for getData / setData / changePassword. **Landing:** `/` and post-login → planner for full access on desktop, otherwise `/production.html`. Phones (UA `Mobi`/iPhone/Android Mobile) are always redirected away from the planner pages.

- **Live URL:** https://vbpp.onecode.win (Cloudflare Workers, account **ONECODE Support**, Worker `production-planning`).
- **Deploy:** Cloudflare Workers Builds deploys **`main`** automatically (`bun install` → `npx wrangler deploy`). Merging to `main` = deploying.
- **Soft1:** `https://01104398142024.oncloud.gr/s1services`, appId **1199**.
- **All SQL lives in `soft1/Foxline.planning.js`** (Soft1 AJS web service). The browser never sends SQL. After changing that file the user must **paste it into the `Foxline.planning` script in Soft1** — Worker deploys don't touch it.
- Opening `public/production-planner.html` / `calendar.html` as `file://` = **mock mode** (demo data, no Soft1).
- ⚠️ **Embedded mode** (Soft1 `x=external` / `window.external` COM) is **DEPRECATED and frozen** in `legacy/embedded/` — no further updates.

---

## 2. Repository & workflow

- **GitHub:** https://github.com/emperorkk/production-planning (username `emperorkk` — no separators).
- **User's local clone:** `C:\Users\konst\production-planning\` (Windows; git needs `http.sslBackend=schannel`).
- **Cloud (Claude Code) sessions:** work on the session's `claude/...` branch (so far `claude/charming-hamilton-9iqrpk`), commit + push there. **Merge to `main` only when the user says "merge"** — done as a fast-forward `git push origin HEAD:main` (check `git merge-base --is-ancestor origin/main HEAD` first). A push to `main` without an explicit "merge" gets blocked by the session's permission classifier.
- **Every merge bumps `package.json` "version"** (patch = fix, minor = feature). The live site shows it (login page + toolbar via `/api/version`); state the new version when reporting a merge.
- Commit attribution: use the lines from the harness reminder (do not hard-code a model name).

### Layout

```
public/                           ← Worker static assets (all gated by session except login/src/icons)
├── login.html                    ← Soft1 Web Account login (+ version label, icon)
├── production-planner.html       ← main app
├── calendar.html                 ← production calendar editor (CCCFXPCAL weeks)
├── production.html               ← Διαχείριση παραγωγής (mobile-first) + production.webmanifest + sw.js (public)
├── favicon.ico, icons/*, manifest.webmanifest   ← app icon (OpenAI-generated; source assets/icon-source-1024.png)
└── src/
    ├── date-fmt.js               ← DateFmt: dd/mm/yyyy display + parse + text-input binding (load first)
    ├── soft1-bridge.js           ← web | mock: dataset(), saveSchedule(), calendar(), record(), session/expiresAt
    ├── data-service.js           ← dataset calls + row mapping + shift explode + work minutes (NO SQL)
    ├── work-time.js              ← WorkTime: per-machine working intervals (addWork/workBetween/utilisation)
    ├── scheduler-engine.js       ← conflicts, deadlines, phase chain index/violations, smart autoPlace
    ├── gantt-renderer.js         ← DOM Gantt: shift bands, blocks, badges, progress bar, heatmap, util rows
    ├── drag-drop-manager.js      ← HTML5 DnD + resize; asks controller for computeSpan (shift-aware)
    ├── ui-controller.js          ← state, loading pipeline, all event wiring, undo/draft/filters/calendar UI
    ├── info-card.js              ← floating cards: machine (native getData RSRC), order (details+production+chain)
    ├── print-view.js             ← shop-floor print (per machine → day → shift)
    ├── excel-exporter.js         ← SheetJS export (3 sheets)
    ├── calendar.js / calendar.css← calendar page
    ├── login.js, version.js      ← login (access picker, landing); fills [data-app-version]
    ├── app-shell.js / .css       ← shared chrome: app switcher · 🔑 change password · Έξοδος (planner toolbar / production menu)
    ├── production-app.js / production.css ← Διαχείριση παραγωγής (views, mock data for file://)
    ├── styles.css
    └── lib/xlsx.min.js           ← SheetJS bundled (no CDN)
worker/
├── index.js                      ← routes, auth gate (public: /login.html, /favicon.ico, /manifest, /src/*, /icons/*)
├── soft1-client.js               ← login/authenticate, callJS (AJS), getDataset, saveSchedule, getRecord (getData)
├── encoding.js                   ← decodeSoft1(): UTF-8 if valid, else windows-1253 (own table)
├── session.js                    ← KV sessions (random 256-bit id, 8 h TTL), HttpOnly cookie pp_sid
├── version.js                    ← VERSION from package.json
├── access.js                     ← access levels, appId per session, landing, mobile detection
└── routes/
    ├── auth.js                   ← /api/login, /api/logout, /api/me (+ expiresAt), /api/change-password
    ├── data.js                   ← /api/data (DATASETS whitelist + params), /api/save (validOrder)
    ├── record.js                 ← /api/record (RECORDS whitelist: RSRC + LOCATEINFO)
    ├── calendar.js               ← /api/calendar (ACTIONS: get | weeks | create | save | fill)
    └── production.js             ← /api/machine (setData RSRC: SETUPTIME, MPRDQTY), /api/move (dates via SaveSchedule, ≤10 orders)
soft1/Foxline.planning.js         ← Soft1 AJS web service — ALL SQL — paste into Soft1
legacy/embedded/                  ← DEPRECATED x=external planner — FROZEN
scripts/sync-to-softone.mjs       ← LEGACY: legacy/embedded → C:\SoftOne\Vlachos Bros\ (npm run sync-embedded-legacy)
wrangler.jsonc                    ← account, assets (html_handling none, run_worker_first true), KV, vars
package.json / package-lock.json  ← version + wrangler
CLAUDE.md                         ← short agent rules
README.md                         ← user-facing setup
handover.md                       ← this file
```

### wrangler.jsonc (current values)

| Key | Value |
|---|---|
| `account_id` | `af6abc318e022147698714a45b9ba92e` (ONECODE Support) |
| `assets` | `./public`, `html_handling: "none"`, `not_found_handling: "none"`, `run_worker_first: true` |
| KV `SESSIONS` | `production-planning-SESSIONS` = `2bf8852d955c4bcbb1def4e4d3ccef37` |
| `SOFT1_API_URL` | `https://01104398142024.oncloud.gr/s1services` |
| `SOFT1_APP_ID` | `1199` (required — access `full`) |
| `SOFT1_APP_ID_PRODUCTION` | `1200` (access `production` — Διαχείριση παραγωγής only) |
| `SOFT1_COMPANY` / `SOFT1_BRANCH` | empty → use the `objs[]` entry Soft1 returns at login |
| `SOFT1_JS_SCRIPT` | `Foxline.planning` |

No Worker secrets are needed (`SESSION_SECRET` is NOT used — sessions are random ids in KV).

---

## 3. Data model — read before touching queries

### Order-centric

Each `FINDOC` with `SOSOURCE = 5171` = **one production order = one phase = one Gantt block**. A multi-step job (print → laminate → slit → bag) is several independent FINDOCs linked through the recipe `CCCFXPRNOMINAL`.

```js
order = {
  id: String(FINDOC), description: M.CODE + ' ' + M.NAME,
  deliveryDate: ISNULL(LS.DELIVDATE, L0.DELIVDATE),   // LS = parent sales order line
  kilos: L0.QTY1, linearMetres: L0.QTY2,
  plannedStart: L0.DATE01, plannedEnd: L0.DATE02,      // null = unscheduled
  status: D.MTRSTS,        // -1 created | 0 released | 1 completed (locked, never written)
  phase: D.STAGE,          // defines eligible machines
  machineId: F.CCCFXRSRC,  // pre-assigned (📌) or planner-set
  mtrl: L0.MTRL, salesOrderRef: L0.FINDOCS,
  // planner-only: _origMachineId/_origStart/_origEnd (as loaded), _workMin, _skipSetup,
  //               _userOverridden, _prod {rolls, producedQty, firstLot, lastLot, …}
}
```

Open orders: **1000–1500** at any time → staged loading (§6). Orders query (in `_ordersBaseSelect()` of the AJS) filters `ISNULL(LS.DELIVDATE,L0.DELIVDATE) >= GETDATE() - 180`.

### Machines & phases
- Machines: `RSRC WHERE SODTYPE=25 AND RSRCTYPE<50` — `SETUPTIME`, `WAITTIME` (min), `MPRDQTY` (m/min), `CCCFXSTAGE` (home phase).
- Eligibility (many-to-many): `SPCOSTGROUP (CCCRSRC, CCCSTAGE)`; phase name `(SELECT NAME FROM STAGE WHERE COMPANY=SPCOSTGROUP AND STAGE=CCCSTAGE)` — table-name-as-alias is Soft1 convention, not a typo. Always show `phaseName`, not the code.
- Phases seen at Vlachos: 1001 Εκτύπωση, 2001 Λαμινάρισμα, 3001 Ρολοκοπή, 4001 Σακουλοποίηση.

### Duration = working time
`work minutes = SETUPTIME + linearMetres / MPRDQTY + WAITTIME` (rounded to 5', min 15'; setup skipped on combined runs). `WorkTime.addWork(machine, start, minutes)` consumes only time **inside that machine's shifts**: start snaps to the next shift, gaps are skipped, `overflow` = ran past the last known shift. Block width spans clock time (gaps included).

### Production calendar (shifts) — OBJECT `CCCFXPCAL`
Verified with a native getData of week 47:
- **Header `CCCFXPCAL`**: key `CCCFXPCAL` = `CODE` = `NAME` = ISO week `'YYYYWW'` (e.g. 202647), `FROMDATE`/`FINALDATE`, `DATE01..DATE07` (Mon..Sun), `WK`, `COMPANY`.
- **Lines `CCCFXPCALLNS`**: `CCCFXPCALLNS` (id), `CCCFXPCAL`, `LINENUM`, **`RSRC`** (on the lines, not the header), `S{day}{shift}` flags `S11..S73` (day 1=Mon..7=Sun, shift 1..3).
- Shift times (constant `SHIFT_TIMES` in `data-service.js`): 1 = 06–14, 2 = 14–22, 3 = 22–24 + 00–06 next day (carry-over). Planned: per-row `STARTTIME/ENDTIME` on `CCCFXPCALLNS` → replace the constant then.
- No calendar row for a machine/week = **machine unavailable**. Provisional shifts are browser-only (per session) unless converted «Σε Soft1».
- Flags travel as a 21-char string `'S11 S12 S13 S21 … S73'` of 0/1 (`lines:[{rsrc, s}]`).

### Production progress — `CCCFXPRDOPRD`
One row = one produced **roll**: `FINDOC` (production order), `FINCODE` (ΚΠ…), `TRNDATE`, `MTRL`, `CODE`, `NAME`, `MTRLOT`, `QTY1`, `LOTCODE`, `ITEDOC`, `WHOUSE`. Progress % = Σ`QTY1` / order `QTY1` (assumes same unit, kg). Only the FINDOCs on the visible Gantt are requested.

### Phase chain — `CCCFXPRNOMINAL`
Lines `MTRL, LINENUM, RAW1MTRL..RAW4MTRL, PRDMTRL, STAGE, PRDQTY1, PRDQTY2`. `PRDMTRL` is produced from the RAWs. **Predecessor** of an order (mtrl X) = any order producing one of X's raws, with the same sales order when both are known. Violation = order starts before its predecessor ends.

### Write-back (SaveSchedule, server-side SQL)
```sql
UPDATE FINDOC   SET CCCFXRSRC = <int>|NULL WHERE FINDOC = <id>
UPDATE MTRLINES SET DATE01 = DATEADD(MINUTE, n, 'YYYYMMDD')|NULL, DATE02 = … WHERE FINDOC = <id> AND MTRTYPE = 1
```
Only `SOSOURCE=5171`, own company, `MTRSTS<>1`. **Order locks** (v0.9): `FINDOC.BOOL01 = 1` → reserved machine (SaveSchedule refuses another machine or unscheduling); `FINDOC.BOOL02 = 1` → locked production day 06:00→06:00 of the current DATE01 (refuses a start in another production day or unscheduling). **Optimistic lock:** the payload carries `origMachine/origStart/origEnd`; if the DB differs → not written, reported as conflict (order stays dirty).

---

## 4. Soft1 AJS web service `Foxline.planning` (soft1/Foxline.planning.js)

`POST https://01104398142024.oncloud.gr/s1services/JS/Foxline.planning/<fn>` with body `{ clientID, ...params }`.

| Function | Params | Returns |
|---|---|---|
| `Ping` | — | `{ success, user, company }` |
| `GetMachines` | — | `{ success, count, data:[rows] }` |
| `GetPhaseMachines` | — | 〃 |
| `GetOrdersInWeek` | `weekStart`, `weekEnd` (YYYY-MM-DD) | 〃 |
| `GetUnscheduledOrders` | `offset`, `pageSize` (≤2000, default 1000) | 〃 |
| `GetProductionOrders` | `weekStart`, `weekEnd` | 〃 (full load, fallback) |
| `GetShifts` | `monday` | 〃 (CCCFXPCAL + lines for that week) |
| `GetMtrlTree` | — | 〃 |
| `GetOrderDetails` | `findoc` | 〃 (fincode, item, customer, sales order, PO, delivery, qty, status, machine, remarks) |
| `GetProduction` | `findocs` ('1,2,3', ≤1000) | per order `{id, rolls, producedQty, firstDate, lastDate, firstLot, lastLot}` |
| `GetOrderMaterials` | `findoc` | materials of the order (`MTRLINES` MTRTYPE 0, SOSOURCE 5171, SODTYPE 51) `{lineNum, mtrl, code, name, qty, unit}` — planner order card + production app order sheet |
| `SetOrderLocks` | `findoc`, `machineLock` 0/1, `dayLock` 0/1, `machine`, `start`, `end` | sets `FINDOC.BOOL01` (reserved machine; also writes CCCFXRSRC) / `BOOL02` (locked production day; also writes DATE01/02) — worker `/api/order-locks` (full access) |
| `GetProductionRolls` | `findoc` | every roll `{fincode, trndate, qty, lot, mtrlot, whouse}` |
| `SaveSchedule` | `orders:[{findoc, machine, start, end, origMachine, origStart, origEnd}]` (YYYY-MM-DD HH:MM) | `{ success, saved, skipped, conflicts, errors[] }` |
| `GetCalendarWeek` | `monday` | `{ success, exists, header{id,code,wk}, data:[machine rows + S11..S73 + lineId] }` (all active machines, left-joined) |
| `GetCalendarWeeks` | `from`, `to` | `{ success, data:[{id, code, wk, monday}] }` |
| `CreateCalendarWeek` | `monday`, `copy` ('previous'\|'none') | `{ success, id, code, copiedFrom }` |
| `SaveCalendarWeek` | `monday`, `lines:[{rsrc, s:'21×0/1'}]` | `{ success, updated, inserted, errors[] }` |
| `FillMissingWeeks` | `from`, `to` (Mondays, ≤26 weeks) | `{ success, created[], skipped[], errors[] }` |
| `PmGetStageLines` | — | stage detail lines `{stage, line, name, sostatus, isLast}` (table `STAGE_LINES_TABLE` in the AJS — confirm name) |
| `PmGetMachineNow` | — | active machines + latest `CCCFXPRDOSTAGE` event (≤14 d) + that order's progress |
| `PmGetStageEvents` | `day` | stage events per machine for the production day (+ last event before it per machine) |
| `PmGetDaySchedule` | `day` | orders with a machine whose DATE01–DATE02 overlaps the production day + latest stage event (lock) |
| `PmGetOrderStages` | `findoc` | stage history of one order (time, line, operator, TIMEDIF, remarks, PC) |
| `PmGetMachineActivity` | `day` | roll timestamps per machine (day −1 … +2; client keeps 06:00→06:00) |
| `PmGetTodayProduction` | — | per machine `{machine, rolls, kg}` since the production day began (06:00) — totals row |
| `PmGetMachineList` | — | RSRC id, code, name, isActive, setupTime, waitTime, speed, phase, phaseName, remarks |
| `PmSearchProductionOrders` | `q`, `status` (open\|done\|all), `machine`, `limit` ≤200 | production orders (+ customer, sales order, progress) |
| `PmSearchCustomerOrders` | `q`, `limit` ≤200 | customer orders `SOSOURCE=1351 AND TFPRMS=201` (also those without production orders yet) + counts |
| `PmGetCustomerOrder` | `findoc` | production orders of one sales order |

Pm* roll time = `MTRLOT.INSDATE` (the scale's `setStock` creates one MTRLOT per roll), fallback `CCCFXPRDOPRD.TRNDATE` — **except slitting (3xxx)**: rolls are weighed after production, so their time is weighing time (UI says «Τελ. ζύγιση», no roll ticks on the idle timeline).

**Machine state = stage events (`CCCFXPRDOSTAGE`)**: one row per state change recorded by the shop floor — `CCCFXPRDOSTAGE` (id), `FINDOC`, `STAGE`, `STAGELINENUM`, `INSGRPOUP`, `INSUSER`, `INSDATE`, `REMARKS`, `PCNAME` (terminal), `TIMEDIF` (minutes, filled when the job closes). `STAGELINENUM` = `LINENUM` of the stage's detail lines (company 1000: 1 Setup, 2 Παραγωγή, 3 Κλείσιμο Βάρδιας, 4 Χαμ.Χρόνος, 5 Διάλλειμα, 6 Αναμονή Οδηγιών, 7 Ολοκλήρωση Παραγωγής; stage 900 is numbered differently, 6001 has one line). Category from `SOSTATUS`: 1 = setup, 2 = production/working, 3 = stop — **except «Αναμονή Οδηγιών» = stop** (`STOP_NAMES` in production-app.js, user decision); the stage's **last line = completion → «Χωρίς εργασία»**. Machine = `FINDOC.CCCFXRSRC` of the event's order. Idle view: segments between events, intersected with the shift calendar → production / setup / stops by reason / no job; utilisation = production ÷ elapsed shift time.

Implementation notes:
- **ES3 only** (Soft1 JS engine): no `JSON.parse`, arrow functions, `Array.isArray`; dataset → rows via `eval(ds.JSON)`; iterate datasets with `ds.FIRST; while(!ds.EOF){…; ds.NEXT;}`; field by name `ds[name]`.
- Company always `X.SYS.COMPANY`; every param validated (ISO dates, Mondays, ints, id lists) before it enters SQL.
- Soft1 treats `:x` inside SQL as a parameter marker → `sqlRows()` rewrites colons inside string literals as `'+CHAR(58)+'`; writes avoid colons entirely (`DATEADD(MINUTE, n, 'YYYYMMDD')`).
- `CreateCalendarWeek`: `X.CREATEOBJ('CCCFXPCAL')` → `DBINSERT` → header (key set only if the column is not IDENTITY — checked with `COLUMNPROPERTY`) → `APPEND` a line per active machine (flags copied from the latest earlier week, or zeros) → `DBPOST`, then dates/WK pinned with an SQL UPDATE. `SaveCalendarWeek`: existing lines → SQL UPDATE of changed flags; machines without a line → added through the object.
- The built-in `SqlData` service is NOT used (it only runs stored SQL by name).

---

## 5. Version history

| Version | What |
|---|---|
| 0.1.0 | Worker scaffold, Soft1 login, embedded + web modes (initial) |
| — | Config: Soft1 URL, ONECODE account, KV, appId 1199; AJS `Foxline.planning` named datasets (SQL out of the browser); embedded deprecated → `legacy/embedded/`; redirect-loop fix + auth gate on all pages; authenticate with REFID/MODULE from login `objs` |
| 0.2.0 | Version label (`/api/version`), app icon/favicon/manifest, faster open-orders load (pages of 1000), Soft1 timing (`Server-Timing`), windows-1253 decoding |
| 0.3.0 | Machine info card (native `getData` RSRC) |
| 0.4.0 | Production calendar (AJS + planner banner + Soft1 shift add/remove + provisional→Soft1 + `calendar.html`), shift-aware durations, magnet/combined runs, phase chain, smart auto-place, save conflict check, order card, undo/redo, draft autosave, navigation (Σήμερα, picker, ←/→, Ctrl+S), filters/sort/count, search-jump, session-expiry banner, print view, load heatmap |
| 0.5.0 | Production progress from `CCCFXPRDOPRD` (block progress bar + rolls, order card lots) |
| 0.5.1 | European dates `dd/mm/yyyy` everywhere (`date-fmt.js`, text date inputs) |
| 0.6.0 | Auto-place creates the missing calendar week from the previous one before planning |
| 0.7.0 | Change password (🔑 next to Έξοδος) via native Soft1 `changePassword` |
| 0.8.0 | **Διαχείριση παραγωγής** (`production.html`, mobile-first, burger menu, PWA install): running jobs, machine idle overview, production/customer order search, RSRC editing (setData). Shared app shell (switcher/🔑/Έξοδος). Access levels on login (1199 full / 1200 production-only), landing by device. Design system with light/dark/system theme (login + new app), phase-grouped overview with totals (`PmGetTodayProduction`), app icon from the Vlachos Bros mark |
| 0.8.1 | Planner Excel: «Αρ. εντολής» (FINCODE) next to the order id (sheets Πρόγραμμα + Παραγγελίες); AJS orders select returns `fincode` |

### Status
- ✅ Worker live at vbpp.onecode.win; login works against Vlachos Soft1; data loads (user reported speed + encoding issues → fixed).
- ✅ AJS deployed by the user (at least the dataset version). **The user must paste the latest `soft1/Foxline.planning.js` (v0.8.0: adds the Pm* functions)** — and confirm `STAGE_LINES_TABLE` (stage detail table name, placeholder `STAGELINES`).
- ⚠️ **Not yet verified on real Soft1:** `CreateCalendarWeek` / `SaveCalendarWeek` / `FillMissingWeeks` (object insert + date pin — check a created week opens normally in Soft1), `GetOrderDetails` columns (`F.REMARKS`, `S.VARCHAR01`), `RSRC` LOCATEINFO fields in `worker/routes/record.js`, whether `ds.JSON` keeps alias case and its datetime format.

### Known limitations / future work
- **Audit log:** the user already has one — integrate with `SaveSchedule` once access is provided.
- No real-time collaboration (conflict check prevents silent overwrites only).
- Provisional shifts live only in the browser session.
- Shift times are constants until `STARTTIME/ENDTIME` columns exist.
- Excel export is unstyled; print view is HTML (browser print). Sheets «Πρόγραμμα» and «Παραγγελίες» carry «Αρ. εντολής» (FINCODE, text) next to the order id.
- Unscheduled panel renders max 500 cards (filter/search to narrow); no virtual scrolling.
- If loading is still slow: the `ISNULL(LS.DELIVDATE,L0.DELIVDATE) >= GETDATE()-180` filter is non-sargable.

---

## 6. Features & UX (what the user sees)

**Planner (`production-planner.html`)**
- Toolbar: ← week label (click = date picker) → · Σήμερα · ↶ ↷ undo/redo · zoom − + · ⚙ Αυτόματο · provisional pill + «Σε Soft1» · 📅 calendar · 🖨 print · Excel · Αποθήκευση · 🔑 change password · Έξοδος.
- 🔑 opens a dialog (current / new / confirm) → `/api/change-password` → Soft1 `changePassword` with the session clientID + appId; Soft1 errors shown in the dialog; the session stays valid. Passwords are never logged. Keys: ←/→ week, Ctrl+Z/Ctrl+Y, Ctrl+S.
- Banners: unsaved changes; **missing calendar week** (create from previous / empty / open calendar); **session expires ≤10'** (re-login keeps the draft).
- Unscheduled panel: count badge, search (Enter = jump to block on Gantt + highlight), ⚙ filters (phase, delivery from/to dd/mm/yyyy, late only, pre-assigned only, sort). Click a card = order card; drag = schedule.
- Drag & drop: ghost shows the shift-aware span (green = combined run without setup, red = past the week's shifts); ineligible machine → refused; overlap → refused with toast naming the collider; magnet to previous block within 30'.
- Blocks: 🔒 completed, 📌 pre-assigned, dashed orange = reassigned, red outline = past delivery, ♻ combined run, ⇅ phase-chain violation, white/green progress bar + `N◯` rolls (production), tooltip with breakdown + working hours + production + lots. Click = order card; right-click = Details / Αλλαγή διάρκειας (working hours) / Με-χωρίς setup / Αφαίρεση.
- Order card: schedule + «Μετάβαση», Soft1 details (customer, sales order, PO…), **production (total, %, every roll/lot)**, phase chain (red when out of order).
- Machine name click = machine card (Soft1 RSRC via native getData + eligible phases).
- Shift bands: click a gap → modal (**Soft1 shift 1/2/3** saved immediately, or provisional with times); right-click real shift → remove from Soft1; right-click provisional → remove.
- Row bottom strip = daily load heatmap (green → amber → red, tooltip h/h); group «Χρησιμ.» row = max utilisation per day.
- Issue panel: overlaps, deadline violations, phase-chain violations; click = jump, ✕ = unschedule.
- **Locks** (right-click a scheduled block): «📍 Δέσμευση μηχανής» (BOOL01 — the order may only go on that machine: drag/drop, auto-place; unscheduled cards show «📍 machine (δεσμευμένη)») and «📆 Κλείδωμα ημέρας» (BOOL02 — moves only inside its production day 06:00→06:00; auto-place never moves scheduled orders). Both are written to Soft1 immediately with the order's current machine + dates; «Αφαίρεση» is refused while locked; SaveSchedule enforces the same rules server-side. Orders without a reserved machine may go on any machine of their phase. **Exception — printing (phase 1xxx, `SchedulerEngine.isPrinting`)**: a printing order that has a machine (CCCFXRSRC) keeps it as the **suggested** machine — auto-place uses only that machine (waits for it, no fallback); the user may still drag it to another printing machine (toast notes the change); unscheduled card shows «📌 machine (προτεινόμενη)».
- Order card: **Υλικά εντολής** (GetOrderMaterials) above production.
- Auto-place: what does not fit in the visible week continues into the **following weeks** (up to `AUTO_AHEAD_WEEKS` = 8) using each week's shifts and the orders already planned there; a week without a CCCFXPCAL calendar → the user is asked once, then it (and later missing ones) is created from the last existing week (`CreateCalendarWeek copy=previous`). Placements in later weeks are normal unsaved changes (save with Αποθήκευση); a summary lists placements per week, created calendars and what did not fit.
- Auto-place: on the **filtered** list; creates the calendar week first if missing; predecessors first, then earliest delivery; picks the machine that finishes earliest; respects shifts, now, predecessors, overlaps; undoable.
- Save: one batched call; per-order failures/conflicts stay dirty with a message; success clears the draft + history.
- Draft: autosaved to `localStorage` (`pp-draft:<user>:<monday>`); after load you're asked to restore.
- Production progress refreshes every 5'.

**Διαχείριση παραγωγής (`production.html`)** — §6b
- Mobile-first; header (burger · logo · title · ↻), drawer menu: Τρέχουσες παραγωγές · Αδράνεια μηχανών · Εντολές παραγωγής · Παραγγελίες πελατών · Μηχανές · (shell) switcher to planner (desktop + full only) · 🔑 · Έξοδος · «Εγκατάσταση εφαρμογής» (beforeinstallprompt; iOS/other → instructions).
- Running: one card per active machine, grouped by phase; state pill = current stage line name (Παραγωγή / Setup / Διάλλειμα …) since HH:MM + operator; current order + progress. KPIs: σε παραγωγή / setup / στάση / χωρίς εργασία / kg σήμερα — the four state counters are **filter toggles** (tap = only those machines, tap again = all; synced with the Όλες / Σε λειτουργία / Αδρανείς segment).
- Idle: day picker (dd/mm/yyyy). Production day 06:00→06:00; shift windows from `GetShifts` (1=06–14, 2=14–22, 3=22–06). Timeline per machine coloured by stage state (green production, amber setup, red stop, grey shift without work), chips with time per reason, utilisation %. Notifications: later.
- Orders: search (fincode, item, customer, sales order, PO) + status chips + machine filter → order sheet (`GetOrderDetails` + rolls). Customers: search sales orders → their production orders.
- **Πρόγραμμα ημέρας**: per machine the day's jobs in order (06:00→06:00) with ↑ / ↓. One step = swap with the neighbour: the pair keeps its outer window [first.start, second.end], each job keeps its (clock) duration, the gap between them is kept. Written immediately via `/api/move` → `SaveSchedule` with the loaded dates as optimistic lock; if one of the two fails, the written one is reverted. Locked: completed (MTRSTS 1) and started (has stage events) jobs. Note: durations are clock time, not shift-aware working time (the planner's `WorkTime`).
- Machines: list + edit sheet — **only setup time (`SETUPTIME`) and speed (`MPRDQTY`) are editable** (user decision); wait time / active / remarks read-only → `/api/machine` → native setData RSRC.
- **Design system** (v0.8): light / dark / system theme (`src/theme.js`, `html[data-theme]`, stored in `localStorage pp-theme`; header ☾/☀ toggle + menu segment). Neutral zinc base, Vlachos red only as accent (light `#dc1f2b`, dark `#f0444e`); status green/amber/red/grey with soft tints. Inter (Greek) + JetBrains Mono for codes/times (Google Fonts). Sidebar ≥1024px, drawer on phones, bottom sheets, totals row (in production / setup / idle / kg today), machines grouped by phase (Vlachos: 2 printing, 3 laminating, 4 slitters, 1 bagger). Tokens at the top of `src/production.css`; login page uses the same CSS. Planner keeps its own look (decision: not restyled).
- Icons: `icons/pm-*` from the Vlachos Bros site icon (512px mark) → PWA icons (`pm-icon-192/512`, `pm-maskable-512`), `pm-apple-180`, `pm-32`, header mark `pm-mark-64`. Planner keeps the old icon/manifest.

**Calendar (`calendar.html?week=YYYY-MM-DD`)**: machines × 7 days × 3 shifts; click cell / machine name (row) / day or shift header (column) to toggle; changed cells outlined; hours per machine; create week (from previous / empty); «Συμπλήρωση» fills missing weeks up to a date (≤26); Αποθήκευση στο Soft1 (Ctrl+S); ←/→ weeks.

---

## 7. Performance (1000–1500 open orders)

- Load pipeline (`_loadData`): machines + phase map + shifts in parallel → render skeleton → week orders → production for the week (background) → unscheduled in pages of **1000** (stop on short page) → MTRL tree (background) → `_onLoadComplete` (chain, render, draft offer). `_loadToken` cancels stale loads on week change.
- O(1) maps `orderById` / `machineById`; DocumentFragment + 500-card cap in the panel.
- Worker logs `dataset <name>: N rows, soft1 X ms` (`npm run tail`) and returns `Server-Timing: soft1;dur=X`.

---

## 8. Known gotchas (things that bit us)

1. **Redirect loop on /login.html** — Cloudflare assets' default `html_handling` redirected `/login.html → /login` and the Worker redirected back. Fixed with `html_handling: "none"`; `run_worker_first: true` so the Worker gates every page.
2. **Login needs appId** (`SOFT1_APP_ID = 1199`) and **authenticate must use `REFID`/`MODULE`/`BRANCH` from the login `objs[]`** entry (not 0). Errors are prefixed `Soft1 login:` / `Soft1 authenticate (…)`.
3. **Greek showed as �** — Soft1 answers in windows-1253. `worker/encoding.js decodeSoft1()` (strict UTF-8, else cp1253). Never use `res.text()` in `soft1-client.js`.
4. **Soft1 `:` = parameter marker** inside SQL text → colon escaping / DATEADD (see §4).
5. **AJS = ES3** (see §4).
6. **Null dates come back as 1899/1900/1970** → `_parseDate` rejects `< 1990`; SaveSchedule conflict check does the same.
7. **Orders scheduled in other weeks** are filtered out of both Gantt and unscheduled panel.
8. **Shift query: `L.RSRC`, not `A.RSRC`.**
9. **New dataset = 3 places:** AJS function + `DATASETS` in `worker/routes/data.js` + caller in `data-service.js`. Calendar actions: `ACTIONS` in `worker/routes/calendar.js`. Native records: `RECORDS` in `worker/routes/record.js`.
10. **Bridge is async** — a non-awaited `Soft1Bridge.*` call is a bug.
11. **`.btn { display:… }` overrode `[hidden]`** → global `[hidden]{display:none!important}`.
12. **Dates:** never `toLocaleDateString` or visible `<input type="date">` (shows mm/dd/yyyy on English browsers) — use `DateFmt` + text inputs. Internally Date / ISO `YYYY-MM-DD`.
13. **Deploys come from `main` only** — changes on the `claude/…` branch are not live until merged.
14. **GitHub user `emperorkk`**; Windows git needs `schannel`; never `git init` in `C:\SoftOne\Vlachos Bros\`.
15. **Do not use the `noma` Soft1 MCP connector** — it is a different Soft1 installation (its RSRC field list was used once for `record.js`; standard fields, unverified at Vlachos).

---

## 9. User preferences

- **Terse** responses; short status. Ask before major refactors / design changes ("Provide feedback before moving on to making any changes").
- **Merge only on an explicit "merge"**; bump the version on every merge and report it.
- **Dates dd/mm/yyyy**, times 24h. **Greek UI** labels.
- The user edits SQL themselves and pastes it — apply their exact SQL (now in `soft1/Foxline.planning.js`) and remind them to paste the script into Soft1 after changes.
- Ask the user for Soft1 schema facts (they answer with screenshots / native getData dumps); don't use noma.
- Credentials in chat: the user rotates test/production accounts — no need to warn.
- OpenAI is connected (images: `gpt-image-2` / `gpt-image-1.5` for transparency) — used for the app icon.

---

## 10. Where to change things

| Task | Where |
|---|---|
| Change a query | `soft1/Foxline.planning.js` only (then user pastes it into Soft1) |
| New dataset | AJS `Get…` + `worker/routes/data.js DATASETS` + `public/src/data-service.js` |
| New write-back field | AJS `SaveSchedule` + `worker/routes/data.js validOrder/clean` + `data-service.js saveOrders` |
| Calendar logic | AJS `*CalendarWeek*` + `worker/routes/calendar.js ACTIONS` + `ui-controller.js` (`_saveSoft1Changes`, banner) / `calendar.js` |
| Shift times / explode | `data-service.js SHIFT_TIMES` + `_explodeShifts()`; working-time math `work-time.js` |
| Duration formula | `data-service.js durationBreakdown / computeWorkMinutes`; span/magnet `ui-controller.js _computeSpan` |
| Auto-place / chain | `scheduler-engine.js autoPlace / buildChainIndex / getChainViolations` |
| Block appearance | `gantt-renderer.js renderBlocks()` + `styles.css` |
| Cards | `info-card.js` (machine/order), native records `worker/routes/record.js` |
| Dates | `public/src/date-fmt.js` |
| Production app | `public/src/production-app.js` + AJS `Pm*` + `worker/routes/data.js PRODUCTION_DATASETS` |
| Access / landing | `worker/access.js`, `public/src/login.js`, `public/src/app-shell.js` |
| Worker routes | `worker/index.js` + `worker/routes/*.js` |
| Soft1 HTTP / encoding | `worker/soft1-client.js`, `worker/encoding.js` |

---

## 11. Local dev & testing

```bash
npm install
npm run dev     # wrangler dev → http://localhost:8787 (needs real Soft1 login for data)
npm run deploy  # manual deploy (normally Workers Builds deploys main)
npm run tail    # live logs (dataset timings)
```

How changes have been verified (scripts were kept in the session scratchpad, not in the repo):
- `node --check` on every JS file (incl. the AJS).
- AJS logic run in Node against a **fake `X`** object (GETSQLDATASET/RUNSQL/CREATEOBJ stubs) — ISO week codes, create/copy/save calendar.
- **Playwright, mock mode** (`file://…/production-planner.html`, `calendar.html`): drag/drop span, undo/redo, draft, filters, cards, search-jump, auto-place, print, dates.
- **Playwright, web mode with intercepted `/api/*`** (fake Soft1 responses served on `http://pp.test`): calendar banner/create/save payloads, save-conflict handling, production progress, auto-place week creation, session banner.
- `wrangler dev` smoke test: `/api/version`, auth gate redirects, 401s.
Nothing replaces a real Soft1 run — see §5 «Not yet verified».

---

## 12. Likely next steps

- User pastes the latest `Foxline.planning.js`; verify calendar create/save/fill on real Soft1 and the order card/production data.
- Integrate the user's existing **audit log** with `SaveSchedule`.
- Per-row shift times when `STARTTIME/ENDTIME` are added to `CCCFXPCALLNS`.
- Optional: Cloudflare Access in front of the Worker (org SSO before the Soft1 login).
