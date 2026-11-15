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
    dirty:          false
  };

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
    els.btnLogout       = document.getElementById('btn-logout');

    if (Soft1Bridge.isMock && els.mockBanner) els.mockBanner.style.display = 'block';

    // Logout button only exists in web mode
    if (Soft1Bridge.isWeb && els.btnLogout) {
      els.btnLogout.style.display = '';
      els.btnLogout.title = 'Αποσύνδεση (' + (Soft1Bridge.user || '') + ')';
      els.btnLogout.addEventListener('click', function () {
        if (state.dirty && !confirm('Υπάρχουν μη αποθηκευμένες αλλαγές. Αποσύνδεση;')) return;
        Soft1Bridge.logout();
      });
    }

    _setWeek(_getWeekStart(new Date()));

    _bindToolbar();
    _bindSearch();
    _bindContextMenu();
    _bindGanttSync();
    _bindShiftBands();
    _bindShiftModal();

    window.addEventListener('beforeunload', function (e) {
      if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
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
    var months = ['Ιαν','Φεβ','Μαρ','Απρ','Μαΐ','Ιουν','Ιουλ','Αυγ','Σεπ','Οκτ','Νοε','Δεκ'];
    return days[weekStart.getDay()] + ' ' + weekStart.getDate() + ' ' + months[weekStart.getMonth()] +
           ' – ' + days[weekEnd.getDay()] + ' ' + weekEnd.getDate() + ' ' + months[weekEnd.getMonth()] +
           ' ' + weekEnd.getFullYear();
  }
  function _setWeek(newStart) {
    state.weekStart = newStart;
    state.weekEnd   = _getWeekEnd(newStart);
    if (els.weekLabel) els.weekLabel.textContent = _weekLabel(state.weekStart, state.weekEnd);
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

      var provs = _provisionalShiftsByWeek[_weekKey()] || [];
      provs.forEach(function (s) { state.shifts.push(s); });

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

      // --- Step C: unscheduled orders (paged) ------------------------------
      _setLoadingMsg('Φόρτωση μη προγραμματισμένων… (0)');
      _loadUnscheduledPage(0, myToken);

      // --- Lazy: MTRL tree in background -----------------------------------
      DataService.getMtrlTree()
        .then(function (t) { if (myToken === _loadToken) state.mtrlTree = t; })
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
      _setLoadingMsg('');
      _showLoading(false);
      _renderUnscheduled();
      return;
    }

    _appendOrders(page);
    _setLoadingMsg('Φόρτωση μη προγραμματισμένων… (' + state.orders.length + ')');

    // Re-render the panel every page so the user sees data appearing
    _renderUnscheduled(els.orderSearch ? els.orderSearch.value : '');

    // Short page = that was the last one (saves an extra empty round trip)
    if (page.length < UNSCHED_PAGE_SIZE) {
      _setLoadingMsg('');
      _showLoading(false);
      return;
    }

    // Yield to the browser, then continue
    setTimeout(function () { _loadUnscheduledPage(offset + UNSCHED_PAGE_SIZE, myToken); }, 0);
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
  function _renderUnscheduled(filter) {
    els.unscheduledList.innerHTML = '';
    var filterText = (filter || '').toLowerCase();

    var unscheduled = state.orders.filter(function (o) {
      if (o.status === 1) return false;                                    // completed → never unscheduled
      if (!o.plannedStart) return true;                                    // truly unscheduled
      // Has a planned start — only "unscheduled here" if it falls outside this week
      // AND we don't show those either (planner navigates to that week to find them).
      return false;
    });

    // Build into a fragment for batch insertion (1500 cards × appendChild = slow)
    var frag = document.createDocumentFragment();
    var now  = new Date();
    var rendered = 0;
    var MAX_RENDER = 500;   // cap initial render; refine via search to find more

    for (var i = 0; i < unscheduled.length && rendered < MAX_RENDER; i++) {
      var order = unscheduled[i];
      if (filterText && order.id.toLowerCase().indexOf(filterText) < 0 &&
          (order.description || '').toLowerCase().indexOf(filterText) < 0 &&
          (_phaseShort(order.phase) || '').toLowerCase().indexOf(filterText) < 0) continue;

      var color = GanttRenderer.orderColor(order.id);
      var hasDelivery = order.deliveryDate && order.deliveryDate.getFullYear() > 1970;
      var isOverdue   = hasDelivery && order.deliveryDate < now;

      var card = document.createElement('div');
      card.className = 'order-card';
      card.style.borderLeftColor = color;
      card.dataset.orderId = order.id;
      card.draggable = true;

      var delivTxt  = hasDelivery ? _fmtDateShort(order.deliveryDate) : '—';
      var metresTxt = (order.linearMetres || 0).toLocaleString() + ' μ.';
      var kilosTxt  = (order.kilos || 0).toLocaleString() + ' κ.';

      var preTag = '';
      if (order._origMachineId) {
        var preMachine = state.machineById[order._origMachineId];
        if (preMachine) preTag = '<div class="card-pre">&#128204; ' + _esc(preMachine.name) + '</div>';
      }

      card.innerHTML =
        '<div class="card-id">' + _esc(order.id) + ' <span class="card-phase">' + _esc(_phaseShort(order.phase)) + '</span></div>' +
        '<div class="card-desc" title="' + _esc(order.description || '') + '">' + _esc(order.description || '') + '</div>' +
        '<div class="card-delivery' + (isOverdue ? ' overdue' : '') + '">&#128197; ' + delivTxt + '</div>' +
        '<div class="card-delivery" style="color:#444">&#128208; ' + metresTxt + ' &nbsp; &#9878;&#65039; ' + kilosTxt + '</div>' +
        preTag;

      frag.appendChild(card);
      rendered++;
    }
    els.unscheduledList.appendChild(frag);

    // Hint if list was capped
    if (unscheduled.length > rendered) {
      var more = document.createElement('div');
      more.style.cssText = 'padding:8px;font-size:11px;color:#888;text-align:center;font-style:italic;';
      more.textContent = '... ακόμα ' + (unscheduled.length - rendered) + ' παραγγελίες (φιλτράρετε για να βρείτε)';
      els.unscheduledList.appendChild(more);
    }

    DragDropManager.attachCardListeners();
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
        _scrollToOrder(issue.order);
      });
      item.querySelector('.issue-remove').addEventListener('click', function (e) {
        e.stopPropagation();
        if (issue.order.status === 1) {
          _toast('Η παραγγελία είναι κλειδωμένη — δεν αφαιρείται', 'error');
          return;
        }
        issue.order.machineId    = null;
        issue.order.plannedStart = null;
        issue.order.plannedEnd   = null;
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

    DragDropManager.on('drop', function (data) {
      var order = state.orderById[data.orderId];
      if (!order) return;
      if (order.status === 1) { _toast('Η παραγγελία είναι κλειδωμένη', 'error'); return; }

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

      order.machineId    = data.machineId;
      order.plannedStart = data.plannedStart;
      order.plannedEnd   = data.plannedEnd;
      _markChanged(order);
      _rerender();

      var machine = state.machineById[data.machineId];
      if (machine) {
        var br = DataService.durationBreakdown(order, machine);
        _toast(order.id + ' → ' + machine.name + ': ' +
               (br.totalMin / 60).toFixed(1) + 'ω (setup ' + br.setupMin +
               'λ + παραγωγή ' + Math.round(br.productionMin) + 'λ + αναμονή ' + br.waitMin + 'λ)', 'success');
      }
    });

    DragDropManager.on('resizeEnd', function (data) {
      var order = state.orderById[data.orderId];
      if (!order || order.status === 1) return;
      var newEnd = new Date(order.plannedStart.getTime() + data.durationHours * 3600000);
      order.plannedEnd      = newEnd;
      order._userOverridden = true;
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
    els.contextMenu.style.left = x + 'px';
    els.contextMenu.style.top  = y + 'px';
    els.contextMenu.classList.add('visible');
  }

  function _handleContextAction(action, ctx) {
    var order = state.orderById[ctx.orderId];
    if (!order) return;
    if (action === 'remove') {
      order.machineId    = null;
      order.plannedStart = null;
      order.plannedEnd   = null;
      _markChanged(order);
      _rerender();
      _toast('Επιστράφηκε στις μη προγραμματισμένες', 'warn');
    } else if (action === 'edit-duration') {
      if (!order.plannedStart) return;
      var currentH = (order.plannedEnd - order.plannedStart) / 3600000;
      var input = prompt('Νέα διάρκεια (ώρες):', currentH.toFixed(1));
      if (input === null) return;
      var hours = parseFloat(input);
      if (isNaN(hours) || hours <= 0) { alert('Άκυρη τιμή'); return; }
      hours = Math.round(hours * 2) / 2;
      order.plannedEnd      = new Date(order.plannedStart.getTime() + hours * 3600000);
      order._userOverridden = true;
      _markChanged(order);
      _rerender();
    }
  }

  // ── Toolbar ───────────────────────────────────────────────────────────────
  function _bindToolbar() {
    els.btnPrevWeek.addEventListener('click', function () {
      if (state.dirty && !confirm('Υπάρχουν μη αποθηκευμένες αλλαγές. Συνέχεια;')) return;
      var prev = new Date(state.weekStart);
      prev.setDate(prev.getDate() - 7);
      _setWeek(prev);
    });
    els.btnNextWeek.addEventListener('click', function () {
      if (state.dirty && !confirm('Υπάρχουν μη αποθηκευμένες αλλαγές. Συνέχεια;')) return;
      var next = new Date(state.weekStart);
      next.setDate(next.getDate() + 7);
      _setWeek(next);
    });
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
      if (band.classList && band.classList.contains('shift-band') && band.dataset.provisional === '1') {
        e.preventDefault();
        e.stopPropagation();
        if (confirm('Αφαίρεση προσωρινής βάρδιας ' + band.dataset.shiftStart + '–' + band.dataset.shiftEnd + ';')) {
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
    els.btnShiftSave.addEventListener('click', _saveProvisionalShift);

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
    if (prefill && prefill.date)      els.shiftDate.value    = prefill.date;
    if (prefill && prefill.machineId) els.shiftMachine.value = prefill.machineId;
    if (!els.shiftStart.value) els.shiftStart.value = '06:00';
    if (!els.shiftEnd.value)   els.shiftEnd.value   = '14:00';
    els.modalBackdrop.classList.add('visible');
  }

  function _closeShiftModal() {
    els.modalBackdrop.classList.remove('visible');
  }

  function _saveProvisionalShift() {
    var date  = els.shiftDate.value;
    var mach  = els.shiftMachine.value;
    var start = els.shiftStart.value;
    var end   = els.shiftEnd.value;
    if (!date || !mach || !start || !end) { alert('Συμπληρώστε όλα τα πεδία'); return; }
    if (start >= end) { alert('Η ώρα έναρξης πρέπει να είναι πριν την ώρα λήξης'); return; }

    var newShift = {
      date: date, machineId: mach, startTime: start, endTime: end,
      provisional: true, shiftNum: 0
    };
    var weekKey = _weekKey();
    if (!_provisionalShiftsByWeek[weekKey]) _provisionalShiftsByWeek[weekKey] = [];
    _provisionalShiftsByWeek[weekKey].push(newShift);
    state.shifts.push(newShift);

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
    _renderGanttOnly();
    _updateProvPill();
  }

  function _updateProvPill() {
    if (!els.provPill) return;
    var n = (_provisionalShiftsByWeek[_weekKey()] || []).length;
    if (n > 0) { els.provPill.hidden = false; els.provCount.textContent = n; }
    else       { els.provPill.hidden = true; }
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
      var ok = await DataService.saveOrders(changed);
      if (ok) {
        changed.forEach(function (o) {
          o._origMachineId = o.machineId;
          o._origStart     = o.plannedStart ? new Date(o.plannedStart) : null;
          o._origEnd       = o.plannedEnd   ? new Date(o.plannedEnd)   : null;
        });
        state.changedOrders = {};
        state.dirty = false;
        _updateDirty();
        _toast('Πρόγραμμα αποθηκεύτηκε επιτυχώς', 'success');
      } else {
        _toast('Σφάλμα κατά την αποθήκευση', 'error');
      }
    } catch (e) {
      _toast('Σφάλμα: ' + (e.message || e), 'error');
    } finally {
      _showLoading(false);
    }
  }

  // ── Auto-place ────────────────────────────────────────────────────────────
  function _autoPlace() {
    var placed = 0;
    state.orders.forEach(function (order) {
      if (order.status === 1) return;
      if (order.machineId && order.plannedStart && order.plannedEnd) return;

      var slot = SchedulerEngine.findFirstAvailableSlot(
        order, state.machines, state.orders, state.shifts, state.weekStart,
        state.phaseMachines,
        function (machine) { return DataService.computeDurationHours(order, machine); }
      );
      if (!slot) return;

      order.machineId    = slot.machineId;
      order.plannedStart = slot.plannedStart;
      order.plannedEnd   = slot.plannedEnd;
      _markChanged(order);
      placed++;
    });

    if (placed > 0) {
      _rerender();
      _toast('Τοποθετήθηκαν αυτόματα ' + placed + ' παραγγελίες', 'success');
    } else {
      _toast('Δεν βρέθηκαν διαθέσιμες θέσεις', 'warn');
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _markChanged(order) {
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
    _updateDirty();
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
