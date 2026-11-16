/* ProductionApp — «Διαχείριση παραγωγής» (production.html). Mobile-first; sidebar ≥1024px.

   Views (hash routes): #running · #idle · #orders · #customers · #machines
   Data: Soft1Bridge.dataset('Pm…') → /api/data → soft1/Foxline.planning.js (Pm* functions)
         Soft1Bridge.machineSave()  → /api/machine → native setData RSRC
   Theme: src/theme.js (system / light / dark). file:// = mock mode (MOCK below).
   Dates: DateFmt (dd/mm/yyyy, 24h). */
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
  var DAYS = ['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'];

  // Line icons (24×24)
  var IC = {
    print:  '<rect x="6" y="3" width="12" height="6" rx="1"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 17v4h10v-4"/>',
    lam:    '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
    slit:   '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1L20 20M8.1 15.9L20 4"/>',
    bag:    '<path d="M6 7h12l1 14H5L6 7z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
    gear:   '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    doc:    '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    box:    '<path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10"/>',
    user:   '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    cal:    '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    clock:  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    tool:   '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
    empty:  '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M8 11h6"/>'
  };
  function svg(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (IC[name] || IC.gear) + '</svg>'; }
  function phaseIcon(p) {
    var c = String(p || '').charAt(0);
    return c === '1' ? 'print' : c === '2' ? 'lam' : c === '3' ? 'slit' : c === '4' ? 'bag' : 'gear';
  }

  var state = {
    view: null,
    phaseNames: {},
    machines: null,          // PmGetMachineList rows
    running: null,           // last running entries
    runningFilter: 'all',
    idleDay: null,
    idleThreshold: 30,
    ordersStatus: 'open',
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
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(v));
    var d = m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : new Date(String(v));
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
    return h ? (h + 'ω ' + (m < 10 ? '0' : '') + m + '′') : (m + '′');
  }
  function minsSince(d) { return d ? (Date.now() - d.getTime()) / 60000 : null; }
  function when(d) {
    if (!d) return '—';
    return d.toDateString() === new Date().toDateString() ? DateFmt.t(d) : DateFmt.dt(d);
  }
  function longDate(d) { return DAYS[d.getDay()] + ' ' + DateFmt.d(d); }
  function statusInfo(s) {
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
  function productionDay(d) {           // production day starts 06:00
    var r = new Date(d); if (r.getHours() < 6) r = addDays(r, -1);
    r.setHours(0, 0, 0, 0); return r;
  }
  function flag(v) {
    if (v === null || v === undefined || v === '') return false;
    var s = String(v).trim().toUpperCase();
    return s === '1' || s === 'TRUE' || s === 'Y' || parseInt(s, 10) > 0;
  }
  function empty(msg) { return '<div class="empty">' + svg('empty') + esc(msg) + '</div>'; }
  function errorBox(el, e) { el.innerHTML = '<div class="error">Σφάλμα: ' + esc(e && e.message || e) + '</div>'; }

  // Group rows by phase (numeric order); key(row) → phase code
  function byPhase(rows, key) {
    var groups = {}, order = [];
    rows.forEach(function (r) {
      var p = String(key(r) || '');
      if (!groups[p]) { groups[p] = []; order.push(p); }
      groups[p].push(r);
    });
    order.sort(function (a, b) { return (parseInt(a, 10) || 99999) - (parseInt(b, 10) || 99999); });
    return order.map(function (p) { return { phase: p, name: p ? phaseLabel(p) : 'Λοιπές', rows: groups[p] }; });
  }
  function groupHead(g, sum) {
    return '<div class="group-h"><h3>' + esc(g.name) + '</h3><span class="n">' + g.rows.length + '</span><span class="line"></span>' +
      (sum ? '<span class="sum">' + sum + '</span>' : '') + '</div>';
  }
  function seg(el, attr, value) {
    el.querySelectorAll('button').forEach(function (b) {
      var on = b.getAttribute(attr) === String(value);
      b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
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
    $('pm-progress').hidden = _busy === 0;
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
    state.machines.forEach(function (m) { if (m.phaseName) state.phaseNames[String(m.phase)] = String(m.phaseName); });
    var sel = $('orders-machine'), cur = sel.value;
    sel.innerHTML = '<option value="">Όλες οι μηχανές</option>' + state.machines
      .filter(function (m) { return flag(m.isActive); })
      .map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name || m.code) + '</option>'; }).join('');
    sel.value = cur;
    return state.machines;
  }

  // ── Router / drawer ────────────────────────────────────────────────────────
  function isDesktop() { return global.matchMedia && matchMedia('(min-width: 1024px)').matches; }
  function openDrawer(open) {
    var d = $('pm-drawer');
    if (isDesktop()) open = false;
    d.classList.toggle('open', open);
    $('pm-scrim').hidden = !open;
    $('pm-burger').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { var a = d.querySelector('.nav-item.active') || d.querySelector('.nav-item'); if (a) a.focus(); }
  }

  function route() {
    var v = (location.hash || '').replace(/^#/, '');
    if (!VIEWS[v]) v = DEFAULT_VIEW;
    showView(v);
  }

  function showView(v) {
    state.view = v;
    Object.keys(VIEWS).forEach(function (k) { $('view-' + k).hidden = (k !== v); });
    document.querySelectorAll('.nav-item').forEach(function (a) {
      var on = a.getAttribute('data-view') === v;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('pm-view-title').textContent = VIEWS[v].title;
    $('pm-view-sub').textContent = v === 'idle' ? 'Ημέρα παραγωγής ' + longDate(state.idleDay) : longDate(new Date());
    $('pm-live').hidden = v !== 'running';
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
  async function loadRunning(silent) {
    var list = $('running-list');
    if (!silent) loading(true);
    try {
      var res = await Promise.all([ds('PmGetRunningJobs'), ds('PmGetMachineStatus'), ds('PmGetTodayProduction')]);
      var jobs = res[0], status = res[1], today = {};
      res[2].forEach(function (r) { today[String(r.machine)] = { kg: parseFloat(r.kg) || 0, rolls: parseInt(r.rolls, 10) || 0 }; });
      var byMachine = {};
      jobs.forEach(function (j) { var k = String(j.machine || ''); (byMachine[k] = byMachine[k] || []).push(j); });

      var entries = status.map(function (m) {
        var mj = byMachine[String(m.id)] || []; delete byMachine[String(m.id)];
        return { id: String(m.id), name: m.name || m.code, code: m.code, phase: m.phase, lastRoll: parseDate(m.lastRoll),
                 lastFincode: m.lastFincode, jobs: mj, today: today[String(m.id)] || { kg: 0, rolls: 0 } };
      });
      Object.keys(byMachine).forEach(function (k) {
        var j0 = byMachine[k][0];
        entries.push({ id: k, name: j0.machineName || 'Χωρίς μηχανή', code: '', phase: j0.phase, lastRoll: parseDate(j0.lastRoll),
                       jobs: byMachine[k], today: today[k] || { kg: 0, rolls: 0 } });
      });
      entries.forEach(function (e) {
        e.state = !e.jobs.length ? 'idle'
                : e.jobs.every(function (j) { return parseInt(j.stageLine, 10) === 1; }) ? 'setup' : 'run';
      });
      state.running = entries;

      var nRun = entries.filter(function (e) { return e.state === 'run'; }).length;
      var nSetup = entries.filter(function (e) { return e.state === 'setup'; }).length;
      var nIdle = entries.filter(function (e) { return e.state === 'idle'; }).length;
      var kg = Object.keys(today).reduce(function (s, k) { return s + today[k].kg; }, 0);
      $('running-kpis').innerHTML =
        '<div class="kpi"><div class="kpi-l"><span class="dot"></span>Σε παραγωγή</div><div class="kpi-v">' + nRun + '<small>/ ' + entries.length + '</small></div></div>' +
        '<div class="kpi"><div class="kpi-l"><span class="kpi-dot" style="background:var(--warn)"></span>Setup</div><div class="kpi-v">' + nSetup + '</div></div>' +
        '<div class="kpi' + (nIdle ? ' alert' : '') + '"><div class="kpi-l"><span class="kpi-dot" style="background:var(--accent)"></span>Χωρίς εργασία</div><div class="kpi-v">' + nIdle + '</div></div>' +
        '<div class="kpi"><div class="kpi-l">Παραχθέντα σήμερα</div><div class="kpi-v">' + num(kg) + '<small>kg</small></div></div>';
      $('nav-count-running').textContent = nRun + nSetup || '';
      var ic = $('nav-count-idle'); ic.textContent = nIdle || ''; ic.classList.toggle('alert', nIdle > 0);
      $('pm-live-text').textContent = 'Live · ' + DateFmt.t(new Date());
      renderRunning();
    } catch (e) {
      errorBox(list, e);
    } finally { if (!silent) loading(false); }
  }

  function renderRunning() {
    var f = state.runningFilter;
    var rows = (state.running || []).filter(function (e) {
      return f === 'all' || (f === 'idle' ? e.state === 'idle' : e.state !== 'idle');
    });
    if (!rows.length) { $('running-list').innerHTML = empty(f === 'idle' ? 'Όλες οι μηχανές έχουν εργασία.' : 'Καμία μηχανή.'); return; }
    $('running-list').innerHTML = byPhase(rows, function (e) { return e.phase; }).map(function (g) {
      var busy = g.rows.filter(function (e) { return e.state !== 'idle'; }).length;
      var kg = g.rows.reduce(function (s, e) { return s + e.today.kg; }, 0);
      return '<section class="group">' + groupHead(g, busy + ' σε λειτουργία · ' + num(kg) + ' kg σήμερα') +
        '<div class="grid">' + g.rows.map(machineCard).join('') + '</div></section>';
    }).join('');
  }

  function machineCard(e) {
    var pill = e.state === 'run' ? '<span class="pill run">Παραγωγή</span>'
             : e.state === 'setup' ? '<span class="pill setup">Setup</span>'
             : '<span class="pill idle">Χωρίς εργασία</span>';
    var head = '<div class="card-h"><div class="m-ico">' + svg(phaseIcon(e.phase)) + '</div>' +
      '<div class="grow"><div class="c-title">' + esc(e.name) + '</div><div class="c-sub">' + esc(phaseLabel(e.phase)) +
      (e.code ? ' · ' + esc(e.code) : '') + '</div></div>' + pill + '</div>';
    if (!e.jobs.length) {
      var m = minsSince(e.lastRoll);
      return '<div class="card">' + head +
        '<div class="idle-note"><span class="big' + (m == null ? ' dim' : '') + '">' + (m == null ? '—' : esc(dur(m))) + '</span>' +
        '<span>' + (e.lastRoll ? 'χωρίς ρολό από ' + esc(when(e.lastRoll)) : 'καμία καταγραφή ρολού') +
        (e.lastFincode ? '<br>τελ. εντολή <span class="code">' + esc(e.lastFincode) + '</span>' : '') + '</span></div>' +
        '<div class="meta"><div>Σήμερα<b>' + num(e.today.kg) + ' kg</b></div><div>Ρολά σήμερα<b>' + e.today.rolls + '</b></div><div></div></div>' +
        '</div>';
    }
    return '<div class="card">' + head + e.jobs.map(function (j) {
      var kilos = parseFloat(j.kilos) || 0, prod = parseFloat(j.producedQty) || 0;
      var pct = kilos > 0 ? Math.min(100, Math.round(prod / kilos * 100)) : 0;
      var last = parseDate(j.lastRoll), setup = parseInt(j.stageLine, 10) === 1;
      var pe = parseDate(j.plannedEnd);
      return '<button class="job" type="button" data-order="' + esc(j.id) + '" aria-label="Εντολή ' + esc(j.fincode) + '">' +
          '<div class="job-top"><span class="code">' + esc(j.fincode) + '</span><span class="job-item">' + esc(j.itemCode) + ' · ' + esc(j.itemName) + '</span></div>' +
          '<div class="job-cust">' + esc(j.customer || '—') + (j.salesOrder ? ' · ' + esc(j.salesOrder) : '') + '</div>' +
          '<div class="prog"><div class="bar' + (setup ? ' warn' : '') + '"><i style="width:' + pct + '%"></i></div><span class="pct">' + pct + '%</span></div>' +
          '<div class="meta"><div>Παραχθέντα<b>' + num(prod) + ' / ' + num(kilos) + ' kg</b></div>' +
          '<div>Ρολά<b>' + num(j.rolls) + '</b></div>' +
          '<div>' + (last ? 'Τελ. ρολό<b>' + esc(DateFmt.t(last)) + ' · ' + esc(dur(minsSince(last))) + '</b>'
                          : 'Πλάνο λήξης<b>' + esc(pe ? when(pe) : '—') + '</b>') + '</div></div>' +
          (j.operator ? '<div class="chips"><span class="chip">' + svg('user') + esc(j.operator) + '</span></div>' : '') +
        '</button>';
    }).join('') + '</div>';
  }

  // ── Αδράνεια μηχανών ───────────────────────────────────────────────────────
  function shiftBlocks(row, day) {
    var dow = day.getDay() || 7, out = [];
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
      if (end - prev > thr) gaps.push([new Date(prev), new Date(end), true]);   // [2] = still open at "now"/shift end
    });
    return gaps;
  }

  async function loadIdle() {
    var list = $('idle-list'), day = state.idleDay;
    $('idle-day').value = DateFmt.d(day);
    if (state.view === 'idle') $('pm-view-sub').textContent = 'Ημέρα παραγωγής ' + longDate(day);
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
      var now = new Date();
      var dayStart = new Date(day.getTime() + 6 * 3600000), span = 24 * 3600000, dayEnd = new Date(dayStart.getTime() + span);
      function pct(d) { return Math.max(0, Math.min(100, (d.getTime() - dayStart.getTime()) / span * 100)); }

      var items = machines.map(function (m) {
        var row = shiftByMachine[String(m.id)];
        var blocks = row ? shiftBlocks(row, day) : [];
        var times = (rollsByMachine[String(m.id)] || []).sort(function (a, b) { return a - b; });
        var inDay = times.filter(function (t) { return t >= dayStart && t < dayEnd; });
        var gaps = blocks.length ? idleGaps(blocks, times, state.idleThreshold, now) : [];
        var idleMin = gaps.reduce(function (s, g) { return s + (g[1] - g[0]) / 60000; }, 0);
        var last = gaps[gaps.length - 1];
        var openGap = last && last[2] && now < blocks[blocks.length - 1][1] && Math.abs(last[1] - now) < 120000 ? last : null;
        return { m: m, blocks: blocks, inDay: inDay, gaps: gaps, idleMin: idleMin, openGap: openGap };
      });
      if (!items.length) { list.innerHTML = empty('Δεν υπάρχουν ενεργές μηχανές.'); return; }

      list.innerHTML = byPhase(items, function (x) { return x.m.phase; }).map(function (g) {
        var tot = g.rows.reduce(function (s, x) { return s + x.idleMin; }, 0);
        return '<section class="group">' + groupHead(g, 'αδράνεια ' + dur(tot)) + '<div class="grid">' + g.rows.map(function (x) {
          var m = x.m;
          var pill = !x.blocks.length ? '<span class="pill off">Χωρίς βάρδια</span>'
                   : x.openGap ? '<span class="pill idle">Αδρανής από ' + esc(DateFmt.t(x.openGap[0])) + '</span>'
                   : x.gaps.length ? '<span class="pill setup">' + x.gaps.length + (x.gaps.length === 1 ? ' διάστημα' : ' διαστήματα') + '</span>'
                   : '<span class="pill run">Χωρίς αδράνεια</span>';
          var bar = x.blocks.map(function (b) {
            return '<div class="s" style="left:' + pct(b[0]) + '%;width:' + (pct(b[1]) - pct(b[0])) + '%"></div>';
          }).join('') + x.gaps.map(function (gp) {
            return '<div class="i" style="left:' + pct(gp[0]) + '%;width:' + Math.max(.5, pct(gp[1]) - pct(gp[0])) + '%"></div>';
          }).join('') + x.inDay.map(function (t) {
            return '<div class="r" style="left:' + pct(t) + '%"></div>';
          }).join('') + (now > dayStart && now < dayEnd ? '<div class="n" style="left:' + pct(now) + '%"></div>' : '');
          return '<div class="card">' +
            '<div class="card-h"><div class="m-ico">' + svg(phaseIcon(m.phase)) + '</div>' +
            '<div class="grow"><div class="c-title">' + esc(m.name || m.code) + '</div><div class="c-sub">' + esc(m.code) + ' · ' + x.inDay.length + ' ρολά</div></div>' + pill + '</div>' +
            '<div class="idle-note"><span class="big' + (!x.blocks.length ? ' dim' : x.idleMin ? '' : ' ok') + '">' + (x.blocks.length ? esc(dur(x.idleMin)) : '—') + '</span>' +
            '<span>' + (!x.blocks.length ? 'δεν υπάρχει βάρδια στο ημερολόγιο' : x.idleMin ? 'συνολική αδράνεια μέσα στις βάρδιες' : 'συνεχής παραγωγή στις βάρδιες') + '</span></div>' +
            '<div class="tl" role="img" aria-label="Χρονογραμμή 06:00–06:00: ' + esc(dur(x.idleMin)) + ' αδράνεια">' + bar + '</div>' +
            '<div class="tl-scale"><span>06</span><span>10</span><span>14</span><span>18</span><span>22</span><span>02</span><span>06</span></div>' +
            (x.gaps.length ? '<div class="gaps">' + x.gaps.map(function (gp) {
              return '<span class="gap">' + esc(DateFmt.t(gp[0])) + '–' + esc(DateFmt.t(gp[1])) + ' · ' + esc(dur((gp[1] - gp[0]) / 60000)) + '</span>';
            }).join('') + '</div>' : '') +
          '</div>';
        }).join('') + '</div></section>';
      }).join('');
    } catch (e) {
      errorBox(list, e);
    } finally { loading(false); }
  }

  function setIdleDay(d) { state.idleDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()); loadIdle(); }

  // ── Εντολές παραγωγής ──────────────────────────────────────────────────────
  function orderCard(o) {
    var st = statusInfo(o.status);
    var kilos = parseFloat(o.kilos) || 0, prod = parseFloat(o.producedQty) || 0;
    var pct = kilos > 0 ? Math.min(100, Math.round(prod / kilos * 100)) : 0;
    var deliv = parseDate(o.deliveryDate);
    var late = deliv && st.cls !== 'done' && deliv < productionDay(new Date());
    return '<button class="card" type="button" data-order="' + esc(o.id) + '">' +
      '<div class="card-h"><div class="m-ico">' + svg(phaseIcon(o.phase)) + '</div>' +
      '<div class="grow"><div class="c-title code">' + esc(o.fincode) + '</div><div class="c-sub">' + esc(o.itemCode) + ' · ' + esc(o.itemName) + '</div></div>' +
      '<span class="pill ' + st.cls + '">' + st.text + '</span></div>' +
      '<div class="chips">' +
        '<span class="chip">' + svg('tool') + esc(o.machineName || 'Χωρίς μηχανή') + '</span>' +
        (o.phase ? '<span class="chip">' + esc(phaseLabel(o.phase)) + '</span>' : '') +
        (o.customer ? '<span class="chip">' + svg('user') + esc(o.customer) + '</span>' : '') +
        (deliv ? '<span class="chip"' + (late ? ' style="color:var(--accent-text);background:var(--accent-soft)"' : '') + '>' + svg('cal') + esc(DateFmt.d(deliv)) + '</span>' : '') +
      '</div>' +
      (prod > 0 || kilos > 0 ? '<div class="prog"><div class="bar"><i style="width:' + pct + '%"></i></div><span class="pct">' + pct + '%</span></div>' +
        '<div class="meta"><div>Παραχθέντα<b>' + num(prod) + ' / ' + num(kilos) + ' kg</b></div><div>Ρολά<b>' + num(o.rolls || 0) + '</b></div>' +
        '<div>Τελ. ρολό<b>' + esc(when(parseDate(o.lastRoll))) + '</b></div></div>' : '') +
      '</button>';
  }

  async function searchOrders() {
    var list = $('orders-list');
    loading(true);
    try {
      var rows = await ds('PmSearchProductionOrders', {
        q: $('orders-q').value.trim(), status: state.ordersStatus, machine: $('orders-machine').value, limit: 100
      });
      list.innerHTML = rows.map(orderCard).join('') || empty('Δεν βρέθηκαν εντολές.');
      if (rows.length >= 100) list.insertAdjacentHTML('beforeend', '<div class="more">Εμφανίζονται οι πρώτες 100 — περιορίστε την αναζήτηση.</div>');
    } catch (e) { errorBox(list, e); }
    finally { loading(false); }
  }

  async function openOrder(id) {
    openSheet('Εντολή παραγωγής', '', '<div class="empty">Φόρτωση…</div>');
    try {
      var res = await Promise.all([ds('GetOrderDetails', { findoc: id }), ds('GetProductionRolls', { findoc: id })]);
      var o = res[0][0];
      if (!o) { $('pm-sheet-body').innerHTML = empty('Δεν βρέθηκε η εντολή.'); return; }
      var rolls = res[1];
      var total = rolls.reduce(function (s, r) { return s + (parseFloat(r.qty) || 0); }, 0);
      var kilos = parseFloat(o.kilos) || 0, pct = kilos > 0 ? Math.min(100, Math.round(total / kilos * 100)) : 0;
      var st = statusInfo(o.status);
      $('pm-sheet-title').innerHTML = '<span class="code" style="font-size:15px">' + esc(o.fincode || id) + '</span>';
      $('pm-sheet-sub').textContent = (o.itemCode || '') + ' · ' + (o.itemName || '');
      $('pm-sheet-body').innerHTML =
        '<dl class="kv">' +
          '<dt>Κατάσταση</dt><dd><span class="pill ' + st.cls + '" style="margin:0">' + st.text + '</span></dd>' +
          (o.customerItemCode ? '<dt>Κωδ. πελάτη</dt><dd>' + esc(o.customerItemCode) + '</dd>' : '') +
          '<dt>Φάση</dt><dd>' + esc(phaseLabel(o.phase) || '—') + '</dd>' +
          '<dt>Μηχανή</dt><dd>' + esc(o.machineName || '—') + '</dd>' +
          '<dt>Ποσότητα</dt><dd>' + num(kilos) + ' kg · ' + num(o.linearMetres) + ' m</dd>' +
          '<dt>Παράδοση</dt><dd>' + esc(DateFmt.d(parseDate(o.deliveryDate)) || '—') + '</dd>' +
          '<dt>Πελάτης</dt><dd>' + esc(o.customer || '—') + '</dd>' +
          '<dt>Παραγγελία</dt><dd>' + esc(o.salesOrder || '—') + (o.customerPO ? ' · PO ' + esc(o.customerPO) : '') + '</dd>' +
          (o.remarks ? '<dt>Σχόλια</dt><dd>' + esc(o.remarks) + '</dd>' : '') +
        '</dl>' +
        '<div class="sheet-sec">Παραγωγή <span>' + num(total) + ' / ' + num(kilos) + ' kg · ' + rolls.length + ' ρολά</span></div>' +
        '<div class="prog" style="margin-top:0"><div class="bar"><i style="width:' + pct + '%"></i></div><span class="pct">' + pct + '%</span></div>' +
        (rolls.length ? '<table class="table" style="margin-top:10px"><thead><tr><th>Ημ/νία</th><th>Lot</th><th class="num">kg</th></tr></thead><tbody>' +
          rolls.map(function (r) {
            return '<tr><td>' + esc(DateFmt.d(parseDate(r.trndate))) + '</td><td class="mono">' + esc(r.lot || r.mtrlot || '') + '</td><td class="num">' + num(r.qty, 1) + '</td></tr>';
          }).join('') + '</tbody></table>' : '<p class="hint" style="margin-top:10px">Δεν υπάρχουν ρολά ακόμη.</p>');
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
        var pct = orders ? Math.round(done / orders * 100) : 0, all = orders && done === orders;
        var fd = parseDate(c.firstDelivery);
        return '<button class="card" type="button" data-customer-order="' + esc(c.id) + '" data-title="' + esc(c.fincode) + '">' +
          '<div class="card-h"><div class="m-ico">' + svg('box') + '</div>' +
          '<div class="grow"><div class="c-title code">' + esc(c.fincode) + '</div><div class="c-sub">' + esc(c.customer || '—') + '</div></div>' +
          '<span class="pill ' + (all ? 'done' : 'run') + '">' + done + '/' + orders + '</span></div>' +
          '<div class="chips"><span class="chip">' + svg('cal') + esc(DateFmt.d(parseDate(c.trndate))) + '</span>' +
            (c.customerPO ? '<span class="chip">PO ' + esc(c.customerPO) + '</span>' : '') +
            (fd ? '<span class="chip">' + svg('clock') + 'Παράδοση ' + esc(DateFmt.d(fd)) + '</span>' : '') + '</div>' +
          '<div class="prog"><div class="bar"><i style="width:' + pct + '%"></i></div><span class="pct">' + pct + '%</span></div>' +
          '</button>';
      }).join('') || empty('Δεν βρέθηκαν παραγγελίες.');
    } catch (e) { errorBox(list, e); }
    finally { loading(false); }
  }

  async function openCustomerOrder(id, title) {
    openSheet('Παραγγελία ' + (title || id), '', '<div class="empty">Φόρτωση…</div>');
    try {
      var rows = await ds('PmGetCustomerOrder', { findoc: id });
      var first = rows[0] || {};
      $('pm-sheet-sub').textContent = (first.customer || '') + (first.customerPO ? ' · PO ' + first.customerPO : '');
      $('pm-sheet-body').innerHTML = '<div class="sheet-sec" style="margin-top:0">Εντολές παραγωγής <span>' + rows.length + '</span></div>' +
        (rows.length ? byPhase(rows, function (o) { return o.phase; }).map(function (g) {
          return '<section class="group">' + groupHead(g) + '<div class="grid" style="grid-template-columns:1fr">' + g.rows.map(orderCard).join('') + '</div></section>';
        }).join('') : empty('Καμία εντολή.'));
    } catch (e) { errorBox($('pm-sheet-body'), e); }
  }

  // ── Μηχανές ────────────────────────────────────────────────────────────────
  async function loadMachineView(force) {
    var list = $('machines-list');
    loading(true);
    try { await loadMachines(force); renderMachines(); }
    catch (e) { errorBox(list, e); }
    finally { loading(false); }
  }

  function renderMachines() {
    var q = $('machines-q').value.trim().toLowerCase();
    var rows = (state.machines || []).filter(function (m) {
      return !q || (String(m.code) + ' ' + String(m.name)).toLowerCase().indexOf(q) >= 0;
    });
    if (!rows.length) { $('machines-list').innerHTML = empty('Δεν βρέθηκαν μηχανές.'); return; }
    $('machines-list').innerHTML = byPhase(rows, function (m) { return m.phase; }).map(function (g) {
      return '<section class="group">' + groupHead(g) + '<div class="grid">' + g.rows.map(function (m) {
        var active = flag(m.isActive);
        return '<button class="card" type="button" data-machine="' + esc(m.id) + '">' +
          '<div class="card-h"><div class="m-ico">' + svg(phaseIcon(m.phase)) + '</div>' +
          '<div class="grow"><div class="c-title">' + esc(m.name || m.code) + '</div><div class="c-sub">' + esc(m.code) + (m.remarks ? ' · ' + esc(m.remarks) : '') + '</div></div>' +
          '<span class="pill ' + (active ? 'run' : 'off') + '">' + (active ? 'Ενεργή' : 'Ανενεργή') + '</span></div>' +
          '<div class="m-vals"><div>Setup<b>' + num(m.setupTime) + ' <small>λεπ.</small></b></div><div>Αναμονή<b>' + num(m.waitTime) + ' <small>λεπ.</small></b></div>' +
          '<div>Ταχύτητα<b>' + num(m.speed, 1) + ' <small>m/min</small></b></div></div></button>';
      }).join('') + '</div></section>';
    }).join('');
  }

  function openMachine(id) {
    var m = (state.machines || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!m) return;
    function val(v) { return v == null ? '' : String(v).replace('.', ','); }
    openSheet(m.name || m.code, 'Επεξεργασία μηχανής · Soft1 RSRC · ' + (m.code || ''),
      '<form id="machine-form" class="form" novalidate>' +
        '<div class="field"><label for="mf-setup">Χρόνος setup</label><div class="unit"><input id="mf-setup" class="input" type="text" inputmode="decimal" value="' + esc(val(m.setupTime)) + '" /><span>λεπτά</span></div></div>' +
        '<div class="field"><label for="mf-wait">Χρόνος αναμονής</label><div class="unit"><input id="mf-wait" class="input" type="text" inputmode="decimal" value="' + esc(val(m.waitTime)) + '" /><span>λεπτά</span></div></div>' +
        '<div class="field"><label for="mf-speed">Ταχύτητα</label><div class="unit"><input id="mf-speed" class="input" type="text" inputmode="decimal" value="' + esc(val(m.speed)) + '" /><span>m/min</span></div></div>' +
        '<div class="field"><label for="mf-active">Κατάσταση</label><label class="switch"><input id="mf-active" type="checkbox"' + (flag(m.isActive) ? ' checked' : '') + ' /> Ενεργή</label></div>' +
        '<div class="field full"><label for="mf-remarks">Σχόλια</label><textarea id="mf-remarks" class="input" maxlength="2000">' + esc(m.remarks || '') + '</textarea></div>' +
        '<div id="mf-error" class="form-error" role="alert"></div>' +
        '<div class="form-actions"><button type="button" class="btn" id="mf-cancel">Άκυρο</button>' +
        '<button type="submit" class="btn brand" id="mf-save">Αποθήκευση στο Soft1</button></div>' +
      '</form>');
    $('mf-cancel').addEventListener('click', closeSheet);
    $('machine-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var err = $('mf-error'); err.textContent = '';
      var vals = { SETUPTIME: $('mf-setup').value, WAITTIME: $('mf-wait').value, MPRDQTY: $('mf-speed').value };
      for (var k in vals) {
        var s = String(vals[k]).trim().replace(',', '.'), n = parseFloat(s);
        if (s === '' || !/^\d+(\.\d+)?$/.test(s) || !isFinite(n)) { err.textContent = 'Μη έγκυρη τιμή — μόνο θετικοί αριθμοί'; return; }
        vals[k] = n;
      }
      var fields = {};
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
  function openSheet(title, sub, html) {
    if ($('pm-sheet-backdrop').hidden) _sheetReturn = document.activeElement;
    $('pm-sheet-title').textContent = title;
    $('pm-sheet-sub').textContent = sub || '';
    $('pm-sheet-body').innerHTML = html;
    $('pm-sheet-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    $('pm-sheet-close').focus();
  }
  function closeSheet() {
    $('pm-sheet-backdrop').hidden = true;
    $('pm-sheet-body').innerHTML = '';
    document.body.style.overflow = '';
    if (_sheetReturn && _sheetReturn.focus) _sheetReturn.focus();
  }

  // ── Theme ──────────────────────────────────────────────────────────────────
  function initTheme() {
    if (!global.Theme) return;
    function paint() { seg($('theme-seg'), 'data-theme-set', Theme.get()); }
    paint();
    global.addEventListener('themechange', paint);
    $('theme-seg').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (b) Theme.set(b.getAttribute('data-theme-set'));
    });
    $('pm-theme').addEventListener('click', function () { Theme.set(Theme.resolved() === 'dark' ? 'light' : 'dark'); });
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
        ? '<p>Στο Safari πατήστε <b>Κοινοποίηση</b> και μετά <b>«Προσθήκη στην οθόνη Αφετηρίας»</b>.</p>'
        : '<p>Ανοίξτε το μενού του browser (&#8942;) και επιλέξτε <b>«Εγκατάσταση εφαρμογής»</b> ή <b>«Προσθήκη στην αρχική οθόνη»</b>.</p>' +
          '<p class="as-hint">Σε Chrome / Edge το κουμπί λειτουργεί απευθείας όταν ο browser επιτρέπει την εγκατάσταση.</p>';
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
    var user = Soft1Bridge.user || '';
    $('pm-user').textContent = user;
    $('pm-avatar').textContent = (user.replace(/[^A-Za-zΑ-Ωα-ωΆ-ώ0-9]/g, '').slice(0, 2) || '—').toUpperCase();
    $('pm-access').textContent = Soft1Bridge.access === 'production' ? 'Διαχείριση παραγωγής' : 'Πλήρης πρόσβαση';

    AppShell.mount({ current: 'production', menu: $('pm-shell-menu'), toast: toast });
    initTheme();
    initInstall();

    $('pm-burger').addEventListener('click', function () { openDrawer(!$('pm-drawer').classList.contains('open')); });
    $('pm-drawer-close').addEventListener('click', function () { openDrawer(false); });
    $('pm-scrim').addEventListener('click', function () { openDrawer(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('pm-sheet-backdrop').hidden) closeSheet(); else openDrawer(false);
    });
    $('pm-refresh').addEventListener('click', function () { state.machines = null; refresh(); });
    global.addEventListener('hashchange', route);
    document.querySelectorAll('.nav-item').forEach(function (a) {
      a.addEventListener('click', function () { if (a.getAttribute('data-view') === state.view) openDrawer(false); });
    });

    // Delegated clicks
    document.addEventListener('click', function (e) {
      var c = e.target.closest && e.target.closest('[data-order],[data-customer-order],[data-machine]');
      if (!c) return;
      if (c.hasAttribute('data-order')) openOrder(c.getAttribute('data-order'));
      else if (c.hasAttribute('data-customer-order')) openCustomerOrder(c.getAttribute('data-customer-order'), c.getAttribute('data-title'));
      else if (c.hasAttribute('data-machine')) openMachine(c.getAttribute('data-machine'));
    });
    $('pm-sheet-close').addEventListener('click', closeSheet);
    $('pm-sheet-backdrop').addEventListener('click', function (e) { if (e.target === $('pm-sheet-backdrop')) closeSheet(); });

    // Running filter
    $('running-filter').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      state.runningFilter = b.getAttribute('data-filter'); seg(this, 'data-filter', state.runningFilter); renderRunning();
    });

    // Idle
    state.idleDay = productionDay(new Date());
    DateFmt.bind($('idle-day'));
    $('idle-day').addEventListener('change', function () { var d = DateFmt.parse(this.value); if (d) setIdleDay(d); });
    $('idle-day').addEventListener('keydown', function (e) { if (e.key === 'Enter') { var d = DateFmt.parse(this.value); if (d) setIdleDay(d); } });
    $('idle-prev').addEventListener('click', function () { setIdleDay(addDays(state.idleDay, -1)); });
    $('idle-next').addEventListener('click', function () { setIdleDay(addDays(state.idleDay, 1)); });
    $('idle-today').addEventListener('click', function () { setIdleDay(productionDay(new Date())); });
    $('idle-threshold').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      state.idleThreshold = parseInt(b.getAttribute('data-min'), 10); seg(this, 'data-min', state.idleThreshold); loadIdle();
    });

    // Searches
    $('orders-form').addEventListener('submit', function (e) { e.preventDefault(); searchOrders(); });
    $('orders-status').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      state.ordersStatus = b.getAttribute('data-status'); seg(this, 'data-status', state.ordersStatus); searchOrders();
    });
    $('orders-machine').addEventListener('change', searchOrders);
    $('customers-form').addEventListener('submit', function (e) { e.preventDefault(); searchCustomers(); });
    $('machines-q').addEventListener('input', renderMachines);

    await loadPhaseNames();
    loadMachines().catch(function (e) { console.warn('machines:', e); });
    route();
  }

  // ── Mock data (file://) — 2 printing, 3 laminating, 4 slitters, 1 bagger ──
  var MOCK = (function () {
    var now = new Date();
    function at(h, m, dayOffset) { var d = new Date(now); d.setDate(d.getDate() + (dayOffset || 0)); d.setHours(h, m, 0, 0); return d; }
    function iso(d) { return DateFmt.toIso(d) + ' ' + DateFmt.t(d) + ':00'; }
    function minsAgo(n) { return new Date(now.getTime() - n * 60000); }
    var P = { 1001: 'Εκτύπωση', 2001: 'Λαμινάρισμα', 3001: 'Ρολοκοπή', 4001: 'Σακουλοποίηση' };
    function mach(id, code, name, phase, setup, wait, speed, remarks) {
      return { id: id, code: code, name: name, isActive: 1, setupTime: setup, waitTime: wait, speed: speed, phase: phase, phaseName: P[phase], remarks: remarks || '' };
    }
    var machines = [
      mach(101, 'PRN-1', 'Flexo 8 χρωμάτων', 1001, 45, 10, 180),
      mach(102, 'PRN-2', 'Βαθυτυπία 10 χρωμάτων', 1001, 60, 15, 220),
      mach(201, 'LAM-1', 'Λαμινατέζ 1', 2001, 30, 20, 150),
      mach(202, 'LAM-2', 'Λαμινατέζ 2', 2001, 30, 20, 160),
      mach(203, 'LAM-3', 'Λαμινατέζ solventless', 2001, 25, 30, 250),
      mach(301, 'SLT-1', 'Ρολοκόπτης 1', 3001, 15, 0, 300),
      mach(302, 'SLT-2', 'Ρολοκόπτης 2', 3001, 15, 0, 300),
      mach(303, 'SLT-3', 'Ρολοκόπτης 3', 3001, 15, 0, 350, 'Νέα μαχαίρια 11/2026'),
      mach(304, 'SLT-4', 'Ρολοκόπτης 4', 3001, 20, 0, 400),
      mach(401, 'BAG-1', 'Σακουλομηχανή', 4001, 20, 5, 90)
    ];
    function mname(id) { return machines.filter(function (m) { return m.id === id; })[0].name; }
    function order(id, fincode, machine, phase, item, name, kilos, prod, rolls, lastMin, stageLine, status, cust, so, soId, po, delivDays) {
      return { id: id, fincode: fincode, machine: machine, machineName: machine ? mname(machine) : null, itemCode: item, itemName: name,
               kilos: kilos, linearMetres: kilos * 20, producedQty: prod, rolls: rolls, lastRoll: lastMin == null ? null : iso(minsAgo(lastMin)),
               stageLine: stageLine, status: status, phase: phase, customer: cust, salesOrder: so, salesOrderId: soId, customerPO: po,
               deliveryDate: DateFmt.toIso(new Date(now.getTime() + delivDays * 86400000)), plannedEnd: iso(at(20, 0)),
               operator: ['Παπαδόπουλος', 'Γεωργίου', 'Νικολάου', 'Δημητρίου'][id % 4] };
    }
    var orders = [
      order(9001, 'ΕΠΑ0012345', 101, 1001, '80398', 'Φιλμ τυπωμένο Α', 1200, 640, 8, 12, 2, 0, 'ΑΛΦΑ ΤΡΟΦΙΜΑ Α.Ε.', 'ΠΑΡ0004567', 7001, 'PO-8812', 4),
      order(9002, 'ΕΠΑ0012346', 102, 1001, '80412', 'Φιλμ τυπωμένο Δ', 900, 0, 0, null, 1, 0, 'ΔΕΛΤΑ ΣΝΑΚ', 'ΠΑΡ0004570', 7003, 'PO-221', 6),
      order(9003, 'ΕΠΑ0012347', 201, 2001, '80399', 'Λαμινέ Β', 800, 310, 4, 7, 2, 0, 'ΑΛΦΑ ΤΡΟΦΙΜΑ Α.Ε.', 'ΠΑΡ0004567', 7001, 'PO-8812', 5),
      order(9004, 'ΕΠΑ0012348', 203, 2001, '80420', 'Λαμινέ τριπλό Ε', 1500, 1220, 15, 3, 2, 0, 'ΓΑΜΜΑ ΚΑΦΕΣ', 'ΠΑΡ0004575', 7004, '', 2),
      order(9005, 'ΕΠΑ0012349', 301, 3001, '79728', 'Ρολό κομμένο Γ', 500, 180, 9, 5, 2, 0, 'ΒΗΤΑ ΓΑΛΑΚΤΟΚΟΜΙΚΑ', 'ΠΑΡ0004501', 7002, '', 1),
      order(9006, 'ΕΠΑ0012350', 302, 3001, '79731', 'Ρολό κομμένο Ζ', 650, 600, 30, 2, 2, 0, 'ΓΑΜΜΑ ΚΑΦΕΣ', 'ΠΑΡ0004575', 7004, '', 2),
      order(9007, 'ΕΠΑ0012351', 401, 4001, '81002', 'Σακούλα Doypack', 300, 120, 6, 18, 2, 0, 'ΔΕΛΤΑ ΣΝΑΚ', 'ΠΑΡ0004570', 7003, 'PO-221', 3),
      order(9008, 'ΕΠΑ0012290', 303, 3001, '79700', 'Ρολό κομμένο Η', 400, 400, 20, 200, 0, 1, 'ΒΗΤΑ ΓΑΛΑΚΤΟΚΟΜΙΚΑ', 'ΠΑΡ0004501', 7002, '', -1)
    ];
    // roll timestamps for the idle overview
    var rollTimes = {};
    var d0 = at(6, 0, now.getHours() < 6 ? -1 : 0), lim = Math.min(now.getTime(), d0.getTime() + 86400000);
    var pattern = { 101: [11, 13], 201: [9, 10], 203: null, 301: null, 302: [8, 9], 303: [10, 30], 401: [12, 14] };
    Object.keys(pattern).forEach(function (k) {
      rollTimes[k] = [];
      var gap = pattern[k], step = (k === '303' ? 11 : 9 + (k % 7));
      for (var t = d0.getTime() + 20 * 60000; t < lim; t += step * 60000) {
        var hh = new Date(t).getHours();
        if (gap && hh >= gap[0] && hh < gap[1]) continue;
        rollTimes[k].push(new Date(t));
      }
    });
    function shiftRow(id, flags) {
      var r = { machine: id };
      for (var d = 1; d <= 7; d++) for (var s = 1; s <= 3; s++) r['S' + d + s] = flags[s - 1] && d <= 6 ? 1 : 0;
      return r;
    }
    return {
      dataset: function (name, p) {
        switch (name) {
          case 'GetPhaseMachines': return machines.map(function (m) { return { machine: m.id, phase: m.phase, phaseName: m.phaseName }; });
          case 'PmGetMachineList': return machines.map(function (m) { return Object.assign({}, m); });
          case 'PmGetRunningJobs': return orders.filter(function (o) { return o.status !== 1 && (o.stageLine === 1 || o.stageLine === 2); });
          case 'PmGetMachineStatus': return machines.filter(function (m) { return m.isActive; }).map(function (m) {
            var r = rollTimes[m.id] || [], last = r[r.length - 1];
            return { id: m.id, code: m.code, name: m.name, phase: m.phase, lastRoll: last ? iso(last) : null, lastFincode: last ? 'ΕΠΑ00122' + (m.id % 100) : null };
          });
          case 'PmGetTodayProduction': return Object.keys(rollTimes).map(function (k) {
            return { machine: +k, rolls: rollTimes[k].length, kg: rollTimes[k].length * (k.charAt(0) === '3' ? 22 : 78) };
          });
          case 'GetShifts': return machines.map(function (m) {
            return shiftRow(m.id, m.phase === 3001 && m.id !== 303 ? [1, 1, 1] : m.id === 202 ? [0, 0, 0] : [1, 1, 0]);
          });
          case 'PmGetMachineActivity': {
            var out = [];
            if (p.day !== DateFmt.toIso(d0)) return out;
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
            var cq = (p.q || '').toLowerCase(), so = {};
            orders.forEach(function (o) {
              var c = so[o.salesOrderId] = so[o.salesOrderId] || { id: o.salesOrderId, fincode: o.salesOrder, trndate: DateFmt.toIso(addDays(now, -7)),
                customerPO: o.customerPO, customer: o.customer, orders: 0, done: 0, firstDelivery: o.deliveryDate };
              c.orders++; if (o.status === 1) c.done++;
              if (o.deliveryDate < c.firstDelivery) c.firstDelivery = o.deliveryDate;
            });
            return Object.keys(so).map(function (k) { return so[k]; })
              .filter(function (c) { return !cq || (c.fincode + ' ' + c.customer + ' ' + c.customerPO).toLowerCase().indexOf(cq) >= 0; });
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
