/* GanttRenderer — builds and updates the Gantt chart DOM
   Exposes: GanttRenderer.init(container, state), .renderBlocks(state),
   .updateHeaders(state), .setZoom(pxPerHour)                                 */
(function (global) {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────
  // Full 24-hour day to support up to 3 shifts (Morning / Afternoon / Night)
  var DAY_START_HOUR  = 0;
  var DAY_END_HOUR    = 24;
  var DAY_HOURS       = DAY_END_HOUR - DAY_START_HOUR;
  var HOUR_LABEL_STEP = 2;      // show hour label every N hours to avoid clutter
  var ROW_HEIGHT      = 52;     // px — keep in sync with CSS .gantt-machine-row min-height
  var UTIL_HEIGHT     = 20;     // px — keep in sync with CSS .gantt-util-row height
  var LABEL_WIDTH     = 140;    // px — keep in sync with CSS

  var pxPerHour = 24;           // default; changed by setZoom() — at 24h × 24px = 576px/day

  // ── Color palette for orders ──────────────────────────────────────────────
  var PALETTE = [
    '#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f',
    '#edc948','#b07aa1','#ff9da7','#9c755f','#2ca02c',
    '#17becf','#bcbd22','#d62728','#9467bd','#8c564b'
  ];
  var orderColorMap = {};
  var colorIndex    = 0;

  function orderColor(orderId) {
    if (!orderColorMap[orderId]) {
      orderColorMap[orderId] = PALETTE[colorIndex % PALETTE.length];
      colorIndex++;
    }
    return orderColorMap[orderId];
  }

  // ── Date / pixel helpers ──────────────────────────────────────────────────
  var WEEK_DAYS = 7;   // Mon–Sun, availability driven by per-machine shift programme
  function dayWidth() { return DAY_HOURS * pxPerHour; }
  function totalWidth() { return WEEK_DAYS * dayWidth(); }

  // Returns x pixel for a Date within the 5-day timeline
  function dateToX(d, weekStart) {
    var dayIndex = Math.round((d - weekStart) / 86400000);
    // clamp to 0-4
    dayIndex = Math.max(0, Math.min(WEEK_DAYS - 1, dayIndex));
    var hours = (d.getHours() - DAY_START_HOUR) + d.getMinutes() / 60;
    return dayIndex * dayWidth() + hours * pxPerHour;
  }

  // Returns Date for a given x pixel and weekStart
  function xToDate(x, weekStart) {
    var dIdx  = Math.floor(x / dayWidth());
    var remPx = x - dIdx * dayWidth();
    var hours = remPx / pxPerHour;
    var d = new Date(weekStart);
    d.setDate(d.getDate() + dIdx);
    d.setHours(DAY_START_HOUR + Math.floor(hours));
    d.setMinutes(Math.round((hours % 1) * 60));
    d.setSeconds(0); d.setMilliseconds(0);
    return d;
  }

  // Snap to 30-minute grid
  function snapDate(d) {
    var mins = d.getMinutes();
    var snapped = Math.round(mins / 30) * 30;
    var r = new Date(d);
    if (snapped >= 60) { r.setHours(r.getHours() + 1); r.setMinutes(0); }
    else               { r.setMinutes(snapped); }
    r.setSeconds(0); r.setMilliseconds(0);
    return r;
  }

  // Format date as "HH:MM"
  function fmtTime(d) {
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function fmtDateShort(d) {
    var days = ['Κυρ','Δευ','Τρι','Τετ','Πεμ','Παρ','Σαβ'];
    return days[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth() + 1);
  }

  // ── DOM refs ──────────────────────────────────────────────────────────────
  var _timeHeaderEl  = null;   // #gantt-time-header
  var _bodyEl        = null;   // #gantt-body
  var _machineRows   = {};     // machineId -> .gantt-timeline element
  var _utilCells     = {};     // machineId -> { Mon: el, Tue: el, ... }
  var _dropGhost     = null;
  var _weekStart     = null;

  // ── Public API ────────────────────────────────────────────────────────────
  var GanttRenderer = {

    pxPerHour: function () { return pxPerHour; },

    init: function (timeHeaderEl, bodyEl, dropGhostEl, state) {
      _timeHeaderEl = timeHeaderEl;
      _bodyEl       = bodyEl;
      _dropGhost    = dropGhostEl;
      _weekStart    = state.weekStart;
      orderColorMap = {};
      colorIndex    = 0;
      // Pre-assign colors in order index order for consistency
      state.orders.forEach(function (o) { orderColor(o.id); });

      _buildHeader(state);
      _buildBody(state);
    },

    renderBlocks: function (state) {
      _weekStart = state.weekStart;
      // Remove all existing blocks
      Object.keys(_machineRows).forEach(function (mid) {
        var tl = _machineRows[mid];
        var blocks = tl.querySelectorAll('.gantt-block');
        blocks.forEach(function (b) { tl.removeChild(b); });
      });

      var weekEnd = new Date(_weekStart);
      weekEnd.setDate(weekEnd.getDate() + WEEK_DAYS);
      var scheduledOrders = state.orders.filter(function (o) {
        if (!o.machineId || !o.plannedStart || !o.plannedEnd) return false;
        // Only render orders whose planned window touches the visible week
        return o.plannedEnd > _weekStart && o.plannedStart < weekEnd;
      });

      // Conflict + deadline lookup sets
      var conflictSet = {};
      var deadlineSet = {};
      SchedulerEngine.getConflicts(state.orders).forEach(function (pair) {
        conflictSet[pair[0].id] = true;
        conflictSet[pair[1].id] = true;
      });
      SchedulerEngine.getDeadlineViolations(state.orders).forEach(function (o) {
        deadlineSet[o.id] = true;
      });

      scheduledOrders.forEach(function (order) {
        var tl = _machineRows[order.machineId];
        if (!tl) return;

        var x = dateToX(order.plannedStart, _weekStart);
        var durationHours = (order.plannedEnd - order.plannedStart) / 3600000;
        var w = Math.max(12, durationHours * pxPerHour);

        var el = document.createElement('div');
        el.className = 'gantt-block';
        el.dataset.orderId   = order.id;
        el.dataset.machineId = order.machineId;

        var locked = (order.status === 1);
        if (locked)                  el.classList.add('locked');
        if (conflictSet[order.id])   el.classList.add('conflict');
        if (deadlineSet[order.id])   el.classList.add('deadline-violation');
        if (order._origMachineId && order._origMachineId !== order.machineId)
          el.classList.add('reassigned');
        if (order._skipSetup)                        el.classList.add('combined');
        if (state._chainViol && state._chainViol[order.id]) el.classList.add('chain-violation');
        if (state._highlightId === order.id)         el.classList.add('highlight');

        var color = orderColor(order.id);
        el.style.left            = x + 'px';
        el.style.width           = w + 'px';
        el.style.backgroundColor = color;
        if (locked) el.style.opacity = '0.6';

        var lockBadge = locked ? '<span class="lock-icon" title="Ολοκληρωμένη — κλειδωμένη">&#128274;</span>' : '';
        var preBadge  = (!locked && order._origMachineId === order.machineId)
                          ? '<span class="pre-pin" title="Προ-ανατεθειμένη μηχανή">&#128204;</span>' : '';
        if (order._skipSetup) preBadge += '<span class="combo-badge" title="Συνδυασμός παραγωγής — χωρίς setup">&#9851;</span>';
        if (state._chainViol && state._chainViol[order.id])
          preBadge += '<span class="chain-badge" title="' + _esc(state._chainViol[order.id]) + '">&#8645;</span>';

        el.innerHTML =
          '<div class="block-inner">' +
            lockBadge + preBadge +
            '<span class="block-id">' + _esc(order.id) + '</span>' +
            (w > 80 ? '<span class="block-hours">' + durationHours.toFixed(1) + 'ω</span>' : '') +
          '</div>' +
          '<div class="deadline-marker"></div>' +
          (locked ? '' : '<div class="resize-handle" title="Αλλαγή διάρκειας"></div>');

        // Tooltip with breakdown
        var tipExtra = '';
        var machine = state.machines.find(function (m) { return m.id === order.machineId; });
        if (machine && DataService && DataService.durationBreakdown) {
          var br = DataService.durationBreakdown(order, machine);
          tipExtra = '\n\nΜηχανή: ' + machine.name +
                     '\nΤαχ.: ' + machine.averageSpeed + ' μ/λ' +
                     '\n• Setup:    ' + br.setupMin + ' λ' +
                     '\n• Παραγωγή: ' + Math.round(br.productionMin) + ' λ (' + (order.linearMetres || 0) + ' μ)' +
                     '\n• Αναμονή:  ' + br.waitMin + ' λ';
        }
        var workTxt = '';
        if (global.WorkTime) {
          var wm = WorkTime.workBetween(order.machineId, order.plannedStart, order.plannedEnd);
          workTxt = ' (εργάσιμες ' + (wm / 60).toFixed(1) + 'ω)';
        }
        if (order._skipSetup) tipExtra += '\n♻ Συνδυασμός με προηγούμενη — χωρίς setup';
        if (state._chainViol && state._chainViol[order.id]) tipExtra += '\n⇅ ' + state._chainViol[order.id];
        el.title = (locked ? '🔒 ' : '') + order.id + ' — ' + (order.description || '') +
                   '\n' + fmtTime(order.plannedStart) + ' – ' + fmtTime(order.plannedEnd) +
                   '\nΔιάρκεια: ' + durationHours.toFixed(1) + ' ώρες' + workTxt + tipExtra +
                   '\n(κλικ για στοιχεία)';

        el.draggable = !locked;
        tl.appendChild(el);
      });

      var util;
      if (global.WorkTime) {
        var detail = WorkTime.utilisation(state.orders, state.machines, _weekStart, WEEK_DAYS);
        util = {};
        Object.keys(detail).forEach(function (mid) {
          util[mid] = {};
          Object.keys(detail[mid]).forEach(function (d) { util[mid][d] = detail[mid][d].pct; });
        });
        _renderHeatStrips(detail, state);
      } else {
        util = SchedulerEngine.getMachineUtilisation(state.orders, state.shifts, state.machines);
      }
      _renderUtilBars(util, state);
    },

    updateHeaders: function (state) {
      _weekStart = state.weekStart;
      _buildHeader(state);
    },

    setZoom: function (newPxPerHour) {
      pxPerHour = Math.max(20, Math.min(120, newPxPerHour));
    },

    // Returns Date for a drop position within the gantt scroll area
    xToDate: function (x) { return xToDate(x, _weekStart); },
    snapDate: snapDate,
    dateToX: function (d) { return dateToX(d, _weekStart); },
    dayWidth: dayWidth,
    totalWidth: totalWidth,

    orderColor: orderColor,
    DAY_START_HOUR: DAY_START_HOUR,
    DAY_END_HOUR:   DAY_END_HOUR,
    LABEL_WIDTH:    LABEL_WIDTH,
    ROW_HEIGHT:     ROW_HEIGHT
  };

  // ── Build time header ─────────────────────────────────────────────────────
  function _buildHeader(state) {
    _timeHeaderEl.innerHTML = '';
    var today = _fmtDate(new Date());

    for (var d = 0; d < WEEK_DAYS; d++) {
      var dayDate = new Date(state.weekStart);
      dayDate.setDate(dayDate.getDate() + d);
      var isToday = _fmtDate(dayDate) === today;

      var dayEl = document.createElement('div');
      dayEl.className = 'gantt-day-header';
      dayEl.style.width = dayWidth() + 'px';
      dayEl.style.minWidth = dayWidth() + 'px';

      var titleEl = document.createElement('div');
      titleEl.className = 'gantt-day-title' + (isToday ? ' today' : '');
      titleEl.textContent = fmtDateShort(dayDate);
      dayEl.appendChild(titleEl);

      var hoursEl = document.createElement('div');
      hoursEl.className = 'gantt-hours-row';
      for (var h = DAY_START_HOUR; h < DAY_END_HOUR; h++) {
        var tick = document.createElement('div');
        tick.className = 'gantt-hour-tick';
        // Label only every Nth hour to avoid clutter on a 24-h day
        tick.textContent = (h % HOUR_LABEL_STEP === 0) ? pad(h) : '';
        tick.style.width = pxPerHour + 'px';
        tick.style.minWidth = tick.style.width;
        hoursEl.appendChild(tick);
      }
      dayEl.appendChild(hoursEl);
      _timeHeaderEl.appendChild(dayEl);
    }
  }

  // ── Build gantt body (machine rows) ───────────────────────────────────────
  function _buildBody(state) {
    _bodyEl.innerHTML = '';
    _machineRows = {};
    _utilCells   = {};

    // Group machines by their primary phase (for visual sectioning).
    // Note: a machine may be eligible for additional phases via SPCOSTGROUP;
    // grouping here is purely cosmetic.
    var groups   = {};
    var groupOrder = [];
    state.machines.forEach(function (m) {
      var grp = m.phase || 'Γενική';
      if (!groups[grp]) { groups[grp] = []; groupOrder.push(grp); }
      groups[grp].push(m);
    });

    groupOrder.forEach(function (grpName) {
      var machines = groups[grpName];

      // Phase group header — use phaseNames map if present
      var hdr = document.createElement('div');
      hdr.className = 'gantt-phase-group-header';
      hdr.style.minWidth = (LABEL_WIDTH + totalWidth()) + 'px';
      var label = (state.phaseNames && state.phaseNames[grpName])
        ? state.phaseNames[grpName] + '  (φάση ' + grpName + ')'
        : 'Φάση ' + grpName;
      hdr.innerHTML = '&#9654; ' + _esc(label);
      _bodyEl.appendChild(hdr);

      // Machine rows
      machines.forEach(function (machine) {
        var row = document.createElement('div');
        row.className = 'gantt-machine-row';
        row.style.height = ROW_HEIGHT + 'px';

        // Label
        var label = document.createElement('div');
        label.className = 'gantt-machine-label';
        label.dataset.machineId = machine.id;
        label.innerHTML = '<span title="Στοιχεία μηχανής — ' + _esc(machine.name) + '">' + _esc(machine.name) + '</span>';
        row.appendChild(label);

        // Timeline
        var tl = document.createElement('div');
        tl.className = 'gantt-timeline';
        tl.dataset.machineId = machine.id;
        tl.dataset.phase     = machine.phase;
        tl.style.width       = totalWidth() + 'px';
        tl.style.height      = ROW_HEIGHT + 'px';

        _addGridLines(tl, state);
        row.appendChild(tl);
        _bodyEl.appendChild(row);
        _machineRows[machine.id] = tl;
      });

      // Utilisation row
      var utilRow = document.createElement('div');
      utilRow.className = 'gantt-util-row';

      var utilLabel = document.createElement('div');
      utilLabel.className = 'gantt-util-label';
      utilLabel.textContent = 'Χρησιμ.';
      utilRow.appendChild(utilLabel);

      var utilBars = document.createElement('div');
      utilBars.className = 'gantt-util-bars';
      _utilCells[grpName] = {};

      for (var d = 0; d < WEEK_DAYS; d++) {
        var dayDate = new Date(state.weekStart);
        dayDate.setDate(dayDate.getDate() + d);

        var cell = document.createElement('div');
        cell.className = 'util-day-cell';
        cell.style.width    = dayWidth() + 'px';
        cell.style.minWidth = dayWidth() + 'px';
        cell.style.position = 'relative';

        var fill = document.createElement('div');
        fill.className = 'util-bar-fill';
        fill.style.width = '0%';
        cell.appendChild(fill);

        var pct = document.createElement('span');
        pct.style.position = 'relative';
        pct.style.zIndex   = '1';
        pct.textContent    = '0%';
        cell.appendChild(pct);

        cell._fill = fill;
        cell._pct  = pct;
        _utilCells[grpName][d] = cell;
        utilBars.appendChild(cell);
      }

      utilRow.appendChild(utilBars);
      _bodyEl.appendChild(utilRow);
    });
  }

  // ── Add background gridlines and shift bands ──────────────────────────────
  function _addGridLines(tl, state) {
    var machineId = tl.dataset.machineId;
    var today = _fmtDate(new Date());

    for (var d = 0; d < WEEK_DAYS; d++) {
      var dayDate = new Date(state.weekStart);
      dayDate.setDate(dayDate.getDate() + d);
      var dateStr = _fmtDate(dayDate);
      var dayX    = d * dayWidth();

      // Day separator line
      var dayLine = document.createElement('div');
      dayLine.className = 'gantt-day-line';
      dayLine.style.left = dayX + 'px';
      tl.appendChild(dayLine);

      // Collect ALL shifts for this MACHINE on this day
      var dayShifts = [];
      if (state.shifts) {
        state.shifts.forEach(function (s) {
          if (s.date === dateStr && s.machineId === machineId) dayShifts.push(s);
        });
      }

      if (dayShifts.length === 0) {
        // No shifts — entire day is unavailable
        _addGapBand(tl, dayX, dayWidth(), machineId, dateStr);
      } else {
        // Sort by startTime so coverage gaps render as no-shift bands
        dayShifts.sort(function (a, b) { return _timeToPx(a.startTime) - _timeToPx(b.startTime); });

        var cursorPx = 0;
        dayShifts.forEach(function (sh, idx) {
          var sPx = _timeToPx(sh.startTime);
          var ePx = _timeToPx(sh.endTime);
          if (ePx <= sPx) return;

          // Gap before this shift
          if (sPx > cursorPx) {
            _addGapBand(tl, dayX + cursorPx, sPx - cursorPx, machineId, dateStr);
          }

          // Shift band — use shiftNum if available, else position index
          var sNum = sh.shiftNum || (idx + 1);
          var band = document.createElement('div');
          band.className = 'shift-band shift-' + sNum + (sh.provisional ? ' provisional' : '');
          band.style.left  = (dayX + sPx) + 'px';
          band.style.width = (ePx - sPx) + 'px';
          band.title = (sh.provisional ? 'Προσωρινή ' : '') +
                       'Βάρδια ' + sNum + ': ' + sh.startTime + '–' + sh.endTime +
                       (sh.provisional ? '\n(δεξί κλικ για αφαίρεση)' : '');
          if (!sh.provisional && sh.isProgrammeRow) {
            // Real Soft1 shift — right-click removes it from CCCFXPCAL. Carry-over 00–06 belongs to the previous day's shift 3.
            var progDay = sh.date;
            if (sh.isCarryOver) {
              var pd = new Date(sh.date + 'T00:00:00'); pd.setDate(pd.getDate() - 1); progDay = _fmtDate(pd);
            }
            band.dataset.realShift  = String(sh.shiftNum);
            band.dataset.machineId  = sh.machineId;
            band.dataset.shiftDay   = progDay;
            band.title += '\n(δεξί κλικ: αφαίρεση από Soft1)';
          }
          if (sh.provisional) {
            band.dataset.provisional = '1';
            band.dataset.shiftDate   = sh.date;
            band.dataset.shiftMachine = sh.machineId;
            band.dataset.shiftStart  = sh.startTime;
            band.dataset.shiftEnd    = sh.endTime;
          }
          tl.appendChild(band);

          cursorPx = Math.max(cursorPx, ePx);
        });

        // Gap after last shift
        if (cursorPx < dayWidth()) {
          _addGapBand(tl, dayX + cursorPx, dayWidth() - cursorPx, machineId, dateStr);
        }
      }

      // Hour gridlines within each day (lighter for non-labeled hours)
      for (var h = 0; h < DAY_HOURS; h++) {
        var line = document.createElement('div');
        line.className = 'gantt-hour-line';
        if (h % HOUR_LABEL_STEP !== 0) line.style.opacity = '0.4';
        line.style.left = (dayX + h * pxPerHour) + 'px';
        tl.appendChild(line);
      }
    }

    // "Now" line
    var now = new Date();
    var nowKey = _fmtDate(now);
    var wStart = state.weekStart;
    var wEnd   = new Date(wStart); wEnd.setDate(wEnd.getDate() + 4);
    if (now >= wStart && now <= wEnd) {
      var nowX = dateToX(now, wStart);
      var nowLine = document.createElement('div');
      nowLine.className = 'gantt-now-line';
      nowLine.style.left  = nowX + 'px';
      nowLine.title = 'Τώρα';
      tl.appendChild(nowLine);
    }
  }

  // Add a clickable no-shift band that lets the user add a provisional shift
  function _addGapBand(tl, leftPx, widthPx, machineId, dateStr) {
    var band = document.createElement('div');
    band.className = 'no-shift-band';
    band.style.left  = leftPx + 'px';
    band.style.width = widthPx + 'px';
    band.dataset.machineId = machineId;
    band.dataset.shiftDate = dateStr;
    band.dataset.gapStartPx = (leftPx % dayWidth());
    band.dataset.gapWidthPx = widthPx;
    tl.appendChild(band);
  }

  // Convert "HH:MM" time string to px offset within a day
  function _timeToPx(t) {
    if (!t) return 0;
    var parts = String(t).split(':');
    var totalHours = parseInt(parts[0], 10) + (parseInt(parts[1], 10) || 0) / 60;
    return (totalHours - DAY_START_HOUR) * pxPerHour;
  }

  // ── Daily load heatmap strip at the bottom of every machine row ─────────
  function _renderHeatStrips(detail, state) {
    Object.keys(_machineRows).forEach(function (mid) {
      var tl = _machineRows[mid];
      tl.querySelectorAll('.heat-cell').forEach(function (c) { c.remove(); });
      for (var d = 0; d < WEEK_DAYS; d++) {
        var day = new Date(state.weekStart); day.setDate(day.getDate() + d);
        var u = detail[mid] && detail[mid][_fmtDate(day)];
        if (!u || (!u.avail && !u.sched)) continue;
        var c = document.createElement('div');
        c.className = 'heat-cell ' + (u.pct > 100 ? 'h-over' : u.pct >= 85 ? 'h-high' : u.pct >= 50 ? 'h-mid' : u.pct > 0 ? 'h-low' : 'h-zero');
        c.style.left  = (d * dayWidth()) + 'px';
        c.style.width = dayWidth() + 'px';
        c.title = 'Φόρτος ' + fmtDateShort(day) + ': ' + u.pct + '% (' + (u.sched / 60).toFixed(1) + ' / ' + (u.avail / 60).toFixed(1) + ' ώρες)';
        tl.appendChild(c);
      }
    });
  }

  // ── Render utilisation bars (per phase group, max across machines) ────────
  function _renderUtilBars(util, state) {
    var groupUtil = {};
    state.machines.forEach(function (m) {
      var grp = m.phase || 'Γενική';
      if (!groupUtil[grp]) groupUtil[grp] = {};
      for (var d = 0; d < WEEK_DAYS; d++) {
        var dayDate = new Date(state.weekStart);
        dayDate.setDate(dayDate.getDate() + d);
        var dateStr = _fmtDate(dayDate);
        var pct = (util[m.id] && util[m.id][dateStr]) ? util[m.id][dateStr] : 0;
        if (!groupUtil[grp][d] || pct > groupUtil[grp][d]) groupUtil[grp][d] = pct;
      }
    });
    Object.keys(_utilCells).forEach(function (grp) {
      for (var d = 0; d < WEEK_DAYS; d++) {
        var cell = _utilCells[grp][d];
        if (!cell) continue;
        var pct = (groupUtil[grp] && groupUtil[grp][d]) ? groupUtil[grp][d] : 0;
        cell._fill.style.width = Math.min(100, pct) + '%';
        cell._pct.textContent  = pct + '%';
        cell.className = 'util-day-cell';
        if (pct > 100) cell.classList.add('over-100');
        else if (pct > 80) cell.classList.add('over-80');
      }
    });
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function _blockKey(b) { return b.orderId + '|' + b.phaseNo; }

  function _esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _fmtDate(d) {
    return d.getFullYear() + '-' +
      (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1) + '-' +
      (d.getDate() < 10 ? '0' : '') + d.getDate();
  }

  global.GanttRenderer = GanttRenderer;

})(window);
