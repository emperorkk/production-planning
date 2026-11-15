/* WorkTime — shift-aware time arithmetic per machine.
   Built from state.shifts ({date:'YYYY-MM-DD', machineId, startTime:'HH:MM', endTime:'HH:MM'}).
   A block's duration is WORKING minutes: it only advances inside shifts and skips gaps.

   build(shifts)                    → (re)index intervals per machine
   nextWorking(mid, t)              → first working instant ≥ t (Date) or null
   addWork(mid, start, minutes)     → { start, end, overflow }  (start snapped to a shift;
                                      overflow = ran past the last known shift → clock time)
   workBetween(mid, a, b)           → working minutes inside [a, b]
   dayCapacity(mid, dayDate)        → working minutes on that calendar day
   utilisation(orders, machines, weekStart, days) → { mid: { 'YYYY-MM-DD': {pct, sched, avail} } } */
(function (global) {
  'use strict';

  var MIN = 60000;
  var _byMachine = {};   // mid -> [[startMs, endMs], ...] sorted, merged

  function _toMs(dateStr, hhmm) {
    var p = String(dateStr).split('-');
    var t = String(hhmm).split(':');
    var h = parseInt(t[0], 10), m = parseInt(t[1], 10) || 0;
    return new Date(+p[0], +p[1] - 1, +p[2], h, m, 0, 0).getTime();   // 24:00 rolls to next day
  }

  function build(shifts) {
    var raw = {};
    (shifts || []).forEach(function (s) {
      var a = _toMs(s.date, s.startTime), b = _toMs(s.date, s.endTime);
      if (!(b > a)) return;
      (raw[s.machineId] = raw[s.machineId] || []).push([a, b]);
    });
    _byMachine = {};
    Object.keys(raw).forEach(function (mid) {
      var list = raw[mid].sort(function (x, y) { return x[0] - y[0]; });
      var merged = [];
      list.forEach(function (iv) {
        var last = merged[merged.length - 1];
        if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
        else merged.push([iv[0], iv[1]]);
      });
      _byMachine[mid] = merged;
    });
  }

  function intervals(mid) { return _byMachine[mid] || []; }

  function nextWorking(mid, t) {
    var ms = +t, list = intervals(mid);
    for (var i = 0; i < list.length; i++) {
      if (ms < list[i][1]) return new Date(Math.max(ms, list[i][0]));
    }
    return null;
  }

  function addWork(mid, start, minutes) {
    var list = intervals(mid);
    var need = Math.max(0, minutes) * MIN;
    var t = +start;
    var first = null;
    for (var i = 0; i < list.length && need > 0; i++) {
      if (t >= list[i][1]) continue;
      var s = Math.max(t, list[i][0]);
      if (first === null) first = s;
      var take = Math.min(need, list[i][1] - s);
      need -= take;
      t = s + take;
    }
    if (first === null) first = +start;
    if (need > 0) return { start: new Date(first), end: new Date(t + need), overflow: true };
    return { start: new Date(first), end: new Date(t), overflow: false };
  }

  function workBetween(mid, a, b) {
    var lo = +a, hi = +b, sum = 0, list = intervals(mid);
    for (var i = 0; i < list.length; i++) {
      var s = Math.max(lo, list[i][0]), e = Math.min(hi, list[i][1]);
      if (e > s) sum += e - s;
    }
    return Math.round(sum / MIN);
  }

  function _dayBounds(dayDate) {
    var d0 = new Date(dayDate); d0.setHours(0, 0, 0, 0);
    var d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
    return [d0.getTime(), d1.getTime()];
  }

  function dayCapacity(mid, dayDate) {
    var b = _dayBounds(dayDate);
    return workBetween(mid, b[0], b[1]);
  }

  function _iso(d) {
    return d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1) + '-' +
           (d.getDate() < 10 ? '0' : '') + d.getDate();
  }

  function utilisation(orders, machines, weekStart, days) {
    days = days || 7;
    var res = {};
    var byM = {};
    orders.forEach(function (o) {
      if (o.machineId && o.plannedStart && o.plannedEnd) (byM[o.machineId] = byM[o.machineId] || []).push(o);
    });
    machines.forEach(function (m) {
      res[m.id] = {};
      for (var d = 0; d < days; d++) {
        var day = new Date(weekStart); day.setDate(day.getDate() + d);
        var b = _dayBounds(day);
        var avail = workBetween(m.id, b[0], b[1]);
        var sched = 0;
        (byM[m.id] || []).forEach(function (o) {
          var s = Math.max(b[0], +o.plannedStart), e = Math.min(b[1], +o.plannedEnd);
          if (e > s) sched += workBetween(m.id, s, e);
        });
        res[m.id][_iso(day)] = {
          avail: avail, sched: sched,
          pct: avail > 0 ? Math.min(999, Math.round(sched / avail * 100)) : (sched > 0 ? 999 : 0)
        };
      }
    });
    return res;
  }

  global.WorkTime = {
    build: build, intervals: intervals, nextWorking: nextWorking, addWork: addWork,
    workBetween: workBetween, dayCapacity: dayCapacity, utilisation: utilisation
  };
})(window);
