import { runSql, saveSchedule } from '../soft1-client.js';
import { getSession }        from '../session.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
function json(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}

// Reject anything that isn't a pure SELECT on the SQL endpoint.
// Same guard runs again inside Foxline.planning/getData — this one just fails fast.
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

// Write-side endpoint. Takes structured order fields — never SQL.
// Foxline.planning/saveSchedule builds the UPDATEs and re-validates everything
// (completed orders, company, types), so this is only a shape check.
const DATE_RX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const MAX_ORDERS = 2000;

function validOrder(o) {
  if (!o || !/^\d+$/.test(String(o.findoc))) return false;
  if (o.machine != null && !/^\d+$/.test(String(o.machine))) return false;
  if (o.start != null && !DATE_RX.test(o.start)) return false;
  if (o.end   != null && !DATE_RX.test(o.end))   return false;
  return true;
}

export async function handleSave(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, { status: 405 });
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Not authenticated' }, { status: 401 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }

  const orders = body.orders;
  if (!Array.isArray(orders) || orders.length === 0 || orders.length > MAX_ORDERS) {
    return json({ error: 'orders[] required (1..' + MAX_ORDERS + ')' }, { status: 400 });
  }
  const bad = orders.filter(o => !validOrder(o));
  if (bad.length) return json({ error: 'Invalid order payload', bad: bad.slice(0, 5) }, { status: 400 });

  const clean = orders.map(o => ({
    findoc:  Number(o.findoc),
    machine: o.machine == null ? null : Number(o.machine),
    start:   o.start ?? null,
    end:     o.end   ?? null
  }));

  try {
    const result = await saveSchedule(env, session.clientID, clean);
    return json({ ok: result.success !== false, ...result });
  } catch (err) {
    return json({ error: err.message || String(err) }, { status: 502 });
  }
}
