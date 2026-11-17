/* ExcelExporter — requires src/lib/xlsx.min.js (SheetJS).
   Order-centric: each order = one schedule row. */
(function (global) {
  'use strict';

  function _pad(n) { return n < 10 ? '0' + n : String(n); }

  function _isoWeek(d) {
    var tmp = new Date(d.valueOf());
    var dayNum = (d.getDay() + 6) % 7;
    tmp.setDate(tmp.getDate() - dayNum + 3);
    var firstThursday = tmp.valueOf();
    tmp.setMonth(0, 1);
    if (tmp.getDay() !== 4) tmp.setMonth(0, 1 + ((4 - tmp.getDay()) + 7) % 7);
    return 1 + Math.ceil((firstThursday - tmp) / 604800000);
  }

  function _fmtCell(d) {
    if (!d) return '';
    if (!(d instanceof Date)) return String(d);
    return _pad(d.getDate()) + '/' + _pad(d.getMonth() + 1) + '/' + d.getFullYear() +
           ' ' + _pad(d.getHours()) + ':' + _pad(d.getMinutes());
  }
  function _fmtDateCell(d) {
    if (!d || !(d instanceof Date)) return String(d || '');
    return _pad(d.getDate()) + '/' + _pad(d.getMonth() + 1) + '/' + d.getFullYear();
  }
  function _fmtDate(d) {
    return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate());
  }

  var ExcelExporter = {

    export: function (state) {
      if (typeof XLSX === 'undefined') {
        alert('Το αρχείο xlsx.min.js δεν βρέθηκε.\nΑντιγράψτε το στο φάκελο src/lib/ και φορτώστε ξανά.');
        return;
      }

      var wb = XLSX.utils.book_new();

      // ── Sheet 1: Schedule ────────────────────────────────────────────────
      var schedRows = [['Παραγγελία','Αρ. εντολής','Περιγραφή','Φάση','Μηχανή','Ημ/νία Έναρξης','Ημ/νία Λήξης','Ώρες','Κιλά','Μέτρα','Sales Order','Κατάσταση']];

      var sortedOrders = state.orders.slice().sort(function (a, b) {
        if (a.plannedStart && b.plannedStart) return a.plannedStart - b.plannedStart;
        if (a.plannedStart) return -1;
        if (b.plannedStart) return 1;
        return 0;
      });

      sortedOrders.forEach(function (o) {
        var machine = state.machines.find(function (m) { return m.id === o.machineId; });
        var hours = (o.plannedStart && o.plannedEnd) ? ((o.plannedEnd - o.plannedStart) / 3600000) : '';
        var status = o.status === 1 ? 'Ολοκληρωμένη'
                   : (o.machineId && o.plannedStart) ? 'Προγραμματισμένη'
                   : 'Μη προγραμματισμένη';
        schedRows.push([
          o.id, o.fincode || '', o.description || '', ((state.phaseNames && state.phaseNames[o.phase]) ? state.phaseNames[o.phase] + ' (' + o.phase + ')' : o.phase),
          machine ? machine.name : (o.machineId || ''),
          _fmtCell(o.plannedStart),
          _fmtCell(o.plannedEnd),
          hours === '' ? '' : Number(hours.toFixed(2)),
          o.kilos || '',
          o.linearMetres || '',
          o.salesOrderRef || '',
          status
        ]);
      });

      var ws1 = XLSX.utils.aoa_to_sheet(schedRows);
      ws1['!cols'] = [14,18,30,8,18,20,20,8,8,10,14,18].map(function (w) { return { wch: w }; });
      XLSX.utils.book_append_sheet(wb, ws1, 'Πρόγραμμα');

      // ── Sheet 2: Machine utilisation per day ─────────────────────────────
      var days = [];
      var d = new Date(state.weekStart);
      while (d <= state.weekEnd) { days.push(new Date(d)); d.setDate(d.getDate() + 1); }

      var dayLabels = ['Κυρ','Δευ','Τρι','Τετ','Πεμ','Παρ','Σαβ'];
      var utilHeader = ['Μηχανή', 'Φάση'].concat(days.map(function (day) {
        return dayLabels[day.getDay()] + ' ' + day.getDate() + '/' + (day.getMonth() + 1);
      }));
      var utilRows = [utilHeader];
      var util = SchedulerEngine.getMachineUtilisation(state.orders, state.shifts, state.machines);
      state.machines.forEach(function (machine) {
        var row = [machine.name, ((state.phaseNames && state.phaseNames[machine.phase]) ? state.phaseNames[machine.phase] : machine.phase)];
        days.forEach(function (day) {
          var dateStr = _fmtDate(day);
          row.push((util[machine.id] && util[machine.id][dateStr]) ? util[machine.id][dateStr] + '%' : '0%');
        });
        utilRows.push(row);
      });
      var ws2 = XLSX.utils.aoa_to_sheet(utilRows);
      ws2['!cols'] = [20, 10].concat(days.map(function () { return { wch: 10 }; }));
      XLSX.utils.book_append_sheet(wb, ws2, 'Χρησιμοποίηση');

      // ── Sheet 3: Orders summary ──────────────────────────────────────────
      var orderRows = [['Παραγγελία','Αρ. εντολής','Περιγραφή','Φάση','Κιλά','Γρ. Μέτρα','Παράδοση','Sales Order','Κατάσταση','Μηχανή']];
      state.orders.forEach(function (o) {
        var machine = state.machines.find(function (m) { return m.id === o.machineId; });
        orderRows.push([
          o.id, o.fincode || '', o.description || '', ((state.phaseNames && state.phaseNames[o.phase]) ? state.phaseNames[o.phase] + ' (' + o.phase + ')' : o.phase),
          o.kilos || '', o.linearMetres || '',
          _fmtDateCell(o.deliveryDate),
          o.salesOrderRef || '',
          o.status === 1 ? 'Ολοκληρωμένη'
            : (o.machineId && o.plannedStart) ? 'Προγραμματισμένη'
            : 'Μη προγραμματισμένη',
          machine ? machine.name : (o.machineId || '—')
        ]);
      });
      var ws3 = XLSX.utils.aoa_to_sheet(orderRows);
      ws3['!cols'] = [14,18,30,8,8,10,14,14,18,18].map(function (w) { return { wch: w }; });
      XLSX.utils.book_append_sheet(wb, ws3, 'Παραγγελίες');

      // ── Download ─────────────────────────────────────────────────────────
      var week = _isoWeek(state.weekStart);
      var y = state.weekStart.getFullYear();
      var filename = 'Προγραμμα_Παραγωγης_Ε' + week + '_' + y + '.xlsx';
      XLSX.writeFile(wb, filename);
    }
  };

  global.ExcelExporter = ExcelExporter;

})(window);
