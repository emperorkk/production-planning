/* Theme — light / dark / system for pages that opt in (login, production.html).
   Load synchronously in <head> AFTER <meta name="theme-color"> so the theme is applied
   before first paint. Sets <html data-theme="light|dark" data-theme-pref="system|light|dark">.

   Theme.get()  → 'system' | 'light' | 'dark'   (stored preference)
   Theme.set(p) → store + apply; fires 'themechange' on window
   Theme.resolved() → 'light' | 'dark' */
(function (global) {
  'use strict';
  var KEY = 'pp-theme';
  var mq = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;
  var BAR = { light: '#ffffff', dark: '#0a0a0c' };

  function get() {
    var p = null;
    try { p = localStorage.getItem(KEY); } catch (_) {}
    return (p === 'light' || p === 'dark') ? p : 'system';
  }
  function resolved() {
    var p = get();
    if (p !== 'system') return p;
    return mq && mq.matches ? 'dark' : 'light';
  }
  function apply() {
    var t = resolved(), root = document.documentElement;
    root.setAttribute('data-theme', t);
    root.setAttribute('data-theme-pref', get());
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', BAR[t]);
    try { global.dispatchEvent(new CustomEvent('themechange', { detail: { theme: t, pref: get() } })); } catch (_) {}
  }
  function set(p) {
    try {
      if (p === 'light' || p === 'dark') localStorage.setItem(KEY, p); else localStorage.removeItem(KEY);
    } catch (_) {}
    apply();
  }
  if (mq) {
    var onChange = function () { if (get() === 'system') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  apply();
  global.Theme = { get: get, set: set, resolved: resolved };
})(window);
