/**
 * Production Planning — Cloudflare Worker entry.
 *
 * Routes:
 *   GET  /                  → redirect to /login.html or /production-planner.html
 *   GET  /login.html        → static (served by ASSETS, open to all)
 *   GET  /production-planner.html → static, gated by session cookie
 *   POST /api/login         → Soft1 Web Services login + authenticate, set session
 *   POST /api/logout        → clear session
 *   GET  /api/me            → whoami
 *   POST /api/sql           → run SELECT via Soft1 (uses session clientID)
 *   POST /api/save          → write schedule via Foxline.planning/saveSchedule
 */

import { handleLogin, handleLogout, handleMe } from './routes/auth.js';
import { handleSql, handleSave }               from './routes/sql.js';
import { getSession }                          from './session.js';

const PUBLIC_PATHS = new Set([
  '/login.html',
  '/favicon.ico'
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── API routes ──────────────────────────────────────────────────────
      if (path === '/api/login')  return handleLogin(request, env);
      if (path === '/api/logout') return handleLogout(request, env);
      if (path === '/api/me')     return handleMe(request, env);
      if (path === '/api/sql')    return handleSql(request, env);
      if (path === '/api/save')   return handleSave(request, env);

      // ── Root redirect ──────────────────────────────────────────────────
      if (path === '/' || path === '/login') {
        const session = await getSession(request, env);
        const target = session ? '/production-planner.html' : '/login.html';
        return Response.redirect(url.origin + target, 302);
      }

      // ── Static assets: gate everything except PUBLIC_PATHS ─────────────
      const isPublicStatic = PUBLIC_PATHS.has(path) || path.startsWith('/src/');
      if (!isPublicStatic) {
        const session = await getSession(request, env);
        if (!session) {
          return Response.redirect(url.origin + '/login.html', 302);
        }
      }

      return env.ASSETS.fetch(request);

    } catch (err) {
      console.error('Worker error:', err);
      return new Response(JSON.stringify({ error: err.message || String(err) }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      });
    }
  }
};
