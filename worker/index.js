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
 *   POST /api/change-password → native Soft1 changePassword (session clientID)
 *   GET  /api/version       → { version } (public)
 *   POST /api/data          → named dataset via Foxline.planning/<Get...>
 *   POST /api/record        → native Soft1 getData (whitelisted objects: RSRC)
 *   POST /api/calendar      → production calendar (CCCFXPCAL) via Foxline.planning
 *   POST /api/save          → write schedule via Foxline.planning/SaveSchedule      (full access)
 *   POST /api/machine       → native Soft1 setData RSRC (Διαχείριση παραγωγής)
 *   POST /api/move          → move production orders in time (dates only) via SaveSchedule
 *
 * Access levels (worker/access.js): 'full' (appId 1199) = planner + production app,
 * 'production' (appId 1200) = production app only. Planner pages are desktop-only.
 */

import { handleLogin, handleLogout, handleMe, handleChangePassword } from './routes/auth.js';
import { handleData, handleSave }              from './routes/data.js';
import { handleRecord }                        from './routes/record.js';
import { handleCalendar }                      from './routes/calendar.js';
import { handleMachineSave, handleMove }       from './routes/production.js';
import { getSession }                          from './session.js';
import { sessionAccess, homeFor, isMobileRequest, PLANNER_PAGES, PRODUCTION_HOME } from './access.js';
import { VERSION }                             from './version.js';

const PUBLIC_PATHS = new Set([
  '/login.html',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/production.webmanifest',
  '/sw.js'
]);

// Planner-only API (403 for access 'production')
const PLANNER_API = new Set(['/api/save', '/api/calendar']);

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
      if (path === '/api/change-password') return handleChangePassword(request, env);
      if (PLANNER_API.has(path)) {
        const s = await getSession(request, env);
        if (s && sessionAccess(s) !== 'full') {
          return new Response(JSON.stringify({ error: 'Δεν επιτρέπεται με αυτό το επίπεδο πρόσβασης' }), {
            status: 403, headers: { 'content-type': 'application/json' }
          });
        }
      }
      if (path === '/api/data')   return handleData(request, env);
      if (path === '/api/machine') return handleMachineSave(request, env);
      if (path === '/api/move')    return handleMove(request, env);
      if (path === '/api/record') return handleRecord(request, env);
      if (path === '/api/calendar') return handleCalendar(request, env);
      if (path === '/api/save')   return handleSave(request, env);

      // ── Root redirect ──────────────────────────────────────────────────
      if (path === '/' || path === '/login') {
        const session = await getSession(request, env);
        const target = session ? homeFor(session, request) : '/login.html';
        return Response.redirect(url.origin + target, 302);
      }

      // ── Static assets: gate everything except PUBLIC_PATHS ─────────────
      const isPublicStatic = PUBLIC_PATHS.has(path) || path.startsWith('/src/') || path.startsWith('/icons/');
      if (!isPublicStatic) {
        const session = await getSession(request, env);
        if (!session) {
          return Response.redirect(url.origin + '/login.html', 302);
        }
        // Planner: full access + not a phone → otherwise land in the production app
        if (PLANNER_PAGES.has(path) && (sessionAccess(session) !== 'full' || isMobileRequest(request))) {
          return Response.redirect(url.origin + PRODUCTION_HOME, 302);
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
