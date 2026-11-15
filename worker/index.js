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
 *   GET  /api/version       → { version } (public)
 *   POST /api/data          → named dataset via Foxline.planning/<Get...>
 *   POST /api/record        → native Soft1 getData (whitelisted objects: RSRC)
 *   POST /api/calendar      → production calendar (CCCFXPCAL) via Foxline.planning
 *   POST /api/save          → write schedule via Foxline.planning/SaveSchedule
 */

import { handleLogin, handleLogout, handleMe } from './routes/auth.js';
import { handleData, handleSave }              from './routes/data.js';
import { handleRecord }                        from './routes/record.js';
import { handleCalendar }                      from './routes/calendar.js';
import { getSession }                          from './session.js';
import { VERSION }                             from './version.js';

const PUBLIC_PATHS = new Set([
  '/login.html',
  '/favicon.ico',
  '/manifest.webmanifest'
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── API routes ──────────────────────────────────────────────────────
      if (path === '/api/version') {
        return new Response(JSON.stringify({ version: VERSION }), {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
        });
      }
      if (path === '/api/login')  return handleLogin(request, env);
      if (path === '/api/logout') return handleLogout(request, env);
      if (path === '/api/me')     return handleMe(request, env);
      if (path === '/api/data')   return handleData(request, env);
      if (path === '/api/record') return handleRecord(request, env);
      if (path === '/api/calendar') return handleCalendar(request, env);
      if (path === '/api/save')   return handleSave(request, env);

      // ── Root redirect ──────────────────────────────────────────────────
      if (path === '/' || path === '/login') {
        const session = await getSession(request, env);
        const target = session ? '/production-planner.html' : '/login.html';
        return Response.redirect(url.origin + target, 302);
      }

      // ── Static assets: gate everything except PUBLIC_PATHS ─────────────
      const isPublicStatic = PUBLIC_PATHS.has(path) || path.startsWith('/src/') || path.startsWith('/icons/');
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
