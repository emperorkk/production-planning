/**
 * Session management — signed cookie + KV-backed session body.
 *
 * The cookie carries an opaque session id. The real session body
 * (clientID, company, user, expiry) lives in KV, so logout is a real logout
 * (delete the KV entry) and we can rotate credentials server-side at any time.
 */

const COOKIE_NAME = 'pp_sid';
export const SESSION_TTL = 60 * 60 * 8;   // 8 hours

function randomId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(/;\s*/).forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1));
  });
  return out;
}

export async function createSession(env, body) {
  const sid = randomId();
  await env.SESSIONS.put(sid, JSON.stringify({ ...body, createdAt: Date.now() }), {
    expirationTtl: SESSION_TTL
  });
  return sid;
}

export async function getSession(request, env) {
  const cookies = parseCookies(request.headers.get('cookie'));
  const sid = cookies[COOKIE_NAME];
  if (!sid) return null;
  const raw = await env.SESSIONS.get(sid);
  if (!raw) return null;
  try { return { sid, ...JSON.parse(raw) }; }
  catch { return null; }
}

export async function destroySession(request, env) {
  const cookies = parseCookies(request.headers.get('cookie'));
  const sid = cookies[COOKIE_NAME];
  if (sid) await env.SESSIONS.delete(sid);
}

export function sessionCookie(sid, { maxAge = SESSION_TTL } = {}) {
  const parts = [
    `${COOKIE_NAME}=${sid}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  return parts.join('; ');
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
