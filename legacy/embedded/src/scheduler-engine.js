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
