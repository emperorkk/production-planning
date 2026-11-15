import { getDataset, saveSchedule } from '../soft1-client.js';
import { getSession }                from '../session.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
function json(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}

// Read-side endpoint. The browser names a dataset; the SQL lives in
// soft1/Foxline.planning.js. Only these functions may be called, with only these params.
const DATASETS = {
  GetMachines:          [],
  GetPhaseMachines:     [],
  GetOrdersInWeek:      ['weekStart', 'weekEnd'],
  GetUnscheduledOrders: ['offset', 'pageSize'],
  GetProductionOrders:  ['weekStart', 'weekEnd'],
  GetShifts:            ['monday'],
  GetMtrlTree:          [],
  GetOrderDetails:      ['findoc'],
  GetProduction:        ['findocs'],
  GetProductionRolls:   ['findoc']
};

export async function handleData(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, { status: 405 });
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Not authenticated' }, { status: 401 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }

  const name    = body.dataset;
  const allowed = Object.hasOwn(DATASETS, name) ? DATASETS[name] : null;
  if (!allowed) return json({ error: 'Unknown dataset: ' + name }, { status: 400 });

  const params = {};
  for (const k of allowed) {
    const v = body.params?.[k];
    if (v !== undefined && v !== null) params[k] = String(v);
  }

  try {
    const t0   = Date.now();
    const rows = await getDataset(env, session.clientID, name, params);
    const ms   = Date.now() - t0;
    console.log(`dataset ${name} ${JSON.stringify(params)}: ${rows.length} rows, soft1 ${ms} ms`);
    return json({ ok: true, rows }, { headers: { 'server-timing': `soft1;dur=${ms}` } });
  } catch (err) {
    return json({ error: err.message || String(err) }, { status: 502 });
  }
}

// Write-side endpoint. Takes structured order fields — never SQL.
// Foxline.planning/SaveSchedule builds the UPDATEs and re-validates everything
// (completed orders, company, types), so this is only a shape check.
const DATE_RX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const MAX_ORDERS = 2000;

function validOrder(o) {
  if (!o || !/^\d+$/.test(String(o.findoc))) return false;
  if (o.machine != null && !/^\d+$/.test(String(o.machine))) return false;
  if (o.start != null && !DATE_RX.test(o.start)) return false;
  if (o.end   != null && !DATE_RX.test(o.end))   return false;
  // Optimistic-lock values (as loaded) — optional
  if (o.origMachine != null && !/^\d+$/.test(String(o.origMachine))) return false;
  if (o.origStart   != null && !DATE_RX.test(o.origStart)) return false;
  if (o.origEnd     != null && !DATE_RX.test(o.origEnd))   return false;
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
    end:     o.end   ?? null,
    ...('origStart' in o || 'origEnd' in o || 'origMachine' in o ? {
      origMachine: o.origMachine == null ? null : Number(o.origMachine),
      origStart:   o.origStart ?? null,
      origEnd:     o.origEnd   ?? null
    } : {})
  }));

  try {
    const result = await saveSchedule(env, session.clientID, clean);
    return json({ ok: result.success !== false, ...result });
  } catch (err) {
    return json({ error: err.message || String(err) }, { status: 502 });
  }
}
