/**
 * «Διαχείριση παραγωγής» write endpoints (both access levels).
 *
 *   POST /api/machine  { key, fields:{ SETUPTIME, MPRDQTY } }
 *        → native Soft1 setData OBJECT=RSRC (goes through the Soft1 object, not SQL)
 *   POST /api/move     { orders:[{ findoc, start, end, origMachine, origStart, origEnd }] }  (1..10)
 *        → Foxline.planning/SaveSchedule with machine = origMachine: only planned dates change,
 *          optimistic lock always on (orig* required), completed orders are never written.
 */
import { setRecord, getRecord, saveSchedule } from '../soft1-client.js';
import { getSession }           from '../session.js';
import { sessionAppId }         from '../access.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
function json(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}

const num = (min, max) => v => {
  if (v === '' || v == null) return { ok: false };
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? { ok: true, v: n } : { ok: false };
};

// Editable RSRC fields → validator (decided with the user: setup time + speed only)
export const RSRC_FIELDS = {
  SETUPTIME: num(0, 10000),          // λεπτά
  MPRDQTY:   num(0, 100000)          // m/min
};

export async function handleMachineSave(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, { status: 405 });
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Not authenticated' }, { status: 401 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }

  const key = String(body.key ?? '');
  if (!/^\d+$/.test(key)) return json({ error: 'Invalid key' }, { status: 400 });
  const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
  const row = {};
  for (const [k, v] of Object.entries(fields)) {
    const check = Object.hasOwn(RSRC_FIELDS, k) ? RSRC_FIELDS[k] : null;
    if (!check) return json({ error: 'Μη επιτρεπτό πεδίο: ' + k }, { status: 400 });
    const r = check(v);
    if (!r.ok) return json({ error: 'Μη έγκυρη τιμή για ' + k }, { status: 400 });
    row[k] = r.v;
  }
  if (!Object.keys(row).length) return json({ error: 'Καμία αλλαγή' }, { status: 400 });

  const appId = sessionAppId(env, session);
  try {
    await setRecord(env, session.clientID, 'RSRC', key, { RSRC: [row] }, appId);
    console.log(`setData RSRC ${key} by ${session.user}: ${Object.keys(row).join(',')}`);
    const data = await getRecord(env, session.clientID, 'RSRC', key,
      'RSRC:RSRC,CODE,NAME,WAITTIME,ISACTIVE,' + Object.keys(RSRC_FIELDS).join(','), appId);
    return json({ ok: true, data });
  } catch (err) {
    return json({ error: err.message || String(err) }, { status: 502 });
  }
}

const DT_RX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
function validMove(o) {
  return o && /^\d+$/.test(String(o.findoc)) && /^\d+$/.test(String(o.origMachine)) &&
    DT_RX.test(o.start) && DT_RX.test(o.end) && DT_RX.test(o.origStart) && DT_RX.test(o.origEnd) &&
    o.start < o.end;
}

export async function handleMove(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, { status: 405 });
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Not authenticated' }, { status: 401 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }

  const orders = body.orders;
  if (!Array.isArray(orders) || orders.length < 1 || orders.length > 10) return json({ error: 'orders[] required (1..10)' }, { status: 400 });
  if (!orders.every(validMove)) return json({ error: 'Invalid move payload' }, { status: 400 });

  const clean = orders.map(o => ({
    findoc: Number(o.findoc), machine: Number(o.origMachine), start: o.start, end: o.end,
    origMachine: Number(o.origMachine), origStart: o.origStart, origEnd: o.origEnd
  }));
  try {
    const result = await saveSchedule(env, session.clientID, clean);
    console.log(`move by ${session.user}: ${clean.map(o => o.findoc + ' ' + o.start).join(', ')} → saved ${result.saved}`);
    return json({ ok: result.success !== false, ...result });
  } catch (err) {
    return json({ error: err.message || String(err) }, { status: 502 });
  }
}
