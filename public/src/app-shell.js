/* AppShell — shared chrome for every app page (Προγραμματισμός, Διαχείριση παραγωγής).

   AppShell.mount({
     current:      'planner' | 'production',
     toolbar:      Element   // desktop layout: buttons appended (switcher · 🔑 · Έξοδος)
     menu:         Element   // mobile layout: menu items appended instead of buttons
     confirmLeave: fn → bool // e.g. unsaved-changes confirm (logout + switcher)
     onLeave:      fn        // called right before navigating away (after confirm)
     toast:        fn(msg, type)
   })

   Needs Soft1Bridge (init() already awaited → .access, .user). Mock mode (file://):
   switcher works, 🔑 and Έξοδος are hidden. Styles: src/app-shell.css. */
(function (global) {
  'use strict';

  var APPS = {
    planner:    { href: 'production-planner.html', label: 'Προγραμματισμός',     icon: '📅', desktopOnly: true, full: true,
                  svg: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M7 13h4M7 17h7"/>' },
    production: { href: 'production.html',         label: 'Διαχείριση παραγωγής', icon: '🏭',
                  svg: '<path d="M3 21V10l6 4V10l6 4V6l6 3v12z"/><path d="M3 21h18"/>' }
  };
  // Line icons for menu layout (24×24, stroke = currentColor)
  var SVG = {
    password: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
    logout:   '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>'
  };
  var LAST_APP_KEY = 'pp-last-app';

  function isMobile() {
    var ua = navigator.userAgent || '';
    if (/Mobi|Android.+Mobile|iPhone|iPod|Windows Phone/i.test(ua)) return true;
    return !!(global.matchMedia && matchMedia('(max-width: 700px) and (pointer: coarse)').matches);
  }

  function access() {
    var B = global.Soft1Bridge;
    return (B && B.access) || 'full';
  }

  // Apps this user may switch to from here
  function availableApps() {
    var out = [];
    Object.keys(APPS).forEach(function (k) {
      var a = APPS[k];
      if (a.full && access() !== 'full') return;
      if (a.desktopOnly && isMobile()) return;
      out.push(k);
    });
    return out;
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'className') e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    if (text != null) e.textContent = text;
    return e;
  }

  function fallbackToast(msg) {
    var t = document.getElementById('as-toast');
    if (!t) { t = el('div', { id: 'as-toast', className: 'as-toast' }); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('visible');
    clearTimeout(fallbackToast._t);
    fallbackToast._t = setTimeout(function () { t.classList.remove('visible'); }, 3500);
  }

  // ── Change-password dialog (native Soft1 changePassword) ─────────────────
  function buildPasswordDialog() {
    var bd = document.getElementById('pw-backdrop');
    if (bd) return bd;
    bd = el('div', { id: 'pw-backdrop', className: 'as-backdrop', role: 'dialog', 'aria-modal': 'true' });
    bd.innerHTML =
      '<div class="as-dialog">' +
        '<div class="as-dialog-header">&#128273; Αλλαγή κωδικού πρόσβασης</div>' +
        '<form id="pw-form" class="as-dialog-body" autocomplete="on">' +
          '<input type="text" name="username" id="pw-user" autocomplete="username" hidden />' +
          '<label for="pw-old">Τρέχων κωδικός</label>' +
          '<input id="pw-old" type="password" autocomplete="current-password" required />' +
          '<label for="pw-new">Νέος κωδικός</label>' +
          '<input id="pw-new" type="password" autocomplete="new-password" required />' +
          '<label for="pw-new2">Επιβεβαίωση νέου κωδικού</label>' +
          '<input id="pw-new2" type="password" autocomplete="new-password" required />' +
          '<div id="pw-error" class="as-error"></div>' +
          '<div class="as-hint">Ο κωδικός αλλάζει στο Soft1 (Web Account). Η τρέχουσα σύνδεση παραμένει ενεργή.</div>' +
        '</form>' +
        '<div class="as-dialog-footer">' +
          '<button id="btn-pw-cancel" class="as-btn as-btn-cancel" type="button">Άκυρο</button>' +
          '<button id="btn-pw-save" class="as-btn as-btn-confirm" type="submit" form="pw-form">Αλλαγή</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bd);
    return bd;
  }

  function bindPasswordDialog(toast) {
    var bd = buildPasswordDialog();
    var f = { old: document.getElementById('pw-old'), nw: document.getElementById('pw-new'),
              nw2: document.getElementById('pw-new2'), err: document.getElementById('pw-error'),
              user: document.getElementById('pw-user'), save: document.getElementById('btn-pw-save') };
    function close() { bd.classList.remove('visible'); f.old.value = f.nw.value = f.nw2.value = ''; }
    document.getElementById('btn-pw-cancel').addEventListener('click', close);
    bd.addEventListener('click', function (e) { if (e.target === bd) close(); });
    bd.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    document.getElementById('pw-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      f.err.textContent = '';
      if (!f.old.value || !f.nw.value) { f.err.textContent = 'Συμπληρώστε όλα τα πεδία'; return; }
      if (f.nw.value !== f.nw2.value)  { f.err.textContent = 'Ο νέος κωδικός και η επιβεβαίωση δεν ταιριάζουν'; f.nw2.focus(); return; }
      if (f.nw.value === f.old.value)  { f.err.textContent = 'Ο νέος κωδικός είναι ίδιος με τον τρέχοντα'; return; }
      f.save.disabled = true;
      try {
        await Soft1Bridge.changePassword(f.old.value, f.nw.value);
        close();
        toast('Ο κωδικός άλλαξε επιτυχώς', 'success');
      } catch (ex) {
        f.err.textContent = 'Αποτυχία: ' + (ex.message || ex);
      } finally { f.save.disabled = false; }
    });
    return function open() {
      f.old.value = f.nw.value = f.nw2.value = ''; f.err.textContent = '';
      f.user.value = Soft1Bridge.user || '';
      bd.classList.add('visible');
      setTimeout(function () { f.old.focus(); }, 0);
    };
  }

  function mount(opts) {
    opts = opts || {};
    var toast = opts.toast || fallbackToast;
    var confirmLeave = opts.confirmLeave || function () { return true; };
    var onLeave = opts.onLeave || function () {};
    var isWeb = !!(global.Soft1Bridge && Soft1Bridge.isWeb);
    var current = opts.current;

    try { if (current) localStorage.setItem(LAST_APP_KEY, current); } catch (_) {}

    var actions = [];
    availableApps().forEach(function (k) {
      if (k === current) return;
      var a = APPS[k];
      actions.push({ id: 'btn-switch-' + k, cls: 'as-switch', icon: a.icon, svg: a.svg, label: a.label,
                     title: 'Μετάβαση σε: ' + a.label, href: a.href,
                     run: function () {
                       if (!confirmLeave()) return;
                       onLeave();
                       location.href = a.href;
                     } });
    });
    if (isWeb) {
      var openPw = bindPasswordDialog(toast);
      actions.push({ id: 'btn-password', cls: 'as-password', icon: '🔑', label: 'Αλλαγή κωδικού',
                     title: 'Αλλαγή κωδικού πρόσβασης', iconOnly: true, svg: SVG.password, run: openPw });
      actions.push({ id: 'btn-logout', cls: 'as-logout', icon: '↪', svg: SVG.logout, label: 'Έξοδος',
                     title: 'Αποσύνδεση (' + (Soft1Bridge.user || '') + ')',
                     run: function () {
                       if (!confirmLeave()) return;
                       onLeave();
                       Soft1Bridge.logout();
                     } });
    }

    actions.forEach(function (a) {
      var b;
      if (opts.menu) {
        b = el(a.href ? 'a' : 'button', { id: a.id, className: 'as-menu-item ' + a.cls, title: a.title });
        if (a.href) b.setAttribute('href', a.href); else b.setAttribute('type', 'button');
        var ic = el('span', { className: 'as-icon', 'aria-hidden': 'true' }, a.svg ? null : a.icon);
        if (a.svg) ic.innerHTML = '<svg viewBox="0 0 24 24">' + a.svg + '</svg>';
        b.appendChild(ic);
        b.appendChild(el('span', { className: 'as-label' }, a.label));
        opts.menu.appendChild(b);
      } else if (opts.toolbar) {
        b = el(a.href ? 'a' : 'button', { id: a.id, className: 'btn as-tool ' + a.cls, title: a.title });
        if (a.href) b.setAttribute('href', a.href); else b.setAttribute('type', 'button');
        b.textContent = a.iconOnly ? a.icon : (a.icon + ' ' + a.label);
        opts.toolbar.appendChild(b);
      } else return;
      b.addEventListener('click', function (e) { e.preventDefault(); a.run(); });
    });
  }

  global.AppShell = {
    mount: mount,
    isMobile: isMobile,
    availableApps: availableApps,
    APPS: APPS,
    lastApp: function () { try { return localStorage.getItem(LAST_APP_KEY); } catch (_) { return null; } }
  };
})(window);
