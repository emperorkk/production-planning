/* UIController — bootstraps the app, owns state, wires all events.
   Order-centric: each FINDOC = one Gantt block. */
(function (global) {
  'use strict';

  // ── Application state ──────────────────────────────────────────────────────
  var state = {
    weekStart:      null,
    weekEnd:        null,
    machines:       [],
    phaseMachines:  {},     // phase -> [machineId,...]
    machinePhases:  {},     // machineId -> [phase,...]
    phaseNames:     {},     // phase code -> display name
    orders:         [],
    orderById:      {},     // O(1) lookup by id
    machineById:    {},     // O(1) lookup by id
    shifts:         [],
    mtrlTree:       [],
    changedOrders:  {},
    dirty:          false,
    calendarExists: true,    // false → no CCCFXPCAL week in Soft1 (banner)
    _chain:         null,    // phase chain index (SchedulerEngine.buildChainIndex)
    _chainViol:     {},      // orderId -> message (starts before predecessor ends)
    _highlightId:   null     // search-jump highlight
  };

  // Undo / redo (unsaved planner changes) + filters
  var _undo = [], _redo = [];
  var _filters = { phase: '', from: null, to: null, late: false, pre: false, sort: 'deliv-asc' };
  var _fullyLoaded = false;

  function _phaseLabel(p) {
    if (p == null || p === '') return '';
    var nm = state.phaseNames[String(p)];
    return nm ? (nm + ' (' + p + ')') : String(p);
  }
  function _phaseShort(p) {
    if (p == null || p === '') return '';
    return state.phaseNames[String(p)] || String(p);
  }

  // Provisional shifts persist across week navigations within the session
  var _provisionalShiftsByWeek = {};

  // ── DOM references ─────────────────────────────────────────────────────────
  var els = {};

  async function init() {
    // Bootstrap the bridge first — in web mode this fetches /api/me
    // and populates Soft1Bridge.user / .company / .branch from the session cookie.
    if (Soft1Bridge.init) {
      try { await Soft1Bridge.init(); }
      catch (e) { console.error('Soft1Bridge.init failed:', e); }
    }

    els.weekLabel       = document.getElementById('week-label');
    els.btnPrevWeek     = document.getElementById('btn-prev-week');
    els.btnNextWeek     = document.getElementById('btn-next-week');
    els.btnSave         = document.getElementById('btn-save');
    els.btnExport       = document.getElementById('btn-export');
    els.btnAutoPlace    = document.getElementById('btn-auto-place');
    els.btnZoomIn       = document.getElementById('btn-zoom-in');
    els.btnZoomOut      = document.getElementById('btn-zoom-out');
    els.ganttScroll     = document.getElementById('gantt-scroll');
    els.ganttBody       = document.getElementById('gantt-body');
    els.timeHeader      = document.getElementById('gantt-time-header');
    els.dropGhost       = document.getElementById('drop-ghost');
    els.unscheduledList = document.getElementById('unscheduled-list');
    els.orderSearch     = document.getElementById('order-search');
    els.issuePanel      = document.getElementById('issue-panel');
    els.contextMenu     = document.getElementById('context-menu');
    els.unsavedBanner   = document.getElementById('unsaved-banner');
    els.mockBanner      = document.getElementById('mock-banner');
    els.toast           = document.getElementById('toast');
    els.loading         = document.getElementById('loading-overlay');
    els.provPill        = document.getElementById('prov-pill');
    els.provCount       = document.getElementById('prov-count');
    els.modalBackdrop   = document.getElementById('modal-backdrop');
    els.shiftDate       = document.getElementById('shift-date');
    els.shiftMachine    = document.getElementById('shift-group');   // re-purposed: now machine selector
    els.shiftStart      = document.getElementById('shift-start');
    els.shiftEnd        = document.getElementById('shift-end');
    els.btnShiftCancel  = document.getElementById('btn-shift-cancel');
    els.btnShiftSave    = document.getElementById('btn-shift-save');
    els.btnUndo         = document.getElementById('btn-undo');
    els.btnRedo         = document.getElementById('btn-redo');
    els.btnToday        = document.getElementById('btn-today');
    els.weekPicker      = document.getElementById('week-picker');
    els.btnPrint        = document.getElementById('btn-print');
    els.btnCalendar     = document.getElementById('btn-calendar');
    els.calBanner       = document.getElementById('cal-banner');
    els.btnCalCreate    = document.getElementById('btn-cal-create');
    els.btnCalCreateEmpty = document.getElementById('btn-cal-create-empty');
    els.btnCalOpen      = document.getElementById('btn-cal-open');
    els.sessionBanner   = document.getElementById('session-banner');
    els.sessionText     = document.getElementById('session-text');
    els.btnRelogin      = document.getElementById('btn-relogin');
    els.btnProvConvert  = document.getElementById('btn-prov-convert');
    els.unschedCount    = document.getElementById('unsched-count');
    els.btnFilters      = document.getElementById('btn-filters');
    els.filterBox       = document.getElementById('filter-box');
    els.fPhase          = document.getElementById('f-phase');
    els.fFrom           = document.getElementById('f-from');
    els.fTo             = document.getElementById('f-to');
    els.fLate           = document.getElementById('f-late');
    els.fPre            = document.getElementById('f-pre');
    els.fSort           = document.getElementById('f-sort');
    els.fClear          = document.getElementById('f-clear');
    els.shiftS          = [document.getElementById('shift-s1'), document.getElementById('shift-s2'), document.getElementById('shift-s3')];
    els.shiftSoft1Box   = document.getElementById('shift-soft1-box');
    els.shiftProvBox    = document.getElementById('shift-prov-box');

    if (Soft1Bridge.isMock && els.mockBanner) els.mockBanner.style.display = 'block';

    // Click a machine name / order → floating info cards
    if (global.InfoCard) InfoCard.init({
      getState: function () { return state; },
      getChain: function () { return state._chain; },
      onJump:   function (o) { _jumpToOrder(o); }
    });

    // Shared shell (src/app-shell.js): app switcher · 🔑 change password · Έξοδος
    var _leaving = false;
    if (global.AppShell) AppShell.mount({
      current: 'planner',
      toolbar: document.getElementById('toolbar'),
      confirmLeave: function () { return !state.dirty || confirm('Υπάρχουν μη αποθηκευμένες αλλαγές. Συνέχεια;'); },
      onLeave: function () { _leaving = true; },
      toast: function (m, t) { _toast(m, t); }
    });

    _setWeek(_getWeekStart(new Date()));

    _bindToolbar();
    _bindSearch();
    _bindContextMenu();
    _bindGanttSync();
    _bindShiftBands();
    _bindShiftModal();
    _bindNavigation();
    _bindHistory();
    _bindFilters();
    _bindCalendarUi();
    _startSessionWatch();

    window.addEventListener('beforeunload', function (e) {
      if (state.dirty && !_leaving) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ── Week helpers ──────────────────────────────────────────────────────────
  function _getWeekStart(d) {
    var start = new Date(d);
    var dow = start.getDay();
    var diff = (dow === 0) ? -6 : 1 - dow;   // Monday
    start.setDate(start.getDate() + diff);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  function _getWeekEnd(weekStart) {
    var end = new Date(weekStart);
    end.setDate(end.getDate() + 6);   // Sunday
    end.setHours(23, 59, 59, 999);
    return end;
  }
  function _weekLabel(weekStart, weekEnd) {
    var days = ['Κυρ','Δευ','Τρι','Τετ','Πεμ','Παρ','Σαβ'];
    return days[weekStart.getDay()] + ' ' + DateFmt.d(weekStart) + ' – ' + days[weekEnd.getDay()] + ' ' + DateFmt.d(weekEnd);
  }
  function _setWeek(newStart) {
    state.weekStart = newStart;
    state.weekEnd   = _getWeekEnd(newStart);
    if (els.weekLabel) els.weekLabel.textContent = _weekLabel(state.weekStart, state.weekEnd);
    if (els.weekPicker) els.weekPicker.value = _fmtDate(state.weekStart);
    var calHref = 'calendar.html?week=' + _fmtDate(state.weekStart);
    if (els.btnCalendar) els.btnCalendar.href = calHref;
    if (els.btnCalOpen)  els.btnCalOpen.href  = calHref;
    _undo = []; _redo = []; _updateHistoryButtons();
    _loadData();
  }

  // ── Incremental loader ────────────────────────────────────────────────────
  // 1. Metadata (machines, phases, shifts) — fast, blocking
  // 2. Render gantt skeleton — instant
  // 3. Stage 1: orders touching this week — fast, render gantt blocks
  // 4. Stage 2: unscheduled orders, paged 300 at a time, with setTimeout(0)
  //    yields between pages so the UI stays responsive
  // Big pages: every page is a full Worker → Soft1 → SQL round trip that re-sorts
  // the whole result (OFFSET), so fewer, larger pages are much faster.
  var UNSCHED_PAGE_SIZE = 1000;

  // Cancellation token: incremented each time we change weeks so an in-flight
  // page loader can abort if the user navigated away.
  var _loadToken = 0;

  async function _loadData() {
    _loadToken++;
    var myToken = _loadToken;

    _showLoading(true);
    _setLoadingMsg('Φόρτωση μηχανών και φάσεων…');

    try {
      // --- Step A: metadata + skeleton (small, fast) -----------------------
      // Run the three metadata queries in parallel — on the Worker these are
      // 3 independent HTTP calls so we save a round-trip of latency.
      var meta = await Promise.all([
        DataService.getMachines(),
        DataService.getPhaseMap(),
        DataService.getShifts(state.weekStart, state.weekEnd)
      ]);
      if (myToken !== _loadToken) return;

      state.machines      = meta[0];
      state.phaseMachines = meta[1].phaseMachines;
      state.machinePhases = meta[1].machinePhases;
      state.phaseNames    = meta[1].phaseNames;
      state.shifts        = meta[2];
      state.calendarExists = !(meta[2].programmeRows === 0);
      _updateCalBanner();

      var provs = _provisionalShiftsByWeek[_weekKey()] || [];
      provs.forEach(function (s) { state.shifts.push(s); });
      _rebuildWorkTime();
      _fillPhaseFilter();
      _fullyLoaded = false;

      state.machineById = {};
      state.machines.forEach(function (m) { state.machineById[m.id] = m; });

      state.orders        = [];
      state.orderById     = {};
      state.changedOrders = {};
      state.dirty         = false;

      _setLoadingMsg('Φόρτωση παραγγελιών εβδομάδας…');
      GanttRenderer.init(els.timeHeader, els.ganttBody, els.dropGhost, state);
      DragDropManager.init(els.ganttScroll, els.dropGhost);
      _renderUnscheduled();
      _renderIssues();
      _updateProvPill();
      _syncGanttHeaderScroll();

      // --- Step B: this-week orders ----------------------------------------
      var weekOrders = await DataService.getOrdersInWeek(state.weekStart, state.weekEnd);
      if (myToken !== _loadToken) return;
      _appendOrders(weekOrders);
      GanttRenderer.renderBlocks(state);
      DragDropManager.attachBlockListeners();
      _renderIssues();
      _loadProduction(myToken);        // background: rolls / produced qty for the orders shown

      // --- Step C: unscheduled orders (paged) ------------------------------
      _setLoadingMsg('Φόρτωση μη προγραμματισμένων… (0)');
      _loadUnscheduledPage(0, myToken);

      // --- Lazy: MTRL tree in background -----------------------------------
      DataService.getMtrlTree()
        .then(function (t) {
          if (myToken !== _loadToken) return;
          state.mtrlTree = t;
          _computeChain();
          GanttRenderer.renderBlocks(state);
          DragDropManager.attachBlockListeners();
          _renderIssues();
        })
        .catch(function (e) { console.warn('mtrlTree:', e); });

    } catch (e) {
      _showLoading(false);
      Soft1Bridge.warn('Σφάλμα φόρτωσης δεδομένων:\n' + (e.message || e));
      console.error(e);
    }
  }

  async function _loadUnscheduledPage(offset, myToken) {
    if (myToken !== _loadToken) return;
    var page;
    try {
      page = await DataService.getUnscheduledOrdersPage(offset, UNSCHED_PAGE_SIZE);
    } catch (e) {
      _showLoading(false);
      Soft1Bridge.warn('Σφάλμα φόρτωσης παραγγελιών:\n' + (e.message || e));
      return;
    }

    if (!page || !page.length) {
      _onLoadComplete();
      return;
    }

    _appendOrders(page);
    _setLoadingMsg('Φόρτωση μη προγραμματισμένων… (' + state.orders.length + ')');

    // Re-render the panel every page so the user sees data appearing
    _renderUnscheduled(els.orderSearch ? els.orderSearch.value : '');

    // Short page = that was the last one (saves an extra empty round trip)
    if (page.length < UNSCHED_PAGE_SIZE) {
      _onLoadComplete();
      return;
    }

    // Yield to the browser, then continue
    setTimeout(function () { _loadUnscheduledPage(offset + UNSCHED_PAGE_SIZE, myToken); }, 0);
  }

  // ── Production progress (CCCFXPRDOPRD) for the orders on this week's Gantt ──
  var _prodTimer = null;
  async function _loadProduction(myToken) {
    clearTimeout(_prodTimer);
    var wEnd = new Date(state.weekStart); wEnd.setDate(wEnd.getDate() + 7);
    var ids = state.orders.filter(function (o) {
      return o.plannedStart && o.plannedEnd && o.plannedEnd > state.weekStart && o.plannedStart < wEnd;
    }).map(function (o) { return o.id; });
    try {
      var prod = await DataService.getProduction(ids);
      if (myToken !== _loadToken) return;
      ids.forEach(function (id) { var o = state.orderById[id]; if (o) o._prod = prod[id] || null; });
      GanttRenderer.renderBlocks(state);
      DragDropManager.attachBlockListeners();
    } catch (e) {
      console.warn('production:', e);
    }
    _prodTimer = setTimeout(function () { if (myToken === _loadToken) _loadProduction(myToken); }, 5 * 60000);
  }

  function _onLoadComplete() {
    _setLoadingMsg('');
    _showLoading(false);
    _fullyLoaded = true;
    _computeChain();
    _rerender();
    _offerDraft();
  }

  function _appendOrders(rows) {
    for (var i = 0; i < rows.length; i++) {
      var o = rows[i];
      // De-dupe (week orders + unscheduled queries can theoretically overlap)
      if (state.orderById[o.id]) continue;
      state.orders.push(o);
      state.orderById[o.id] = o;
    }
  }

  function _setLoadingMsg(msg) {
    if (!els.loading) return;
    var label = els.loading.querySelector('.loading-label');
    if (!label) {
      label = document.createElement('div');
      label.className = 'loading-label';
      label.style.cssText = 'margin-top:14px;font-size:12px;color:#555;';
      els.loading.appendChild(label);
    }
    label.textContent = msg;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function _render() {
    _computeChain();
    GanttRenderer.init(els.timeHeader, els.ganttBody, els.dropGhost, state);
    GanttRenderer.renderBlocks(state);

    DragDropManager.init(els.ganttScroll, els.dropGhost);
    DragDropManager.attachBlockListeners();

    _renderUnscheduled();
    _renderIssues();
    _updateDirty();
    _syncGanttHeaderScroll();
  }

  function _rerender() {
    _computeChain();
    GanttRenderer.renderBlocks(state);
    DragDropManager.attachBlockListeners();
    _renderUnscheduled(els.orderSearch ? els.orderSearch.value : '');
    _renderIssues();
    _updateDirty();
  }

  // Lean re-render: rebuild only the gantt (skeleton + blocks). Used for zoom
  // where we don't want to also rebuild the 500-card unscheduled panel.
  function _renderGanttOnly() {
    GanttRenderer.init(els.timeHeader, els.ganttBody, els.dropGhost, state);
    GanttRenderer.renderBlocks(state);
    DragDropManager.attachBlockListeners();
  }

  // ── Unscheduled panel ─────────────────────────────────────────────────────
  function _filteredUnscheduled(filter) {
    var filterText = (filter != null ? filter : (els.orderSearch ? els.orderSearch.value : '')).toLowerCase().trim();
    var now = new Date();
    var from = _filters.from ? new Date(_filters.from + 'T00:00:00') : null;
    var to   = _filters.to   ? new Date(_filters.to   + 'T23:59:59') : null;
    var list = state.orders.filter(function (o) {
      if (o.status === 1 || o.plannedStart) return false;               // only truly unscheduled
      if (_filters.phase && String(o.phase) !== _filters.phase) return false;
      var hasDel = o.deliveryDate && o.deliveryDate.getFullYear() > 1970;
      if (from && (!hasDel || o.deliveryDate < from)) return false;
      if (to   && (!hasDel || o.deliveryDate > to))   return false;
      if (_filters.late && !(hasDel && o.deliveryDate < now)) return false;
      if (_filters.pre && !o._origMachineId) return false;
      if (filterText && o.id.toLowerCase().indexOf(filterText) < 0 &&
          (o.description || '').toLowerCase().indexOf(filterText) < 0 &&
          (_phaseShort(o.phase) || '').toLowerCase().indexOf(filterText) < 0) return false;
      return true;
    });
    var key = _filters.sort;
    function dv(o) { return o.deliveryDate ? +o.deliveryDate : Infinity; }
    list.sort(function (a, b) {
      if (key === 'deliv-desc')  return (dv(b) === Infinity ? -Infinity : dv(b)) - (dv(a) === Infinity ? -Infinity : dv(a));
      if (key === 'metres-desc') return (b.linearMetres || 0) - (a.linearMetres || 0);
      if (key === 'kilos-desc')  return (b.kilos || 0) - (a.kilos || 0);
      if (key === 'id-asc')      return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
      return dv(a) - dv(b);
    });
    return list;
  }

  function _renderUnscheduled(filter) {
    els.unscheduledList.innerHTML = '';
    var list  = _filteredUnscheduled(filter);
    var total = state.orders.filter(function (o) { return o.status !== 1 && !o.plannedStart; }).length;
    if (els.unschedCount) els.unschedCount.textContent = list.length === total ? String(total) : (list.length + ' / ' + total);
    if (els.btnFilters) els.btnFilters.classList.toggle('active', _filtersActive());

    var frag = document.createDocumentFragment();
    var now  = new Date();
    var MAX_RENDER = 500;   // cap; refine via search/filters to find more
    var n = Math.min(list.length, MAX_RENDER);

    for (var i = 0; i < n; i++) {
      var order = list[i];
      var color = GanttRenderer.orderColor(order.id);
      var hasDelivery = order.deliveryDate && order.deliveryDate.getFullYear() > 1970;
      var isOverdue   = hasDelivery && order.deliveryDate < now;

      var card = document.createElement('div');
      card.className = 'order-card';
      card.style.borderLeftColor = color;
      card.dataset.orderId = order.id;
      card.draggable = true;
      card.title = 'Σύρετε στο Gantt · κλικ για στοιχεία';

      var delivTxt  = hasDelivery ? _fmtDateShort(order.deliveryDate) : '—';
      var metresTxt = (order.linearMetres || 0).toLocaleString() + ' μ.';
      var kilosTxt  = (order.kilos || 0).toLocaleString() + ' κ.';

      var preTag = '';
      if (order.machineLocked && order.machineId && state.machineById[order.machineId]) {
        preTag = '<div class="card-pre" title="Δεσμευμένη μηχανή — μπαίνει μόνο εδώ">&#128205; ' + _esc(state.machineById[order.machineId].name) + ' (δεσμευμένη)</div>';
      } else if (order._origMachineId) {
        var preMachine = state.machineById[order._origMachineId];
        if (preMachine) preTag = SchedulerEngine.isPrinting(order.phase)
          ? '<div class="card-pre" title="Προτεινόμενη μηχανή — το Αυτόματο τη χρησιμοποιεί· μπορείτε να την αλλάξετε">&#128204; ' + _esc(preMachine.name) + ' (προτεινόμενη)</div>'
          : '<div class="card-pre">&#128204; ' + _esc(preMachine.name) + '</div>';
      }

      card.innerHTML =
        '<div class="card-id">' + _esc(order.id) + ' <span class="card-phase">' + _esc(_phaseShort(order.phase)) + '</span></div>' +
        '<div class="card-desc" title="' + _esc(order.description || '') + '">' + _esc(order.description || '') + '</div>' +
        '<div class="card-delivery' + (isOverdue ? ' overdue' : '') + '">&#128197; ' + delivTxt + '</div>' +
        '<div class="card-delivery" style="color:#444">&#128208; ' + metresTxt + ' &nbsp; &#9878;&#65039; ' + kilosTxt + '</div>' +
        preTag;
      frag.appendChild(card);
    }
    els.unscheduledList.appendChild(frag);

    if (list.length > n) {
      var more = document.createElement('div');
      more.style.cssText = 'padding:8px;font-size:11px;color:#888;text-align:center;font-style:italic;';
      more.textContent = '... ακόμα ' + (list.length - n) + ' παραγγελίες (φιλτράρετε για να βρείτε)';
      els.unscheduledList.appendChild(more);
    } else if (!list.length) {
      var none = document.createElement('div');
      none.style.cssText = 'padding:12px;font-size:12px;color:#888;text-align:center;';
      none.textContent = _fullyLoaded ? 'Καμία παραγγελία με αυτά τα κριτήρια' : 'Φόρτωση…';
      els.unscheduledList.appendChild(none);
    }

    DragDropManager.attachCardListeners();
  }

  function _filtersActive() {
    return !!(_filters.phase || _filters.from || _filters.to || _filters.late || _filters.pre);
  }

  function _fillPhaseFilter() {
    if (!els.fPhase) return;
    var cur = els.fPhase.value;
    var phases = Object.keys(state.phaseMachines).sort();
    els.fPhase.innerHTML = '<option value="">Όλες οι φάσεις</option>' + phases.map(function (p) {
      return '<option value="' + _esc(p) + '">' + _esc(_phaseLabel(p)) + '</option>';
    }).join('');
    els.fPhase.value = cur;
  }

  function _bindFilters() {
    if (!els.filterBox) return;
    els.btnFilters.addEventListener('click', function () { els.filterBox.hidden = !els.filterBox.hidden; });
    DateFmt.bind(els.fFrom); DateFmt.bind(els.fTo);
    function apply() {
      _filters.phase = els.fPhase.value;
      _filters.from  = DateFmt.euToIso(els.fFrom.value) || null;
      _filters.to    = DateFmt.euToIso(els.fTo.value) || null;
      _filters.late  = els.fLate.checked;
      _filters.pre   = els.fPre.checked;
      _filters.sort  = els.fSort.value;
      _renderUnscheduled();
    }
    [els.fPhase, els.fFrom, els.fTo, els.fLate, els.fPre, els.fSort].forEach(function (el) {
      el.addEventListener('change', apply);
    });
    els.fClear.addEventListener('click', function () {
      els.fPhase.value = ''; els.fFrom.value = ''; els.fTo.value = '';
      els.fLate.checked = false; els.fPre.checked = false; els.fSort.value = 'deliv-asc';
      apply();
    });
  }

  // ── Issue panel ────────────────────────────────────────────────────────────
  function _renderIssues() {
    els.issuePanel.innerHTML = '<div class="issue-header">&#9888; Προβλήματα προγράμματος</div>';

    var issues = [];
    SchedulerEngine.getConflicts(state.orders).forEach(function (pair) {
      // Emit one row per overlapping order so each can be individually rescued
      issues.push({ type: 'conflict', text: 'Επικάλυψη: ' + pair[0].id + ' με ' + pair[1].id, order: pair[0] });
      issues.push({ type: 'conflict', text: 'Επικάλυψη: ' + pair[1].id + ' με ' + pair[0].id, order: pair[1] });
    });
    SchedulerEngine.getDeadlineViolations(state.orders).forEach(function (o) {
      issues.push({ type: 'deadline', text: 'Υπέρβαση παράδοσης: ' + o.id, order: o });
    });
    Object.keys(state._chainViol || {}).forEach(function (id) {
      var o = state.orderById[id];
      if (o) issues.push({ type: 'chain', text: id + ': ' + state._chainViol[id], order: o });
    });

    if (issues.length === 0) {
      els.issuePanel.classList.remove('has-issues');
      return;
    }
    els.issuePanel.classList.add('has-issues');

    // De-dupe by orderId+type to avoid 4 lines for one mutual overlap
    var seen = {};
    issues.forEach(function (issue) {
      var key = issue.type + '|' + issue.order.id + '|' + issue.text;
      if (seen[key]) return;
      seen[key] = true;

      var item = document.createElement('div');
      item.className = 'issue-item ' + issue.type + '-issue';
      item.innerHTML = '<span class="issue-icon"></span>' +
                       '<span class="issue-text">' + _esc(issue.text) + '</span>' +
                       '<button class="issue-remove" title="Αφαίρεση από πρόγραμμα">&#10005;</button>';
      item.querySelector('.issue-text').addEventListener('click', function () {
        _jumpToOrder(issue.order);
      });
      item.querySelector('.issue-remove').addEventListener('click', function (e) {
        e.stopPropagation();
        if (issue.order.status === 1) {
          _toast('Η παραγγελία είναι κλειδωμένη — δεν αφαιρείται', 'error');
          return;
        }
        if (_lockBlocksRemove(issue.order)) return;
        _pushHistory();
        issue.order.machineId    = null;
        issue.order.plannedStart = null;
        issue.order.plannedEnd   = null;
        issue.order._skipSetup   = false;
        _markChanged(issue.order);
        _rerender();
        _toast(issue.order.id + ' επιστράφηκε στις μη προγραμματισμένες', 'warn');
      });
      els.issuePanel.appendChild(item);
    });
  }

  // ── Drop / drag callbacks ─────────────────────────────────────────────────
  function _bindGanttSync() {
    DragDropManager.on('validateDrop', function (data) {
      var order = state.orderById[data.drag.orderId];
      if (!order) return false;
      if (order.status === 1) return false;                                  // locked
      if (order.machineLocked && order.machineId && data.machineId !== order.machineId) return false;   // reserved machine
      var eligible = state.phaseMachines[order.phase] || [];
      return eligible.indexOf(data.machineId) >= 0;
    });

    // Dynamic duration based on target machine
    DragDropManager.on('computeDuration', function (data) {
      var order = state.orderById[data.orderId];
      var machine = state.machineById[data.machineId];
      if (!order || !machine) return 1;
      // Phase eligibility check
      var eligible = state.phaseMachines[order.phase] || [];
      if (eligible.indexOf(machine.id) < 0) return 1;
      if (data.preserveExisting && order._userOverridden && order.plannedStart && order.plannedEnd) {
        return (order.plannedEnd - order.plannedStart) / 3600000;
      }
      return DataService.computeDurationHours(order, machine);
    });

    // Shift-aware span: snaps to working time, skips non-shift gaps; magnet to the previous
    // block (≤ 30') and combined run (same item right after → no setup).
    DragDropManager.on('computeSpan', function (data) {
      return _computeSpan(data.orderId, data.machineId, data.start, data.preserveExisting);
    });

    DragDropManager.on('drop', function (data) {
      var order = state.orderById[data.orderId];
      if (!order) return;
      if (order.status === 1) { _toast('Η παραγγελία είναι κλειδωμένη', 'error'); return; }

      if (order.machineLocked && order.machineId && data.machineId !== order.machineId) {
        var rm = state.machineById[order.machineId];
        _toast('Δεσμευμένη μηχανή: η ' + order.id + ' μπαίνει μόνο στη ' + (rm ? rm.name : order.machineId), 'error');
        return;
      }
      if (order.dayLocked && order.plannedStart && _prodDay(data.plannedStart) !== _prodDay(order.plannedStart)) {
        _toast('Κλειδωμένη ημέρα: η ' + order.id + ' κινείται μόνο μέσα στην ' + _fmtDateShort(_prodDayDate(order.plannedStart)) + ' (06:00–06:00)', 'error');
        return;
      }
      var eligible = state.phaseMachines[order.phase] || [];
      if (eligible.indexOf(data.machineId) < 0) {
        _toast('Η μηχανή δεν ανήκει στη φάση ' + order.phase, 'error');
        return;
      }

      // Reject overlap with any other scheduled order on the same machine
      var startMs = data.plannedStart.getTime();
      var endMs   = data.plannedEnd.getTime();
      var collide = null;
      for (var i = 0; i < state.orders.length; i++) {
        var o = state.orders[i];
        if (o.id === data.orderId) continue;                          // ignore self (moves)
        if (o.machineId !== data.machineId) continue;
        if (!o.plannedStart || !o.plannedEnd) continue;
        if (o.plannedEnd.getTime() > startMs && o.plannedStart.getTime() < endMs) {
          collide = o; break;
        }
      }
      if (collide) {
        _toast('Επικάλυψη με ' + collide.id + ' (' + _fmtTime(collide.plannedStart) + '–' + _fmtTime(collide.plannedEnd) + ') — ακυρώθηκε', 'error');
        return;
      }

      var prefNote = '';
      if (!order.machineLocked && SchedulerEngine.isPrinting(order.phase) && order._origMachineId &&
          order._origMachineId !== data.machineId && state.machineById[order._origMachineId]) {
        prefNote = ' — άλλαξε από την προτεινόμενη ' + state.machineById[order._origMachineId].name;
      }
      _pushHistory();
      var keepOverride = order._userOverridden && order.machineId === data.machineId;
      order.machineId    = data.machineId;
      order.plannedStart = data.plannedStart;
      order.plannedEnd   = data.plannedEnd;
      if (data.span) {
        order._workMin   = data.span.workMin;
        order._skipSetup = !!data.span.skipSetup;
      }
      if (!keepOverride) order._userOverridden = false;
      _markChanged(order);
      _rerender();

      var machine = state.machineById[data.machineId];
      if (machine) {
        var br = DataService.durationBreakdown(order, machine);
        var msg = order.id + ' → ' + machine.name + ': ' + ((order._workMin || br.totalMin) / 60).toFixed(1) + ' εργάσιμες ώρες' +
                  (order._skipSetup ? ' (♻ συνδυασμός — χωρίς setup)' : ' (setup ' + br.setupMin + 'λ + παραγωγή ' +
                   Math.round(br.productionMin) + 'λ + αναμονή ' + br.waitMin + 'λ)');
        if (data.span && data.span.overflow) {
          _toast(msg + prefNote + ' — ⚠ ξεπερνά τις διαθέσιμες βάρδιες της εβδομάδας', 'warn');
        } else {
          _toast(msg + prefNote, prefNote ? 'warn' : 'success');
        }
      }
    });

    DragDropManager.on('resizeEnd', function (data) {
      var order = state.orderById[data.orderId];
      if (!order || order.status === 1) return;
      _pushHistory();
      var newEnd = new Date(order.plannedStart.getTime() + data.durationHours * 3600000);
      order.plannedEnd      = newEnd;
      order._userOverridden = true;
      order._workMin        = WorkTime.workBetween(order.machineId, order.plannedStart, newEnd) || Math.round(data.durationHours * 60);
      _markChanged(order);
      _rerender();
    });
  }

  // ── Context menu ──────────────────────────────────────────────────────────
  function _bindContextMenu() {
    DragDropManager.on('contextMenu', function (data) {
      var order = state.orderById[data.orderId];
      if (order && order.status === 1) return;   // no menu on locked
      _showContextMenu(data.x, data.y, data.orderId);
    });

    document.addEventListener('click', function () {
      els.contextMenu.classList.remove('visible');
    });

    els.contextMenu.querySelectorAll('li').forEach(function (li) {
      li.addEventListener('click', function (e) {
        e.stopPropagation();
        var action = li.dataset.action;
        var ctx = els.contextMenu._ctx;
        els.contextMenu.classList.remove('visible');
        _handleContextAction(action, ctx);
      });
    });
  }

  function _showContextMenu(x, y, orderId) {
    els.contextMenu._ctx = { orderId: orderId };
    var o = state.orderById[orderId], scheduled = !!(o && o.machineId && o.plannedStart);
    var liM = els.contextMenu.querySelector('[data-action="lock-machine"]');
    var liD = els.contextMenu.querySelector('[data-action="lock-day"]');
    if (liM) { liM.hidden = !scheduled; liM.innerHTML = o && o.machineLocked ? '&#128205; Αποδέσμευση μηχανής' : '&#128205; Δέσμευση μηχανής'; }
    if (liD) { liD.hidden = !scheduled; liD.innerHTML = o && o.dayLocked ? '&#128198; Ξεκλείδωμα ημέρας' : '&#128198; Κλείδωμα ημέρας'; }
    els.contextMenu.style.left = x + 'px';
    els.contextMenu.style.top  = y + 'px';
    els.contextMenu.classList.add('visible');
  }

  function _handleContextAction(action, ctx) {
    var order = state.orderById[ctx.orderId];
    if (!order) return;
    if (action === 'details') {
      var blk = document.querySelector('.gantt-block[data-order-id="' + CSS.escape(order.id) + '"]');
      if (blk && global.InfoCard) InfoCard.openOrder(order.id, blk);
      return;
    }
    if (action === 'toggle-setup') {
      if (!order.plannedStart || !order.machineId) return;
      var m = state.machineById[order.machineId];
      if (!m) return;
      _pushHistory();
      order._skipSetup = !order._skipSetup;
      order._userOverridden = false;
      order._workMin = DataService.computeWorkMinutes(order, m, order._skipSetup);
      order.plannedEnd = WorkTime.addWork(order.machineId, order.plannedStart, order._workMin).end;
      _markChanged(order);
      _rerender();
      _toast(order.id + (order._skipSetup ? ': χωρίς setup' : ': με setup'), 'success');
      return;
    }
    if (action === 'lock-machine' || action === 'lock-day') { _toggleLock(order, action === 'lock-machine' ? 'machine' : 'day'); return; }
    if (action === 'remove') {
      if (_lockBlocksRemove(order)) return;
      _pushHistory();
      order.machineId    = null;
      order.plannedStart = null;
      order.plannedEnd   = null;
      order._skipSetup   = false;
      _markChanged(order);
      _rerender();
      _toast('Επιστράφηκε στις μη προγραμματισμένες', 'warn');
    } else if (action === 'edit-duration') {
      if (!order.plannedStart) return;
      var currentH = WorkTime.workBetween(order.machineId, order.plannedStart, order.plannedEnd) / 60 ||
                     (order.plannedEnd - order.plannedStart) / 3600000;
      var input = prompt('Νέα διάρκεια σε εργάσιμες ώρες (μέσα σε βάρδιες):', currentH.toFixed(1));
      if (input === null) return;
      var hours = parseFloat(String(input).replace(',', '.'));
      if (isNaN(hours) || hours <= 0) { alert('Άκυρη τιμή'); return; }
      _pushHistory();
      order._workMin        = Math.round(hours * 60);
      order.plannedEnd      = WorkTime.addWork(order.machineId, order.plannedStart, order._workMin).end;
      order._userOverridden = true;
      _markChanged(order);
      _rerender();
    }
  }

  // ── Toolbar ───────────────────────────────────────────────────────────────
  function _bindToolbar() {
    els.btnPrevWeek.addEventListener('click', function () { _goWeek(-7); });
    els.btnNextWeek.addEventListener('click', function () { _goWeek(7); });
    if (els.btnPrint) els.btnPrint.addEventListener('click', function () { PrintView.open(state, _phaseLabel); });
    els.btnSave.addEventListener('click', _save);
    els.btnExport.addEventListener('click', function () { ExcelExporter.export(state); });
    els.btnAutoPlace.addEventListener('click', _autoPlace);
    els.btnZoomIn.addEventListener('click', function () {
      GanttRenderer.setZoom(GanttRenderer.pxPerHour() + 12); _renderGanttOnly();
    });
    els.btnZoomOut.addEventListener('click', function () {
      GanttRenderer.setZoom(GanttRenderer.pxPerHour() - 12); _renderGanttOnly();
    });
  }

  function _bindSearch() {
    els.orderSearch.addEventListener('input', function () {
      _renderUnscheduled(els.orderSearch.value);
    });
    els.orderSearch.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var q = els.orderSearch.value.trim().toLowerCase();
      if (!q) return;
      var hits = state.orders.filter(function (o) {
        return o.plannedStart && (o.id.toLowerCase() === q || o.id.toLowerCase().indexOf(q) >= 0 ||
               (o.description || '').toLowerCase().indexOf(q) >= 0);
      });
      hits.sort(function (a, b) { return (a.id.toLowerCase() === q ? 0 : 1) - (b.id.toLowerCase() === q ? 0 : 1); });
      if (hits.length) { _jumpToOrder(hits[0]); return; }
      var un = _filteredUnscheduled();
      _toast(un.length ? 'Δεν είναι στο Gantt — ' + un.length + ' μη προγραμματισμένες ταιριάζουν' : 'Δεν βρέθηκε στην εβδομάδα', 'warn');
    });
  }

  // ── Provisional-shift handling ────────────────────────────────────────────
  function _bindShiftBands() {
    els.ganttScroll.addEventListener('click', function (e) {
      var band = e.target;
      if (band.classList && band.classList.contains('no-shift-band')) {
        e.stopPropagation();
        _openShiftModal({
          date:      band.dataset.shiftDate,
          machineId: band.dataset.machineId
        });
      }
    });

    els.ganttScroll.addEventListener('contextmenu', function (e) {
      var band = e.target;
      if (band.classList && band.classList.contains('shift-band') && band.dataset.realShift) {
        e.preventDefault();
        e.stopPropagation();
        var m = state.machineById[band.dataset.machineId];
        if (!confirm('Αφαίρεση βάρδιας ' + band.dataset.realShift + ' (' + DateFmt.isoToEu(band.dataset.shiftDay) + ') της μηχανής ' +
                     (m ? m.name : band.dataset.machineId) + ' από το Soft1;')) return;
        _setSoft1Shifts(band.dataset.machineId, band.dataset.shiftDay, function (cur) {
          cur[+band.dataset.realShift - 1] = 0; return cur;
        });
        return;
      }
      if (band.classList && band.classList.contains('shift-band') && band.dataset.provisional === '1') {
        e.preventDefault();
        e.stopPropagation();
        if (confirm('Αφαίρεση προσωρινής βάρδιας ' + DateFmt.isoToEu(band.dataset.shiftDate) + ' ' + band.dataset.shiftStart + '–' + band.dataset.shiftEnd + ';')) {
          _removeProvisionalShift(band.dataset.shiftDate, band.dataset.shiftMachine, band.dataset.shiftStart, band.dataset.shiftEnd);
        }
      }
    });
  }

  function _bindShiftModal() {
    els.btnShiftCancel.addEventListener('click', _closeShiftModal);
    els.modalBackdrop.addEventListener('click', function (e) {
      if (e.target === els.modalBackdrop) _closeShiftModal();
    });
    els.btnShiftSave.addEventListener('click', function () {
      var mode = document.querySelector('input[name="shift-mode"]:checked');
      if (mode && mode.value === 'soft1') _saveSoft1ShiftFromModal();
      else _saveProvisionalShift();
    });
    document.querySelectorAll('input[name="shift-mode"]').forEach(function (r) {
      r.addEventListener('change', _syncShiftMode);
    });
    els.shiftDate.addEventListener('change', _prefillSoft1Checks);
    els.shiftMachine.addEventListener('change', _prefillSoft1Checks);
    if (els.btnProvConvert) els.btnProvConvert.addEventListener('click', _convertProvisionalToSoft1);

    if (els.provPill) {
      els.provPill.addEventListener('click', function () {
        var weekKey = _weekKey();
        var provs = _provisionalShiftsByWeek[weekKey] || [];
        if (!provs.length) return;
        if (confirm('Αφαίρεση και των ' + provs.length + ' προσωρινών βαρδιών;')) {
          _provisionalShiftsByWeek[weekKey] = [];
          _loadData();
        }
      });
    }
  }

  function _openShiftModal(prefill) {
    // Populate machine selector
    els.shiftMachine.innerHTML = '';
    state.machines.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id; opt.textContent = m.name + ' (φ. ' + m.phase + ')';
      els.shiftMachine.appendChild(opt);
    });
    DateFmt.bind(els.shiftDate);
    if (prefill && prefill.date)      els.shiftDate.value    = DateFmt.isoToEu(prefill.date);
    if (prefill && prefill.machineId) els.shiftMachine.value = prefill.machineId;
    if (!els.shiftStart.value) els.shiftStart.value = '06:00';
    if (!els.shiftEnd.value)   els.shiftEnd.value   = '14:00';
    _prefillSoft1Checks();
    _syncShiftMode();
    els.modalBackdrop.classList.add('visible');
  }

  function _closeShiftModal() {
    els.modalBackdrop.classList.remove('visible');
  }

  function _shiftDateIso() { return DateFmt.euToIso(els.shiftDate.value); }

  function _saveProvisionalShift() {
    var date  = _shiftDateIso();
    var mach  = els.shiftMachine.value;
    var start = els.shiftStart.value;
    var end   = els.shiftEnd.value;
    if (!date || !mach || !start || !end) { alert('Συμπληρώστε όλα τα πεδία (ημερομηνία ηη/μμ/εεεε)'); return; }
    if (start >= end) { alert('Η ώρα έναρξης πρέπει να είναι πριν την ώρα λήξης'); return; }

    var newShift = {
      date: date, machineId: mach, startTime: start, endTime: end,
      provisional: true, shiftNum: 0
    };
    var weekKey = _weekKey();
    if (!_provisionalShiftsByWeek[weekKey]) _provisionalShiftsByWeek[weekKey] = [];
    _provisionalShiftsByWeek[weekKey].push(newShift);
    state.shifts.push(newShift);
    _rebuildWorkTime();

    _closeShiftModal();
    _renderGanttOnly();
    _updateProvPill();
    _toast('Προσωρινή βάρδια προστέθηκε', 'warn');
  }

  function _removeProvisionalShift(date, machineId, start, end) {
    var weekKey = _weekKey();
    var arr = _provisionalShiftsByWeek[weekKey] || [];
    _provisionalShiftsByWeek[weekKey] = arr.filter(function (s) {
      return !(s.date === date && s.machineId === machineId && s.startTime === start && s.endTime === end);
    });
    state.shifts = state.shifts.filter(function (s) {
      if (!s.provisional) return true;
      return !(s.date === date && s.machineId === machineId && s.startTime === start && s.endTime === end);
    });
    _rebuildWorkTime();
    _renderGanttOnly();
    _updateProvPill();
  }

  function _updateProvPill() {
    if (!els.provPill) return;
    var n = (_provisionalShiftsByWeek[_weekKey()] || []).length;
    if (n > 0) { els.provPill.hidden = false; els.provCount.textContent = n; }
    else       { els.provPill.hidden = true; }
    if (els.btnProvConvert) els.btnProvConvert.hidden = !(n > 0);
  }

  function _weekKey() { return _fmtDateShort(state.weekStart); }

  // ── Sync header scroll ────────────────────────────────────────────────────
  function _syncGanttHeaderScroll() {
    var timeHeaderWrapper = document.getElementById('gantt-time-header-wrapper');
    if (!timeHeaderWrapper) return;
    els.ganttScroll.addEventListener('scroll', function () {
      timeHeaderWrapper.scrollLeft = els.ganttScroll.scrollLeft;
    });
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function _save() {
    var changed = state.orders.filter(function (o) { return state.changedOrders[o.id]; });
    if (!changed.length) { _toast('Δεν υπάρχουν αλλαγές για αποθήκευση', 'warn'); return; }

    _showLoading(true);
    try {
      var res = await DataService.saveOrders(changed);
      var failedIds = Object.keys(res.failed);
      changed.forEach(function (o) {
        if (res.failed[o.id]) return;                    // keep as changed → user can retry / resolve
        o._origMachineId = o.machineId;
        o._origStart     = o.plannedStart ? new Date(o.plannedStart) : null;
        o._origEnd       = o.plannedEnd   ? new Date(o.plannedEnd)   : null;
        delete state.changedOrders[o.id];
      });
      state.dirty = Object.keys(state.changedOrders).length > 0;
      _updateDirty();
      _saveDraftNow();
      if (!failedIds.length) {
        _undo = []; _redo = []; _updateHistoryButtons();
        _toast('Πρόγραμμα αποθηκεύτηκε επιτυχώς (' + (res.saved || changed.length) + ')', 'success');
      } else {
        var lines = failedIds.slice(0, 12).map(function (id) { return id + ': ' + res.failed[id]; }).join('\n');
        Soft1Bridge.warn('Αποθηκεύτηκαν ' + (res.saved || 0) + ', απέτυχαν ' + failedIds.length +
          (res.conflicts ? ' (' + res.conflicts + ' άλλαξαν από άλλο χρήστη — φορτώστε ξανά την εβδομάδα)' : '') +
          ':\n' + lines);
      }
    } catch (e) {
      _toast('Σφάλμα: ' + (e.message || e), 'error');
    } finally {
      _showLoading(false);
    }
  }

  // ── Auto-place (shift-aware, earliest delivery first, fastest finish) ──────
  var AUTO_AHEAD_WEEKS = 8;          // auto-place looks at most this many weeks after the visible one
  async function _autoPlace() {
    var candidates = _filteredUnscheduled();
    if (!candidates.length) { _toast('Δεν υπάρχουν μη προγραμματισμένες (με τα τρέχοντα φίλτρα)', 'warn'); return; }
    if (!confirm('Αυτόματη τοποθέτηση ' + candidates.length + ' παραγγελιών' +
                 (_filtersActive() || (els.orderSearch && els.orderSearch.value) ? ' (φιλτραρισμένες)' : '') +
                 ' στις διαθέσιμες βάρδιες της εβδομάδας;\nΌσες δεν χωράνε συνεχίζουν στις επόμενες εβδομάδες (έως ' + AUTO_AHEAD_WEEKS + ').' +
                 '\nΣειρά: νωρίτερη παράδοση πρώτα, μηχανή που τελειώνει νωρίτερα.' +
                 (state.calendarExists ? '' : '\n\nΗ εβδομάδα δεν έχει ημερολόγιο βαρδιών — θα δημιουργηθεί στο Soft1 από την προηγούμενη εβδομάδα.'))) return;

    // No CCCFXPCAL week → create it from the last existing week first, then plan on its shifts
    if (!state.calendarExists) {
      _showLoading(true);
      try {
        var r = await DataService.calendar('create', { monday: _fmtDate(state.weekStart), copy: 'previous' });
        if (r.success === false) throw new Error(r.error || 'Αποτυχία');
        await _reloadShifts();
        _toast('Δημιουργήθηκε η εβδομάδα ' + (r.code || '') + (r.copiedFrom ? ' από ' + r.copiedFrom : ''), 'success');
      } catch (e) {
        Soft1Bridge.warn('Δεν δημιουργήθηκε το ημερολόγιο της εβδομάδας — η αυτόματη τοποθέτηση ακυρώθηκε:\n' + (e.message || e));
        return;
      } finally { _showLoading(false); }
      if (!state.calendarExists) {
        Soft1Bridge.warn('Το ημερολόγιο δημιουργήθηκε αλλά δεν βρέθηκαν βάρδιες — ελέγξτε το στο Ημερολόγιο.');
        return;
      }
    }

    var now = new Date();
    var minStart = now > state.weekStart ? now : state.weekStart;
    var weekEnd = new Date(state.weekStart); weekEnd.setDate(weekEnd.getDate() + 7);
    var placements = SchedulerEngine.autoPlace(candidates, {
      orders: state.orders, machines: state.machines, phaseMachines: state.phaseMachines,
      weekStart: state.weekStart, weekEnd: weekEnd, minStart: minStart, chain: state._chain,
      workMinutes: function (o, m) { return DataService.computeWorkMinutes(o, m); }
    });
    _pushHistory();
    _applyPlacements(placements);
    var perWeek = [{ label: 'αυτή την εβδομάδα', n: placements.length }];
    var placedIds = {}; placements.forEach(function (p) { placedIds[p.order.id] = true; });
    var leftovers = candidates.filter(function (o) { return !placedIds[o.id]; });

    // What does not fit → the following weeks (their shifts + the orders already planned there).
    // A week without a CCCFXPCAL calendar → ask once, then create it (and later ones) from the last existing week.
    var created = [], stopReason = '';
    if (leftovers.length) {
      _showLoading(true);
      var allShifts = state.shifts.slice(), createOk = null;
      try {
        for (var k = 1; k <= AUTO_AHEAD_WEEKS && leftovers.length; k++) {
          var ws = new Date(state.weekStart); ws.setDate(ws.getDate() + 7 * k);
          var we = new Date(ws); we.setDate(we.getDate() + 7);
          var sun = new Date(ws); sun.setDate(sun.getDate() + 6);
          var label = 'εβδ. ' + _isoWeekNo(ws) + ' (' + _fmtDateShort(ws) + '–' + _fmtDateShort(sun) + ')';
          _setLoadingMsg('Αυτόματη τοποθέτηση: ' + label + '…');
          var sh = await DataService.getShifts(ws, sun);
          if (!sh.programmeRows) {
            if (createOk === null) {
              _showLoading(false);
              var prevWk = new Date(ws); prevWk.setDate(prevWk.getDate() - 7);
              createOk = confirm(leftovers.length + ' παραγγελίες δεν χωράνε έως την εβδομάδα ' + _isoWeekNo(prevWk) + '.\n\n' +
                'Η ' + label.replace('εβδ. ', 'εβδομάδα ') + ' δεν έχει ημερολόγιο βαρδιών στο Soft1.\n' +
                'Να δημιουργηθεί (και όσες ακόμα χρειαστούν) από την τελευταία εβδομάδα;');
              _showLoading(true);
            }
            if (!createOk) { stopReason = 'δεν δημιουργήθηκε ημερολόγιο για την ' + label; break; }
            var r = await DataService.calendar('create', { monday: _fmtDate(ws), copy: 'previous' });
            if (r.success === false) { stopReason = 'αποτυχία δημιουργίας ημερολογίου ' + label + ': ' + (r.error || ''); break; }
            created.push(String(r.code || _isoWeekNo(ws)));
            sh = await DataService.getShifts(ws, sun);
            if (!sh.programmeRows) { stopReason = 'το ημερολόγιο της ' + label + ' δεν έχει βάρδιες'; break; }
          }
          allShifts = allShifts.concat(sh);
          WorkTime.build(allShifts);
          // occupancy of that week: orders already planned there (not in the current view) + everything placed so far
          var there = await DataService.getOrdersInWeek(ws, sun);
          var occupancy = there.filter(function (o) { return !state.orderById[o.id]; }).concat(state.orders);
          var pl = SchedulerEngine.autoPlace(leftovers, {
            orders: occupancy, machines: state.machines, phaseMachines: state.phaseMachines,
            weekStart: ws, weekEnd: we, minStart: now > ws ? now : ws, chain: state._chain,
            workMinutes: function (o, m) { return DataService.computeWorkMinutes(o, m); }
          });
          _applyPlacements(pl);
          if (pl.length) perWeek.push({ label: label, n: pl.length });
          pl.forEach(function (p) { placedIds[p.order.id] = true; });
          leftovers = leftovers.filter(function (o) { return !placedIds[o.id]; });
        }
        if (leftovers.length && !stopReason) stopReason = 'δεν χώρεσαν μέσα σε ' + AUTO_AHEAD_WEEKS + ' εβδομάδες';
      } catch (e) {
        stopReason = 'σφάλμα: ' + (e.message || e);
      } finally {
        _rebuildWorkTime();                        // back to the visible week only
        _setLoadingMsg('');
        _showLoading(false);
      }
    }

    var total = Object.keys(placedIds).length;
    if (!total) { _undo.pop(); _updateHistoryButtons && _updateHistoryButtons(); }
    _rerender();
    var msg = 'Τοποθετήθηκαν ' + total + ' από ' + candidates.length + ' παραγγελίες' +
      (perWeek.length > 1 || perWeek[0].n !== total ? ': ' + perWeek.filter(function (w) { return w.n; })
        .map(function (w) { return w.label + ' ' + w.n; }).join(', ') : '') +
      (created.length ? '.\nΔημιουργήθηκαν ημερολόγια: ' + created.join(', ') : '') +
      (leftovers.length ? '.\nΔεν τοποθετήθηκαν ' + leftovers.length + ' (' + stopReason + ').' : '.') +
      (perWeek.length > 1 ? '\nΟι επόμενες εβδομάδες αποθηκεύονται με «Αποθήκευση»· δείτε τες με →.' : '');
    if (perWeek.length > 1 || leftovers.length || created.length) Soft1Bridge.warn(msg);
    else _toast(msg, total ? 'success' : 'warn');
  }

  function _applyPlacements(placements) {
    placements.forEach(function (p) {
      p.order.machineId    = p.machineId;
      p.order.plannedStart = p.plannedStart;
      p.order.plannedEnd   = p.plannedEnd;
      p.order._workMin     = p.workMin;
      p.order._skipSetup   = false;
      p.order._userOverridden = false;
      _markChanged(p.order);
    });
  }

  function _isoWeekNo(d) {
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
    var y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / 86400000 + 1) / 7);
  }

  // ── Shift-aware span for an order on a machine ───────────────────────────
  function _computeSpan(orderId, machineId, start, preserveExisting) {
    var order = state.orderById[orderId], machine = state.machineById[machineId];
    if (!order || !machine) return null;
    var MAGNET = 30 * 60000;
    // Previous block on this machine (closest end at/before the drop point + magnet)
    var prev = null;
    state.orders.forEach(function (o) {
      if (o === order || o.machineId !== machineId || !o.plannedEnd || !o.plannedStart) return;
      if (+o.plannedEnd <= +start + MAGNET && +o.plannedStart < +start && (!prev || o.plannedEnd > prev.plannedEnd)) prev = o;
    });
    var s0 = start, magnet = false;
    if (prev && Math.abs(+start - +prev.plannedEnd) <= MAGNET) { s0 = prev.plannedEnd; magnet = true; }
    var skipSetup = !!(magnet && prev.mtrl != null && String(prev.mtrl) === String(order.mtrl));
    var minutes = (preserveExisting && order._userOverridden && order.machineId === machineId && order._workMin)
      ? order._workMin
      : DataService.computeWorkMinutes(order, machine, skipSetup);
    var span = WorkTime.addWork(machineId, s0, minutes);
    span.workMin = minutes;
    span.skipSetup = skipSetup;
    return span;
  }

  function _rebuildWorkTime() { WorkTime.build(state.shifts); }

  // ── Phase chain ──────────────────────────────────────────────────────────
  function _computeChain() {
    state._chain = SchedulerEngine.buildChainIndex(state.orders, state.mtrlTree);
    state._chainViol = {};
    SchedulerEngine.getChainViolations(state.orders, state._chain).forEach(function (v) {
      state._chainViol[v.order.id] = 'ξεκινά πριν τελειώσει η προηγούμενη φάση ' + v.pred.id +
        ' (' + _fmtTime(v.pred.plannedEnd) + ' ' + _fmtDateShort(v.pred.plannedEnd) + ')';
    });
  }

  // ── Undo / redo ──────────────────────────────────────────────────────────
  function _snapshot() {
    var snap = [];
    state.orders.forEach(function (o) {
      if (o.machineId || o.plannedStart || state.changedOrders[o.id])
        snap.push([o.id, o.machineId, o.plannedStart ? +o.plannedStart : null, o.plannedEnd ? +o.plannedEnd : null,
                   !!o._userOverridden, o._workMin || null, !!o._skipSetup]);
    });
    return snap;
  }
  function _restore(snap) {
    var map = {};
    snap.forEach(function (r) { map[r[0]] = r; });
    state.orders.forEach(function (o) {
      if (o.status === 1) return;
      var r = map[o.id];
      o.machineId       = r ? r[1] : null;
      o.plannedStart    = r && r[2] ? new Date(r[2]) : null;
      o.plannedEnd      = r && r[3] ? new Date(r[3]) : null;
      o._userOverridden = r ? r[4] : false;
      o._workMin        = r ? r[5] : null;
      o._skipSetup      = r ? r[6] : false;
    });
    state.changedOrders = {};
    state.orders.forEach(function (o) { _markChanged(o, true); });
    state.dirty = Object.keys(state.changedOrders).length > 0;
    _updateDirty();
    _scheduleDraftSave();
    _rerender();
  }
  function _pushHistory() {
    _undo.push(_snapshot());
    if (_undo.length > 50) _undo.shift();
    _redo = [];
    _updateHistoryButtons();
  }
  function _doUndo() {
    if (!_undo.length) return;
    _redo.push(_snapshot()); _restore(_undo.pop()); _updateHistoryButtons();
    _toast('Αναίρεση', 'warn');
  }
  function _doRedo() {
    if (!_redo.length) return;
    _undo.push(_snapshot()); _restore(_redo.pop()); _updateHistoryButtons();
    _toast('Επανάληψη', 'warn');
  }
  function _updateHistoryButtons() {
    if (els.btnUndo) els.btnUndo.disabled = !_undo.length;
    if (els.btnRedo) els.btnRedo.disabled = !_redo.length;
  }
  function _bindHistory() {
    if (els.btnUndo) els.btnUndo.addEventListener('click', _doUndo);
    if (els.btnRedo) els.btnRedo.addEventListener('click', _doRedo);
  }

  // ── Draft autosave (localStorage, per user + week) ───────────────────────
  var _draftTimer = null;
  function _draftKey() { return 'pp-draft:' + (Soft1Bridge.user || '') + ':' + _fmtDate(state.weekStart); }
  function _scheduleDraftSave() {
    clearTimeout(_draftTimer);
    _draftTimer = setTimeout(_saveDraftNow, 800);
  }
  function _saveDraftNow() {
    clearTimeout(_draftTimer);
    try {
      var ids = Object.keys(state.changedOrders);
      if (!ids.length) { localStorage.removeItem(_draftKey()); return; }
      var changes = ids.map(function (id) {
        var o = state.orderById[id];
        return o ? [id, o.machineId, o.plannedStart ? +o.plannedStart : null, o.plannedEnd ? +o.plannedEnd : null,
                    !!o._userOverridden, o._workMin || null, !!o._skipSetup] : null;
      }).filter(Boolean);
      localStorage.setItem(_draftKey(), JSON.stringify({ ts: Date.now(), changes: changes }));
    } catch (e) { /* storage unavailable — ignore */ }
  }
  function _offerDraft() {
    var draft = null;
    try { draft = JSON.parse(localStorage.getItem(_draftKey()) || 'null'); } catch (e) { draft = null; }
    if (!draft || !draft.changes || !draft.changes.length) return;
    var when = new Date(draft.ts);
    if (!confirm('Βρέθηκε μη αποθηκευμένο πρόχειρο (' + draft.changes.length + ' αλλαγές, ' +
                 DateFmt.dt(when) + ').\nΕπαναφορά;')) {
      try { localStorage.removeItem(_draftKey()); } catch (e) {}
      return;
    }
    _pushHistory();
    var applied = 0, missing = 0;
    draft.changes.forEach(function (r) {
      var o = state.orderById[r[0]];
      if (!o || o.status === 1) { missing++; return; }
      o.machineId = r[1]; o.plannedStart = r[2] ? new Date(r[2]) : null; o.plannedEnd = r[3] ? new Date(r[3]) : null;
      o._userOverridden = r[4]; o._workMin = r[5]; o._skipSetup = r[6];
      _markChanged(o); applied++;
    });
    _rerender();
    _toast('Επαναφέρθηκαν ' + applied + ' αλλαγές' + (missing ? ' (' + missing + ' δεν βρέθηκαν)' : ''), 'success');
  }

  // ── Navigation ───────────────────────────────────────────────────────────
  function _confirmLeave() {
    if (!state.dirty) return true;
    _saveDraftNow();
    return confirm('Υπάρχουν μη αποθηκευμένες αλλαγές (κρατούνται ως πρόχειρο). Συνέχεια;');
  }
  function _goWeek(days) {
    if (!_confirmLeave()) return;
    var d = new Date(state.weekStart); d.setDate(d.getDate() + days);
    _setWeek(d);
  }
  function _bindNavigation() {
    if (els.btnToday) els.btnToday.addEventListener('click', function () {
      if (!_confirmLeave()) return;
      _setWeek(_getWeekStart(new Date()));
    });
    if (els.weekLabel && els.weekPicker) {
      els.weekLabel.addEventListener('click', function () {
        try { els.weekPicker.showPicker(); } catch (e) { els.weekPicker.focus(); }
      });
      els.weekPicker.addEventListener('change', function () {
        if (!els.weekPicker.value) return;
        if (!_confirmLeave()) { els.weekPicker.value = _fmtDate(state.weekStart); return; }
        _setWeek(_getWeekStart(new Date(els.weekPicker.value + 'T00:00:00')));
      });
    }
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if (els.modalBackdrop.classList.contains('visible')) return;
      if ((e.ctrlKey || e.metaKey) && !typing) {
        var k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); _doUndo(); return; }
        if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); _doRedo(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (state.dirty) _save(); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); _goWeek(-7); }
      if (e.key === 'ArrowRight') { e.preventDefault(); _goWeek(7); }
    });
  }

  // ── Search → jump to block ───────────────────────────────────────────────
  function _jumpToOrder(order) {
    if (!order || !order.plannedStart) return;
    var wEnd = new Date(state.weekStart); wEnd.setDate(wEnd.getDate() + 7);
    if (order.plannedStart >= wEnd || order.plannedEnd <= state.weekStart) {
      _toast(order.id + ' είναι σε άλλη εβδομάδα (' + _fmtDateShort(order.plannedStart) + ')', 'warn');
      return;
    }
    state._highlightId = order.id;
    GanttRenderer.renderBlocks(state);
    DragDropManager.attachBlockListeners();
    var blk = els.ganttScroll.querySelector('.gantt-block[data-order-id="' + CSS.escape(order.id) + '"]');
    if (blk) {
      var x = GanttRenderer.dateToX(order.plannedStart) + GanttRenderer.LABEL_WIDTH;
      els.ganttScroll.scrollLeft = Math.max(0, x - 200);
      blk.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    setTimeout(function () {
      if (state._highlightId !== order.id) return;
      state._highlightId = null;
      var b = els.ganttScroll.querySelector('.gantt-block.highlight');
      if (b) b.classList.remove('highlight');
    }, 4000);
  }

  // ── Session expiry warning ───────────────────────────────────────────────
  function _startSessionWatch() {
    if (!Soft1Bridge.isWeb || !els.sessionBanner) return;
    if (els.btnRelogin) els.btnRelogin.addEventListener('click', function () {
      _saveDraftNow();
      window.location.href = '/login.html';
    });
    function tick() {
      var exp = Soft1Bridge.expiresAt;
      if (!exp) return;
      var left = Math.round((exp - Date.now()) / 60000);
      if (left > 10) { els.sessionBanner.hidden = true; return; }
      els.sessionBanner.hidden = false;
      els.sessionText.textContent = left > 0
        ? 'Η σύνδεση λήγει σε ' + left + ' λεπτά — αποθηκεύστε τις αλλαγές σας.'
        : 'Η σύνδεση έληξε. Οι αλλαγές κρατήθηκαν ως πρόχειρο — συνδεθείτε ξανά για να συνεχίσετε.';
      if (left <= 0) _saveDraftNow();
    }
    tick();
    setInterval(tick, 30000);
  }

  // ── Production calendar (Soft1 CCCFXPCAL) ────────────────────────────────
  function _updateCalBanner() {
    if (els.calBanner) els.calBanner.hidden = state.calendarExists;
  }
  function _bindCalendarUi() {
    if (els.btnCalCreate) els.btnCalCreate.addEventListener('click', function () { _createCalendarWeek('previous'); });
    if (els.btnCalCreateEmpty) els.btnCalCreateEmpty.addEventListener('click', function () { _createCalendarWeek('none'); });
  }
  async function _createCalendarWeek(copy) {
    _showLoading(true);
    try {
      var r = await DataService.calendar('create', { monday: _fmtDate(state.weekStart), copy: copy });
      if (r.success === false) throw new Error(r.error || 'Αποτυχία');
      _toast('Δημιουργήθηκε η εβδομάδα ' + (r.code || '') + (r.copiedFrom ? ' (αντιγραφή από ' + r.copiedFrom + ')' : ''), 'success');
      await _reloadShifts();
    } catch (e) {
      Soft1Bridge.warn('Σφάλμα δημιουργίας ημερολογίου:\n' + (e.message || e));
    } finally { _showLoading(false); }
  }

  // Re-read only the shifts (keeps unsaved planner changes)
  async function _reloadShifts() {
    var sh = await DataService.getShifts(state.weekStart, state.weekEnd);
    state.calendarExists = !(sh.programmeRows === 0);
    (_provisionalShiftsByWeek[_weekKey()] || []).forEach(function (p) { sh.push(p); });
    state.shifts = sh;
    _rebuildWorkTime();
    _updateCalBanner();
    _renderGanttOnly();
    _renderIssues();
  }

  // Current Soft1 flags (21) of a machine for this week, from the loaded programme rows
  function _machineWeekFlags(machineId) {
    var f = []; for (var i = 0; i < 21; i++) f.push(0);
    state.shifts.forEach(function (s) {
      if (s.machineId !== machineId || !s.isProgrammeRow || s.isCarryOver) return;
      var day = Math.round((new Date(s.date + 'T00:00:00') - state.weekStart) / 86400000);
      if (day >= 0 && day < 7 && s.shiftNum >= 1 && s.shiftNum <= 3) f[day * 3 + s.shiftNum - 1] = 1;
    });
    return f;
  }

  // Apply fn(dayFlags[3]) → dayFlags to one machine/day and save to Soft1
  async function _setSoft1Shifts(machineId, dateStr, fn) {
    return _saveSoft1Changes([{ machineId: machineId, dateStr: dateStr, fn: fn }]);
  }

  async function _saveSoft1Changes(changes) {
    _showLoading(true);
    try {
      var monday = _fmtDate(state.weekStart);
      if (!state.calendarExists) {
        var c = await DataService.calendar('create', { monday: monday, copy: 'previous' });
        if (c.success === false) throw new Error(c.error || 'Αποτυχία δημιουργίας εβδομάδας');
        await _reloadShifts();
      }
      var byMachine = {};
      changes.forEach(function (ch) {
        var flags = byMachine[ch.machineId] || (byMachine[ch.machineId] = _machineWeekFlags(ch.machineId));
        var day = Math.round((new Date(ch.dateStr + 'T00:00:00') - state.weekStart) / 86400000);
        if (day < 0 || day > 6) return;
        var cur = flags.slice(day * 3, day * 3 + 3);
        var next = ch.fn(cur.slice());
        for (var k = 0; k < 3; k++) flags[day * 3 + k] = next[k] ? 1 : 0;
      });
      var lines = Object.keys(byMachine).map(function (mid) { return { rsrc: mid, s: byMachine[mid].join('') }; });
      if (!lines.length) return true;
      var r = await DataService.calendar('save', { monday: monday, lines: lines });
      if (r.success === false) throw new Error((r.errors || []).map(function (e) { return e.error; }).join('\n') || r.error);
      await _reloadShifts();
      _toast('Οι βάρδιες αποθηκεύτηκαν στο Soft1', 'success');
      return true;
    } catch (e) {
      Soft1Bridge.warn('Σφάλμα αποθήκευσης βαρδιών:\n' + (e.message || e));
      return false;
    } finally { _showLoading(false); }
  }

  function _syncShiftMode() {
    var mode = document.querySelector('input[name="shift-mode"]:checked');
    var soft1 = !mode || mode.value === 'soft1';
    if (els.shiftSoft1Box) els.shiftSoft1Box.hidden = !soft1;
    if (els.shiftProvBox)  els.shiftProvBox.hidden  = soft1;
  }
  function _prefillSoft1Checks() {
    if (!els.shiftS[0] || !_shiftDateIso() || !els.shiftMachine.value) return;
    var flags = _machineWeekFlags(els.shiftMachine.value);
    var day = Math.round((new Date(_shiftDateIso() + 'T00:00:00') - state.weekStart) / 86400000);
    for (var k = 0; k < 3; k++) els.shiftS[k].checked = day >= 0 && day < 7 && !!flags[day * 3 + k];
  }
  async function _saveSoft1ShiftFromModal() {
    var date = _shiftDateIso(), mach = els.shiftMachine.value;
    if (!date || !mach) { alert('Συμπληρώστε ημερομηνία (ηη/μμ/εεεε) και μηχανή'); return; }
    var day = Math.round((new Date(date + 'T00:00:00') - state.weekStart) / 86400000);
    if (day < 0 || day > 6) { alert('Η ημερομηνία πρέπει να είναι μέσα στην εμφανιζόμενη εβδομάδα'); return; }
    var want = els.shiftS.map(function (c) { return c.checked ? 1 : 0; });
    _closeShiftModal();
    await _setSoft1Shifts(mach, date, function () { return want; });
  }

  // Provisional shifts → Soft1 shift flags (06–14 → 1, 14–22 → 2, 22–06 → 3 of the starting day)
  async function _convertProvisionalToSoft1() {
    var provs = _provisionalShiftsByWeek[_weekKey()] || [];
    if (!provs.length) return;
    var changes = [];
    provs.forEach(function (p) {
      var a = _hm(p.startTime), b = _hm(p.endTime);
      var hits = [];
      if (a < 14 * 60 && b > 6 * 60)  hits.push({ d: p.date, n: 1 });
      if (a < 22 * 60 && b > 14 * 60) hits.push({ d: p.date, n: 2 });
      if (b > 22 * 60)                hits.push({ d: p.date, n: 3 });
      if (a < 6 * 60) {
        var prev = new Date(p.date + 'T00:00:00'); prev.setDate(prev.getDate() - 1);
        hits.push({ d: _fmtDate(prev), n: 3 });
      }
      hits.forEach(function (h) {
        changes.push({ machineId: p.machineId, dateStr: h.d, fn: function (cur) { cur[h.n - 1] = 1; return cur; } });
      });
    });
    if (!confirm('Μετατροπή ' + provs.length + ' προσωρινών βαρδιών σε κανονικές βάρδιες στο Soft1;')) return;
    var ok = await _saveSoft1Changes(changes);
    if (ok) {
      _provisionalShiftsByWeek[_weekKey()] = [];
      await _reloadShifts();
      _updateProvPill();
    }
  }
  function _hm(t) { var p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); }

  // ── Locks: reserved machine (FINDOC.BOOL01) / locked production day (FINDOC.BOOL02) ──
  // Production day = 06:00 → 06:00 (before 06:00 belongs to the previous day).
  function _prodDayDate(d) { var x = new Date(d.getTime() - 6 * 3600000); x.setHours(0, 0, 0, 0); return x; }
  function _prodDay(d) { return d ? _prodDayDate(d).getTime() : null; }
  function _minuteStr(d) {
    return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate()) + ' ' + _pad(d.getHours()) + ':' + _pad(d.getMinutes());
  }
  function _lockBlocksRemove(order) {
    if (order.machineLocked) { _toast('Δεσμευμένη μηχανή — αποδεσμεύστε πρώτα (δεξί κλικ)', 'error'); return true; }
    if (order.dayLocked)     { _toast('Κλειδωμένη ημέρα — ξεκλειδώστε πρώτα (δεξί κλικ)', 'error'); return true; }
    return false;
  }
  // Toggle a lock; written to Soft1 immediately together with the order's current machine + dates
  async function _toggleLock(order, kind) {
    if (order.status === 1) return;
    if (!order.machineId || !order.plannedStart || !order.plannedEnd) { _toast('Τοποθετήστε πρώτα την εντολή στο πρόγραμμα', 'warn'); return; }
    var ml = order.machineLocked ? 1 : 0, dl = order.dayLocked ? 1 : 0;
    if (kind === 'machine') ml = ml ? 0 : 1; else dl = dl ? 0 : 1;
    var body = { findoc: order.id, machineLock: ml, dayLock: dl,
                 start: _minuteStr(order.plannedStart), end: _minuteStr(order.plannedEnd) };
    if (ml) body.machine = order.machineId;
    try {
      await Soft1Bridge.orderLocks(body);
    } catch (e) { _toast('Αποτυχία: ' + (e.message || e), 'error'); return; }
    order.machineLocked = !!ml;
    order.dayLocked     = !!dl;
    // dates (and the machine when reserving) are now in Soft1 → new baseline for this order
    order._origStart = new Date(order.plannedStart);
    order._origEnd   = new Date(order.plannedEnd);
    if (ml) order._origMachineId = order.machineId;
    _markChanged(order);
    _rerender();
    var mname = (state.machineById[order.machineId] || {}).name || order.machineId;
    _toast(kind === 'machine'
      ? (ml ? order.id + ': δεσμεύτηκε στη ' + mname : order.id + ': αποδεσμεύτηκε η μηχανή')
      : (dl ? order.id + ': κλειδώθηκε στην ' + _fmtDateShort(_prodDayDate(order.plannedStart)) : order.id + ': ξεκλειδώθηκε η ημέρα'), 'success');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _markChanged(order, quiet) {
    // Detect if values differ from baseline
    var changed = (order.machineId !== order._origMachineId)
      || _datesDiffer(order.plannedStart, order._origStart)
      || _datesDiffer(order.plannedEnd,   order._origEnd);
    if (changed) {
      state.changedOrders[order.id] = true;
      state.dirty = true;
    } else {
      delete state.changedOrders[order.id];
    }
    if (quiet) return;
    state.dirty = Object.keys(state.changedOrders).length > 0;
    _updateDirty();
    _scheduleDraftSave();
  }

  function _datesDiffer(a, b) {
    if (!a && !b) return false;
    if (!a || !b) return true;
    return a.getTime() !== b.getTime();
  }

  function _updateDirty() {
    if (els.unsavedBanner) {
      if (state.dirty) els.unsavedBanner.classList.add('visible');
      else             els.unsavedBanner.classList.remove('visible');
    }
    if (els.btnSave) els.btnSave.disabled = !state.dirty;
  }

  function _scrollToOrder(order) {
    if (!order || !order.plannedStart) return;
    var x = GanttRenderer.dateToX(order.plannedStart) + GanttRenderer.LABEL_WIDTH;
    els.ganttScroll.scrollLeft = Math.max(0, x - 200);
  }

  function _showLoading(show) {
    if (!els.loading) return;
    if (show) els.loading.classList.add('visible');
    else      els.loading.classList.remove('visible');
  }

  var _toastTimer = null;
  function _toast(msg, type) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.className   = 'visible ' + (type || '');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () {
      els.toast.classList.remove('visible');
    }, 3500);
  }

  function _fmtTime(d) {
    if (!d) return '';
    return _pad(d.getHours()) + ':' + _pad(d.getMinutes());
  }

  function _fmtDateShort(d) {
    if (!d) return '';
    return _pad(d.getDate()) + '/' + _pad(d.getMonth() + 1) + '/' + d.getFullYear();
  }
  function _pad(n) { return n < 10 ? '0' + n : String(n); }
  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else                                    init();

  global.UIController = { state: state };

})(window);
