import { runSql, runExec }   from '../soft1-client.js';
import { getSession }        from '../session.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
function json(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}

// Reject anything that isn't a pure SELECT on the SQL endpoint.
// Writes must go through /api/exec (which calls a Soft1 server-side script),
// so a stolen session cannot nuke the database with DROP/TRUNCATE.
function isSafeSelect(sql) {
  const s = String(sql || '').trim().replace(/^\(+/, '');
  if (!/^(select|with)\b/i.test(s)) return false;
  // Deny ; chained statements and DML keywords
  if (/;\s*\S/.test(s))                   return false;
  if (/\b(insert|update|delete|drop|truncate|alter|create|exec|execute|merge|grant|revoke)\b/i.test(s)) return false;
  return true;
}

export async function handleSql(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, { status: 405 });
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Not authenticated' }, { status: 401 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }
  const sql = body.sql || body.SQL;
  if (!sql || !isSafeSelect(sql)) {
    return json({ error: 'Only SELECT queries allowed on /api/sql' }, { status: 400 });
  }

  try {
    const rows = await runSql(env, session.clientID, sql);
    return json({ ok: true, rows });
  } catch (err) {
    return json({ error: err.message || String(err) }, { status: 502 });
  }
}

// Write-side endpoint. Server-side Soft1 "RUNSQL" script performs the UPDATE.
// Prefix allow-list keeps the scope narrow (we only UPDATE two tables).
const ALLOWED_PREFIXES = [
  /^\s*UPDATE\s+FINDOC\s+SET\s+CCCFXRSRC\s*=/i,
  /^\s*UPDATE\s+MTRLINES\s+SET\s+DATE01\s*=/i
];

function isAllowedUpdate(sql) {
  return ALLOWED_PREFIXES.some(rx => rx.test(sql));
}

export async function handleExec(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, { status: 405 });
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Not authenticated' }, { status: 401 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }

  const sql = body.sql || body.SQL;
  if (!sql || !isAllowedUpdate(sql)) {
    return json({ error: 'Only schedule-writeback UPDATEs allowed here' }, { status: 400 });
  }

  try {
    const ok = await runExec(env, session.clientID, sql);
    return json({ ok });
  } catch (err) {
    return json({ error: err.message || String(err) }, { status: 502 });
  }
}
