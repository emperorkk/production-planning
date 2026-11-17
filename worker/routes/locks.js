/**
 * POST /api/order-locks  { findoc, machineLock: 0|1, dayLock: 0|1, machine?, start?, end? }
 *   → Foxline.planning/SetOrderLocks  (planner, access 'full' only — gated in worker/index.js)
 *   BOOL01 = reserved machine (also writes CCCFXRSRC), BOOL02 = locked production day (also writes DATE01/02).
 */
import { callJS }     from '../soft1-client.js';
import { getSession } from '../session.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
function json(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}
const DT_RX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

export async function handleOrderLocks(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, { status: 405 });
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Not authenticated' }, { status: 401 });

  let b;
  try { b = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }

  const ml = b.machineLock === 1 || b.machineLock === '1' ? 1 : 0;
  const dl = b.dayLock === 1 || b.dayLock === '1' ? 1 : 0;
  if (!/^\d+$/.test(String(b.findoc))) return json({ error: 'Invalid findoc' }, { status: 400 });
  if (ml && !/^\d+$/.test(String(b.machine))) return json({ error: 'machine is required to reserve' }, { status: 400 });
  const hasDates = b.start != null || b.end != null;
  if (hasDates && !(DT_RX.test(b.start) && DT_RX.test(b.end) && b.start < b.end)) return json({ error: 'Invalid dates' }, { status: 400 });
  if (dl && !hasDates) return json({ error: 'start / end are required to lock the day' }, { status: 400 });

  const params = { findoc: String(b.findoc), machineLock: String(ml), dayLock: String(dl) };
  if (ml) params.machine = String(b.machine);
  if (hasDates) { params.start = b.start; params.end = b.end; }
  try {
    const data = await callJS(env, session.clientID, 'SetOrderLocks', params);
    if (data.success === false) return json({ error: data.error || 'SetOrderLocks failed' }, { status: 400 });
    console.log(`locks ${b.findoc} by ${session.user}: machine ${ml} day ${dl}`);
    return json({ ok: true, ...data });
  } catch (err) {
    return json({ error: err.message || String(err) }, { status: 502 });
  }
}
