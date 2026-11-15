import { loginAndAuthenticate }                              from '../soft1-client.js';
import { createSession, destroySession, getSession, sessionCookie, clearCookie } from '../session.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}

export async function handleLogin(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, { status: 405 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { username, password, company, branch } = body;
  if (!username || !password) {
    return json({ error: 'username and password are required' }, { status: 400 });
  }

  try {
    const auth = await loginAndAuthenticate(env, { username, password, company, branch });
    const sid  = await createSession(env, {
      clientID: auth.clientID,
      company:  auth.company,
      branch:   auth.branch,
      user:     auth.user
    });
    return json(
      { ok: true, user: auth.user, company: auth.company, branch: auth.branch },
      { headers: { 'set-cookie': sessionCookie(sid) } }
    );
  } catch (err) {
    return json({ error: err.message || String(err) }, { status: 401 });
  }
}

export async function handleLogout(request, env) {
  await destroySession(request, env);
  return json({ ok: true }, { headers: { 'set-cookie': clearCookie() } });
}

export async function handleMe(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Not authenticated' }, { status: 401 });
  return json({
    user:    session.user,
    company: session.company,
    branch:  session.branch
  });
}
