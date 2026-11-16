/* ProductionApp — «Διαχείριση παραγωγής» (production.html). Mobile-first, burger menu.

   Views (hash routes): #running · #idle · #orders · #customers · #machines
   Data: Soft1Bridge.dataset('Pm…') → /api/data → soft1/Foxline.planning.js (Pm* functions)
         Soft1Bridge.machineSave()  → /api/machine → native setData RSRC
   file:// = mock mode with demo data (MOCK below). Dates: DateFmt (dd/mm/yyyy, 24h). */
(function (global) {
  'use strict';

  var VIEWS = {
    running:   { title: 'Τρέχουσες παραγωγές' },
    idle:      { title: 'Αδράνεια μηχανών' },
    orders:    { title: 'Εντολές παραγωγής' },
    customers: { title: 'Παραγγελίες πελατών' },
    machines:  { title: 'Μηχανές' }
  };
  var DEFAULT_VIEW = 'running';
  var RUNNING_REFRESH_MS = 60000;
  var SHIFT_HOURS = { 1: [6, 14], 2: [14, 22], 3: [22, 30] };   // 3 = 22:00 → 06:00 next day
  var ROLL_RECENT_MS = 2 * 3600000;                             // "running" if a roll in the last 2 h

  var state = {
    view: null,
    phaseNames: {},
    machines: null,        // PmGetMachineList rows
    idleDay: null,
    runningTimer: null,
    loaded: {}
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date) return v.getFullYear() < 1990 ? null : v;
    var s = String(v);
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    var d = m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : new Date(s);
    if (isNaN(d.getTime()) || d.getFullYear() < 1990) return null;
    return d;
  }
  function num(v, dec) {
    var n = parseFloat(v);
    if (!isFinite(n)) return '—';
    return n.toLocaleString('el-GR', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
  }
  function dur(min) {
    min = Math.max(0, Math.round(min));
    var h = Math.floor(min / 60), m = min % 60;
    return h ? (h + 'ω ' + (m < 10 ? '0' : '') + m + '\'') : (m + '\'');
  }
  function ago(d) {
    if (!d) return '—';
    var min = (Date.now() - d.getTime()) / 60000;
    if (min < 1) return 'μόλις τώρα';
    return 'πριν ' + dur(min);
  }
  function when(d) {
    if (!d) return '—';
    var today = new Date();
    return d.toDateString() === today.toDateString() ? DateFmt.t(d) : DateFmt.dt(d);
  }
  function statusLabel(s) {
    s = parseInt(s, 10);
    if (s === 1)  return { text: 'Ολοκληρωμένη', cls: 'done' };
    if (s === -1) return { text: 'Δημιουργημένη', cls: 'off' };
    return { text: 'Ανοιχτή', cls: 'run' };
  }
  function phaseLabel(p) {
    if (p == null || p === '') return '';
    return state.phaseNames[String(p)] || String(p);
  }
  function addDays(d, n) { var r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function mondayOf(d) {
    var r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var dow = r.getDay(); r.setDate(r.getDate() + (dow === 0 ? -6 : 1 - dow));
    return r;
  }
  function flag(v) {
    if (v === null || v === undefined || v === '') return false;
    var s = String(v).trim().toUpperCase();
    return s === '1' || s === 'TRUE' || s === 'Y' || parseInt(s, 10) > 0;
  }

  var _toastTimer;
  function toast(msg, type) {
    var t = $('pm-toast');
    t.textContent = msg; t.className = 'as-toast visible ' + (type || '');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { t.classList.remove('visible'); }, 3500);
  }
  var _busy = 0;
  function loading(on) {
    _busy += on ? 1 : -1; if (_busy < 0) _busy = 0;
    $('pm-loading').hidden = _busy === 0;
  }
  function errorBox(el, e) {
    el.innerHTML = '<div class="pm-error">Σφάλμα: ' + esc(e && e.message || e) + '</div>';
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  function ds(name, params) {
    if (Soft1Bridge.isMock) return Promise.resolve(MOCK.dataset(name, params || {}));
    return Soft1Bridge.dataset(name, params || {});
  }

  async function loadPhaseNames() {
    try {
      var rows = await ds('GetPhaseMachines');
      rows.forEach(function (r) {
        var nm = r.phaseName || r.phasename || r.PHASENAME;
        if (nm) state.phaseNames[String(r.phase)] = String(nm);
      });
    } catch (e) { console.warn('phase names:', e); }
  }

  async function loadMachines(force) {
    if (state.machines && !force) return state.machines;
    state.machines = await ds('PmGetMachineList');
    var sel = $('orders-machine');
    var cur = sel.value;
    sel.innerHTML = '<option value="">Όλες οι μηχανές</option>' + state.machines
      .filter(function (m) { return flag(m.isActive); })
      .map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name || m.code) + '</option>'; }).join('');
    sel.value = cur;
    return state.machines;
  }

  // ── Router / drawer ────────────────────────────────────────────────────────
  function openDrawer(open) {
    var d = $('pm-drawer');
    d.classList.toggle('open', open);
    d.setAttribute('aria-hidden', open ? 'false' : 'true');
    $('pm-scrim').hidden = !open;
    $('pm-burger').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { var a = d.querySelector('.pm-nav-item.active') || d.querySelector('.pm-nav-item'); if (a) a.focus(); }
  }

  function route() {
    var v = (location.hash || '').replace(/^#/, '');
    if (!VIEWS[v]) v = DEFAULT_VIEW;
    showView(v);
  }

  function showView(v) {
    state.view = v;
    Object.keys(VIEWS).forEach(function (k) { $('view-' + k).hidden = (k !== v); });
    document.querySelectorAll('.pm-nav-item').forEach(function (a) {
      var on = a.getAttribute('data-view') === v;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('pm-view-title').textContent = VIEWS[v].title;
    document.title = VIEWS[v].title + ' — Διαχείριση παραγωγής';
    openDrawer(false);
    clearInterval(state.runningTimer);
    if (v === 'running') state.runningTimer = setInterval(function () { if (!document.hidden) loadRunning(true); }, RUNNING_REFRESH_MS);
    if (!state.loaded[v]) { state.loaded[v] = true; refresh(); }
  }

  function refresh() {
    switch (state.view) {
      case 'running':   return loadRunning();
      case 'idle':      return loadIdle();
      case 'orders':    return searchOrders();
      case 'customers': return searchCustomers();
      case 'machines':  return loadMachineView(true);
    }
  }

  // ── Τρέχουσες παραγωγές ────────────────────────────────────────────────────
  function jobState(j) {
    var line = parseInt(j.stageLine, 10);
    if (line === 1) return { text: 'Setup', cls: 'setup', card: 'st-setup' };
    return { text: 'Παραγωγή', cls: 'run', card: 'st-run' };
  }

  async function loadRunning(silent) {
    var list = $('running-list');
    if (!silent) loading(true);
    try {
      var res = await Promise.all([ds('PmGetRunningJobs'), ds('PmGetMachineStatus')]);
      var jobs = res[0], status = res[1];
      var byMachine = {};
      jobs.forEach(function (j) { var k = String(j.machine || ''); (byMachine[k] = byMachine[k] || []).push(j); });

      var html = [];
      var running = 0, idle = 0;
      status.forEach(function (m) {
        var mj = byMachine[String(m.id)] || [];
        delete byMachine[String(m.id)];
        if (mj.length) { running++; mj.forEach(function (j) { html.push(jobCard(j, m.name)); }); }
        else { idle++; html.push(idleCard(m)); }
      });
      // jobs on machines not in the active list (or without machine)
      Object.keys(byMachine).forEach(function (k) {
        byMachine[k].forEach(function (j) { running++; html.push(jobCard(j, j.machineName || 'Χωρίς μηχανή')); });
      });
      list.innerHTML = html.join('') || '<div class="pm-empty">Δεν υπάρχουν μηχανές.</div>';
      $('running-summary').textContent = running + ' σε λειτουργία · ' + idle + ' χωρίς εργασία';
      $('running-updated').textContent = 'Ενημέρωση ' + DateFmt.t(new Date());
    } catch (e) {
      errorBox(list, e);
    } finally { if (!silent) loading(false); }
  }

  function jobCard(j, machineName) {
    var st = jobState(j);
    var kilos = parseFloat(j.kilos) || 0, prod = parseFloat(j.producedQty) || 0;
    var pct = kilos > 0 ? Math.min(100, Math.round(prod / kilos * 100)) : 0;
    var last = parseDate(j.lastRoll);
    return '<button class="pm-card ' + st.card + '" type="button" data-order="' + esc(j.id) + '">' +
      '<div class="pm-card-head"><div class="pm-card-title">' + esc(machineName || j.machineName) + '</div>' +
      '<span class="pm-badge ' + st.cls + '">' + st.text + '</span></div>' +
      '<div class="pm-card-sub"><b>' + esc(j.fincode) + '</b> · ' + esc(j.itemCode) + ' ' + esc(j.itemName) + '</div>' +
      (j.customer ? '<div class="pm-card-sub">' + esc(j.customer) + (j.salesOrder ? ' · ' + esc(j.salesOrder) : '') + '</div>' : '') +
      '<div class="pm-progress" title="' + pct + '%"><div style="width:' + pct + '%"></div></div>' +
      '<div class="pm-card-row"><span><b>' + num(prod) + '</b> / ' + num(kilos) + ' kg (' + pct + '%)</span>' +
      '<span>' + num(j.rolls) + ' ρολά</span>' +
      '<span>Τελ. ρολό: <b>' + esc(last ? when(last) : '—') + '</b>' + (last ? ' (' + ago(last) + ')' : '') + '</span>' +
      (j.operator ? '<span>Χειριστής: ' + esc(j.operator) + '</span>' : '') +
      (parseDate(j.plannedEnd) ? '<span>Πλάνο λήξης: ' + esc(DateFmt.dt(parseDate(j.plannedEnd))) + '</span>' : '') +
      '</div></button>';
  }

  function idleCard(m) {
    var last = parseDate(m.lastRoll);
    return '<div class="pm-card st-idle">' +
      '<div class="pm-card-head"><div class="pm-card-title">' + esc(m.name || m.code) + '</div>' +
      '<span class="pm-badge idle">Χωρίς εργασία</span></div>' +
      '<div class="pm-card-sub">' + esc(phaseLabel(m.phase)) + '</div>' +
      '<div class="pm-card-row"><span>Τελ. ρολό: <b>' + esc(last ? when(last) : '—') + '</b>' + (last ? ' (' + ago(last) + ')' : '') + '</span>' +
      (m.lastFincode ? '<span>Εντολή: ' + esc(m.lastFincode) + '</span>' : '') + '</div></div>';
  }

  // ── Αδράνεια μηχανών ───────────────────────────────────────────────────────
  function shiftBlocks(row, day) {
    // day: local midnight. Returns merged [start,end] Date intervals of that production day.
    var dow = day.getDay() || 7;
    var out = [];
    for (var s = 1; s <= 3; s++) {
      if (!flag(row['S' + dow + s]) && !flag(row['s' + dow + s])) continue;
      var h = SHIFT_HOURS[s];
      out.push([new Date(day.getTime() + h[0] * 3600000), new Date(day.getTime() + h[1] * 3600000)]);
    }
    var merged = [];
    out.forEach(function (iv) {
      var last = merged[merged.length - 1];
      if (last && last[1].getTime() >= iv[0].getTime()) last[1] = iv[1]; else merged.push(iv);
    });
    return merged;
  }

  function idleGaps(blocks, times, thresholdMin, now) {
    var thr = thresholdMin * 60000, gaps = [];
    blocks.forEach(function (b) {
      var end = Math.min(b[1].getTime(), now.getTime());
      var prev = b[0].getTime();
      if (end <= prev) return;
      times.forEach(function (t) {
        var x = t.getTime();
        if (x < prev || x > end) return;
        if (x - prev > thr) gaps.push([new Date(prev), new Date(x)]);
        prev = x;
      });
      if (end - prev > thr) gaps.push([new Date(prev), new Date(end)]);
    });
    return gaps;
  }

  async function loadIdle() {
    var list = $('idle-list');
    var day = state.idleDay;
    $('idle-day').value = DateFmt.d(day);
    loading(true);
    try {
      var res = await Promise.all([
        loadMachines(),
        ds('GetShifts', { monday: DateFmt.toIso(mondayOf(day)) }),
        ds('PmGetMachineActivity', { day: DateFmt.toIso(day) })
      ]);
      var machines = res[0].filter(function (m) { return flag(m.isActive); });
      var shiftByMachine = {};
      res[1].forEach(function (r) { shiftByMachine[String(r.machine)] = r; });
      var rollsByMachine = {};
      res[2].forEach(function (r) {
        var t = parseDate(r.t); if (!t) return;
        (rollsByMachine[String(r.machine)] = rollsByMachine[String(r.machine)] || []).push(t);
      });
      var thr = parseInt($('idle-threshold').value, 10) || 30;
      var now = new Date();
      var dayStart = new Date(day.getTime() + 6 * 3600000), span = 24 * 3600000;
      function pct(d) { return Math.max(0, Math.min(100, (d.getTime() - dayStart.getTime()) / span * 100)); }

      var cards = machines.map(function (m) {
        var row = shiftByMachine[String(m.id)];
        var blocks = row ? shiftBlocks(row, day) : [];
        var times = (rollsByMachine[String(m.id)] || []).sort(function (a, b) { return a - b; });
        var inDay = times.filter(function (t) { return t >= dayStart && t < new Date(dayStart.getTime() + span); });
        var gaps = blocks.length ? idleGaps(blocks, times, thr, now) : [];
        var idleMin = gaps.reduce(function (s, g) { return s + (g[1] - g[0]) / 60000; }, 0);
        var openGap = gaps.length && Math.abs(gaps[gaps.length - 1][1].getTime() - Math.min(now.getTime(), blocks[blocks.length - 1][1].getTime())) < 60000
                      && now < blocks[blocks.length - 1][1] ? gaps[gaps.length - 1] : null;
        var cls = !blocks.length ? 'st-off' : (openGap ? 'st-idle' : (gaps.length ? 'st-setup' : 'st-run'));
        var badge = !blocks.length ? '<span class="pm-badge off">Χωρίς βάρδια</span>'
                  : openGap ? '<span class="pm-badge idle">Αδρανής από ' + esc(DateFmt.t(openGap[0])) + '</span>'
                  : gaps.length ? '<span class="pm-badge setup">' + esc(dur(idleMin)) + ' αδράνεια</span>'
                  : '<span class="pm-badge run">Χωρίς αδράνεια</span>';
        var bar = blocks.map(function (b) {
          return '<div class="pm-tl-shift" style="left:' + pct(b[0]) + '%;width:' + (pct(b[1]) - pct(b[0])) + '%"></div>';
        }).join('') + gaps.map(function (g) {
          return '<div class="pm-tl-idle" title="' + esc(DateFmt.t(g[0]) + '–' + DateFmt.t(g[1])) + '" style="left:' + pct(g[0]) + '%;width:' + Math.max(.4, pct(g[1]) - pct(g[0])) + '%"></div>';
        }).join('') + inDay.map(function (t) {
          return '<div class="pm-tl-roll" style="left:' + pct(t) + '%"></div>';
        }).join('') + (now > dayStart && now < new Date(dayStart.getTime() + span) ? '<div class="pm-tl-now" style="left:' + pct(now) + '%"></div>' : '');
        return '<div class="pm-card ' + cls + '">' +
          '<div class="pm-card-head"><div class="pm-card-title">' + esc(m.name || m.code) + '</div>' + badge + '</div>' +
          '<div class="pm-card-sub">' + esc(phaseLabel(m.phase)) + ' · ' + inDay.length + ' ρολά' +
            (blocks.length ? ' · αδράνεια ' + esc(dur(idleMin)) : '') + '</div>' +
          '<div class="pm-timeline" role="img" aria-label="Χρονογραμμή 06:00–06:00">' + bar + '</div>' +
          '<div class="pm-tl-scale"><span>06</span><span>10</span><span>14</span><span>18</span><span>22</span><span>02</span><span>06</span></div>' +
          (gaps.length ? '<ul class="pm-idle-list">' + gaps.map(function (g) {
            return '<li>' + esc(DateFmt.t(g[0])) + ' – ' + esc(DateFmt.t(g[1])) + ' (' + esc(dur((g[1] - g[0]) / 60000)) + ')</li>';
          }).join('') + '</ul>' : '') +
          '</div>';
      });
      // Idle machines first
      list.innerHTML = cards.join('') || '<div class="pm-empty">Δεν υπάρχουν ενεργές μηχανές.</div>';
    } catch (e) {
      errorBox(list, e);
    } finally { loading(false); }
  }

  function setIdleDay(d) { state.idleDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()); loadIdle(); }

  // ── Εντολές παραγωγής ──────────────────────────────────────────────────────
  function orderCard(o) {
    var st = statusLabel(o.status);
    var kilos = parseFloat(o.kilos) || 0, prod = parseFloat(o.producedQty) || 0;
    var pct = kilos > 0 ? Math.min(100, Math.round(prod / kilos * 100)) : 0;
    var deliv = parseDate(o.deliveryDate);
    return '<button class="pm-card ' + (st.cls === 'done' ? 'st-off' : 'st-run') + '" type="button" data-order="' + esc(o.id) + '">' +
      '<div class="pm-card-head"><div class="pm-card-title">' + esc(o.fincode) + '</div>' +
      '<span class="pm-badge ' + st.cls + '">' + st.text + '</span></div>' +
      '<div class="pm-card-sub">' + esc(o.itemCode) + ' ' + esc(o.itemName) + '</div>' +
      '<div class="pm-card-row">' +
        (o.machineName ? '<span>&#128295; ' + esc(o.machineName) + '</span>' : '<span class="pm-muted">Χωρίς μηχανή</span>') +
        (o.phase ? '<span>' + esc(phaseLabel(o.phase)) + '</span>' : '') +
        (o.customer ? '<span>' + esc(o.customer) + '</span>' : '') +
        (deliv ? '<span>Παράδοση <b>' + esc(DateFmt.d(deliv)) + '</b></span>' : '') +
      '</div>' +
      (prod > 0 ? '<div class="pm-progress"><div style="width:' + pct + '%"></div></div>' +
                 '<div class="pm-card-row"><span>' + num(prod) + ' / ' + num(kilos) + ' kg · ' + num(o.rolls) + ' ρολά</span></div>' : '') +
      '</button>';
  }

  async function searchOrders() {
    var list = $('orders-list');
    var st = document.querySelector('input[name="orders-status"]:checked');
    loading(true);
    try {
      var rows = await ds('PmSearchProductionOrders', {
        q: $('orders-q').value.trim(), status: st ? st.value : 'open', machine: $('orders-machine').value, limit: 100
      });
      list.innerHTML = rows.map(orderCard).join('') || '<div class="pm-empty">Δεν βρέθηκαν εντολές.</div>';
      if (rows.length >= 100) list.insertAdjacentHTML('beforeend', '<div class="pm-empty pm-small">Εμφανίζονται οι πρώτες 100 — περιορίστε την αναζήτηση.</div>');
    } catch (e) { errorBox(list, e); }
    finally { loading(false); }
  }

  async function openOrder(id) {
    openSheet('Εντολή παραγωγής', '<div class="pm-empty">Φόρτωση…</div>');
    try {
      var res = await Promise.all([ds('GetOrderDetails', { findoc: id }), ds('GetProductionRolls', { findoc: id })]);
      var o = res[0][0];
      if (!o) { $('pm-sheet-body').innerHTML = '<div class="pm-empty">Δεν βρέθηκε η εντολή.</div>'; return; }
      var rolls = res[1];
      var total = rolls.reduce(function (s, r) { return s + (parseFloat(r.qty) || 0); }, 0);
      var kilos = parseFloat(o.kilos) || 0;
      var st = statusLabel(o.status);
      $('pm-sheet-title').textContent = 'Εντολή ' + (o.fincode || id);
      $('pm-sheet-body').innerHTML =
        '<dl class="pm-kv">' +
          '<dt>Κατάσταση</dt><dd><span class="pm-badge ' + st.cls + '">' + st.text + '</span></dd>' +
          '<dt>Είδος</dt><dd>' + esc(o.itemCode) + ' ' + esc(o.itemName) + '</dd>' +
          (o.customerItemCode ? '<dt>Κωδ. πελάτη</dt><dd>' + esc(o.customerItemCode) + '</dd>' : '') +
          '<dt>Φάση</dt><dd>' + esc(phaseLabel(o.phase)) + '</dd>' +
          '<dt>Μηχανή</dt><dd>' + esc(o.machineName || '—') + '</dd>' +
          '<dt>Ποσότητα</dt><dd>' + num(kilos) + ' kg · ' + num(o.linearMetres) + ' m</dd>' +
          '<dt>Παράδοση</dt><dd>' + esc(DateFmt.d(parseDate(o.deliveryDate)) || '—') + '</dd>' +
          '<dt>Πελάτης</dt><dd>' + esc(o.customer || '—') + '</dd>' +
          '<dt>Παραγγελία</dt><dd>' + esc(o.salesOrder || '—') + (o.customerPO ? ' · PO ' + esc(o.customerPO) : '') + '</dd>' +
          (o.remarks ? '<dt>Σχόλια</dt><dd>' + esc(o.remarks) + '</dd>' : '') +
        '</dl>' +
        '<div class="pm-section-title">Παραγωγή — ' + num(total) + ' / ' + num(kilos) + ' kg' +
          (kilos > 0 ? ' (' + Math.round(total / kilos * 100) + '%)' : '') + ' · ' + rolls.length + ' ρολά</div>' +
        (rolls.length ? '<table class="pm-table"><thead><tr><th>Ημ/νία</th><th>Lot</th><th class="num">kg</th></tr></thead><tbody>' +
          rolls.map(function (r) {
            return '<tr><td>' + esc(DateFmt.d(parseDate(r.trndate))) + '</td><td>' + esc(r.lot || r.mtrlot || '') + '</td><td class="num">' + num(r.qty, 1) + '</td></tr>';
          }).join('') + '</tbody></table>' : '<div class="pm-muted pm-small">Δεν υπάρχουν ρολά ακόμη.</div>');
    } catch (e) { errorBox($('pm-sheet-body'), e); }
  }

  // ── Παραγγελίες πελατών ────────────────────────────────────────────────────
  async function searchCustomers() {
    var list = $('customers-list');
    loading(true);
    try {
      var rows = await ds('PmSearchCustomerOrders', { q: $('customers-q').value.trim(), limit: 100 });
      list.innerHTML = rows.map(function (c) {
        var orders = parseInt(c.orders, 10) || 0, done = parseInt(c.done, 10) || 0;
        var pct = orders ? Math.round(done / orders * 100) : 0;
        return '<button class="pm-card ' + (done === orders ? 'st-off' : 'st-run') + '" type="button" data-customer-order="' + esc(c.id) + '" data-title="' + esc(c.fincode) + '">' +
          '<div class="pm-card-head"><div class="pm-card-title">' + esc(c.fincode) + '</div>' +
          '<span class="pm-badge ' + (done === orders ? 'done' : 'run') + '">' + done + '/' + orders + ' εντολές</span></div>' +
          '<div class="pm-card-sub">' + esc(c.customer || '—') + '</div>' +
          '<div class="pm-card-row">' +
            '<span>Ημ/νία ' + esc(DateFmt.d(parseDate(c.trndate))) + '</span>' +
            (c.customerPO ? '<span>PO ' + esc(c.customerPO) + '</span>' : '') +
            (parseDate(c.firstDelivery) ? '<span>Παράδοση <b>' + esc(DateFmt.d(parseDate(c.firstDelivery))) + '</b></span>' : '') +
          '</div><div class="pm-progress"><div style="width:' + pct + '%"></div></div></button>';
      }).join('') || '<div class="pm-empty">Δεν βρέθηκαν παραγγελίες.</div>';
    } catch (e) { errorBox(list, e); }
    finally { loading(false); }
  }

  async function openCustomerOrder(id, title) {
    openSheet('Παραγγελία ' + (title || id), '<div class="pm-empty">Φόρτωση…</div>');
    try {
      var rows = await ds('PmGetCustomerOrder', { findoc: id });
      var first = rows[0] || {};
      $('pm-sheet-body').innerHTML =
        (first.customer ? '<dl class="pm-kv"><dt>Πελάτης</dt><dd>' + esc(first.customer) + '</dd>' +
          (first.customerPO ? '<dt>PO</dt><dd>' + esc(first.customerPO) + '</dd>' : '') + '</dl>' : '') +
        '<div class="pm-section-title">Εντολές παραγωγής (' + rows.length + ')</div>' +
        '<div class="pm-cards">' + (rows.map(orderCard).join('') || '<div class="pm-empty">Καμία εντολή.</div>') + '</div>';
    } catch (e) { errorBox($('pm-sheet-body'), e); }
  }

  // ── Μηχανές ────────────────────────────────────────────────────────────────
  async function loadMachineView(force) {
    var list = $('machines-list');
    loading(true);
    try {
      await loadMachines(force);
      renderMachines();
    } catch (e) { errorBox(list, e); }
    finally { loading(false); }
  }

  function renderMachines() {
    var q = $('machines-q').value.trim().toLowerCase();
    var rows = (state.machines || []).filter(function (m) {
      return !q || (String(m.code) + ' ' + String(m.name)).toLowerCase().indexOf(q) >= 0;
    });
    $('machines-list').innerHTML = rows.map(function (m) {
      var active = flag(m.isActive);
      return '<button class="pm-card ' + (active ? 'st-run' : 'st-off') + '" type="button" data-machine="' + esc(m.id) + '">' +
        '<div class="pm-card-head"><div class="pm-card-title">' + esc(m.name || m.code) + '</div>' +
        '<span class="pm-badge ' + (active ? 'run' : 'off') + '">' + (active ? 'Ενεργή' : 'Ανενεργή') + '</span></div>' +
        '<div class="pm-card-sub">' + esc(m.code) + (m.phase ? ' · ' + esc(m.phaseName || phaseLabel(m.phase)) : '') + '</div>' +
        '<div class="pm-card-row"><span>Setup <b>' + num(m.setupTime) + '\'</b></span><span>Αναμονή <b>' + num(m.waitTime) + '\'</b></span>' +
        '<span>Ταχύτητα <b>' + num(m.speed, 1) + '</b> m/min</span></div></button>';
    }).join('') || '<div class="pm-empty">Δεν βρέθηκαν μηχανές.</div>';
  }

  function openMachine(id) {
    var m = (state.machines || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!m) return;
    openSheet(m.name || m.code,
      '<form id="machine-form" class="pm-form" novalidate>' +
        '<div class="pm-card-sub">' + esc(m.code) + (m.phase ? ' · ' + esc(m.phaseName || phaseLabel(m.phase)) : '') + '</div>' +
        '<label for="mf-setup">Χρόνος setup (λεπτά)</label><input id="mf-setup" class="pm-input" type="text" inputmode="decimal" value="' + esc(m.setupTime == null ? '' : m.setupTime) + '" />' +
        '<label for="mf-wait">Χρόνος αναμονής (λεπτά)</label><input id="mf-wait" class="pm-input" type="text" inputmode="decimal" value="' + esc(m.waitTime == null ? '' : m.waitTime) + '" />' +
        '<label for="mf-speed">Ταχύτητα (m/min)</label><input id="mf-speed" class="pm-input" type="text" inputmode="decimal" value="' + esc(m.speed == null ? '' : m.speed) + '" />' +
        '<label class="pm-switch"><input id="mf-active" type="checkbox"' + (flag(m.isActive) ? ' checked' : '') + ' /> Ενεργή</label>' +
        '<label for="mf-remarks">Σχόλια</label><textarea id="mf-remarks" class="pm-input" maxlength="2000">' + esc(m.remarks || '') + '</textarea>' +
        '<div id="mf-error" class="pm-form-error"></div>' +
        '<div class="pm-form-actions"><button type="button" class="pm-btn" id="mf-cancel">Άκυρο</button>' +
        '<button type="submit" class="pm-btn pm-btn-primary" id="mf-save">Αποθήκευση στο Soft1</button></div>' +
      '</form>');
    $('mf-cancel').addEventListener('click', closeSheet);
    $('machine-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var err = $('mf-error'); err.textContent = '';
      var vals = { SETUPTIME: $('mf-setup').value, WAITTIME: $('mf-wait').value, MPRDQTY: $('mf-speed').value };
      var fields = {};
      for (var k in vals) {
        var n = parseFloat(String(vals[k]).replace(',', '.'));
        if (vals[k] === '' || !isFinite(n) || n < 0) { err.textContent = 'Μη έγκυρη τιμή'; return; }
        vals[k] = n;
      }
      if (vals.SETUPTIME !== parseFloat(m.setupTime)) fields.SETUPTIME = vals.SETUPTIME;
      if (vals.WAITTIME  !== parseFloat(m.waitTime))  fields.WAITTIME  = vals.WAITTIME;
      if (vals.MPRDQTY   !== parseFloat(m.speed))     fields.MPRDQTY   = vals.MPRDQTY;
      var act = $('mf-active').checked ? 1 : 0;
      if (act !== (flag(m.isActive) ? 1 : 0)) fields.ISACTIVE = act;
      var rem = $('mf-remarks').value;
      if (rem !== (m.remarks || '')) fields.REMARKS = rem;
      if (!Object.keys(fields).length) { closeSheet(); return; }
      $('mf-save').disabled = true;
      try {
        await Soft1Bridge.machineSave(m.id, fields);
        if ('SETUPTIME' in fields) m.setupTime = fields.SETUPTIME;
        if ('WAITTIME' in fields)  m.waitTime  = fields.WAITTIME;
        if ('MPRDQTY' in fields)   m.speed     = fields.MPRDQTY;
        if ('ISACTIVE' in fields)  m.isActive  = fields.ISACTIVE;
        if ('REMARKS' in fields)   m.remarks   = fields.REMARKS;
        closeSheet();
        renderMachines();
        toast('Η μηχανή αποθηκεύτηκε στο Soft1', 'success');
      } catch (ex) {
        err.textContent = 'Αποτυχία: ' + (ex.message || ex);
      } finally { var b = $('mf-save'); if (b) b.disabled = false; }
    });
  }

  // ── Bottom sheet ───────────────────────────────────────────────────────────
  var _sheetReturn = null;
  function openSheet(title, html) {
    if ($('pm-sheet-backdrop').hidden) _sheetReturn = document.activeElement;
    $('pm-sheet-title').textContent = title;
    $('pm-sheet-body').innerHTML = html;
    $('pm-sheet-backdrop').hidden = false;
    $('pm-sheet-close').focus();
  }
  function closeSheet() {
    $('pm-sheet-backdrop').hidden = true;
    $('pm-sheet-body').innerHTML = '';
    if (_sheetReturn && _sheetReturn.focus) _sheetReturn.focus();
  }

  // ── Install (PWA) ──────────────────────────────────────────────────────────
  function initInstall() {
    var btn = $('pm-install');
    var deferred = null;
    var standalone = (global.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    if (standalone) return;
    var ua = navigator.userAgent || '';
    var isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    btn.hidden = false;
    global.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; btn.hidden = false; });
    global.addEventListener('appinstalled', function () { btn.hidden = true; deferred = null; toast('Η εφαρμογή εγκαταστάθηκε', 'success'); });
    btn.addEventListener('click', async function () {
      openDrawer(false);
      if (deferred) {
        deferred.prompt();
        try { await deferred.userChoice; } catch (_) {}
        deferred = null;
        return;
      }
      $('pm-install-text').innerHTML = isIOS
        ? '<p>Στο Safari πατήστε <b>Κοινοποίηση</b> (&#x2191;&#xFE0E;) και μετά <b>«Προσθήκη στην οθόνη Αφετηρίας»</b>.</p>'
        : '<p>Ανοίξτε το μενού του browser (&#8942;) και επιλέξτε <b>«Εγκατάσταση εφαρμογής»</b> ή <b>«Προσθήκη στην αρχική οθόνη»</b>.</p>' +
          '<p class="as-hint">Σε Chrome/Edge το κουμπί λειτουργεί απευθείας όταν ο browser επιτρέπει την εγκατάσταση.</p>';
      $('pm-install-help').classList.add('visible');
    });
    $('pm-install-ok').addEventListener('click', function () { $('pm-install-help').classList.remove('visible'); });
    if (Soft1Bridge.isWeb && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function (e) { console.warn('sw:', e); });
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    try { await Soft1Bridge.init(); } catch (e) { console.error(e); }
    if (Soft1Bridge.isMock) $('pm-mock').hidden = false;
    $('pm-user').textContent = Soft1Bridge.user || '';

    AppShell.mount({ current: 'production', menu: $('pm-shell-menu'), toast: toast });
    initInstall();

    $('pm-burger').addEventListener('click', function () { openDrawer(!$('pm-drawer').classList.contains('open')); });
    $('pm-scrim').addEventListener('click', function () { openDrawer(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('pm-sheet-backdrop').hidden) closeSheet(); else openDrawer(false);
    });
    $('pm-refresh').addEventListener('click', function () { state.machines = null; refresh(); });
    global.addEventListener('hashchange', route);
    document.querySelectorAll('.pm-nav-item').forEach(function (a) {
      a.addEventListener('click', function () { if (a.getAttribute('data-view') === state.view) openDrawer(false); });
    });

    // Card clicks (delegated)
    document.addEventListener('click', function (e) {
      var c = e.target.closest && e.target.closest('[data-order],[data-customer-order],[data-machine]');
      if (!c) return;
      if (c.hasAttribute('data-order')) openOrder(c.getAttribute('data-order'));
      else if (c.hasAttribute('data-customer-order')) openCustomerOrder(c.getAttribute('data-customer-order'), c.getAttribute('data-title'));
      else if (c.hasAttribute('data-machine')) openMachine(c.getAttribute('data-machine'));
    });
    $('pm-sheet-close').addEventListener('click', closeSheet);
    $('pm-sheet-backdrop').addEventListener('click', function (e) { if (e.target === $('pm-sheet-backdrop')) closeSheet(); });

    // Idle
    state.idleDay = new Date(); state.idleDay.setHours(0, 0, 0, 0);
    if (new Date().getHours() < 6) state.idleDay = addDays(state.idleDay, -1);   // production day starts 06:00
    DateFmt.bind($('idle-day'));
    $('idle-day').addEventListener('change', function () { var d = DateFmt.parse(this.value); if (d) setIdleDay(d); });
    $('idle-prev').addEventListener('click', function () { setIdleDay(addDays(state.idleDay, -1)); });
    $('idle-next').addEventListener('click', function () { setIdleDay(addDays(state.idleDay, 1)); });
    $('idle-today').addEventListener('click', function () { var d = new Date(); if (d.getHours() < 6) d = addDays(d, -1); setIdleDay(d); });
    $('idle-threshold').addEventListener('change', loadIdle);

    // Searches
    $('orders-form').addEventListener('submit', function (e) { e.preventDefault(); searchOrders(); });
    document.querySelectorAll('input[name="orders-status"]').forEach(function (r) { r.addEventListener('change', searchOrders); });
    $('orders-machine').addEventListener('change', searchOrders);
    $('customers-form').addEventListener('submit', function (e) { e.preventDefault(); searchCustomers(); });
    $('machines-q').addEventListener('input', renderMachines);

    await loadPhaseNames();
    loadMachines().catch(function (e) { console.warn('machines:', e); });
    route();
  }

  // ── Mock data (file://) ────────────────────────────────────────────────────
  var MOCK = (function () {
    function at(h, m, dayOffset) { var d = new Date(); d.setDate(d.getDate() + (dayOffset || 0)); d.setHours(h, m, 0, 0); return d; }
    function iso(d) { return DateFmt.toIso(d) + ' ' + DateFmt.t(d) + ':00'; }
    var machines = [
      { id: 101, code: 'FLX-1', name: 'Flexo 8 χρωμάτων', isActive: 1, setupTime: 45, waitTime: 10, speed: 180, phase: 1001, phaseName: 'Εκτύπωση', remarks: '' },
      { id: 102, code: 'LAM-1', name: 'Λαμινατέζ 1', isActive: 1, setupTime: 30, waitTime: 20, speed: 150, phase: 2001, phaseName: 'Λαμινάρισμα', remarks: '' },
      { id: 103, code: 'SLT-1', name: 'Ρολοκόπτης 1', isActive: 1, setupTime: 15, waitTime: 0, speed: 300, phase: 3001, phaseName: 'Ρολοκοπή', remarks: 'Νέα μαχαίρια 11/2026' },
      { id: 104, code: 'BAG-1', name: 'Σακουλομηχανή 1', isActive: 1, setupTime: 20, waitTime: 5, speed: 90, phase: 4001, phaseName: 'Σακουλοποίηση', remarks: '' },
      { id: 105, code: 'BAG-2', name: 'Σακουλομηχανή 2', isActive: 0, setupTime: 20, waitTime: 5, speed: 80, phase: 4001, phaseName: 'Σακουλοποίηση', remarks: 'Εκτός λειτουργίας' }
    ];
    var now = new Date();
    function minsAgo(n) { return new Date(now.getTime() - n * 60000); }
    var orders = [
      { id: 9001, fincode: 'ΕΠΑ0012345', machine: 101, machineName: 'Flexo 8 χρωμάτων', itemCode: '80398', itemName: 'Φιλμ τυπωμένο Α', kilos: 1200, linearMetres: 24000, producedQty: 640, rolls: 8, lastRoll: iso(minsAgo(12)), stageLine: 2, status: 0, phase: 1001, customer: 'ΑΛΦΑ ΤΡΟΦΙΜΑ Α.Ε.', salesOrder: 'ΠΑΡ0004567', salesOrderId: 7001, customerPO: 'PO-8812', deliveryDate: DateFmt.toIso(addDays(now, 4)), plannedEnd: iso(at(20, 0)), operator: 'Παπαδόπουλος' },
      { id: 9002, fincode: 'ΕΠΑ0012346', machine: 102, machineName: 'Λαμινατέζ 1', itemCode: '80399', itemName: 'Λαμινέ Β', kilos: 800, linearMetres: 16000, producedQty: 0, rolls: 0, lastRoll: null, stageLine: 1, status: 0, phase: 2001, customer: 'ΑΛΦΑ ΤΡΟΦΙΜΑ Α.Ε.', salesOrder: 'ΠΑΡ0004567', salesOrderId: 7001, customerPO: 'PO-8812', deliveryDate: DateFmt.toIso(addDays(now, 5)), plannedEnd: iso(at(23, 30)), operator: 'Γεωργίου' },
      { id: 9003, fincode: 'ΕΠΑ0012290', machine: 103, machineName: 'Ρολοκόπτης 1', itemCode: '79728', itemName: 'Ρολό κομμένο Γ', kilos: 500, linearMetres: 9000, producedQty: 500, rolls: 20, lastRoll: iso(minsAgo(200)), stageLine: 0, status: 1, phase: 3001, customer: 'ΒΗΤΑ ΓΑΛΑΚΤΟΚΟΜΙΚΑ', salesOrder: 'ΠΑΡ0004501', salesOrderId: 7002, customerPO: '', deliveryDate: DateFmt.toIso(addDays(now, -1)) }
    ];
    var rollTimes = { 101: [], 103: [], 104: [] };
    var d0 = at(6, 0), lim = Math.min(now.getTime(), at(6, 0, 1).getTime());
    for (var t = d0.getTime() + 15 * 60000; t < lim; t += 13 * 60000) {
      var hh = new Date(t).getHours();
      if (!(hh >= 11 && hh < 13)) rollTimes[101].push(new Date(t));           // gap 11–13
      if (hh < 10) rollTimes[103].push(new Date(t));                          // stops at 10:00
    }
    var shiftRow = function (id, flags) {
      var r = { machine: id }; for (var d = 1; d <= 7; d++) for (var s = 1; s <= 3; s++) r['S' + d + s] = flags[s - 1] && d <= 5 ? 1 : 0; return r;
    };
    return {
      dataset: function (name, p) {
        switch (name) {
          case 'GetPhaseMachines': return machines.map(function (m) { return { machine: m.id, phase: m.phase, phaseName: m.phaseName }; });
          case 'PmGetMachineList': return machines.map(function (m) { return Object.assign({}, m); });
          case 'PmGetRunningJobs': return orders.filter(function (o) { return o.status !== 1 && (o.stageLine === 1 || o.stageLine === 2); });
          case 'PmGetMachineStatus': return machines.filter(function (m) { return m.isActive; }).map(function (m) {
            var r = rollTimes[m.id] || []; var last = r[r.length - 1];
            return { id: m.id, code: m.code, name: m.name, phase: m.phase, lastRoll: last ? iso(last) : null, lastFincode: last ? 'ΕΠΑ00122' + m.id : null };
          });
          case 'GetShifts': return [shiftRow(101, [1, 1, 0]), shiftRow(102, [1, 1, 1]), shiftRow(103, [1, 0, 0]), shiftRow(104, [1, 1, 0])];
          case 'PmGetMachineActivity': {
            var out = [];
            if (p.day !== DateFmt.toIso(at(0, 0, now.getHours() < 6 ? -1 : 0))) return out;
            Object.keys(rollTimes).forEach(function (k) { rollTimes[k].forEach(function (x) { out.push({ machine: +k, t: iso(x), qty: 80 }); }); });
            return out;
          }
          case 'PmSearchProductionOrders': {
            var q = (p.q || '').toLowerCase();
            return orders.filter(function (o) {
              if (p.status === 'open' && o.status === 1) return false;
              if (p.status === 'done' && o.status !== 1) return false;
              if (p.machine && String(o.machine) !== String(p.machine)) return false;
              return !q || [o.fincode, o.itemCode, o.itemName, o.customer, o.salesOrder, o.customerPO].join(' ').toLowerCase().indexOf(q) >= 0;
            });
          }
          case 'PmSearchCustomerOrders': {
            var cq = (p.q || '').toLowerCase();
            return [
              { id: 7001, fincode: 'ΠΑΡ0004567', trndate: DateFmt.toIso(addDays(now, -6)), customerPO: 'PO-8812', customer: 'ΑΛΦΑ ΤΡΟΦΙΜΑ Α.Ε.', orders: 2, done: 0, firstDelivery: DateFmt.toIso(addDays(now, 4)) },
              { id: 7002, fincode: 'ΠΑΡ0004501', trndate: DateFmt.toIso(addDays(now, -12)), customerPO: '', customer: 'ΒΗΤΑ ΓΑΛΑΚΤΟΚΟΜΙΚΑ', orders: 1, done: 1, firstDelivery: DateFmt.toIso(addDays(now, -1)) }
            ].filter(function (c) { return !cq || (c.fincode + ' ' + c.customer + ' ' + c.customerPO).toLowerCase().indexOf(cq) >= 0; });
          }
          case 'PmGetCustomerOrder': return orders.filter(function (o) { return String(o.salesOrderId) === String(p.findoc); });
          case 'GetOrderDetails': return orders.filter(function (o) { return String(o.id) === String(p.findoc); }).map(function (o) {
            return Object.assign({ remarks: 'Demo', customerItemCode: 'C-' + o.itemCode }, o);
          });
          case 'GetProductionRolls': {
            var o = orders.filter(function (x) { return String(x.id) === String(p.findoc); })[0];
            var n = o ? o.rolls : 0, rows = [];
            for (var i = 0; i < n; i++) rows.push({ fincode: 'ΚΠ' + (1000 + i), trndate: DateFmt.toIso(now), qty: o.producedQty / n, lot: '261116' + String(i + 1).padStart(3, '0') });
            return rows;
          }
        }
        return [];
      }
    };
  })();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.ProductionApp = { state: state, _idleGaps: idleGaps, _shiftBlocks: shiftBlocks };
})(window);
