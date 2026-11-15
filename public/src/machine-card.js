/* MachineCard — floating card with Soft1 machine (RSRC) details.
   Click a machine name (.gantt-machine-label) → native Soft1 getData (OBJECT=RSRC, KEY=id)
   via Soft1Bridge.record(). Closes on Esc, outside click or ✕. */
(function (global) {
  'use strict';

  var _card = null;
  var _getState = function () { return {}; };
  var _reqSeq = 0;

  // Field → [Greek label, formatter]
  var FIELDS = [
    ['CODE',       'Κωδικός'],
    ['ISACTIVE',   'Ενεργή',                    function (v) { return String(v) === '1' ? 'Ναι' : 'Όχι'; }],
    ['RSRCTYPE',   'Κατηγορία'],
    ['MPRDQTY',    'Ταχύτητα (μ./λεπτό)',        _num],
    ['SETUPTIME',  'Χρόνος setup (λεπτά)',       _num],
    ['WAITTIME',   'Χρόνος αναμονής (λεπτά)',    _num],
    ['MOVETIME',   'Χρόνος μεταφοράς (λεπτά)',   _num],
    ['QUETIME',    'Χρόνος παραγωγής (ώρες)',    _num],
    ['MINPRTIME',  'Ελάχ. διάρκεια (λεπτά)',     _num],
    ['MAXPRTIME',  'Μέγ. διάρκεια (λεπτά)',      _num],
    ['EFFICIENCY', 'Απόδοση %',                  _num],
    ['HWORK',      'Ώρες εργασίας',              _num],
    ['HCOST',      'Κόστος / ώρα',               _num],
    ['REMARKS',    'Παρατηρήσεις']
  ];

  function _num(v) {
    var n = parseFloat(v);
    return isNaN(n) ? String(v) : n.toLocaleString('el-GR', { maximumFractionDigits: 3 });
  }
  function _esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function close() {
    if (_card) { _card.remove(); _card = null; }
  }

  function _position(card, anchor) {
    var r = anchor.getBoundingClientRect();
    var w = card.offsetWidth, h = card.offsetHeight;
    var left = r.right + 8;
    if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - 8);
    var top = Math.min(r.top, window.innerHeight - h - 8);
    card.style.left = left + 'px';
    card.style.top  = Math.max(8, top) + 'px';
  }

  function _phasesHtml(machineId) {
    var st = _getState() || {};
    var phases = (st.machinePhases && st.machinePhases[machineId]) || [];
    if (!phases.length) return '';
    return '<div class="mc-phases">' + phases.map(function (p) {
      var nm = st.phaseNames && st.phaseNames[p];
      return '<span class="mc-chip">' + _esc(nm ? nm + ' (' + p + ')' : p) + '</span>';
    }).join('') + '</div>';
  }

  async function open(machineId, anchor) {
    close();
    var st = _getState() || {};
    var local = (st.machineById && st.machineById[machineId]) || {};
    var seq = ++_reqSeq;

    _card = document.createElement('div');
    _card.className = 'machine-card';
    _card.innerHTML =
      '<div class="mc-head"><div class="mc-title">' + _esc(local.name || machineId) + '</div>' +
      '<button class="mc-close" title="Κλείσιμο">&times;</button></div>' +
      _phasesHtml(machineId) +
      '<div class="mc-body"><div class="mc-loading">Φόρτωση από Soft1…</div></div>';
    document.body.appendChild(_card);
    _card.querySelector('.mc-close').addEventListener('click', close);
    _position(_card, anchor);

    var body = _card.querySelector('.mc-body');
    try {
      var data = await Soft1Bridge.record('RSRC', machineId);
      if (seq !== _reqSeq || !_card) return;
      var rec = (data.RSRC && data.RSRC[0]) || null;
      if (!rec) { body.innerHTML = '<div class="mc-empty">Δεν βρέθηκαν στοιχεία.</div>'; return; }
      if (rec.NAME) _card.querySelector('.mc-title').textContent = rec.NAME;
      var rows = FIELDS.filter(function (f) {
        var v = rec[f[0]];
        return v !== undefined && v !== null && v !== '';
      }).map(function (f) {
        var v = f[2] ? f[2](rec[f[0]]) : rec[f[0]];
        return '<div class="mc-row"><span class="mc-k">' + _esc(f[1]) + '</span><span class="mc-v">' + _esc(v) + '</span></div>';
      });
      body.innerHTML = rows.join('') || '<div class="mc-empty">Δεν βρέθηκαν στοιχεία.</div>';
      _position(_card, anchor);
    } catch (e) {
      if (seq !== _reqSeq || !_card) return;
      body.innerHTML = '<div class="mc-error">Σφάλμα: ' + _esc(e.message || e) + '</div>';
    }
  }

  function init(getState) {
    if (typeof getState === 'function') _getState = getState;
    document.addEventListener('click', function (e) {
      var label = e.target.closest && e.target.closest('.gantt-machine-label');
      if (label && label.dataset.machineId) { e.stopPropagation(); open(label.dataset.machineId, label); return; }
      if (_card && !_card.contains(e.target)) close();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    window.addEventListener('resize', close);
  }

  global.MachineCard = { init: init, open: open, close: close };
})(window);
