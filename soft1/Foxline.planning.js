//// Foxline.planning
//
// Soft1 custom web service for the Production Planner (Cloudflare Worker / web mode).
// Endpoint:  https://<sn>.oncloud.gr/s1services/JS/Foxline.planning/<function>
// Body:      { "clientID": "<authenticated clientID>", ...params }
//
// Functions:
//   ping          → { success, user, company }                 session liveness check
//   getData       → { success, count, data:[rows] }            SELECT-only, sql in Prms.sql
//   saveSchedule  → { success, saved, skipped, errors:[...] }  writes machine + DATE01/DATE02
//
// Written in ES3 (no JSON.parse, no arrow functions, no Array helpers) for the Soft1 JS engine.

// ─── Common helpers ─────────────────────────────────────────────────────────

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
 var fDs  = X.GETSQLDATASET(fSQL, null);
 resp.success = true;
 resp.count   = fDs.RECORDCOUNT;
 resp.data    = (fDs.RECORDCOUNT > 0) ? eval(fDs.JSON) : [];
 return resp;
}

// Soft1 treats ":<name>" as a parameter marker, which breaks time literals such as
// '2026-11-16 00:00:00'. Rewrite every colon that sits inside a single-quoted string
// literal as  '+CHAR(58)+'  (same trick as PrmsToSQLFmt in Production.scale).
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

// Only a single SELECT / WITH statement is allowed through getData.
function isSafeSelect(sql)
{
 var s = String(sql).replace(/^[\s(]+/, '');
 if (!/^(select|with)\b/i.test(s))  return false;
 if (/;\s*\S/.test(s))               return false;
 if (/--|\/\*/.test(s))              return false;
 if (/\b(insert|update|delete|drop|truncate|alter|create|exec|execute|merge|grant|revoke|into)\b/i.test(s))
   return false;
 return true;
}

function isInt(v)
{
 return v !== null && v !== undefined && /^\d+$/.test(String(v));
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

// ─── ping ───────────────────────────────────────────────────────────────────

function ping(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 var resp = {};
 resp.success = true;
 resp.user    = X.SYS.USER;
 resp.company = X.SYS.COMPANY;
 resp.cdate   = X.FORMATDATE('dd-mm-yyyy hh:nn:ss', X.SYS.SYSDATE);
 return resp;
}

// ─── getData ────────────────────────────────────────────────────────────────
// Prms.sql = a single SELECT statement built by the planner (public/src/data-service.js).

function getData(Prms)
{
 if (!checkClientId(Prms)) return responseError();
 var sql = Prms.sql;
 if (!sql || !isSafeSelect(sql))
   return responseError("Only a single SELECT statement is allowed");
 try {
   return sqlRows(escapeLiteralColons(String(sql)));
 }
 catch (e) {
   return responseError("SQL error: " + (e.message || e.description || e));
 }
}

// ─── saveSchedule ───────────────────────────────────────────────────────────
// Prms.orders = [ { findoc: 123, machine: 45 | null, start: 'YYYY-MM-DD HH:MM' | null, end: ... }, ... ]
// Only production orders (SOSOURCE 5171) of the session company that are NOT completed
// (MTRDOC.MTRSTS <> 1) are written. Everything else is reported in `errors`.

function saveSchedule(Prms)
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

   if (!isInt(findoc))                     { resp.errors.push({ findoc: findoc, error: 'Invalid findoc' });  continue; }
   if (machine !== null && !isInt(machine)) { resp.errors.push({ findoc: findoc, error: 'Invalid machine' }); continue; }
   if (dStart === false || dEnd === false) { resp.errors.push({ findoc: findoc, error: 'Invalid date' });    continue; }

   try {
     var ds = X.GETSQLDATASET(
       "SELECT D.MTRSTS FROM FINDOC F INNER JOIN MTRDOC D ON D.FINDOC = F.FINDOC" +
       " WHERE F.FINDOC = " + findoc + " AND F.SOSOURCE = 5171 AND F.COMPANY = " + X.SYS.COMPANY, null);

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
