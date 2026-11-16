/**
 * «Διαχείριση παραγωγής» write endpoints (both access levels).
 *
 *   POST /api/machine  { key, fields:{ SETUPTIME, WAITTIME, MPRDQTY, ISACTIVE, REMARKS } }
 *        → native Soft1 setData OBJECT=RSRC (goes through the Soft1 object, not SQL)
 */
import { setRecord, getRecord } from '../soft1-client.js';
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

// Editable RSRC fields → validator
export const RSRC_FIELDS = {
  SETUPTIME: num(0, 10000),          // λεπτά
  WAITTIME:  num(0, 10000),          // λεπτά
  MPRDQTY:   num(0, 100000),         // m/min
  ISACTIVE:  v => (v === 0 || v === 1 || v === '0' || v === '1') ? { ok: true, v: Number(v) } : { ok: false },
  REMARKS:   v => (typeof v === 'string' && v.length <= 2000) ? { ok: true, v } : { ok: false }
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
      'RSRC:RSRC,CODE,NAME,' + Object.keys(RSRC_FIELDS).join(','), appId);
    return json({ ok: true, data });
  } catch (err) {
    return json({ error: err.message || String(err) }, { status: 502 });
  }
}
