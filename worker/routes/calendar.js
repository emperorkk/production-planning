import { callJS }     from '../soft1-client.js';
import { getSession } from '../session.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
function json(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}

// Production calendar (CCCFXPCAL) — thin, validated pass-through to Foxline.planning.
//   { action: 'get',    monday }
//   { action: 'weeks',  from, to }
//   { action: 'create', monday, copy: 'previous' | 'none' }
//   { action: 'save',   monday, lines: [{ rsrc, s: '21 × 0/1' }] }
//   { action: 'fill',   from, to }          (Mondays, ≤ 26 weeks)
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isMonday = v => ISO.test(v) && new Date(v + 'T00:00:00Z').getUTCDay() === 1;

const ACTIONS = {
  get:    { fn: 'GetCalendarWeek',    check: b => isMonday(b.monday),                       params: b => ({ monday: b.monday }) },
  weeks:  { fn: 'GetCalendarWeeks',   check: b => ISO.test(b.from) && ISO.test(b.to),       params: b => ({ from: b.from, to: b.to }) },
  create: { fn: 'CreateCalendarWeek', check: b => isMonday(b.monday),                       params: b => ({ monday: b.monday, copy: b.copy === 'none' ? 'none' : 'previous' }) },
  fill:   { fn: 'FillMissingWeeks',   check: b => isMonday(b.from) && isMonday(b.to),       params: b => ({ from: b.from, to: b.to }) },
  save:   {
    fn: 'SaveCalendarWeek',
    check: b => isMonday(b.monday) && Array.isArray(b.lines) && b.lines.length > 0 && b.lines.length <= 500 &&
                b.lines.every(l => /^\d+$/.test(String(l.rsrc)) && /^[01]{21}$/.test(String(l.s))),
    params: b => ({ monday: b.monday, lines: b.lines.map(l => ({ rsrc: Number(l.rsrc), s: String(l.s) })) })
  }
};

export async function handleCalendar(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, { status: 405 });
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Not authenticated' }, { status: 401 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }

  const a = Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
  if (!a)            return json({ error: 'Unknown action' }, { status: 400 });
  if (!a.check(body)) return json({ error: 'Invalid parameters for ' + body.action }, { status: 400 });

  try {
    const t0   = Date.now();
    const data = await callJS(env, session.clientID, a.fn, a.params(body));
    const ms   = Date.now() - t0;
    console.log(`calendar ${body.action}: soft1 ${ms} ms, success=${data.success}`);
    return json(data, { status: data.success === false && !data.errors ? 502 : 200,
                        headers: { 'server-timing': `soft1;dur=${ms}` } });
  } catch (err) {
    return json({ error: err.message || String(err) }, { status: 502 });
  }
}
