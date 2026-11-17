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
    schedule:  { title: 'Πρόγραμμα ημέρας' },
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
    stageLines: {},
    schDay: null,
    schedule: {},
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
    ['orders-machine', 'sch-machine'].forEach(function (id) {
      var sel = $(id), cur = sel.value;
      sel.innerHTML = '<option value="">Όλες οι μηχανές</option>' + state.machines
        .filter(function (m) { return flag(m.isActive); })
        .map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name || m.code) + '</option>'; }).join('');
      sel.value = cur;
    });
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
    $('pm-view-sub').textContent = v === 'idle' ? 'Ημέρα παραγωγής ' + longDate(state.idleDay)
      : v === 'schedule' ? 'Ημέρα παραγωγής ' + longDate(state.schDay) : longDate(new Date());
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
      case 'schedule':  return loadSchedule();
      case 'idle':      return loadIdle();
      case 'orders':    return searchOrders();
      case 'customers': return searchCustomers();
      case 'machines':  return loadMachineView(true);
    }
  }

  // ── Stage lines (state of a machine = its latest CCCFXPRDOSTAGE event) ─────
  // SOSTATUS 1 = setup, 2 = production/working, 3 = stopped; last line of a stage = completion.
  var CAT = {
    run:   { label: 'Παραγωγή',       pill: 'run' },
    setup: { label: 'Setup',          pill: 'setup' },
    stop:  { label: 'Στάση',          pill: 'idle' },
    none:  { label: 'Χωρίς εργασία',  pill: 'off' }
  };
  async function loadStageLines() {
    try {
      var rows = await ds('PmGetStageLines');
      state.stageLines = {};
      rows.forEach(function (r) {
        state.stageLines[String(r.stage) + '|' + String(r.line)] =
          { name: String(r.name || ''), sostatus: parseInt(r.sostatus, 10), isLast: flag(r.isLast) };
      });
    } catch (e) { console.warn('stage lines:', e); state.stageLines = {}; }
  }
  // Lines that count as a stop whatever their SOSTATUS (user decision: «Αναμονή Οδηγιών» = stop)
  var STOP_NAMES = ['αναμονη οδηγιων'];
  function norm(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim(); }
  function stageInfo(stage, line) {
    if (stage == null || stage === '' || line == null || line === '') return { cat: 'none', name: CAT.none.label };
    var l = state.stageLines[String(stage) + '|' + String(line)];
    if (!l) return { cat: 'run', name: 'Φάση ' + stage + ' / ' + line };
    if (l.isLast) return { cat: 'none', name: l.name, done: true };
    if (STOP_NAMES.indexOf(norm(l.name)) >= 0) return { cat: 'stop', name: l.name };
    return { cat: l.sostatus === 1 ? 'setup' : l.sostatus === 3 ? 'stop' : 'run', name: l.name };
  }
  function isSlitting(phase) { return String(phase || '').charAt(0) === '3'; }   // rolls weighed after production

  // ── Τρέχουσες παραγωγές ────────────────────────────────────────────────────
  async function loadRunning(silent) {
    var list = $('running-list');
    if (!silent) loading(true);
    try {
      var res = await Promise.all([ds('PmGetMachineNow'), ds('PmGetTodayProduction')]);
      var today = {};
      res[1].forEach(function (r) { today[String(r.machine)] = { kg: parseFloat(r.kg) || 0, rolls: parseInt(r.rolls, 10) || 0 }; });
      var entries = res[0].map(function (m) {
        var si = stageInfo(m.stage, m.line);
        var hasOrder = m.findoc && si.cat !== 'none';
        return { id: String(m.id), name: m.name || m.code, code: m.code, phase: m.phase,
                 cat: si.cat, stateName: si.name, since: parseDate(m.since), operator: m.operator,
                 lastFincode: m.fincode, order: hasOrder ? m : null,
                 today: today[String(m.id)] || { kg: 0, rolls: 0 } };
      });
      state.running = entries;

      var n = { run: 0, setup: 0, stop: 0, none: 0 };
      entries.forEach(function (e) { n[e.cat]++; });
      var kg = Object.keys(today).reduce(function (s, k) { return s + today[k].kg; }, 0);
      // The four state counters are filter toggles (data-cat); kg today is display only
      function kpi(label, val, color, extra, cat) {
        var inner = '<div class="kpi-l">' +
          (color === 'live' ? '<span class="dot"></span>' : color ? '<span class="kpi-dot" style="background:' + color + '"></span>' : '') +
          label + '</div><div class="kpi-v">' + val + '</div>';
        return cat ? '<button type="button" class="kpi kpi-btn' + (extra || '') + '" data-cat="' + cat + '" aria-pressed="false" title="Φίλτρο: ' + label + '">' + inner + '</button>'
                   : '<div class="kpi' + (extra || '') + '">' + inner + '</div>';
      }
      $('running-kpis').innerHTML =
        kpi('Σε παραγωγή', n.run + '<small>/ ' + entries.length + '</small>', 'live', '', 'run') +
        kpi('Setup', n.setup, 'var(--warn)', '', 'setup') +
        kpi('Στάση', n.stop, 'var(--accent)', n.stop ? ' alert' : '', 'stop') +
        kpi('Χωρίς εργασία', n.none, 'var(--off)', '', 'none') +
        kpi('Παραχθέντα σήμερα', num(kg) + '<small>kg</small>', '', ' wide');
      paintRunningFilter();
      $('nav-count-running').textContent = (n.run + n.setup) || '';
      var ic = $('nav-count-idle'); ic.textContent = (n.stop + n.none) || ''; ic.classList.toggle('alert', n.stop > 0);
      $('pm-live-text').textContent = 'Live · ' + DateFmt.t(new Date());
      renderRunning();
    } catch (e) {
      errorBox(list, e);
    } finally { if (!silent) loading(false); }
  }

  // Filter: all | busy | idle (segment) or a single state run | setup | stop | none (counter)
  var FILTER_EMPTY = { idle: 'Όλες οι μηχανές δουλεύουν.', run: 'Καμία μηχανή σε παραγωγή.', setup: 'Καμία μηχανή σε setup.',
                       stop: 'Καμία μηχανή σε στάση.', none: 'Όλες οι μηχανές έχουν εργασία.' };
  function setRunningFilter(f) { state.runningFilter = f; paintRunningFilter(); renderRunning(); }
  function paintRunningFilter() {
    var f = state.runningFilter;
    seg($('running-filter'), 'data-filter', f);              // no segment lit when a counter filter is active
    document.querySelectorAll('#running-kpis [data-cat]').forEach(function (k) {
      var on = k.getAttribute('data-cat') === f;
      k.classList.toggle('on', on); k.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function renderRunning() {
    var f = state.runningFilter;
    var rows = (state.running || []).filter(function (e) {
      var busy = e.cat === 'run' || e.cat === 'setup';
      if (f === 'all') return true;
      if (f === 'busy') return busy;
      if (f === 'idle') return !busy;
      return e.cat === f;
    });
    if (!rows.length) { $('running-list').innerHTML = empty(FILTER_EMPTY[f] || 'Καμία μηχανή.'); return; }
    $('running-list').innerHTML = byPhase(rows, function (e) { return e.phase; }).map(function (g) {
      var busy = g.rows.filter(function (e) { return e.cat === 'run'; }).length;
      var kg = g.rows.reduce(function (s, e) { return s + e.today.kg; }, 0);
      return '<section class="group">' + groupHead(g, busy + ' σε παραγωγή · ' + num(kg) + ' kg σήμερα' + (isSlitting(g.phase) ? '*' : '')) +
        '<div class="grid">' + g.rows.map(machineCard).join('') + '</div>' +
        (isSlitting(g.phase) ? '<p class="hint" style="margin:8px 0 0">* Ρολοκοπή: τα ρολά ζυγίζονται μετά την παραγωγή — kg / ώρα ρολού = ώρα ζύγισης.</p>' : '') +
        '</section>';
    }).join('');
  }

  function machineCard(e) {
    var c = CAT[e.cat];
    var pill = '<span class="pill ' + c.pill + '">' + esc(e.cat === 'none' ? c.label : e.stateName) + '</span>';
    var head = '<div class="card-h"><div class="m-ico">' + svg(phaseIcon(e.phase)) + '</div>' +
      '<div class="grow"><div class="c-title">' + esc(e.name) + '</div><div class="c-sub">' + esc(phaseLabel(e.phase)) +
      (e.code ? ' · ' + esc(e.code) : '') + '</div></div>' + pill + '</div>';
    var m = minsSince(e.since);
    var stateRow = '<div class="state-row">' + svg('clock') +
      (e.since ? '<span>' + esc(e.cat === 'none' ? (e.lastFincode ? 'Ολοκλήρωση ' : 'Από ') : 'Από ') + esc(when(e.since)) + '</span><b>' + esc(dur(m)) + '</b>'
               : '<span>Καμία καταγραφή τις τελευταίες 14 ημέρες</span>') +
      (e.operator && e.cat !== 'none' ? '<span class="chip">' + svg('user') + esc(e.operator) + '</span>' : '') + '</div>';
    if (!e.order) {
      return '<div class="card">' + head + stateRow +
        (e.lastFincode ? '<div class="c-sub" style="margin-top:8px">Τελ. εντολή <span class="code">' + esc(e.lastFincode) + '</span></div>' : '') +
        '<div class="meta"><div>Σήμερα<b>' + num(e.today.kg) + ' kg</b></div><div>Ρολά<b>' + e.today.rolls + '</b></div><div></div></div></div>';
    }
    var j = e.order;
    var kilos = parseFloat(j.kilos) || 0, prod = parseFloat(j.producedQty) || 0;
    var pct = kilos > 0 ? Math.min(100, Math.round(prod / kilos * 100)) : 0;
    var last = parseDate(j.lastRoll), pe = parseDate(j.plannedEnd);
    return '<div class="card">' + head + stateRow +
      '<button class="job" type="button" data-order="' + esc(j.findoc) + '" aria-label="Εντολή ' + esc(j.fincode) + '">' +
        '<div class="job-top"><span class="code">' + esc(j.fincode) + '</span><span class="job-item">' + esc(j.itemCode) + ' · ' + esc(j.itemName) + '</span></div>' +
        '<div class="job-cust">' + esc(j.customer || '—') + (j.salesOrder ? ' · ' + esc(j.salesOrder) : '') + '</div>' +
        '<div class="prog"><div class="bar' + (e.cat === 'setup' ? ' warn' : '') + '"><i style="width:' + pct + '%"></i></div><span class="pct">' + pct + '%</span></div>' +
        '<div class="meta"><div>Παραχθέντα<b>' + num(prod) + ' / ' + num(kilos) + ' kg</b></div>' +
        '<div>Ρολά<b>' + num(j.rolls || 0) + '</b></div>' +
        '<div>' + (last ? (isSlitting(e.phase) ? 'Τελ. ζύγιση' : 'Τελ. ρολό') + '<b>' + esc(DateFmt.t(last)) + ' · ' + esc(dur(minsSince(last))) + '</b>'
                        : 'Πλάνο λήξης<b>' + esc(pe ? when(pe) : '—') + '</b>') + '</div></div>' +
      '</button></div>';
  }

  // ── Πρόγραμμα ημέρας: jobs per machine, move one step up / down ───────────
  function minuteStr(d) { return DateFmt.toIso(d) + ' ' + DateFmt.t(d); }   // 'YYYY-MM-DD HH:MM' (SaveSchedule format)
  function timeRange(a, b, day) {
    var same = function (d) { return d.toDateString() === day.toDateString(); };
    return (same(a) ? '' : DateFmt.dm(a) + ' ') + DateFmt.t(a) + '–' + (same(b) || b.toDateString() === a.toDateString() ? '' : DateFmt.dm(b) + ' ') + DateFmt.t(b);
  }

  async function loadSchedule() {
    var list = $('sch-list'), day = state.schDay;
    $('sch-day').value = DateFmt.d(day);
    if (state.view === 'schedule') $('pm-view-sub').textContent = 'Ημέρα παραγωγής ' + longDate(day);
    loading(true);
    try {
      var res = await Promise.all([loadMachines(), ds('PmGetDaySchedule', { day: DateFmt.toIso(day) })]);
      var jobs = res[1].map(function (r) {
        return { id: String(r.id), fincode: r.fincode, machine: String(r.machine), itemCode: r.itemCode, itemName: r.itemName,
                 customer: r.customer, delivery: parseDate(r.deliveryDate), status: parseInt(r.status, 10), phase: r.phase,
                 kilos: r.kilos, start: parseDate(r.plannedStart), end: parseDate(r.plannedEnd),
                 started: r.evStage != null && r.evStage !== '' };
      }).filter(function (j) { return j.start && j.end; });
      jobs.forEach(function (j) { j.locked = j.status === 1 ? 'Ολοκληρωμένη' : j.started ? 'Σε εξέλιξη' : ''; });
      var byMachine = {};
      jobs.forEach(function (j) { (byMachine[j.machine] = byMachine[j.machine] || []).push(j); });
      Object.keys(byMachine).forEach(function (k) { byMachine[k].sort(function (a, b) { return a.start - b.start || a.id - b.id; }); });
      state.schedule = byMachine;
      renderSchedule();
    } catch (e) { errorBox(list, e); }
    finally { loading(false); }
  }

  function renderSchedule() {
    var list = $('sch-list'), day = state.schDay, filter = $('sch-machine').value;
    var machines = (state.machines || []).filter(function (m) {
      return (!filter || String(m.id) === filter) && (flag(m.isActive) || state.schedule[String(m.id)]);
    }).sort(function (a, b) { return (parseInt(a.phase, 10) || 99999) - (parseInt(b.phase, 10) || 99999) || String(a.code).localeCompare(String(b.code)); });
    var dayEnd = new Date(day.getTime() + 30 * 3600000), late = productionDay(new Date());
    var html = machines.map(function (m) {
      var jobs = state.schedule[String(m.id)] || [];
      return '<section class="group"><div class="group-h"><h3>' + esc(m.name || m.code) + '</h3><span class="n">' + jobs.length + '</span>' +
        '<span class="line"></span><span class="sum">' + esc(phaseLabel(m.phase)) + '</span></div>' +
        (jobs.length ? '<div class="sch-list">' + jobs.map(function (j, i) {
          var prev = jobs[i - 1], next = jobs[i + 1];
          var canUp = !j.locked && prev && !prev.locked, canDown = !j.locked && next && !next.locked;
          var isLate = j.delivery && j.status !== 1 && j.delivery < late;
          return '<div class="sch-row' + (j.locked ? ' locked' : '') + '" data-id="' + esc(j.id) + '">' +
            '<div class="sch-pos">' + (i + 1) + '</div>' +
            '<button class="sch-main" type="button" data-order="' + esc(j.id) + '">' +
              '<div class="sch-time">' + esc(timeRange(j.start, j.end, day)) + '<span>' + esc(dur((j.end - j.start) / 60000)) + '</span></div>' +
              '<div class="job-top"><span class="code">' + esc(j.fincode) + '</span><span class="job-item">' + esc(j.itemCode) + ' · ' + esc(j.itemName) + '</span></div>' +
              '<div class="job-cust">' + esc(j.customer || '—') + (j.delivery ? ' · <span' + (isLate ? ' class="late"' : '') + '>παράδοση ' + esc(DateFmt.d(j.delivery)) + '</span>' : '') + '</div>' +
              (j.locked ? '<span class="pill ' + (j.status === 1 ? 'done' : 'run') + ' sch-lock">' + esc(j.locked) + '</span>' : '') +
            '</button>' +
            '<div class="sch-btns">' +
              '<button class="icon-btn" type="button" data-mv="-1" data-m="' + esc(m.id) + '" data-i="' + i + '"' + (canUp ? '' : ' disabled') + ' aria-label="Νωρίτερα (' + esc(j.fincode) + ')" title="Νωρίτερα"><svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button>' +
              '<button class="icon-btn" type="button" data-mv="1" data-m="' + esc(m.id) + '" data-i="' + i + '"' + (canDown ? '' : ' disabled') + ' aria-label="Αργότερα (' + esc(j.fincode) + ')" title="Αργότερα"><svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg></button>' +
            '</div></div>';
        }).join('') + '</div>' : '<p class="hint" style="margin:0 0 4px">Καμία εργασία σε αυτή την ημέρα.</p>') + '</section>';
    }).join('');
    list.innerHTML = html || empty('Καμία μηχανή.');
    void dayEnd;
  }

  // Swap job i with its neighbour (dir −1 = earlier, +1 = later). The pair keeps its outer window
  // [first.start, second.end]; each job keeps its duration; the gap between them is kept.
  var _moving = false;
  async function moveJob(machineId, i, dir) {
    if (_moving) return;
    var jobs = state.schedule[String(machineId)] || [];
    var a = jobs[dir < 0 ? i - 1 : i], b = jobs[dir < 0 ? i : i + 1];     // a before b
    if (!a || !b || a.locked || b.locked) return;
    var durA = a.end - a.start, durB = b.end - b.start;
    var bStart = new Date(a.start.getTime()), bEnd = new Date(a.start.getTime() + durB);
    var aEnd = new Date(b.end.getTime()), aStart = new Date(b.end.getTime() - durA);
    var payload = [
      { findoc: b.id, start: minuteStr(bStart), end: minuteStr(bEnd), origMachine: machineId, origStart: minuteStr(b.start), origEnd: minuteStr(b.end) },
      { findoc: a.id, start: minuteStr(aStart), end: minuteStr(aEnd), origMachine: machineId, origStart: minuteStr(a.start), origEnd: minuteStr(a.end) }
    ];
    var moved = dir < 0 ? b : a;
    _moving = true;
    document.querySelectorAll('#sch-list [data-mv]').forEach(function (x) { x.disabled = true; });
    loading(true);
    try {
      var r = await Soft1Bridge.moveOrders(payload);
      var errs = r.errors || [];
      if (errs.length) {
        // undo whatever was written, so the two jobs never overlap
        var failed = {}; errs.forEach(function (e) { failed[String(e.findoc)] = true; });
        var undo = payload.filter(function (p) { return !failed[String(p.findoc)]; }).map(function (p) {
          return { findoc: p.findoc, start: p.origStart, end: p.origEnd, origMachine: p.origMachine, origStart: p.start, origEnd: p.end };
        });
        if (undo.length && r.saved) { try { await Soft1Bridge.moveOrders(undo); } catch (_) {} }
        toast('Δεν έγινε η μετακίνηση: ' + (errs[0].error || 'σφάλμα'), 'error');
      } else {
        if (Soft1Bridge.isMock) MOCK.move(payload);
        toast('Η ' + moved.fincode + ' μετακινήθηκε ' + (dir < 0 ? 'νωρίτερα' : 'αργότερα'), 'success');
      }
    } catch (e) {
      toast('Σφάλμα: ' + (e.message || e), 'error');
    } finally {
      _moving = false; loading(false);
      await loadSchedule();
      var row = document.querySelector('#sch-list .sch-row[data-id="' + moved.id + '"] [data-mv="' + dir + '"]');
      if (row && !row.disabled) row.focus();
    }
  }
  function setSchDay(d) { state.schDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()); loadSchedule(); }

  // ── Αδράνεια μηχανών (timeline from stage events, inside the shift calendar) ─
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

  // events (sorted) → segments [{from, to, cat, name}] clipped to [a, b]
  function stateSegments(events, a, b) {
    var segs = [], cur = { cat: 'none', name: CAT.none.label }, t = a.getTime(), end = b.getTime();
    events.forEach(function (ev) {
      var x = ev.t.getTime();
      if (x <= t) { cur = ev.info; return; }
      if (x >= end) return;
      segs.push({ from: t, to: x, cat: cur.cat, name: cur.name });
      cur = ev.info; t = x;
    });
    if (end > t) segs.push({ from: t, to: end, cat: cur.cat, name: cur.name });
    return segs.filter(function (s) { return s.to > s.from; });
  }
  function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

  async function loadIdle() {
    var list = $('idle-list'), day = state.idleDay;
    $('idle-day').value = DateFmt.d(day);
    if (state.view === 'idle') $('pm-view-sub').textContent = 'Ημέρα παραγωγής ' + longDate(day);
    loading(true);
    try {
      var res = await Promise.all([
        loadMachines(),
        ds('GetShifts', { monday: DateFmt.toIso(mondayOf(day)) }),
        ds('PmGetStageEvents', { day: DateFmt.toIso(day) }),
        ds('PmGetMachineActivity', { day: DateFmt.toIso(day) })
      ]);
      var machines = res[0].filter(function (m) { return flag(m.isActive); });
      var shiftByMachine = {}, evByMachine = {}, rollsByMachine = {};
      res[1].forEach(function (r) { shiftByMachine[String(r.machine)] = r; });
      res[2].forEach(function (r) {
        var t = parseDate(r.t); if (!t) return;
        (evByMachine[String(r.machine)] = evByMachine[String(r.machine)] || []).push({ t: t, info: stageInfo(r.stage, r.line), operator: r.operator });
      });
      res[3].forEach(function (r) {
        var t = parseDate(r.t); if (!t) return;
        (rollsByMachine[String(r.machine)] = rollsByMachine[String(r.machine)] || []).push(t);
      });
      var now = new Date();
      var dayStart = new Date(day.getTime() + 6 * 3600000), span = 24 * 3600000, dayEnd = new Date(dayStart.getTime() + span);
      var until = new Date(Math.min(now.getTime(), dayEnd.getTime()));
      var isToday = now >= dayStart && now < dayEnd;
      function pct(x) { return Math.max(0, Math.min(100, (x - dayStart.getTime()) / span * 100)); }

      if (until <= dayStart) { list.innerHTML = empty('Η ημέρα δεν έχει ξεκινήσει ακόμη.'); return; }
      var items = machines.map(function (m) {
        var blocks = shiftByMachine[String(m.id)] ? shiftBlocks(shiftByMachine[String(m.id)], day) : [];
        var evs = (evByMachine[String(m.id)] || []).sort(function (a, b) { return a.t - b.t; });
        var segs = stateSegments(evs, dayStart, until);
        var tot = { run: 0, setup: 0, stop: 0, none: 0 }, reasons = {}, shiftMin = 0;
        blocks.forEach(function (b) {
          var b0 = b[0].getTime(), b1 = Math.min(b[1].getTime(), until.getTime());
          if (b1 <= b0) return;
          shiftMin += (b1 - b0) / 60000;
          segs.forEach(function (s) {
            var o = overlap(s.from, s.to, b0, b1) / 60000; if (!o) return;
            tot[s.cat] += o;
            var rk = s.cat === 'none' ? CAT.none.label : s.name;
            if (s.cat === 'stop' || s.cat === 'none') reasons[rk] = (reasons[rk] || 0) + o;
          });
        });
        var cur = segs.length ? segs[segs.length - 1] : null;
        return { m: m, blocks: blocks, segs: segs, tot: tot, reasons: reasons, shiftMin: shiftMin,
                 idle: tot.stop + tot.none, util: shiftMin ? Math.round(tot.run / shiftMin * 100) : null,
                 cur: isToday ? cur : null,
                 rolls: isSlitting(m.phase) ? [] : (rollsByMachine[String(m.id)] || []).filter(function (t) { return t >= dayStart && t < dayEnd; }) };
      });
      if (!items.length) { list.innerHTML = empty('Δεν υπάρχουν ενεργές μηχανές.'); return; }

      list.innerHTML = byPhase(items, function (x) { return x.m.phase; }).map(function (g) {
        var idle = g.rows.reduce(function (s, x) { return s + x.idle; }, 0);
        return '<section class="group">' + groupHead(g, 'αδράνεια ' + dur(idle)) + '<div class="grid">' + g.rows.map(function (x) {
          var m = x.m;
          var pill = !x.blocks.length ? '<span class="pill off">Χωρίς βάρδια</span>'
                   : x.cur ? '<span class="pill ' + CAT[x.cur.cat].pill + '">' + esc(x.cur.cat === 'none' ? CAT.none.label : x.cur.name) + '</span>'
                   : '<span class="pill ' + (x.util >= 75 ? 'run' : x.util >= 50 ? 'setup' : 'idle') + '">Αξιοποίηση ' + x.util + '%</span>';
          var bar = x.blocks.map(function (b) {
            return '<div class="s" style="left:' + pct(b[0].getTime()) + '%;width:' + (pct(b[1].getTime()) - pct(b[0].getTime())) + '%"></div>';
          }).join('') + x.segs.filter(function (s) { return s.cat !== 'none'; }).map(function (s) {
            return '<div class="g ' + s.cat + '" title="' + esc(s.name + ' ' + DateFmt.t(new Date(s.from)) + '–' + DateFmt.t(new Date(s.to))) + '" style="left:' + pct(s.from) + '%;width:' + Math.max(.3, pct(s.to) - pct(s.from)) + '%"></div>';
          }).join('') + x.rolls.map(function (t) {
            return '<div class="r" style="left:' + pct(t.getTime()) + '%"></div>';
          }).join('') + (isToday ? '<div class="n" style="left:' + pct(now.getTime()) + '%"></div>' : '');
          var reasons = Object.keys(x.reasons).sort(function (a, b) { return x.reasons[b] - x.reasons[a]; })
            .filter(function (k) { return x.reasons[k] >= 1; });
          return '<div class="card">' +
            '<div class="card-h"><div class="m-ico">' + svg(phaseIcon(m.phase)) + '</div>' +
            '<div class="grow"><div class="c-title">' + esc(m.name || m.code) + '</div><div class="c-sub">' + esc(m.code) +
              (x.util != null ? ' · αξιοποίηση ' + x.util + '%' : '') + '</div></div>' + pill + '</div>' +
            '<div class="idle-note"><span class="big' + (!x.blocks.length ? ' dim' : x.idle >= 1 ? '' : ' ok') + '">' + (x.blocks.length ? esc(dur(x.idle)) : '—') + '</span>' +
            '<span>' + (!x.blocks.length ? 'δεν υπάρχει βάρδια στο ημερολόγιο' : 'αδράνεια μέσα στις βάρδιες<br>(στάσεις + χωρίς εργασία)') + '</span></div>' +
            '<div class="tl" role="img" aria-label="Χρονογραμμή 06:00–06:00">' + bar + '</div>' +
            '<div class="tl-scale"><span>06</span><span>10</span><span>14</span><span>18</span><span>22</span><span>02</span><span>06</span></div>' +
            (x.blocks.length ? '<div class="gaps">' +
              '<span class="gap run">Παραγωγή ' + esc(dur(x.tot.run)) + '</span>' +
              (x.tot.setup >= 1 ? '<span class="gap setup">Setup ' + esc(dur(x.tot.setup)) + '</span>' : '') +
              reasons.map(function (k) { return '<span class="gap">' + esc(k) + ' ' + esc(dur(x.reasons[k])) + '</span>'; }).join('') +
            '</div>' : '') +
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
      var res = await Promise.all([ds('GetOrderDetails', { findoc: id }), ds('GetProductionRolls', { findoc: id }),
                                   ds('PmGetOrderStages', { findoc: id })]);
      var o = res[0][0];
      var stages = res[2].map(function (r) { return { t: parseDate(r.t), info: stageInfo(r.stage, r.line), operator: r.operator, minutes: r.minutes, remarks: r.remarks }; })
        .filter(function (r) { return r.t; });
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
        (stages.length ? '<div class="sheet-sec">Ιστορικό σταδίων <span>' + stages.length + '</span></div>' +
          '<table class="table"><thead><tr><th>Ώρα</th><th>Στάδιο</th><th>Χειριστής</th><th class="num">Διάρκεια</th></tr></thead><tbody>' +
          stages.map(function (r, i) {
            var next = stages[i + 1], mins = next ? (next.t - r.t) / 60000 : (r.info.cat === 'none' ? null : minsSince(r.t));
            if (parseFloat(r.minutes) > 0 && !next) mins = parseFloat(r.minutes);
            return '<tr><td class="mono">' + esc(DateFmt.dm(r.t) + ' ' + DateFmt.t(r.t)) + '</td>' +
              '<td><span class="sdot ' + r.info.cat + '"></span>' + esc(r.info.name) + (r.remarks && String(r.remarks).trim() ? '<div class="c-sub">' + esc(r.remarks) + '</div>' : '') + '</td>' +
              '<td>' + esc(r.operator || '') + '</td><td class="num">' + (mins == null ? '' : esc(dur(mins)) + (next ? '' : '…')) + '</td></tr>';
          }).join('') + '</tbody></table>' : '') +
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
        var pct = orders ? Math.round(done / orders * 100) : 0, all = orders > 0 && done === orders;
        var fd = parseDate(c.firstDelivery);
        return '<button class="card" type="button" data-customer-order="' + esc(c.id) + '" data-title="' + esc(c.fincode) + '">' +
          '<div class="card-h"><div class="m-ico">' + svg('box') + '</div>' +
          '<div class="grow"><div class="c-title code">' + esc(c.fincode) + '</div><div class="c-sub">' + esc(c.customer || '—') + '</div></div>' +
          (orders ? '<span class="pill ' + (all ? 'done' : 'run') + '">' + done + '/' + orders + '</span>' : '<span class="pill off">Χωρίς εντολές</span>') + '</div>' +
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
        '<div class="field"><label for="mf-speed">Ταχύτητα</label><div class="unit"><input id="mf-speed" class="input" type="text" inputmode="decimal" value="' + esc(val(m.speed)) + '" /><span>m/min</span></div></div>' +
        '<dl class="kv field full" style="margin-top:4px"><dt>Χρόνος αναμονής</dt><dd>' + num(m.waitTime) + ' λεπτά</dd>' +
          '<dt>Κατάσταση</dt><dd>' + (flag(m.isActive) ? 'Ενεργή' : 'Ανενεργή') + '</dd>' +
          (m.remarks ? '<dt>Σχόλια</dt><dd>' + esc(m.remarks) + '</dd>' : '') + '</dl>' +
        '<div id="mf-error" class="form-error" role="alert"></div>' +
        '<div class="form-actions"><button type="button" class="btn" id="mf-cancel">Άκυρο</button>' +
        '<button type="submit" class="btn brand" id="mf-save">Αποθήκευση στο Soft1</button></div>' +
      '</form>');
    $('mf-cancel').addEventListener('click', closeSheet);
    $('machine-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var err = $('mf-error'); err.textContent = '';
      var vals = { SETUPTIME: $('mf-setup').value, MPRDQTY: $('mf-speed').value };
      for (var k in vals) {
        var s = String(vals[k]).trim().replace(',', '.'), n = parseFloat(s);
        if (s === '' || !/^\d+(\.\d+)?$/.test(s) || !isFinite(n)) { err.textContent = 'Μη έγκυρη τιμή — μόνο θετικοί αριθμοί'; return; }
        vals[k] = n;
      }
      var fields = {};
      if (vals.SETUPTIME !== parseFloat(m.setupTime)) fields.SETUPTIME = vals.SETUPTIME;
      if (vals.MPRDQTY   !== parseFloat(m.speed))     fields.MPRDQTY   = vals.MPRDQTY;
      if (!Object.keys(fields).length) { closeSheet(); return; }
      $('mf-save').disabled = true;
      try {
        await Soft1Bridge.machineSave(m.id, fields);
        if ('SETUPTIME' in fields) m.setupTime = fields.SETUPTIME;
        if ('MPRDQTY' in fields)   m.speed     = fields.MPRDQTY;
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
      setRunningFilter(b.getAttribute('data-filter'));
    });
    $('running-kpis').addEventListener('click', function (e) {
      var k = e.target.closest('[data-cat]'); if (!k) return;
      var cat = k.getAttribute('data-cat');
      setRunningFilter(state.runningFilter === cat ? 'all' : cat);     // tap again = all machines
    });

    // Idle
    state.idleDay = productionDay(new Date());
    DateFmt.bind($('idle-day'));
    $('idle-day').addEventListener('change', function () { var d = DateFmt.parse(this.value); if (d) setIdleDay(d); });
    $('idle-day').addEventListener('keydown', function (e) { if (e.key === 'Enter') { var d = DateFmt.parse(this.value); if (d) setIdleDay(d); } });
    $('idle-prev').addEventListener('click', function () { setIdleDay(addDays(state.idleDay, -1)); });
    $('idle-next').addEventListener('click', function () { setIdleDay(addDays(state.idleDay, 1)); });
    $('idle-today').addEventListener('click', function () { setIdleDay(productionDay(new Date())); });

    // Πρόγραμμα ημέρας
    state.schDay = productionDay(new Date());
    DateFmt.bind($('sch-day'));
    function schFromInput() { var d = DateFmt.parse($('sch-day').value); if (d) setSchDay(d); }
    $('sch-day').addEventListener('change', schFromInput);
    $('sch-day').addEventListener('keydown', function (e) { if (e.key === 'Enter') schFromInput(); });
    $('sch-prev').addEventListener('click', function () { setSchDay(addDays(state.schDay, -1)); });
    $('sch-next').addEventListener('click', function () { setSchDay(addDays(state.schDay, 1)); });
    $('sch-today').addEventListener('click', function () { setSchDay(productionDay(new Date())); });
    $('sch-machine').addEventListener('change', renderSchedule);
    $('sch-list').addEventListener('click', function (e) {
      var b = e.target.closest('[data-mv]'); if (!b || b.disabled) return;
      e.stopPropagation();
      moveJob(b.getAttribute('data-m'), parseInt(b.getAttribute('data-i'), 10), parseInt(b.getAttribute('data-mv'), 10));
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

    await Promise.all([loadPhaseNames(), loadStageLines()]);
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
    // Stage lines (as at Vlachos: 1 Setup, 2 Παραγωγή, 3 Κλείσιμο Βάρδιας, 4 Χαμ.Χρόνος, 5 Διάλλειμα, 6 Αναμονή Οδηγιών, 7 Ολοκλήρωση)
    var LINES = [[1, 'Setup', 1], [2, 'Παραγωγή', 2], [3, 'Κλείσιμο Βάρδιας', 3], [4, 'Χαμ.Χρόνος', 3], [5, 'Διάλλειμα', 3],
                 [6, 'Αναμονή Οδηγιών', 2], [7, 'Ολοκλήρωση Παραγωγής', 3]];
    var stageLines = [];
    [1001, 2001, 3001, 4001].forEach(function (st) {
      LINES.forEach(function (l) { stageLines.push({ stage: st, line: l[0], name: l[1], sostatus: l[2], isLast: l[0] === 7 ? 1 : 0 }); });
    });
    // Stage events per machine: [hh, mm, line] relative to the production day start (hh ≥ 24 = next day)
    var day0 = at(6, 0, now.getHours() < 6 ? -1 : 0);
    var SCRIPT = {
      101: [9001, [[6, 5, 1], [6, 50, 2], [10, 0, 5], [10, 25, 2], [13, 30, 4], [14, 15, 2], [18, 0, 5], [18, 30, 2]]],
      102: [9002, [[6, 10, 2], [9, 40, 7], [10, 5, 1]]],
      201: [9003, [[6, 0, 2], [9, 0, 4], [10, 10, 2], [12, 0, 5], [12, 30, 2]]],
      202: [9010, [[-9, 0, 2], [-3, 0, 7]]],
      203: [9004, [[6, 0, 2], [11, 0, 5], [11, 20, 2]]],
      301: [9005, [[6, 30, 1], [7, 0, 2], [10, 30, 6], [11, 5, 2]]],
      302: [9006, [[6, 0, 2], [8, 0, 4], [9, 0, 2]]],
      303: [9008, [[6, 0, 2], [9, 49, 7]]],
      401: [9007, [[6, 20, 1], [6, 40, 2], [12, 0, 5], [14, 0, 2]]]
    };
    var events = [], evId = 1;
    Object.keys(SCRIPT).forEach(function (mid) {
      var fd = SCRIPT[mid][0], st = machines.filter(function (m) { return String(m.id) === mid; })[0].phase;
      SCRIPT[mid][1].forEach(function (e) {
        var t = new Date(day0.getTime() + ((e[0] - 6) * 60 + e[1]) * 60000);
        if (t > now) return;
        events.push({ id: evId++, machine: +mid, findoc: fd, fincode: 'ΕΠΑ00' + (12345 + fd - 9001), stage: st, line: e[2], t: t,
                      operator: ['Παπαδόπουλος', 'Γεωργίου', 'Νικολάου', 'Δημητρίου'][mid % 4] });
      });
    });
    function evRow(e) { return Object.assign({}, e, { t: iso(e.t) }); }
    // Daily schedule store: per machine a sequence of jobs from the machine's current order onward
    var sched = [], schId = 9101;
    var ITEMS = [['80398', 'Φιλμ τυπωμένο Α'], ['80412', 'Φιλμ τυπωμένο Δ'], ['80420', 'Λαμινέ τριπλό Ε'], ['79731', 'Ρολό κομμένο Ζ'], ['81002', 'Σακούλα Doypack']];
    var CUST = ['ΑΛΦΑ ΤΡΟΦΙΜΑ Α.Ε.', 'ΒΗΤΑ ΓΑΛΑΚΤΟΚΟΜΙΚΑ', 'ΓΑΜΜΑ ΚΑΦΕΣ', 'ΔΕΛΤΑ ΣΝΑΚ'];
    machines.forEach(function (m, mi) {
      if (m.id === 202) return;
      var t = new Date(day0.getTime() + (mi % 3) * 20 * 60000), first = SCRIPT[m.id] && SCRIPT[m.id][0];
      for (var k = 0; k < 5; k++) {
        var mins = 90 + ((mi * 7 + k * 13) % 5) * 45, it = ITEMS[(mi + k) % ITEMS.length];
        var o = k === 0 && first ? orders.filter(function (x) { return x.id === first; })[0] : null;
        sched.push({ id: o ? o.id : schId++, fincode: o ? o.fincode : 'ΕΠΑ00' + (12400 + schId), machine: m.id, machineName: m.name,
                     itemCode: o ? o.itemCode : it[0], itemName: o ? o.itemName : it[1], customer: o ? o.customer : CUST[(mi + k) % 4],
                     deliveryDate: DateFmt.toIso(addDays(now, (k + mi) % 6 - 1)), kilos: 400 + k * 150, status: o ? o.status : 0,
                     phase: m.phase, start: new Date(t), end: new Date(t.getTime() + mins * 60000),
                     evStage: o && events.some(function (e) { return e.findoc === o.id; }) ? m.phase : null });
        t = new Date(t.getTime() + (mins + 10) * 60000);
      }
    });
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
    function parseMin(v) { var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(v); return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]); }
    return {
      move: function (list) {
        list.forEach(function (p) {
          var j = sched.filter(function (x) { return String(x.id) === String(p.findoc); })[0];
          if (j) { j.start = parseMin(p.start); j.end = parseMin(p.end); }
        });
      },
      dataset: function (name, p) {
        switch (name) {
          case 'GetPhaseMachines': return machines.map(function (m) { return { machine: m.id, phase: m.phase, phaseName: m.phaseName }; });
          case 'PmGetMachineList': return machines.map(function (m) { return Object.assign({}, m); });
          case 'PmGetStageLines': return stageLines;
          case 'PmGetDaySchedule': {
            var ds0 = DateFmt.fromIso(p.day), w0 = ds0.getTime() + 6 * 3600000, w1 = w0 + 24 * 3600000;
            return sched.filter(function (j) { return j.start.getTime() < w1 && j.end.getTime() > w0; })
              .map(function (j) { return Object.assign({}, j, { plannedStart: iso(j.start), plannedEnd: iso(j.end) }); });
          }
          case 'PmGetMachineNow': return machines.filter(function (m) { return m.isActive; }).map(function (m) {
            var ev = events.filter(function (e) { return e.machine === m.id; }).sort(function (a, b) { return b.t - a.t; })[0];
            var o = ev && orders.filter(function (x) { return x.id === ev.findoc; })[0];
            return Object.assign({ id: m.id, code: m.code, name: m.name, phase: m.phase },
              ev ? { findoc: ev.findoc, stage: ev.stage, line: ev.line, since: iso(ev.t), operator: ev.operator, fincode: ev.fincode } : {},
              o ? { fincode: o.fincode, itemCode: o.itemCode, itemName: o.itemName, kilos: o.kilos, plannedEnd: o.plannedEnd, status: o.status,
                    salesOrder: o.salesOrder, customer: o.customer, rolls: o.rolls, producedQty: o.producedQty, lastRoll: o.lastRoll } : {});
          });
          case 'PmGetStageEvents': return p.day === DateFmt.toIso(day0) ? events.map(evRow) : [];
          case 'PmGetOrderStages': return events.filter(function (e) { return String(e.findoc) === String(p.findoc); })
            .sort(function (a, b) { return a.t - b.t; }).map(evRow);
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

  global.ProductionApp = { state: state, _stateSegments: stateSegments, _shiftBlocks: shiftBlocks };
})(window);
