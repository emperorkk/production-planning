/* SchedulerEngine — order-centric: each order is one Gantt block.
   Conflicts, deadline checks, utilisation, auto-place. */
(function (global) {
  'use strict';

  function _fmtDate(d) {
    return d.getFullYear() + '-' +
      (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1) + '-' +
      (d.getDate() < 10 ? '0' : '') + d.getDate();
  }

  function _timeToMinutes(t) {
    if (!t) return 0;
    var parts = String(t).split(':');
    return parseInt(parts[0], 10) * 60 + (parseInt(parts[1], 10) || 0);
  }

  // Returns the orders that have a planned start (i.e. are scheduled blocks)
  function _scheduled(orders) {
    return orders.filter(function (o) {
      return o.machineId && o.plannedStart && o.plannedEnd;
    });
  }

  var SchedulerEngine = {

    // Pairs of overlapping orders on the same machine
    getConflicts: function (orders) {
      var conflicts = [];
      var byMachine = {};
      _scheduled(orders).forEach(function (o) {
        if (!byMachine[o.machineId]) byMachine[o.machineId] = [];
        byMachine[o.machineId].push(o);
      });
      Object.keys(byMachine).forEach(function (machineId) {
        var list = byMachine[machineId].slice().sort(function (a, b) {
          return a.plannedStart - b.plannedStart;
        });
        for (var i = 0; i < list.length - 1; i++) {
          if (list[i].plannedEnd > list[i + 1].plannedStart) {
            conflicts.push([list[i], list[i + 1]]);
          }
        }
      });
      return conflicts;
    },

    // Orders ending after their delivery date
    getDeadlineViolations: function (orders) {
      return _scheduled(orders).filter(function (o) {
        return o.deliveryDate && o.plannedEnd > o.deliveryDate;
      });
    },

    // % utilisation per machine per day, driven by per-machine shifts
    getMachineUtilisation: function (orders, shifts, machines) {
      var util = {};

      shifts.forEach(function (s) {
        var start = _timeToMinutes(s.startTime);
        var end   = _timeToMinutes(s.endTime);
        if (end <= start) return;
        if (!util[s.machineId]) util[s.machineId] = {};
        if (!util[s.machineId][s.date]) util[s.machineId][s.date] = { scheduled: 0, available: 0 };
        util[s.machineId][s.date].available += (end - start);
      });

      _scheduled(orders).forEach(function (o) {
        var dateStr = _fmtDate(o.plannedStart);
        if (!util[o.machineId]) util[o.machineId] = {};
        if (!util[o.machineId][dateStr]) util[o.machineId][dateStr] = { scheduled: 0, available: 480 };
        var hours = (o.plannedEnd - o.plannedStart) / 3600000;
        util[o.machineId][dateStr].scheduled += hours * 60;
      });

      var result = {};
      Object.keys(util).forEach(function (machineId) {
        result[machineId] = {};
        Object.keys(util[machineId]).forEach(function (date) {
          var d = util[machineId][date];
          result[machineId][date] = d.available > 0
            ? Math.min(999, Math.round(d.scheduled / d.available * 100))
            : 0;
        });
      });
      return result;
    },

    // ── Phase chain (CCCFXPRNOMINAL) ─────────────────────────────────────
    // Tree line: PRDMTRL is produced from RAW1..RAW4. An order producing mtrl X has as
    // predecessors the orders producing X's raws (same sales order when both are known).
    buildChainIndex: function (orders, mtrlTree) {
      var raws = {};                       // prdMtrl -> [rawMtrl, ...]
      var produced = {};                   // rawMtrl -> [prdMtrl, ...]
      (mtrlTree || []).forEach(function (r) {
        var prd = r.prdMtrl != null ? String(r.prdMtrl) : null;
        if (!prd) return;
        [r.raw1, r.raw2, r.raw3, r.raw4].forEach(function (x) {
          if (x == null || x === '') return;
          x = String(x);
          (raws[prd] = raws[prd] || []).push(x);
          (produced[x] = produced[x] || []).push(prd);
        });
      });
      var byMtrl = {};
      orders.forEach(function (o) { if (o.mtrl != null) (byMtrl[String(o.mtrl)] = byMtrl[String(o.mtrl)] || []).push(o); });
      function sameSO(a, b) { return !a.salesOrderRef || !b.salesOrderRef || String(a.salesOrderRef) === String(b.salesOrderRef); }
      function collect(o, map) {
        var out = [];
        ((o.mtrl != null && map[String(o.mtrl)]) || []).forEach(function (m) {
          (byMtrl[m] || []).forEach(function (p) { if (p !== o && sameSO(o, p) && out.indexOf(p) < 0) out.push(p); });
        });
        return out;
      }
      return {
        predecessors: function (o) { return collect(o, raws); },
        successors:   function (o) { return collect(o, produced); }
      };
    },

    // [{ order, pred }] where order starts before its scheduled predecessor ends
    getChainViolations: function (orders, chain) {
      var out = [];
      _scheduled(orders).forEach(function (o) {
        chain.predecessors(o).forEach(function (p) {
          if (p.plannedEnd && p.plannedStart && o.plannedStart < p.plannedEnd) out.push({ order: o, pred: p });
        });
      });
      return out;
    },

    // ── Smart auto-place (shift-aware) ────────────────────────────────────
    // Earliest delivery first; for each order the eligible machine that FINISHES earliest;
    // never before `minStart`, never before a predecessor's end, no overlaps, inside the week.
    // opts: { orders, machines, phaseMachines, weekStart, weekEnd, minStart, chain, workMinutes(order, machine) }
    autoPlace: function (candidates, opts) {
      var WT = global.WorkTime;
      var blocks = {};                     // mid -> sorted scheduled orders
      _scheduled(opts.orders).forEach(function (o) { (blocks[o.machineId] = blocks[o.machineId] || []).push(o); });
      Object.keys(blocks).forEach(function (k) { blocks[k].sort(function (a, b) { return a.plannedStart - b.plannedStart; }); });

      var list = candidates.slice().sort(function (a, b) {
        var da = a.deliveryDate ? +a.deliveryDate : Infinity, db = b.deliveryDate ? +b.deliveryDate : Infinity;
        return da - db || String(a.id).localeCompare(String(b.id));
      });
      // Predecessors first (topological), otherwise delivery order
      if (opts.chain) {
        var inList = {}; list.forEach(function (o) { inList[o.id] = o; });
        var seen = {}, ordered = [];
        var visit = function (o, depth) {
          if (seen[o.id] || depth > 20) return;
          seen[o.id] = true;
          opts.chain.predecessors(o).forEach(function (p) { if (inList[p.id]) visit(p, depth + 1); });
          ordered.push(o);
        };
        list.forEach(function (o) { visit(o, 0); });
        list = ordered;
      }
      var placements = [];
      var placedEnd = {};                  // id -> end ms of orders placed in this run

      list.forEach(function (order) {
        // Reserved machine (FINDOC.BOOL01) → only that machine; otherwise any machine of the phase
        var ids = (order.machineLocked && order.machineId) ? [order.machineId] : (opts.phaseMachines[order.phase] || []);
        var eligible = ids.map(function (id) {
          return opts.machines.filter(function (m) { return m.id === id; })[0];
        }).filter(Boolean);
        var earliest = +opts.minStart;
        if (opts.chain) opts.chain.predecessors(order).forEach(function (p) {
          var pe = placedEnd[p.id] || (p.plannedEnd ? +p.plannedEnd : 0);
          if (pe) earliest = Math.max(earliest, pe);
        });

        var best = null;
        eligible.forEach(function (m) {
          var minutes = opts.workMinutes(order, m);
          var list = blocks[m.id] || [];
          var t = earliest;
          for (var guard = 0; guard < 500; guard++) {
            var s = WT.nextWorking(m.id, t);
            if (!s || +s >= +opts.weekEnd) return;
            var span = WT.addWork(m.id, s, minutes);
            if (span.overflow || +span.end > +opts.weekEnd) return;
            var hit = null;
            for (var i = 0; i < list.length; i++) {
              if (+list[i].plannedEnd > +span.start && +list[i].plannedStart < +span.end) { hit = list[i]; break; }
            }
            if (!hit) {
              if (!best || +span.end < +best.end) best = { machine: m, start: span.start, end: span.end, minutes: minutes };
              return;
            }
            t = +hit.plannedEnd;
          }
        });
        if (!best) return;
        var fake = { id: order.id, machineId: best.machine.id, plannedStart: best.start, plannedEnd: best.end };
        var arr = blocks[best.machine.id] = blocks[best.machine.id] || [];
        arr.push(fake);
        arr.sort(function (a, b) { return a.plannedStart - b.plannedStart; });
        placedEnd[order.id] = +best.end;
        placements.push({ order: order, machineId: best.machine.id, plannedStart: best.start,
                          plannedEnd: best.end, workMin: best.minutes });
      });
      return placements;
    },

    // Suggests earliest available slot for an unscheduled order
    // phaseMachines: { phase -> [machineId,...] }, computeHoursFn(machine) -> hours
    findFirstAvailableSlot: function (order, machines, orders, shifts, weekStart, phaseMachines, computeHoursFn) {
      var eligibleIds = phaseMachines[order.phase] || [];
      var eligible = machines.filter(function (m) { return eligibleIds.indexOf(m.id) >= 0; });
      if (!eligible.length) return null;

      for (var dayOffset = 0; dayOffset < 7; dayOffset++) {
        var dayDate = new Date(weekStart);
        dayDate.setDate(dayDate.getDate() + dayOffset);
        var dateStr = _fmtDate(dayDate);

        for (var m = 0; m < eligible.length; m++) {
          var machine = eligible[m];

          // Per-machine per-day shifts
          var dayShifts = shifts.filter(function (s) {
            return s.date === dateStr && s.machineId === machine.id;
          }).sort(function (a, b) {
            return _timeToMinutes(a.startTime) - _timeToMinutes(b.startTime);
          });
          if (!dayShifts.length) continue;

          var hours      = computeHoursFn ? computeHoursFn(machine) : 1;
          var durationMs = hours * 3600000;

          for (var s = 0; s < dayShifts.length; s++) {
            var dayShift = dayShifts[s];
            var shiftStart = new Date(dayDate);
            var st = dayShift.startTime.split(':');
            shiftStart.setHours(parseInt(st[0], 10), parseInt(st[1], 10), 0, 0);

            var shiftEnd = new Date(dayDate);
            var et = dayShift.endTime.split(':');
            var endH = parseInt(et[0], 10);
            if (endH === 24) shiftEnd.setHours(23, 59, 59, 999);
            else             shiftEnd.setHours(endH, parseInt(et[1], 10), 0, 0);

            // Existing scheduled orders on this machine overlapping this shift
            var existing = _scheduled(orders).filter(function (o) {
              return o.machineId === machine.id &&
                     o.plannedEnd   > shiftStart &&
                     o.plannedStart < shiftEnd &&
                     o.id !== order.id;
            }).sort(function (a, b) { return a.plannedStart - b.plannedStart; });

            var cursor = shiftStart;
            for (var k = 0; k <= existing.length; k++) {
              var gapEnd = k < existing.length ? existing[k].plannedStart : shiftEnd;
              if (cursor.getTime() + durationMs <= gapEnd.getTime()) {
                return {
                  machineId:     machine.id,
                  plannedStart:  new Date(cursor),
                  plannedEnd:    new Date(cursor.getTime() + durationMs),
                  durationHours: hours
                };
              }
              if (k < existing.length) {
                cursor = new Date(Math.max(cursor.getTime(), existing[k].plannedEnd.getTime()));
              }
            }
          }
        }
      }
      return null;
    }
  };

  global.SchedulerEngine = SchedulerEngine;

})(window);
