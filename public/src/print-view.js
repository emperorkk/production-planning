/* PrintView — shop-floor print: one page per machine, orders grouped by day + shift. */
(function (global) {
  'use strict';

  var DAYS = ['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'];

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function _pad(n) { return n < 10 ? '0' + n : String(n); }
  function _t(d) { return _pad(d.getHours()) + ':' + _pad(d.getMinutes()); }
  function _d(d) { return _pad(d.getDate()) + '/' + _pad(d.getMonth() + 1); }

  // Shift by start time: 06–14 → 1, 14–22 → 2, otherwise 3 (22–06 belongs to the previous day)
  function _shiftOf(d) {
    var h = d.getHours();
    if (h >= 6 && h < 14) return { n: 1, day: d };
    if (h >= 14 && h < 22) return { n: 2, day: d };
    var day = new Date(d);
    if (h < 6) day.setDate(day.getDate() - 1);
    return { n: 3, day: day };
  }

  function open(state, phaseLabel) {
    var wStart = state.weekStart, wEnd = new Date(wStart); wEnd.setDate(wEnd.getDate() + 7);
    var byMachine = {};
    state.orders.forEach(function (o) {
      if (!o.machineId || !o.plannedStart || !o.plannedEnd) return;
      if (o.plannedEnd <= wStart || o.plannedStart >= wEnd) return;
      (byMachine[o.machineId] = byMachine[o.machineId] || []).push(o);
    });

    var pages = state.machines.filter(function (m) { return byMachine[m.id]; }).map(function (m) {
      var list = byMachine[m.id].sort(function (a, b) { return a.plannedStart - b.plannedStart; });
      var rows = '', lastKey = '';
      list.forEach(function (o) {
        var sh = _shiftOf(o.plannedStart);
        var key = sh.day.toDateString() + sh.n;
        if (key !== lastKey) {
          rows += '<tr class="grp"><td colspan="8">' + DAYS[sh.day.getDay()] + ' ' + _d(sh.day) + ' — Βάρδια ' + sh.n + '</td></tr>';
          lastKey = key;
        }
        rows += '<tr><td>' + _t(o.plannedStart) + '</td><td>' + _d(o.plannedEnd) + ' ' + _t(o.plannedEnd) + '</td>' +
                '<td><b>' + _esc(o.id) + '</b></td><td>' + _esc(o.description) + '</td>' +
                '<td class="n">' + (o.linearMetres || 0).toLocaleString('el-GR') + '</td>' +
                '<td class="n">' + (o.kilos || 0).toLocaleString('el-GR') + '</td>' +
                '<td>' + (o.deliveryDate ? _d(o.deliveryDate) : '') + '</td>' +
                '<td class="chk">☐</td></tr>';
      });
      return '<section><h2>' + _esc(m.name) + ' <small>' + _esc(phaseLabel ? phaseLabel(m.phase) : m.phase) + '</small></h2>' +
             '<table><thead><tr><th>Έναρξη</th><th>Λήξη</th><th>Παραγγελία</th><th>Περιγραφή</th>' +
             '<th>Μέτρα</th><th>Κιλά</th><th>Παράδοση</th><th>✓</th></tr></thead><tbody>' + rows + '</tbody></table></section>';
    });

    if (!pages.length) { alert('Δεν υπάρχουν προγραμματισμένες παραγγελίες αυτή την εβδομάδα.'); return; }

    var title = 'Πρόγραμμα Παραγωγής ' + _d(wStart) + ' – ' + _d(new Date(wEnd - 1));
    var html = '<!doctype html><html lang="el"><head><meta charset="utf-8"><title>' + _esc(title) + '</title><style>' +
      'body{font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#111;margin:16px}' +
      'h1{font-size:14px;margin:0 0 8px}h2{font-size:15px;margin:0 0 6px;border-bottom:2px solid #2c3e50}h2 small{font-weight:normal;color:#555;font-size:11px}' +
      'section{page-break-after:always;margin-bottom:24px}section:last-child{page-break-after:auto}' +
      'table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:3px 5px;text-align:left;vertical-align:top}' +
      'th{background:#eef1f4}tr.grp td{background:#2c3e50;color:#fff;font-weight:600}td.n{text-align:right}td.chk{text-align:center;font-size:14px}' +
      '@media print{body{margin:0}.noprint{display:none}}' +
      '</style></head><body><div class="noprint" style="margin-bottom:10px"><button onclick="print()">🖨 Εκτύπωση</button></div>' +
      '<h1>' + _esc(title) + '</h1>' + pages.join('') + '</body></html>';
    var w = window.open('', '_blank');
    if (!w) { alert('Ο browser μπλόκαρε το νέο παράθυρο — επιτρέψτε τα pop-ups.'); return; }
    w.document.open(); w.document.write(html); w.document.close();
    setTimeout(function () { try { w.focus(); w.print(); } catch (e) {} }, 300);
  }

  global.PrintView = { open: open };
})(window);
