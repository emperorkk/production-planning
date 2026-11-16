/**
 * Access levels — chosen on the login page, one Soft1 appId each.
 *
 *   full        appId SOFT1_APP_ID (1199)            Προγραμματισμός + Διαχείριση παραγωγής
 *   production  appId SOFT1_APP_ID_PRODUCTION (1200) Διαχείριση παραγωγής only
 *
 * Sessions created before access levels existed have no `access` → treated as full
 * (they were logged in with 1199).
 */

export const PLANNER_HOME    = '/production-planner.html';
export const PRODUCTION_HOME = '/production.html';

// Planner-only pages (desktop + full access)
export const PLANNER_PAGES = new Set(['/production-planner.html', '/calendar.html']);

export function normalizeAccess(v) {
  return v === 'production' ? 'production' : 'full';
}

export function sessionAccess(session) {
  return normalizeAccess(session && session.access);
}

export function appIdFor(env, access) {
  if (normalizeAccess(access) === 'production') return String(env.SOFT1_APP_ID_PRODUCTION || '1200');
  return String(env.SOFT1_APP_ID || '');
}

// appId of an existing session (falls back for sessions created before v0.8)
export function sessionAppId(env, session) {
  return (session && session.appId) ? String(session.appId) : appIdFor(env, sessionAccess(session));
}

// Phones (not tablets/desktops). Planner is desktop-only.
export function isMobileRequest(request) {
  const ua = request.headers.get('user-agent') || '';
  return /Mobi|Android.+Mobile|iPhone|iPod|Windows Phone/i.test(ua);
}

export function homeFor(session, request) {
  if (sessionAccess(session) === 'full' && !isMobileRequest(request)) return PLANNER_HOME;
  return PRODUCTION_HOME;
}
