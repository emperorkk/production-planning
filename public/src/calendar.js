/* Production calendar page — edits Soft1 CCCFXPCAL weeks (machine × day × shift) via /api/calendar. */
(function () {
  'use strict';

  var DAYS = ['ΔΕ', 'ΤΡ', 'ΤΕ', 'ΠΕ', 'ΠΑ', 'ΣΑ', 'ΚΥ'];
  var $ = function (id) { return document.getElementById(id); };
  var monday = null;          // Date (local midnight)
  var rows = [];              // [{ rsrc, name, code, phase, phaseName, flags:[21], orig:'...' }]
  var exists = false;

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function weekStart(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); var w = x.getDay(); x.setDate(x.getDate() + (w === 0 ? -6 : 1 - w)); return x; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function dirty() { return rows.some(function (r) { return r.flags.join('') !== r.orig; }); }

  var _t;
  function toast(msg, type) {
    var el = $('toast'); el.textContent = msg; el.className = 'visible ' + (type || '');
    clearTimeout(_t); _t = setTimeout(function () { el.classList.remove('visible'); }, 3500);
  }
  function loading(on) { $('loading-overlay').classList.toggle('visible', !!on); }

  function setWeek(d) {
    if (dirty() && !confirm('Υπάρχουν μη αποθηκευμένες αλλαγές στο ημερολόγιο. Συνέχεια;')) return;
    monday = weekStart(d);
    var end = new Date(monday); end.setDate(end.getDate() + 6);
    $('c-week').textContent = DateFmt.d(monday) + ' – ' + DateFmt.d(end);
    $('c-picker').value = iso(monday);
    $('c-back').href = 'production-planner.html';
    history.replaceState(null, '', 'calendar.html?week=' + iso(monday));
    load();
  }

  async function load() {
    loading(true);
    try {
      var r = await DataService.calendar('get', { monday: iso(monday) });
      if (r.success === false) throw new Error(r.error || 'Αποτυχία');
      exists = !!r.exists;
      rows = (r.data || []).map(function (x) {
        var f = [];
        for (var d = 1; d <= 7; d++) for (var s = 1; s <= 3; s++) f.push(+(x['S' + d + s] || 0) ? 1 : 0);
        return { rsrc: String(x.rsrc), name: x.name, code: x.code, phase: x.phase, phaseName: x.phaseName,
                 inCal: x.lineId != null || !exists, flags: f, orig: exists ? f.join('') : '' };
      });
      $('c-status').textContent = exists
        ? 'Εβδομάδα ' + (r.header && r.header.wk || '') + ' · κωδικός ' + (r.header && r.header.code || '') + ' · ' + rows.length + ' μηχανές'
        : 'Η εβδομάδα ' + (r.header && r.header.code || '') + ' δεν υπάρχει στο Soft1';
      $('c-missing').hidden = exists;
      render();
    } catch (e) {
      $('c-status').textContent = 'Σφάλμα: ' + (e.message || e);
      rows = []; render();
    } finally { loading(false); }
  }

  function render() {
    var t = $('c-grid');
    var head1 = '<tr><th class="c-m" rowspan="2">Μηχανή</th><th class="c-ph" rowspan="2">Φάση</th>';
    var head2 = '<tr>';
    for (var d = 0; d < 7; d++) {
      var dd = new Date(monday); dd.setDate(dd.getDate() + d);
      head1 += '<th colspan="3" class="c-day' + (d >= 5 ? ' we' : '') + '" data-day="' + d + '">' + DAYS[d] + ' ' + DateFmt.d(dd) + '</th>';
      for (var s = 0; s < 3; s++) head2 += '<th class="c-sh' + (s === 0 ? ' first' : '') + '" data-col="' + (d * 3 + s) + '">' + (s + 1) + '</th>';
    }
    head1 += '<th rowspan="2">Ώρες</th></tr>'; head2 += '</tr>';
    var body = rows.map(function (r, i) {
      var cells = r.flags.map(function (v, k) {
        var ch = r.orig && r.orig.charAt(k) !== String(v);
        return '<td class="c-cell' + (v ? ' on' : '') + (ch ? ' changed' : '') + (k % 3 === 0 ? ' first' : '') +
               (Math.floor(k / 3) >= 5 ? ' we' : '') + '" data-r="' + i + '" data-k="' + k + '"></td>';
      }).join('');
      var hrs = r.flags.reduce(function (a, b) { return a + b; }, 0) * 8;
      return '<tr' + (r.inCal ? '' : ' class="c-new" title="Η μηχανή δεν έχει γραμμή — θα προστεθεί"') + '>' +
             '<td class="c-m" data-row="' + i + '">' + esc(r.name) + '</td>' +
             '<td class="c-ph">' + esc(r.phaseName || r.phase || '') + '</td>' + cells +
             '<td class="c-h">' + hrs + '</td></tr>';
    }).join('');
    t.innerHTML = '<thead>' + head1 + head2 + '</thead><tbody>' + (body || '<tr><td colspan="24" class="c-empty">—</td></tr>') + '</tbody>';
    $('c-save').disabled = !exists || !dirty();
    var grid = t;
    grid.classList.toggle('readonly', !exists);
  }

  function toggleCells(list) {
    if (!exists) { toast('Δημιουργήστε πρώτα την εβδομάδα', 'warn'); return; }
    var allOn = list.every(function (c) { return rows[c[0]].flags[c[1]] === 1; });
    list.forEach(function (c) { rows[c[0]].flags[c[1]] = allOn ? 0 : 1; });
    render();
  }

  $('c-grid').addEventListener('click', function (e) {
    var td = e.target.closest('td, th');
    if (!td) return;
    if (td.dataset.k !== undefined) return toggleCells([[+td.dataset.r, +td.dataset.k]]);
    if (td.dataset.row !== undefined) {
      var i = +td.dataset.row, l = []; for (var k = 0; k < 21; k++) l.push([i, k]); return toggleCells(l);
    }
    if (td.dataset.col !== undefined) return toggleCells(rows.map(function (_, i) { return [i, +td.dataset.col]; }));
    if (td.dataset.day !== undefined) {
      var d = +td.dataset.day, l2 = [];
      rows.forEach(function (_, i) { for (var s = 0; s < 3; s++) l2.push([i, d * 3 + s]); });
      return toggleCells(l2);
    }
  });

  async function save() {
    var lines = rows.filter(function (r) { return r.flags.join('') !== r.orig; })
                    .map(function (r) { return { rsrc: r.rsrc, s: r.flags.join('') }; });
    if (!lines.length) return;
    loading(true);
    try {
      var r = await DataService.calendar('save', { monday: iso(monday), lines: lines });
      if (r.success === false) throw new Error((r.errors || []).map(function (e) { return (e.rsrc ? e.rsrc + ': ' : '') + e.error; }).join('\n') || r.error);
      toast('Αποθηκεύτηκε στο Soft1 (' + (r.updated || 0) + ' ενημερώσεις, ' + (r.inserted || 0) + ' νέες γραμμές)', 'success');
      rows.forEach(function (x) { x.orig = x.flags.join(''); x.inCal = true; });
      render();
    } catch (e) { alert('Σφάλμα αποθήκευσης:\n' + (e.message || e)); }
    finally { loading(false); }
  }

  async function create(copy) {
    loading(true);
    try {
      var r = await DataService.calendar('create', { monday: iso(monday), copy: copy });
      if (r.success === false) throw new Error(r.error);
      toast('Δημιουργήθηκε η εβδομάδα ' + (r.code || '') + (r.copiedFrom ? ' (από ' + r.copiedFrom + ')' : ''), 'success');
    } catch (e) { alert('Σφάλμα δημιουργίας:\n' + (e.message || e)); }
    finally { loading(false); }
    load();
  }

  async function fill() {
    var to = DateFmt.euToIso($('c-fill-to').value);
    if (!to) { toast('Δώστε ημερομηνία ηη/μμ/εεεε', 'warn'); return; }
    var toMon = weekStart(new Date(to + 'T00:00:00'));
    if (toMon < monday) { toast('Η ημερομηνία πρέπει να είναι μετά την τρέχουσα εβδομάδα', 'warn'); return; }
    var weeks = Math.round((toMon - monday) / 604800000) + 1;
    if (weeks > 27) { toast('Μέχρι 26 εβδομάδες τη φορά', 'warn'); return; }
    if (!confirm('Δημιουργία όσων εβδομάδων λείπουν από ' + DateFmt.d(monday) + ' έως ' + DateFmt.d(toMon) + ' (' + weeks + ' εβδ.), με αντιγραφή της προηγούμενης;')) return;
    loading(true);
    try {
      var r = await DataService.calendar('fill', { from: iso(monday), to: iso(toMon) });
      var msg = 'Δημιουργήθηκαν ' + (r.created || []).length + ' εβδομάδες' + ((r.skipped || []).length ? ', ' + r.skipped.length + ' υπήρχαν ήδη' : '');
      if (r.errors && r.errors.length) alert(msg + '\nΣφάλματα:\n' + r.errors.map(function (e) { return e.week + ': ' + e.error; }).join('\n'));
      else toast(msg, 'success');
    } catch (e) { alert('Σφάλμα:\n' + (e.message || e)); }
    finally { loading(false); }
    load();
  }

  $('c-prev').addEventListener('click', function () { var d = new Date(monday); d.setDate(d.getDate() - 7); setWeek(d); });
  $('c-next').addEventListener('click', function () { var d = new Date(monday); d.setDate(d.getDate() + 7); setWeek(d); });
  $('c-today').addEventListener('click', function () { setWeek(new Date()); });
  $('c-picker').addEventListener('change', function () { if (this.value) setWeek(new Date(this.value + 'T00:00:00')); });
  $('c-save').addEventListener('click', save);
  $('c-create').addEventListener('click', function () { create('previous'); });
  $('c-create-empty').addEventListener('click', function () { create('none'); });
  $('c-fill').addEventListener('click', fill);
  DateFmt.bind($('c-fill-to'));
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (e.key === 'ArrowLeft')  $('c-prev').click();
    if (e.key === 'ArrowRight') $('c-next').click();
  });
  window.addEventListener('beforeunload', function (e) { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

  (async function () {
    if (Soft1Bridge.init) { try { await Soft1Bridge.init(); } catch (e) {} }
    var q = /[?&]week=(\d{4}-\d{2}-\d{2})/.exec(location.search);
    setWeek(q ? new Date(q[1] + 'T00:00:00') : new Date());
  })();
})();
