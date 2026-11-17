/* DataService — all SQL lives here. Order-centric model:
   each FINDOC = one production order = one production phase = one Gantt block. */
(function (global) {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // SHIFT TIME DEFAULTS — swap to per-row STARTTIME/ENDTIME when Soft1 model
  // is upgraded with those columns.
  // ═══════════════════════════════════════════════════════════════════════════
  var SHIFT_TIMES = {
    1: { start: '06:00', end: '14:00' },   // Πρωινή
    2: { start: '14:00', end: '22:00' },   // Απογευματινή
    3: { start: '22:00', end: '24:00' }    // Νυχτερινή (carry-over 00:00–06:00 added on next day)
  };
  var NIGHT_CARRY_END = '06:00';   // shift 3 spills into next day until this time

  // All SQL lives in soft1/Foxline.planning.js — this file only calls datasets by name
  // (Soft1Bridge.dataset → /api/data → Foxline.planning/<name>).

  // ─── Helpers ───────────────────────────────────────────────────────────────
  function _pad(n) { return n < 10 ? '0' + n : String(n); }
  function _fmtDate(d) {
    return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate());
  }
  function _fmtDateTime(d) {
    return _fmtDate(d) + ' ' + _pad(d.getHours()) + ':' + _pad(d.getMinutes()) + ':00';
  }
  function _parseDate(v) {
    if (!v) return null;
    if (v instanceof Date) {
      return (v.getFullYear() < 1990) ? null : v;   // treat 1970-epoch / 1899 / 1900 as null
    }
    var d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return (d.getFullYear() < 1990) ? null : d;
  }
  function _addDays(d, n) {
    var r = new Date(d); r.setDate(r.getDate() + n); return r;
  }

  // Map a raw row (mock object or Soft1 dataset row) to the internal order shape.
  function _mapOrderRows(rows) {
    var out = new Array(rows.length);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var start = r.plannedStart || r.plannedStartDataTime;
      var end   = r.plannedEnd   || r.plannedFinishDataTime;
      var startD = (start instanceof Date) ? start : _parseDate(start);
      var endD   = (end   instanceof Date) ? end   : _parseDate(end);
      // Reject 1970-epoch null dates already handled by _parseDate
      var machineId = r.machine || r.machineId || null;
      out[i] = {
        id:            String(r.id),
        fincode:       r.fincode != null ? String(r.fincode) : '',
        description:   String(r.description || ''),
        deliveryDate:  (r.deliveryDate instanceof Date) ? (_parseDate(r.deliveryDate)) : _parseDate(r.deliveryDate),
        kilos:         parseFloat(r.kilos)        || 0,
        linearMetres:  parseFloat(r.linearMetres) || 0,
        status:        parseInt(r.status, 10),
        phase:         String(r.phase || ''),
        machineId:     machineId ? String(machineId) : null,
        plannedStart:  startD,
        plannedEnd:    endD,
        mtrl:          r.mtrl || null,
        salesOrderRef: r.salesOrderRef || null,
        _origMachineId: machineId ? String(machineId) : null,
        _origStart:     startD ? new Date(startD) : null,
        _origEnd:       endD   ? new Date(endD)   : null,
        _userOverridden: false
      };
    }
    return out;
  }

  // Truthy check for Soft1 boolean field (1, '1', true, 'Y')
  function _flag(v) {
    if (v === null || v === undefined || v === '') return false;
    var s = String(v).trim().toUpperCase();
    return s === '1' || s === 'TRUE' || s === 'Y' || s === 'YES' || parseInt(s, 10) > 0;
  }

  // ─── DataService ───────────────────────────────────────────────────────────
  var DataService = {

    // ── Machines ───────────────────────────────────────────────────────────
    getMachines: async function () {
      if (Soft1Bridge.isMock) {
        return Soft1Bridge.mockData.machines.map(function (r) {
          return {
            id:           String(r.id),
            name:         r.name,
            phase:        String(r.phase),
            setupTime:    r.setupTime,
            waitTime:     r.waitTime,
            averageSpeed: r.averageSpeed
          };
        });
      }
      var rows = await Soft1Bridge.dataset('GetMachines');
      return rows.map(function (r) {
        return {
          id:           String(r.id),
          name:         String(r.name || r.id),
          phase:        String(r.phase || ''),
          setupTime:    parseFloat(r.setuptime) || 0,
          waitTime:     parseFloat(r.waittime)  || 0,
          averageSpeed: parseFloat(r.average_speed_in_metres_per_minute) || 0
        };
      });
    },

    // ── Phase-machine eligibility map ──────────────────────────────────────
    // Returns { phaseMachines, machinePhases, phaseNames }
    getPhaseMap: async function () {
      var rows;
      if (Soft1Bridge.isMock) {
        rows = Soft1Bridge.mockData.phaseMachines;
      } else {
        rows = await Soft1Bridge.dataset('GetPhaseMachines');
      }
      var phaseMachines = {};
      var machinePhases = {};
      var phaseNames    = {};
      rows.forEach(function (r) {
        var phase = String(r.phase);
        var mach  = String(r.machine);
        var name  = r.phaseName || r.phasename || r.PHASENAME;
        if (name) phaseNames[phase] = String(name);
        if (!phaseMachines[phase]) phaseMachines[phase] = [];
        if (!machinePhases[mach])  machinePhases[mach]  = [];
        if (phaseMachines[phase].indexOf(mach) < 0) phaseMachines[phase].push(mach);
        if (machinePhases[mach].indexOf(phase) < 0) machinePhases[mach].push(phase);
      });
      return { phaseMachines: phaseMachines, machinePhases: machinePhases, phaseNames: phaseNames };
    },

    // ── Production orders ──────────────────────────────────────────────────
    // STAGE 1: load only orders touching the visible week (small set, fast)
    getOrdersInWeek: async function (weekStart, weekEnd) {
      if (Soft1Bridge.isMock) {
        var rows = Soft1Bridge.mockData.productionOrders.filter(function (r) {
          if (!r.plannedStart && !r.plannedEnd) return false;
          var s = r.plannedStart || r.plannedEnd;
          var e = r.plannedEnd   || r.plannedStart;
          return e >= weekStart && s <= weekEnd;
        });
        return _mapOrderRows(rows);
      }
      var rows = await Soft1Bridge.dataset('GetOrdersInWeek', { weekStart: _fmtDate(weekStart), weekEnd: _fmtDate(weekEnd) });
      return _mapOrderRows(rows);
    },

    // STAGE 2: paged unscheduled orders (DATE01 IS NULL). Returns up to pageSize rows.
    getUnscheduledOrdersPage: async function (offset, pageSize) {
      if (Soft1Bridge.isMock) {
        var all = Soft1Bridge.mockData.productionOrders.filter(function (r) {
          return r.status !== 1 && !r.plannedStart;
        });
        return _mapOrderRows(all.slice(offset, offset + pageSize));
      }
      var rows = await Soft1Bridge.dataset('GetUnscheduledOrders', { offset: offset, pageSize: pageSize });
      return _mapOrderRows(rows);
    },

    // (legacy, used as a fallback only)
    getProductionOrders: async function (weekStart, weekEnd) {
      if (Soft1Bridge.isMock) return _mapOrderRows(Soft1Bridge.mockData.productionOrders);
      var rows = await Soft1Bridge.dataset('GetProductionOrders', { weekStart: _fmtDate(weekStart), weekEnd: _fmtDate(weekEnd) });
      return _mapOrderRows(rows);
    },

    // ── Shifts (per machine, per day, exploded from CCCFXPCAL) ─────────────
    getShifts: async function (weekStart, weekEnd) {
      var monIso = _fmtDate(weekStart);
      var rows;
      if (Soft1Bridge.isMock) {
        rows = _mockShiftRows(weekStart);
      } else {
        rows = await Soft1Bridge.dataset('GetShifts', { monday: monIso });
      }
      var shifts = _explodeShifts(rows, weekStart);
      shifts.programmeRows = rows.length;   // 0 → no CCCFXPCAL week in Soft1
      return shifts;
    },

    // ── MTRL production tree (loaded once, used for combination hints) ─────
    getMtrlTree: async function () {
      var rows;
      if (Soft1Bridge.isMock) {
        rows = Soft1Bridge.mockData.mtrlTree.map(function (r) { return Object.assign({}, r); });
      } else {
        rows = await Soft1Bridge.dataset('GetMtrlTree');
      }
      return rows.map(function (r) {
        return {
          mtrl:    r.mtrl,
          lineNum: parseInt(r.lineNum || r.LINENUM, 10),
          raw1:    r.raw1 || r.RAW1MTRL || null,
          raw2:    r.raw2 || r.RAW2MTRL || null,
          raw3:    r.raw3 || r.RAW3MTRL || null,
          raw4:    r.raw4 || r.RAW4MTRL || null,
          prdMtrl: r.prdMtrl || r.PRDMTRL,
          phase:   String(r.phase || ''),
          kilos:   parseFloat(r.kilos)  || 1,
          metres:  parseFloat(r.metres) || 0
        };
      });
    },

    // ── Save: one batched call to Foxline.planning/SaveSchedule ──────────
    // Sends the values as loaded (orig*) so Soft1 can refuse orders changed by someone else.
    // Returns { ok, saved, failed: { orderId: message }, conflicts }
    saveOrders: async function (changedOrders) {
      function fmt(d) { return d ? _fmtDateTime(d).slice(0, 16) : null; }
      var payload = changedOrders
        .filter(function (o) { return o.status !== 1; })      // never write completed orders
        .map(function (o) {
          return {
            findoc:      parseInt(o.id, 10),
            machine:     o.machineId == null ? null : parseInt(o.machineId, 10),
            start:       fmt(o.plannedStart),
            end:         fmt(o.plannedEnd),
            origMachine: o._origMachineId == null ? null : parseInt(o._origMachineId, 10),
            origStart:   fmt(o._origStart),
            origEnd:     fmt(o._origEnd)
          };
        });
      var result = { ok: true, saved: 0, failed: {}, conflicts: 0 };
      if (!payload.length) return result;
      var res = await Soft1Bridge.saveSchedule(payload);
      result.saved     = res.saved || 0;
      result.conflicts = res.conflicts || 0;
      (res.errors || []).forEach(function (e) {
        result.failed[String(e.findoc)] = (e.conflict ? '⚠ ' : '') + e.error;
      });
      result.ok = res.ok !== false && !Object.keys(result.failed).length;
      return result;
    },

    // ── Order details (info card) ──────────────────────────────────────────
    getOrderDetails: async function (orderId) {
      if (Soft1Bridge.isMock) {
        var o = Soft1Bridge.mockData.productionOrders.filter(function (r) { return r.id === orderId; })[0];
        return o ? { id: o.id, fincode: o.id, itemCode: String(o.mtrl), itemName: o.description,
                     kilos: o.kilos, linearMetres: o.linearMetres, deliveryDate: o.deliveryDate,
                     salesOrder: o.salesOrderRef, customer: 'Demo πελάτης', status: o.status, phase: o.phase } : null;
      }
      var rows = await Soft1Bridge.dataset('GetOrderDetails', { findoc: parseInt(orderId, 10) });
      return rows[0] || null;
    },

    // ── Production progress (CCCFXPRDOPRD) ─────────────────────────────────
    // ids: order ids actually shown. Returns { id: { rolls, producedQty, firstDate, lastDate, firstLot, lastLot } }
    getProduction: async function (ids) {
      var out = {};
      ids = (ids || []).filter(function (x) { return /^\d+$/.test(String(x)) || Soft1Bridge.isMock; });
      if (!ids.length) return out;
      if (Soft1Bridge.isMock) {
        ids.forEach(function (id, i) {
          var o = Soft1Bridge.mockData.productionOrders.filter(function (r) { return r.id === id; })[0];
          if (!o || (i % 2 && o.status !== 1)) return;
          var rolls = o.status === 1 ? 6 : 3;
          out[id] = { rolls: rolls, producedQty: o.status === 1 ? o.kilos : Math.round(o.kilos * 0.4),
                      firstDate: new Date(), lastDate: new Date(), firstLot: '260914001', lastLot: '26091400' + rolls };
        });
        return out;
      }
      for (var i = 0; i < ids.length; i += 500) {
        var rows = await Soft1Bridge.dataset('GetProduction', { findocs: ids.slice(i, i + 500).join(',') });
        rows.forEach(function (r) {
          out[String(r.id)] = {
            rolls:       parseInt(r.rolls, 10) || 0,
            producedQty: parseFloat(r.producedQty) || 0,
            firstDate:   _parseDate(r.firstDate),
            lastDate:    _parseDate(r.lastDate),
            firstLot:    r.firstLot != null ? String(r.firstLot) : '',
            lastLot:     r.lastLot  != null ? String(r.lastLot)  : ''
          };
        });
      }
      return out;
    },

    getProductionRolls: async function (orderId) {
      if (Soft1Bridge.isMock) {
        var p = (await DataService.getProduction([orderId]))[orderId];
        if (!p) return [];
        var rows = [];
        for (var i = 1; i <= p.rolls; i++) rows.push({ fincode: 'ΚΠ' + (378540 + i), trndate: new Date(), qty: Math.round(p.producedQty / p.rolls * 100) / 100, lot: '26091400' + i, whouse: 1002 });
        return rows;
      }
      return Soft1Bridge.dataset('GetProductionRolls', { findoc: parseInt(orderId, 10) });
    },

    // ── Production calendar (CCCFXPCAL) ────────────────────────────────────
    calendar: function (action, body) { return Soft1Bridge.calendar(action, body || {}); },

    // Working minutes for an order on a machine (setup optional — skipped on combined runs)
    computeWorkMinutes: function (order, machine, skipSetup) {
      if (!order || !machine) return 60;
      var b = DataService.durationBreakdown(order, machine);
      var min = (skipSetup ? 0 : b.setupMin) + b.productionMin + b.waitMin;
      return Math.max(15, Math.round(min / 5) * 5);
    },

    // ── Duration calculation ───────────────────────────────────────────────
    computeDurationHours: function (order, machine) {
      if (!order || !machine) return 1;
      var metres = parseFloat(order.linearMetres) || 0;
      var speed  = parseFloat(machine.averageSpeed) || 0;
      var setup  = parseFloat(machine.setupTime) || 0;
      var wait   = parseFloat(machine.waitTime)  || 0;
      var productionMinutes = (speed > 0) ? (metres / speed) : 0;
      var hours  = (setup + productionMinutes + wait) / 60;
      return Math.max(0.5, Math.round(hours * 2) / 2);
    },

    durationBreakdown: function (order, machine) {
      var metres = parseFloat(order.linearMetres) || 0;
      var speed  = parseFloat(machine.averageSpeed) || 0;
      var setup  = parseFloat(machine.setupTime) || 0;
      var wait   = parseFloat(machine.waitTime)  || 0;
      var productionMinutes = (speed > 0) ? (metres / speed) : 0;
      return {
        setupMin:      setup,
        productionMin: productionMinutes,
        waitMin:       wait,
        totalMin:      setup + productionMinutes + wait
      };
    },

    // Constants exposed for UI labels
    SHIFT_TIMES: SHIFT_TIMES
  };

  // ─── Shift explosion ──────────────────────────────────────────────────────
  // Each programme row produces up to 21 shift records (7 days × 3 shifts),
  // plus carry-over morning records when shift 3 is active.
  function _explodeShifts(rows, weekStart) {
    var shifts = [];
    rows.forEach(function (row) {
      var machineId = String(row.machine);
      for (var day = 1; day <= 7; day++) {
        var dateField = 'DATE0' + day;
        var dayDate = row[dateField] || row['date0' + day];
        if (!dayDate) {
          // Fall back to weekStart + (day-1)
          dayDate = _addDays(weekStart, day - 1);
        } else if (!(dayDate instanceof Date)) {
          dayDate = _parseDate(dayDate);
        }
        if (!dayDate) continue;
        var dateStr = _fmtDate(dayDate);

        for (var shift = 1; shift <= 3; shift++) {
          var key = 'S' + day + shift;        // S11, S12, ..., S73
          var alt = 's' + day + shift;
          var active = _flag(row[key]) || _flag(row[alt]);
          if (!active) continue;

          var times = SHIFT_TIMES[shift];
          shifts.push({
            date:      dateStr,
            machineId: machineId,
            shiftNum:  shift,
            startTime: times.start,
            endTime:   times.end,
            isProgrammeRow: true
          });

          // Night shift carry-over to next day's early morning
          if (shift === 3) {
            var nextDate = _fmtDate(_addDays(dayDate, 1));
            shifts.push({
              date:      nextDate,
              machineId: machineId,
              shiftNum:  3,
              startTime: '00:00',
              endTime:   NIGHT_CARRY_END,
              isProgrammeRow: true,
              isCarryOver:    true
            });
          }
        }
      }
    });
    return shifts;
  }

  // ─── Mock shift programme: reasonable defaults so demo works ──────────────
  function _mockShiftRows(weekStart) {
    var dates = [];
    for (var i = 0; i < 7; i++) {
      var d = _addDays(weekStart, i);
      dates.push(_fmtDate(d));
    }
    // Build one row per machine; weekday all-3-shifts, Saturday morning only, Sunday off.
    var machines = Soft1Bridge.mockData.machines;
    return machines.map(function (m) {
      var row = {
        machine: m.id,
        DATE01: dates[0], DATE02: dates[1], DATE03: dates[2],
        DATE04: dates[3], DATE05: dates[4], DATE06: dates[5], DATE07: dates[6],
        // Weekday: all 3 shifts
        S11: 1, S12: 1, S13: 1,
        S21: 1, S22: 1, S23: 1,
        S31: 1, S32: 1, S33: 1,
        S41: 1, S42: 1, S43: 1,
        S51: 1, S52: 1, S53: 0,
        // Saturday morning only
        S61: 1, S62: 0, S63: 0,
        // Sunday off
        S71: 0, S72: 0, S73: 0
      };
      // Vary CNC-2: only morning shift (showcases per-machine variability)
      if (m.id === 'CNC-2') {
        row.S12 = 0; row.S13 = 0; row.S22 = 0; row.S23 = 0;
        row.S32 = 0; row.S33 = 0; row.S42 = 0; row.S43 = 0;
        row.S52 = 0; row.S53 = 0;
      }
      return row;
    });
  }

  // Export shared helpers for other modules
  global.DataService    = DataService;
  global._fmtDate       = _fmtDate;
  global._fmtDateTime   = _fmtDateTime;

})(window);
