import { getRecord }  from '../soft1-client.js';
import { getSession } from '../session.js';
import { sessionAppId } from '../access.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
function json(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}

// Native Soft1 getData. Only these objects, with a fixed LOCATEINFO per object.
const RECORDS = {
  RSRC: 'RSRC:RSRC,CODE,NAME,ISACTIVE,RSRCTYPE,SETUPTIME,WAITTIME,MOVETIME,MPRDQTY,QUETIME,' +
        'EFFICIENCY,HCOST,HWORK,MINPRTIME,MAXPRTIME,REMARKS'
};

export async function handleRecord(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, { status: 405 });
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Not authenticated' }, { status: 401 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }

  const object = String(body.object || '');
  const key    = String(body.key ?? '');
  if (!Object.hasOwn(RECORDS, object)) return json({ error: 'Unknown object: ' + object }, { status: 400 });
  if (!/^\d+$/.test(key))             return json({ error: 'Invalid key' }, { status: 400 });

  try {
    const t0   = Date.now();
    const data = await getRecord(env, session.clientID, object, key, RECORDS[object], sessionAppId(env, session));
    const ms   = Date.now() - t0;
    return json({ ok: true, data }, { headers: { 'server-timing': `soft1;dur=${ms}` } });
  } catch (err) {
    return json({ error: err.message || String(err) }, { status: 502 });
  }
}
