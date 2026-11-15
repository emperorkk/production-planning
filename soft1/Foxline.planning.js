//// Foxline.planning
//
// Soft1 custom web service for the Production Planner (Cloudflare Worker).
// Endpoint:  https://<sn>.oncloud.gr/s1services/JS/Foxline.planning/<function>
// Body:      { "clientID": "<authenticated clientID>", ...params }
//
// ALL planner SQL lives here. The browser never sends SQL — it calls a dataset by name.
//
// Datasets (→ { success, count, data:[rows] }):
//   GetMachines                                   RSRC machines + speed/setup/wait
//   GetPhaseMachines                              SPCOSTGROUP phase ↔ machine + phase name
//   GetOrdersInWeek       weekStart, weekEnd      orders whose DATE01/DATE02 fall in the week
//   GetUnscheduledOrders  offset, pageSize(≤2000) open orders with DATE01 IS NULL, paged
//   GetProductionOrders   weekStart, weekEnd      open orders + completed in the week (full load)
//   GetShifts             monday                  CCCFXPCAL + CCCFXPCALLNS for the week
//   GetMtrlTree                                   CCCFXPRNOMINAL recipe chain
// Writes:
//   SaveSchedule          orders:[{findoc, machine|null, start|null, end|null}]
//                         → { success, saved, skipped, errors:[...] }
// Misc:
//   Ping                                          → { success, user, company }
//
// Dates in params: 'YYYY-MM-DD' (week/monday), 'YYYY-MM-DD HH:MM' (SaveSchedule).
// Company always comes from the session (X.SYS.COMPANY), never from the caller.
// Written in ES3 (no JSON.parse, no arrow functions, no Array helpers) for the Soft1 JS engine.

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function checkClientId(Prms)
{
 try {
   return (Prms.clientID && Prms.clientID != "");
 }
 catch (e) {
   return false;
 }
}

function responseError(msg)
{
 var resp = {};
 resp.success = false;
 resp.error   = msg || "Authenticate fails due to invalid credentials!";
 return resp;
}

// Like SQL2JSON in Production.scale, but "no rows" is a valid empty result, not an error.
function sqlRows(fSQL)
{
 var resp = {};
 try {
   var fDs = X.GETSQLDATASET(escapeLiteralColons(fSQL), null);
   resp.success = true;
   resp.count   = fDs.RECORDCOUNT;
   resp.data    = (fDs.RECORDCOUNT > 0) ? eval(fDs.JSON) : [];
 }
 catch (e) {
   resp.success = false;
   resp.error   = "SQL error: " + (e.message || e.description || e);
 }
 return resp;
}

// Soft1 treats ":<name>" as a parameter marker, which breaks time literals such as
// '2026-11-16 00:00:00'. Rewrite every colon inside a single-quoted literal as
// '+CHAR(58)+'  (same trick as PrmsToSQLFmt in Production.scale).
function escapeLiteralColons(sql)
{
 var out = '';
 var inStr = false;
 var q = String.fromCharCode(39);
 for (var i = 0; i < sql.length; i++) {
   var c = sql.charAt(i);
   if (c == q) {
     inStr = !inStr;           // '' (escaped quote) toggles twice → stays correct
     out += c;
   }
   else if (c == ':' && inStr)
     out += q + '+CHAR(58)+' + q;
   else
     out += c;
 }
 return out;
}

function isInt(v)
{
 return v !== null && v !== undefined && /^\d+$/.test(String(v));
}

function isIsoDate(v)
{
 return v !== null && v !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(v));
}

// 'YYYY-MM-DD HH:MM'  →  DATEADD(MINUTE, n, 'YYYYMMDD')   (no colons in the SQL text)
// null / ''           →  NULL
// anything else       →  false (invalid)
function dateToSql(v)
{
 if (v === null || v === undefined || v === '') return 'NULL';
 var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v));
 if (!m) return false;
 var mins = parseInt(m[4], 10) * 60 + parseInt(m[5], 10);
 return "DATEADD(MINUTE, " + mins + ", '" + m[1] + m[2] + m[3] + "')";
}

function company()
{
 return parseInt(X.SYS.COMPANY, 10);
}

// ═══════════════════════════════════════════════════════════════════════════
// SQL — single source of truth (was public/src/data-service.js QUERIES)
// ═══════════════════════════════════════════════════════════════════════════

function _ordersBaseSelect()
{
 return "SELECT F.FINDOC AS id" +
        ", M.CODE + ' ' + M.NAME AS description" +
        ", isnull(LS.DELIVDATE,L0.DELIVDATE) AS deliveryDate" +
        ", L0.QTY1 AS kilos" +
        ", L0.QTY2 AS linearMetres" +
        ", L0.DATE01 AS plannedStartDataTime" +
        ", L0.DATE02 AS plannedFinishDataTime" +
        ", D.MTRSTS AS status" +
        ", D.STAGE AS phase" +
        ", F.CCCFXRSRC AS machine" +
        ", L0.FINDOCS AS salesOrderRef" +
        ", L0.MTRL AS mtrl" +
        " FROM FINDOC F" +
        " INNER JOIN MTRDOC D ON D.FINDOC = F.FINDOC" +
        " INNER JOIN MTRLINES L0 ON L0.FINDOC = F.FINDOC AND L0.MTRTYPE = 1" +
        " LEFT OUTER JOIN MTRLINES LS ON LS.FINDOC = L0.FINDOCS AND LS.MTRLINES=L0.MTRLINESS" +
        " INNER JOIN MTRL M ON M.MTRL = L0.MTRL" +
        " WHERE F.SOSOURCE = 5171" +
        " AND F.COMPANY = " + company() +
        " AND isnull(LS.DELIVDATE,L0.DELIVDATE) >= GETDATE() - 180";
}

// ═══════════════════════════════════════════════════════════════════════════
// Datasets
// ═══════════════════════════════════════════════════════════════════════════

function Ping(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 var resp = {};
 resp.success = true;
 resp.user    = X.SYS.USER;
 resp.company = X.SYS.COMPANY;
 resp.cdate   = X.FORMATDATE('dd-mm-yyyy hh:nn:ss', X.SYS.SYSDATE);
 return resp;
}

// Machines / Resources (RSRC)
function GetMachines(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 return sqlRows(
   "SELECT RSRC AS id" +
   ", NAME AS name" +
   ", CCCFXSTAGE AS phase" +
   ", SETUPTIME AS setuptime" +
   ", WAITTIME  AS waittime" +
   ", MPRDQTY   AS average_speed_in_metres_per_minute" +
   " FROM RSRC" +
   " WHERE SODTYPE = 25 AND RSRCTYPE < 50 AND COMPANY = " + company());
}

// Phase ↔ machine eligibility (SPCOSTGROUP)
function GetPhaseMachines(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 return sqlRows(
   "SELECT CCCRSRC AS machine, CCCSTAGE AS phase, (select name from STAGE where COMPANY=SPCOSTGROUP and STAGE=CCCSTAGE) phaseName" +
   " FROM SPCOSTGROUP" +
   " WHERE CCCRSRC IS NOT NULL AND COMPANY = " + company());
}

// STAGE 1 — orders touching the visible week (gantt blocks)
function GetOrdersInWeek(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 if (!isIsoDate(Prms.weekStart) || !isIsoDate(Prms.weekEnd))
   return responseError("weekStart / weekEnd must be YYYY-MM-DD");
 var ws = "'" + Prms.weekStart + " 00:00:00'";
 var we = "'" + Prms.weekEnd   + " 23:59:59'";
 return sqlRows(
   _ordersBaseSelect() +
   " AND (L0.DATE01 BETWEEN " + ws + " AND " + we +
   "   OR L0.DATE02 BETWEEN " + ws + " AND " + we + ")" +
   " ORDER BY L0.DELIVDATE");
}

// STAGE 2 — paged unscheduled orders (DATE01 IS NULL)
function GetUnscheduledOrders(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 var offset   = isInt(Prms.offset)   ? parseInt(Prms.offset, 10)   : 0;
 var pageSize = isInt(Prms.pageSize) ? parseInt(Prms.pageSize, 10) : 1000;
 if (pageSize < 1 || pageSize > 2000) pageSize = 1000;
 return sqlRows(
   _ordersBaseSelect() +
   " AND D.MTRSTS <> 1" +
   " AND L0.DATE01 IS NULL" +
   " ORDER BY L0.DELIVDATE" +
   " OFFSET " + offset + " ROWS FETCH NEXT " + pageSize + " ROWS ONLY");
}

// Full load: open orders + completed orders planned in the week
function GetProductionOrders(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 if (!isIsoDate(Prms.weekStart) || !isIsoDate(Prms.weekEnd))
   return responseError("weekStart / weekEnd must be YYYY-MM-DD");
 return sqlRows(
   _ordersBaseSelect() +
   " AND (D.MTRSTS <> 1" +
   "      OR L0.DATE01 BETWEEN '" + Prms.weekStart + " 00:00:00' AND '" + Prms.weekEnd + " 23:59:59'" +
   "      OR L0.DATE02 BETWEEN '" + Prms.weekStart + " 00:00:00' AND '" + Prms.weekEnd + " 23:59:59')" +
   " ORDER BY L0.DELIVDATE");
}

// Shift programme for the week starting `monday` (per machine — RSRC is on the LINES table)
function GetShifts(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 if (!isIsoDate(Prms.monday)) return responseError("monday must be YYYY-MM-DD");
 return sqlRows(
   "SELECT L.RSRC AS machine" +
   ", A.DATE01, A.DATE02, A.DATE03, A.DATE04, A.DATE05, A.DATE06, A.DATE07" +
   ", L.S11, L.S12, L.S13" +
   ", L.S21, L.S22, L.S23" +
   ", L.S31, L.S32, L.S33" +
   ", L.S41, L.S42, L.S43" +
   ", L.S51, L.S52, L.S53" +
   ", L.S61, L.S62, L.S63" +
   ", L.S71, L.S72, L.S73" +
   " FROM CCCFXPCAL A" +
   " INNER JOIN CCCFXPCALLNS L ON A.CCCFXPCAL = L.CCCFXPCAL" +
   " WHERE A.COMPANY = " + company() +
   " AND A.DATE01 = '" + Prms.monday + "'");
}

// MTRL production tree (CCCFXPRNOMINAL)
function GetMtrlTree(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 return sqlRows(
   "SELECT MTRL, LINENUM" +
   ", RAW1MTRL, RAW2MTRL, RAW3MTRL, RAW4MTRL, PRDMTRL" +
   ", STAGE AS phase" +
   ", ISNULL(PRDQTY1, 1) AS kilos" +
   ", PRDQTY2 AS metres" +
   " FROM CCCFXPRNOMINAL" +
   " ORDER BY MTRL, LINENUM");
}

// ═══════════════════════════════════════════════════════════════════════════
// SaveSchedule — machine (FINDOC.CCCFXRSRC) + planned dates (MTRLINES.DATE01/02)
// Only production orders (SOSOURCE 5171) of the session company that are NOT
// completed (MTRDOC.MTRSTS <> 1) are written. Everything else is reported.
// ═══════════════════════════════════════════════════════════════════════════

function SaveSchedule(Prms)
{
 if (!checkClientId(Prms)) return responseError();

 var orders = Prms.orders;
 if (typeof orders == 'string') orders = eval('(' + orders + ')');
 if (!orders || orders.length == undefined) return responseError("orders[] is required");

 var resp = {};
 resp.success = true;
 resp.saved   = 0;
 resp.skipped = 0;
 resp.errors  = [];

 for (var i = 0; i < orders.length; i++) {
   var o = orders[i];
   var findoc  = o.findoc;
   var machine = (o.machine === null || o.machine === undefined || o.machine === '') ? null : o.machine;
   var dStart  = dateToSql(o.start);
   var dEnd    = dateToSql(o.end);

   if (!isInt(findoc))                      { resp.errors.push({ findoc: findoc, error: 'Invalid findoc' });  continue; }
   if (machine !== null && !isInt(machine)) { resp.errors.push({ findoc: findoc, error: 'Invalid machine' }); continue; }
   if (dStart === false || dEnd === false)  { resp.errors.push({ findoc: findoc, error: 'Invalid date' });    continue; }

   try {
     var ds = X.GETSQLDATASET(
       "SELECT D.MTRSTS FROM FINDOC F INNER JOIN MTRDOC D ON D.FINDOC = F.FINDOC" +
       " WHERE F.FINDOC = " + findoc + " AND F.SOSOURCE = 5171 AND F.COMPANY = " + company(), null);

     if (ds.RECORDCOUNT == 0) { resp.errors.push({ findoc: findoc, error: 'Not found' }); continue; }
     if (ds.MTRSTS == 1)      { resp.skipped++; continue; }    // completed → never written

     X.RUNSQL("UPDATE FINDOC SET CCCFXRSRC = " + (machine === null ? "NULL" : machine) +
              " WHERE FINDOC = " + findoc, null);
     X.RUNSQL("UPDATE MTRLINES SET DATE01 = " + dStart + ", DATE02 = " + dEnd +
              " WHERE FINDOC = " + findoc + " AND MTRTYPE = 1", null);
     resp.saved++;
   }
   catch (e) {
     resp.errors.push({ findoc: findoc, error: String(e.message || e.description || e) });
   }
 }

 if (resp.errors.length > 0) resp.success = false;
 return resp;
}
