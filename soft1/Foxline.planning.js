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
//   GetOrderDetails       findoc                  one production order + sales order / customer
// Writes:
//   SaveSchedule          orders:[{findoc, machine|null, start|null, end|null,
//                                  origMachine, origStart, origEnd}]   (orig* = values when loaded;
//                                  if the DB changed since, the order is NOT written → conflict)
//                         → { success, saved, skipped, conflicts, errors:[...] }
// Production calendar (OBJECT CCCFXPCAL, lines CCCFXPCALLNS, key = CODE = ISO 'YYYYWW'):
//   GetCalendarWeek       monday                  → { success, exists, header, data:[machine rows] }
//   GetCalendarWeeks      from, to                → { success, data:[{id, code, wk, monday}] }
//   CreateCalendarWeek    monday, copy('previous'|'none')  → { success, id, code, copiedFrom }
//   SaveCalendarWeek      monday, lines:[{rsrc, s:'21 chars 0/1 (S11..S73)'}] → { success, updated, inserted }
//   FillMissingWeeks      from, to (≤ 26 weeks)   → { success, created:[codes], skipped:[codes] }
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

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// 'YYYY-MM-DD' → UTC Date (no time-zone drift)
function isoToUtc(v)
{
 var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
 return m ? new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))) : null;
}
function utcToIso(d)  { return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
function utcToSql(d)  { return "'" + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + "'"; }
function addDaysUtc(d, n) { return new Date(d.getTime() + n * 86400000); }

function isMonday(v)
{
 var d = isoToUtc(v);
 return d !== null && d.getUTCDay() == 1;
}

// ISO-8601 week → { year, week, code:'YYYYWW' }
function isoWeek(d)
{
 var t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
 var dayNum = t.getUTCDay() || 7;
 t.setUTCDate(t.getUTCDate() + 4 - dayNum);
 var yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
 var week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
 return { year: t.getUTCFullYear(), week: week, code: t.getUTCFullYear() + pad2(week) };
}

var SHIFT_FIELDS = ['S11','S12','S13','S21','S22','S23','S31','S32','S33','S41','S42','S43',
                    'S51','S52','S53','S61','S62','S63','S71','S72','S73'];

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

// One production order with its sales order / customer (order info card)
function GetOrderDetails(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 if (!isInt(Prms.findoc)) return responseError("findoc must be an integer");
 return sqlRows(
   "SELECT F.FINDOC AS id, F.FINCODE AS fincode, F.TRNDATE AS trndate" +
   ", M.CODE AS itemCode, M.NAME AS itemName, M.CODE2 AS customerItemCode" +
   ", L0.QTY1 AS kilos, L0.QTY2 AS linearMetres" +
   ", isnull(LS.DELIVDATE,L0.DELIVDATE) AS deliveryDate" +
   ", D.MTRSTS AS status, D.STAGE AS phase" +
   ", (SELECT NAME FROM RSRC WHERE RSRC=F.CCCFXRSRC AND COMPANY=F.COMPANY) AS machineName" +
   ", S.FINCODE AS salesOrder, S.VARCHAR01 AS customerPO" +
   ", (SELECT NAME FROM TRDR WHERE TRDR=S.TRDR) AS customer" +
   ", F.REMARKS AS remarks" +
   " FROM FINDOC F" +
   " INNER JOIN MTRDOC D ON D.FINDOC = F.FINDOC" +
   " INNER JOIN MTRLINES L0 ON L0.FINDOC = F.FINDOC AND L0.MTRTYPE = 1" +
   " LEFT OUTER JOIN MTRLINES LS ON LS.FINDOC = L0.FINDOCS AND LS.MTRLINES=L0.MTRLINESS" +
   " LEFT OUTER JOIN FINDOC S ON S.FINDOC = L0.FINDOCS" +
   " INNER JOIN MTRL M ON M.MTRL = L0.MTRL" +
   " WHERE F.FINDOC = " + parseInt(Prms.findoc, 10) +
   " AND F.SOSOURCE = 5171 AND F.COMPANY = " + company());
}

// ═══════════════════════════════════════════════════════════════════════════
// Production calendar — OBJECT CCCFXPCAL (header) + CCCFXPCALLNS (machine lines)
// Header: CODE = NAME = ISO 'YYYYWW', FROMDATE/FINALDATE, DATE01..DATE07 (Mon..Sun), WK
// Lines : RSRC + S{day}{shift} flags (day 1=Mon..7=Sun, shift 1..3)
// ═══════════════════════════════════════════════════════════════════════════

function _calendarRow(mondayUtc)
{
 var ds = X.GETSQLDATASET(
   "SELECT CCCFXPCAL, CODE, WK FROM CCCFXPCAL WHERE COMPANY = " + company() +
   " AND DATE01 = " + utcToSql(mondayUtc), null);
 if (ds.RECORDCOUNT == 0) return null;
 return { id: ds.CCCFXPCAL, code: ds.CODE, wk: ds.WK };
}

// Latest calendar strictly before `mondayUtc` (source for copying)
function _previousCalendar(mondayUtc)
{
 var ds = X.GETSQLDATASET(
   "SELECT TOP 1 CCCFXPCAL, CODE FROM CCCFXPCAL WHERE COMPANY = " + company() +
   " AND DATE01 < " + utcToSql(mondayUtc) + " ORDER BY DATE01 DESC", null);
 if (ds.RECORDCOUNT == 0) return null;
 return { id: ds.CCCFXPCAL, code: ds.CODE };
}

// Active production machines (same filter as GetMachines)
function _machineIds()
{
 var ds = X.GETSQLDATASET(
   "SELECT RSRC FROM RSRC WHERE SODTYPE = 25 AND RSRCTYPE < 50 AND COMPANY = " + company() +
   " ORDER BY RSRC", null);
 var ids = [];
 ds.FIRST;
 while (!ds.EOF) { ids.push(ds.RSRC); ds.NEXT; }
 return ids;
}

// { rsrc: 'flags21' } for the lines of a calendar id
function _calendarFlags(calId)
{
 var map = {};
 var ds = X.GETSQLDATASET(
   "SELECT RSRC, " + SHIFT_FIELDS.join(', ') + " FROM CCCFXPCALLNS WHERE CCCFXPCAL = " + calId, null);
 ds.FIRST;
 while (!ds.EOF) {
   var f = '';
   for (var i = 0; i < SHIFT_FIELDS.length; i++) f += (ds[SHIFT_FIELDS[i]] == 1 ? '1' : '0');
   map[String(ds.RSRC)] = f;
   ds.NEXT;
 }
 return map;
}

function _validFlags(s) { return /^[01]{21}$/.test(String(s)); }

function GetCalendarWeek(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 if (!isMonday(Prms.monday)) return responseError("monday must be a Monday (YYYY-MM-DD)");
 var mon = isoToUtc(Prms.monday);
 var cal = _calendarRow(mon);
 var resp = sqlRows(
   "SELECT R.RSRC AS rsrc, R.CODE AS code, R.NAME AS name, R.CCCFXSTAGE AS phase" +
   ", (SELECT NAME FROM STAGE WHERE COMPANY = R.COMPANY AND STAGE = R.CCCFXSTAGE) AS phaseName" +
   ", L.CCCFXPCALLNS AS lineId, " +
   (function () { var a = []; for (var i = 0; i < SHIFT_FIELDS.length; i++) a.push('L.' + SHIFT_FIELDS[i]); return a.join(', '); })() +
   " FROM RSRC R LEFT OUTER JOIN CCCFXPCALLNS L ON L.RSRC = R.RSRC AND L.CCCFXPCAL = " + (cal ? cal.id : -1) +
   " WHERE R.SODTYPE = 25 AND R.RSRCTYPE < 50 AND R.COMPANY = " + company() +
   " ORDER BY R.CCCFXSTAGE, R.CODE");
 resp.exists = (cal !== null);
 resp.header = cal ? { id: cal.id, code: cal.code, wk: cal.wk } : { code: isoWeek(mon).code, wk: isoWeek(mon).week };
 return resp;
}

function GetCalendarWeeks(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 if (!isIsoDate(Prms.from) || !isIsoDate(Prms.to)) return responseError("from / to must be YYYY-MM-DD");
 return sqlRows(
   "SELECT CCCFXPCAL AS id, CODE AS code, WK AS wk, CONVERT(varchar(10), DATE01, 23) AS monday" +
   " FROM CCCFXPCAL WHERE COMPANY = " + company() +
   " AND DATE01 >= " + utcToSql(isoToUtc(Prms.from)) + " AND DATE01 <= " + utcToSql(isoToUtc(Prms.to)) +
   " ORDER BY DATE01");
}

// Creates the week through the Soft1 object (so object scripts / validations run),
// then pins the date columns with SQL (unambiguous 'YYYYMMDD' literals).
function _createWeek(mondayUtc, copy)
{
 var wk   = isoWeek(mondayUtc);
 var src  = (copy == 'none') ? null : _previousCalendar(mondayUtc);
 var srcFlags = src ? _calendarFlags(src.id) : {};
 var ids  = _machineIds();
 var zeros = '000000000000000000000';

 // Is the header key an identity column? If not, it must be given (= CODE, as in Soft1).
 var idDs = X.GETSQLDATASET("SELECT COLUMNPROPERTY(OBJECT_ID('CCCFXPCAL'), 'CCCFXPCAL', 'IsIdentity') AS ISID", null);
 var keyIsIdentity = (idDs.ISID == 1);

 var obj = X.CREATEOBJ('CCCFXPCAL');
 var newId;
 try {
   var hdr = obj.FINDTABLE('CCCFXPCAL');
   var lns = obj.FINDTABLE('CCCFXPCALLNS');
   obj.DBINSERT;
   hdr.EDIT;
   if (!keyIsIdentity) hdr.CCCFXPCAL = parseInt(wk.code, 10);
   hdr.CODE = wk.code;
   hdr.NAME = wk.code;
   try {
     hdr.FROMDATE  = utcToIso(mondayUtc);
     hdr.FINALDATE = utcToIso(addDaysUtc(mondayUtc, 6));
     for (var d = 0; d < 7; d++) hdr['DATE0' + (d + 1)] = utcToIso(addDaysUtc(mondayUtc, d));
     hdr.WK = wk.week;
   } catch (eDates) { /* pinned by SQL below */ }
   hdr.POST;

   for (var i = 0; i < ids.length; i++) {
     var flags = srcFlags[String(ids[i])] || zeros;
     lns.APPEND;
     lns.RSRC = ids[i];
     for (var k = 0; k < SHIFT_FIELDS.length; k++) lns[SHIFT_FIELDS[k]] = parseInt(flags.charAt(k), 10);
     lns.POST;
   }
   newId = obj.DBPOST;
 }
 finally {
   obj.FREE;
 }
 if (!newId) newId = keyIsIdentity ? null : parseInt(wk.code, 10);
 if (!newId) {
   var chk = _calendarRow(mondayUtc);
   newId = chk ? chk.id : null;
 }
 if (newId) {
   var upd = "UPDATE CCCFXPCAL SET FROMDATE = " + utcToSql(mondayUtc) +
             ", FINALDATE = " + utcToSql(addDaysUtc(mondayUtc, 6)) + ", WK = " + wk.week;
   for (var j = 0; j < 7; j++) upd += ", DATE0" + (j + 1) + " = " + utcToSql(addDaysUtc(mondayUtc, j));
   X.RUNSQL(upd + " WHERE CCCFXPCAL = " + newId, null);
 }
 return { id: newId, code: wk.code, copiedFrom: src ? src.code : null };
}

function CreateCalendarWeek(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 if (!isMonday(Prms.monday)) return responseError("monday must be a Monday (YYYY-MM-DD)");
 var mon = isoToUtc(Prms.monday);
 if (_calendarRow(mon)) return responseError("Calendar week already exists");
 try {
   var r = _createWeek(mon, Prms.copy == 'none' ? 'none' : 'previous');
   var resp = {};
   resp.success = true; resp.id = r.id; resp.code = r.code; resp.copiedFrom = r.copiedFrom;
   return resp;
 }
 catch (e) {
   return responseError("Create failed: " + (e.message || e.description || e));
 }
}

// lines: [{ rsrc, s: '010110...' (21 flags, S11..S73) }]
// Existing lines → SQL UPDATE of the flags; machines without a line → added through the object.
function SaveCalendarWeek(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 if (!isMonday(Prms.monday)) return responseError("monday must be a Monday (YYYY-MM-DD)");
 var lines = Prms.lines;
 if (typeof lines == 'string') lines = eval('(' + lines + ')');
 if (!lines || lines.length == undefined) return responseError("lines[] is required");

 var mon = isoToUtc(Prms.monday);
 var cal = _calendarRow(mon);
 if (!cal) return responseError("Calendar week does not exist — create it first");

 var existing = _calendarFlags(cal.id);
 var resp = {};
 resp.success = true; resp.updated = 0; resp.inserted = 0; resp.errors = [];
 var missing = [];

 for (var i = 0; i < lines.length; i++) {
   var ln = lines[i];
   if (!isInt(ln.rsrc) || !_validFlags(ln.s)) { resp.errors.push({ rsrc: ln.rsrc, error: 'Invalid line' }); continue; }
   if (existing[String(ln.rsrc)] === undefined) { missing.push(ln); continue; }
   if (existing[String(ln.rsrc)] == ln.s) continue;
   var set = [];
   for (var k = 0; k < SHIFT_FIELDS.length; k++) set.push(SHIFT_FIELDS[k] + " = " + ln.s.charAt(k));
   try {
     X.RUNSQL("UPDATE CCCFXPCALLNS SET " + set.join(', ') +
              " WHERE CCCFXPCAL = " + cal.id + " AND RSRC = " + parseInt(ln.rsrc, 10), null);
     resp.updated++;
   }
   catch (e) { resp.errors.push({ rsrc: ln.rsrc, error: String(e.message || e.description || e) }); }
 }

 if (missing.length) {
   var obj = X.CREATEOBJ('CCCFXPCAL');
   try {
     obj.DBLOCATE(cal.id);
     var lns = obj.FINDTABLE('CCCFXPCALLNS');
     for (var m = 0; m < missing.length; m++) {
       lns.APPEND;
       lns.RSRC = parseInt(missing[m].rsrc, 10);
       for (var q = 0; q < SHIFT_FIELDS.length; q++) lns[SHIFT_FIELDS[q]] = parseInt(missing[m].s.charAt(q), 10);
       lns.POST;
     }
     obj.DBPOST;
     resp.inserted = missing.length;
   }
   catch (e2) { resp.errors.push({ error: 'Insert lines failed: ' + (e2.message || e2.description || e2) }); }
   finally { obj.FREE; }
 }

 if (resp.errors.length) resp.success = false;
 return resp;
}

function FillMissingWeeks(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 if (!isMonday(Prms.from) || !isMonday(Prms.to)) return responseError("from / to must be Mondays (YYYY-MM-DD)");
 var from = isoToUtc(Prms.from), to = isoToUtc(Prms.to);
 if (to < from) return responseError("to must be after from");
 if ((to - from) / 86400000 / 7 > 26) return responseError("Max 26 weeks per call");

 var resp = {};
 resp.success = true; resp.created = []; resp.skipped = []; resp.errors = [];
 for (var d = from; d <= to; d = addDaysUtc(d, 7)) {
   if (_calendarRow(d)) { resp.skipped.push(isoWeek(d).code); continue; }
   try { resp.created.push(_createWeek(d, 'previous').code); }
   catch (e) { resp.errors.push({ week: isoWeek(d).code, error: String(e.message || e.description || e) }); }
 }
 if (resp.errors.length) resp.success = false;
 return resp;
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

     // Optimistic lock: only when the caller sent the values it loaded (origMachine/origStart/origEnd)
     if (o.origMachine !== undefined || o.origStart !== undefined || o.origEnd !== undefined) {
       var cur = X.GETSQLDATASET(
         "SELECT ISNULL(CONVERT(varchar(20), F.CCCFXRSRC), '') AS M" +
         ", ISNULL(CONVERT(varchar(16), L.DATE01, 120), '') AS S" +
         ", ISNULL(CONVERT(varchar(16), L.DATE02, 120), '') AS E" +
         " FROM FINDOC F INNER JOIN MTRLINES L ON L.FINDOC = F.FINDOC AND L.MTRTYPE = 1" +
         " WHERE F.FINDOC = " + findoc, null);
       var curS = String(cur.S), curE = String(cur.E);
       if (curS.substr(0, 4) < '1990') curS = '';          // 1899/1900/1970 "null" dates
       if (curE.substr(0, 4) < '1990') curE = '';
       var expM = (o.origMachine === null || o.origMachine === undefined) ? '' : String(o.origMachine);
       var expS = o.origStart ? String(o.origStart).replace('T', ' ').substr(0, 16) : '';
       var expE = o.origEnd   ? String(o.origEnd).replace('T', ' ').substr(0, 16)   : '';
       if (String(cur.M) != expM || curS != expS || curE != expE) {
         resp.conflicts = (resp.conflicts || 0) + 1;
         resp.errors.push({ findoc: findoc, conflict: true,
                            error: 'Άλλαξε από άλλο χρήστη (μηχανή ' + cur.M + ', ' + curS + ' – ' + curE + ')' });
         continue;
       }
     }

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
