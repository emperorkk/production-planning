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

  // ═══════════════════════════════════════════════════════════════════════════
  // QUERIES — replace nothing in production except where noted.
  // ═══════════════════════════════════════════════════════════════════════════
  function _company() { return Soft1Bridge.isMock ? 1000 : Soft1Bridge.company; }

  var QUERIES = {

    // ── Machines / Resources (RSRC) ────────────────────────────────────────
    machines: function () {
      return "SELECT RSRC AS id" +
             ", NAME AS name" +
             ", CCCFXSTAGE AS phase" +
             ", SETUPTIME AS setuptime" +
             ", WAITTIME  AS waittime" +
             ", MPRDQTY   AS average_speed_in_metres_per_minute" +
             " FROM RSRC" +
             " WHERE SODTYPE = 25 AND RSRCTYPE < 50 AND COMPANY = " + _company();
    },

    // ── Phase ↔ machine eligibility (SPCOSTGROUP) ──────────────────────────
    phaseMachines: function () {
      return "SELECT CCCRSRC AS machine, CCCSTAGE AS phase, (select name from STAGE where COMPANY=SPCOSTGROUP and STAGE=CCCSTAGE) phaseName" +
             " FROM SPCOSTGROUP" +
             " WHERE CCCRSRC IS NOT NULL AND COMPANY = " + _company();
    },

    // ── Production orders (one row = one phase = one Gantt block) ──────────
    // Returns: every non-completed order in the last 6 months + completed orders
    // whose planned start (DATE01) falls within the current displayed week.
    // Common SELECT/FROM that both order queries share — kept as a function so
    // every call regenerates with current company.
    _ordersBaseSelect: function () {
      return "SELECT F.FINDOC AS id" +
             ", M.CODE + ' ' + M.NAME AS description" +
             ", isnull(LS.DELIVDATE,L0.DELIVDATE) AS deliveryDate" +
             ", L0.QTY1 AS kilos" +
             ", L0.QTY2 AS linearMetres" +
             ", L0.DATE01 AS plannedStartDataTime" +
             ", L0.DATE02 AS plannedFinishDataTime" +
             ", D.MTRSTS AS status" +
             ", D.STAGE AS phase" +
             ", F.CCCFXRSRC AS machine" +
             ", L0.FINDOCS AS salesOrderRef" +
             ", L0.MTRL AS mtrl" +
             " FROM FINDOC F" +
             " INNER JOIN MTRDOC D ON D.FINDOC = F.FINDOC" +
             " INNER JOIN MTRLINES L0 ON L0.FINDOC = F.FINDOC AND L0.MTRTYPE = 1" +
             " LEFT OUTER JOIN MTRLINES LS ON LS.FINDOC = L0.FINDOCS AND LS.MTRLINES=L0.MTRLINESS" +
             " INNER JOIN MTRL M ON M.MTRL = L0.MTRL" +
             " WHERE F.SOSOURCE = 5171" +
             " AND F.COMPANY = " + _company() +
             " AND isnull(LS.DELIVDATE,L0.DELIVDATE) >= " + Soft1Bridge.nowFn() + " - 180";
    },

    // STAGE 1 — small set of orders touching the visible week (renders gantt blocks).
    ordersInWeek: function (weekStartIso, weekEndIso) {
      var ws = "'" + weekStartIso + " 00:00:00'";
      var we = "'" + weekEndIso   + " 23:59:59'";
      return QUERIES._ordersBaseSelect() +
             " AND (L0.DATE01 BETWEEN " + ws + " AND " + we +
             "   OR L0.DATE02 BETWEEN " + ws + " AND " + we + ")" +
             " ORDER BY L0.DELIVDATE";
    },

    // STAGE 2 — paged unscheduled orders (DATE01 IS NULL). Stream in batches.
    unscheduledOrdersPage: function (offset, pageSize) {
      return QUERIES._ordersBaseSelect() +
             " AND D.MTRSTS <> 1" +
             " AND L0.DATE01 IS NULL" +
             " ORDER BY L0.DELIVDATE" +
             " OFFSET " + offset + " ROWS FETCH NEXT " + pageSize + " ROWS ONLY";
    },

    // (kept for backwards compat / Excel export full-load fallback)
    productionOrders: function (weekStartIso, weekEndIso) {
      return "SELECT F.FINDOC AS id" +
             ", M.CODE + ' ' + M.NAME AS description" +
             ", isnull(LS.DELIVDATE,L0.DELIVDATE) AS deliveryDate" +
             ", L0.QTY1 AS kilos" +
             ", L0.QTY2 AS linearMetres" +
             ", L0.DATE01 AS plannedStartDataTime" +
             ", L0.DATE02 AS plannedFinishDataTime" +
             ", D.MTRSTS AS status" +
             ", D.STAGE AS phase" +
             ", F.CCCFXRSRC AS machine" +
             ", L0.FINDOCS AS salesOrderRef" +
             ", L0.MTRL AS mtrl" +
             " FROM FINDOC F" +
             " INNER JOIN MTRDOC D ON D.FINDOC = F.FINDOC" +
             " INNER JOIN MTRLINES L0 ON L0.FINDOC = F.FINDOC AND L0.MTRTYPE = 1" +
			 " LEFT OUTER JOIN MTRLINES LS ON LS.FINDOC = L0.FINDOCS AND LS.MTRLINES=L0.MTRLINESS"+
             " INNER JOIN MTRL M ON M.MTRL = L0.MTRL" +
             " WHERE F.SOSOURCE = 5171" +
             " AND F.COMPANY = " + _company() +
             " AND isnull(LS.DELIVDATE,L0.DELIVDATE) >= " + Soft1Bridge.nowFn() + " - 180" +
             " AND (D.MTRSTS <> 1" +
             "      OR L0.DATE01 BETWEEN '" + weekStartIso + " 00:00:00' AND '" + weekEndIso + " 23:59:59'" +
             "      OR L0.DATE02 BETWEEN '" + weekStartIso + " 00:00:00' AND '" + weekEndIso + " 23:59:59')" +			 
             " ORDER BY L0.DELIVDATE";
    },

    // ── Shift programme — explodes into per-machine, per-day shift records ─
    // {0} = ISO Monday-of-week date string, e.g. '2026-05-11'
    shifts: function (mondayIso) {
      return "SELECT L.RSRC AS machine" +
             ", A.DATE01, A.DATE02, A.DATE03, A.DATE04, A.DATE05, A.DATE06, A.DATE07" +
             ", L.S11, L.S12, L.S13" +
             ", L.S21, L.S22, L.S23" +
             ", L.S31, L.S32, L.S33" +
             ", L.S41, L.S42, L.S43" +
             ", L.S51, L.S52, L.S53" +
             ", L.S61, L.S62, L.S63" +
             ", L.S71, L.S72, L.S73" +
             " FROM CCCFXPCAL A" +
             " INNER JOIN CCCFXPCALLNS L ON A.CCCFXPCAL = L.CCCFXPCAL" +
             " WHERE A.COMPANY = " + _company() +
             " AND A.DATE01 = '" + mondayIso + "'";
    },

    // ── MTRL production tree (consumed for "combine same-PRDMTRL" hint) ────
    mtrlTree: function () {
      return "SELECT MTRL, LINENUM" +
             ", RAW1MTRL, RAW2MTRL, RAW3MTRL, RAW4MTRL, PRDMTRL" +
             ", STAGE AS phase" +
             ", ISNULL(PRDQTY1, 1) AS kilos" +
             ", PRDQTY2 AS metres" +
             " FROM CCCFXPRNOMINAL" +
             " ORDER BY MTRL, LINENUM";
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // WRITE-BACK SQL — two UPDATEs per changed order
  // ═══════════════════════════════════════════════════════════════════════════
  var WRITE = {
    setMachine: function (orderId, machineId) {
      return "UPDATE FINDOC SET CCCFXRSRC = " + (machineId == null ? "NULL" : "'" + _esc(machineId) + "'") +
             " WHERE FINDOC = " + parseInt(orderId, 10);
    },
    setSchedule: function (orderId, plannedStart, plannedEnd) {
      return "UPDATE MTRLINES" +
             " SET DATE01 = " + (plannedStart ? "'" + plannedStart + "'" : "NULL") +
             ", DATE02 = " + (plannedEnd   ? "'" + plannedEnd   + "'" : "NULL") +
             " WHERE FINDOC = " + parseInt(orderId, 10) + " AND MTRTYPE = 1";
    }
  };

  // ─── Helpers ───────────────────────────────────────────────────────────────
  function _esc(s) { return String(s).replace(/'/g, "''"); }
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
      var rows = await Soft1Bridge.query(QUERIES.machines());
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
        rows = await Soft1Bridge.query(QUERIES.phaseMachines());
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
      var rows = await Soft1Bridge.query(QUERIES.ordersInWeek(_fmtDate(weekStart), _fmtDate(weekEnd)));
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
      var rows = await Soft1Bridge.query(QUERIES.unscheduledOrdersPage(offset, pageSize));
      return _mapOrderRows(rows);
    },

    // (legacy, used as a fallback only)
    getProductionOrders: async function (weekStart, weekEnd) {
      if (Soft1Bridge.isMock) return _mapOrderRows(Soft1Bridge.mockData.productionOrders);
      var rows = await Soft1Bridge.query(QUERIES.productionOrders(_fmtDate(weekStart), _fmtDate(weekEnd)));
      return _mapOrderRows(rows);
    },

    // ── Shifts (per machine, per day, exploded from CCCFXPCAL) ─────────────
    getShifts: async function (weekStart, weekEnd) {
      var monIso = _fmtDate(weekStart);
      var rows;
      if (Soft1Bridge.isMock) {
        rows = _mockShiftRows(weekStart);
      } else {
        rows = await Soft1Bridge.query(QUERIES.shifts(monIso));
      }
      return _explodeShifts(rows, weekStart);
    },

    // ── MTRL production tree (loaded once, used for combination hints) ─────
    getMtrlTree: async function () {
      var rows;
      if (Soft1Bridge.isMock) {
        rows = Soft1Bridge.mockData.mtrlTree.map(function (r) { return Object.assign({}, r); });
      } else {
        rows = await Soft1Bridge.query(QUERIES.mtrlTree());
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

    // ── Save: two UPDATEs per changed order ────────────────────────────────
    saveOrders: async function (changedOrders) {
      // Web mode: one batched call to Foxline.planning/saveSchedule (builds the UPDATEs server-side)
      if (Soft1Bridge.isWeb) {
        var payload = changedOrders
          .filter(function (o) { return o.status !== 1; })
          .map(function (o) {
            return {
              findoc:  parseInt(o.id, 10),
              machine: o.machineId == null ? null : parseInt(o.machineId, 10),
              start:   o.plannedStart ? _fmtDateTime(o.plannedStart).slice(0, 16) : null,
              end:     o.plannedEnd   ? _fmtDateTime(o.plannedEnd).slice(0, 16)   : null
            };
          });
        if (!payload.length) return true;
        try {
          var res = await Soft1Bridge.saveSchedule(payload);
          if (res.errors && res.errors.length) {
            console.warn('saveSchedule errors', res.errors);
            Soft1Bridge.warn('Αποτυχία αποθήκευσης για ' + res.errors.length + ' εντολές:\n' +
              res.errors.slice(0, 10).map(function (e) { return e.findoc + ': ' + e.error; }).join('\n'));
          }
          return res.ok !== false && !(res.errors && res.errors.length);
        } catch (e) {
          Soft1Bridge.warn('Σφάλμα αποθήκευσης: ' + (e.message || e));
          return false;
        }
      }

      // Embedded / mock: two UPDATEs per order via RUNSQL
      var allOk = true;
      for (var i = 0; i < changedOrders.length; i++) {
        var o = changedOrders[i];
        if (o.status === 1) continue;   // never write to completed orders
        var startStr = o.plannedStart ? _fmtDateTime(o.plannedStart) : null;
        var endStr   = o.plannedEnd   ? _fmtDateTime(o.plannedEnd)   : null;
        if (!(await Soft1Bridge.exec(WRITE.setMachine(o.id, o.machineId))))       allOk = false;
        if (!(await Soft1Bridge.exec(WRITE.setSchedule(o.id, startStr, endStr)))) allOk = false;
      }
      return allOk;
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
