/* InfoCard — floating detail cards.
   MachineCard: click a machine name  → native Soft1 getData (OBJECT=RSRC, KEY=id) via Soft1Bridge.record()
   OrderCard:   click an order (Gantt block or unscheduled card) → Foxline.planning/GetOrderDetails
                + phase chain (predecessors / successors) from the planner state.
   Close: Esc, outside click or ✕. */
(function (global) {
  'use strict';

  var _card = null;
  var _reqSeq = 0;
  var _ctx = { getState: function () { return {}; }, getChain: function () { return null; }, onJump: null };

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function _num(v) {
    var n = parseFloat(v);
    return isNaN(n) ? String(v) : n.toLocaleString('el-GR', { maximumFractionDigits: 3 });
  }
  function _date(v) {
    if (!v) return '';
    var d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));
    if (isNaN(d) || d.getFullYear() < 1990) return '';
    return d.toLocaleDateString('el-GR');
  }
  function _dt(d) {
    if (!d) return '';
    return d.toLocaleDateString('el-GR', { day: '2-digit', month: '2-digit' }) + ' ' +
           d.toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' });
  }

  function close() { if (_card) { _card.remove(); _card = null; } }

  function _position(card, anchor) {
    var r = anchor.getBoundingClientRect();
    var w = card.offsetWidth, h = card.offsetHeight;
    var left = r.right + 8;
    if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - 8);
    var top = Math.min(r.top, window.innerHeight - h - 8);
    card.style.left = left + 'px';
    card.style.top  = Math.max(8, top) + 'px';
  }

  // Generic: title, optional chips/extra HTML, async loader returning [[label, value], ...]
  async function show(anchor, opts) {
    close();
    var seq = ++_reqSeq;
    _card = document.createElement('div');
    _card.className = 'machine-card info-card';
    _card.innerHTML =
      '<div class="mc-head"><div class="mc-title">' + _esc(opts.title) + '</div>' +
      '<button class="mc-close" title="Κλείσιμο">&times;</button></div>' +
      (opts.topHtml || '') +
      '<div class="mc-body"><div class="mc-loading">Φόρτωση από Soft1…</div></div>' +
      (opts.bottomHtml || '');
    document.body.appendChild(_card);
    _card.querySelector('.mc-close').addEventListener('click', close);
    if (opts.bind) opts.bind(_card);
    _position(_card, anchor);

    var body = _card.querySelector('.mc-body');
    try {
      var res = await opts.load();
      if (seq !== _reqSeq || !_card) return;
      if (res && res.title) _card.querySelector('.mc-title').textContent = res.title;
      var rows = (res && res.rows || []).filter(function (r) { return r[1] !== undefined && r[1] !== null && r[1] !== ''; });
      body.innerHTML = rows.length
        ? rows.map(function (r) {
            return '<div class="mc-row"><span class="mc-k">' + _esc(r[0]) + '</span><span class="mc-v">' + _esc(r[1]) + '</span></div>';
          }).join('')
        : '<div class="mc-empty">Δεν βρέθηκαν στοιχεία.</div>';
      _position(_card, anchor);
    } catch (e) {
      if (seq !== _reqSeq || !_card) return;
      body.innerHTML = '<div class="mc-error">Σφάλμα: ' + _esc(e.message || e) + '</div>';
    }
  }

  // ── Machine (RSRC) ──────────────────────────────────────────────────────
  var M_FIELDS = [
    ['CODE', 'Κωδικός'],
    ['ISACTIVE', 'Ενεργή', function (v) { return String(v) === '1' ? 'Ναι' : 'Όχι'; }],
    ['RSRCTYPE', 'Κατηγορία'],
    ['MPRDQTY', 'Ταχύτητα (μ./λεπτό)', _num],
    ['SETUPTIME', 'Χρόνος setup (λεπτά)', _num],
    ['WAITTIME', 'Χρόνος αναμονής (λεπτά)', _num],
    ['MOVETIME', 'Χρόνος μεταφοράς (λεπτά)', _num],
    ['QUETIME', 'Χρόνος παραγωγής (ώρες)', _num],
    ['MINPRTIME', 'Ελάχ. διάρκεια (λεπτά)', _num],
    ['MAXPRTIME', 'Μέγ. διάρκεια (λεπτά)', _num],
    ['EFFICIENCY', 'Απόδοση %', _num],
    ['HWORK', 'Ώρες εργασίας', _num],
    ['HCOST', 'Κόστος / ώρα', _num],
    ['REMARKS', 'Παρατηρήσεις']
  ];

  function openMachine(machineId, anchor) {
    var st = _ctx.getState() || {};
    var local = (st.machineById && st.machineById[machineId]) || {};
    var phases = (st.machinePhases && st.machinePhases[machineId]) || [];
    var chips = phases.length ? '<div class="mc-phases">' + phases.map(function (p) {
      var nm = st.phaseNames && st.phaseNames[p];
      return '<span class="mc-chip">' + _esc(nm ? nm + ' (' + p + ')' : p) + '</span>';
    }).join('') + '</div>' : '';
    return show(anchor, {
      title: local.name || machineId,
      topHtml: chips,
      load: async function () {
        var data = await Soft1Bridge.record('RSRC', machineId);
        var rec = (data.RSRC && data.RSRC[0]) || null;
        if (!rec) return { rows: [] };
        return {
          title: rec.NAME || local.name,
          rows: M_FIELDS.map(function (f) { var v = rec[f[0]]; return [f[1], v == null || v === '' ? v : (f[2] ? f[2](v) : v)]; })
        };
      }
    });
  }

  // ── Production order ────────────────────────────────────────────────────
  var STATUS = { '-1': 'Δημιουργήθηκε', '0': 'Αποδεσμευμένη', '1': 'Ολοκληρωμένη' };

  function openOrder(orderId, anchor) {
    var st = _ctx.getState() || {};
    var o = (st.orderById && st.orderById[orderId]) || { id: orderId };
    var chain = _ctx.getChain();
    var machine = o.machineId && st.machineById ? st.machineById[o.machineId] : null;

    var sched = o.plannedStart
      ? '<div class="mc-sched">&#128197; ' + _esc(_dt(o.plannedStart)) + ' – ' + _esc(_dt(o.plannedEnd)) +
        (machine ? ' · ' + _esc(machine.name) : '') +
        (_ctx.onJump ? ' <button class="mc-link" data-jump="1">Μετάβαση</button>' : '') + '</div>'
      : '<div class="mc-sched mc-muted">Μη προγραμματισμένη</div>';

    var chainHtml = '';
    if (chain) {
      var pre = chain.predecessors(o), suc = chain.successors(o);
      function item(x, arrow) {
        var nm = st.phaseNames && st.phaseNames[x.phase] || x.phase;
        var when = x.plannedStart ? _dt(x.plannedStart) + '–' + _dt(x.plannedEnd) : 'μη προγρ.';
        var bad = arrow === '←' ? (x.plannedEnd && o.plannedStart && o.plannedStart < x.plannedEnd)
                                : (x.plannedStart && o.plannedEnd && x.plannedStart < o.plannedEnd);
        return '<div class="mc-chain-item' + (bad ? ' bad' : '') + '">' + arrow + ' <b>' + _esc(x.id) + '</b> ' +
               _esc(nm) + ' <span class="mc-muted">' + _esc(when) + '</span></div>';
      }
      if (pre.length || suc.length) {
        chainHtml = '<div class="mc-chain"><div class="mc-chain-h">Αλυσίδα φάσεων</div>' +
          pre.map(function (x) { return item(x, '←'); }).join('') +
          '<div class="mc-chain-item me">● <b>' + _esc(o.id) + '</b> ' + _esc((st.phaseNames && st.phaseNames[o.phase]) || o.phase || '') + '</div>' +
          suc.map(function (x) { return item(x, '→'); }).join('') + '</div>';
      }
    }

    var prodHtml = '<div class="mc-prod"><div class="mc-chain-h">Παραγωγή (ρολά / lots)</div>' +
                   '<div class="mc-prod-body mc-muted">Φόρτωση…</div></div>';

    return show(anchor, {
      title: o.id + (o.description ? ' — ' + o.description : ''),
      topHtml: sched,
      bottomHtml: prodHtml + chainHtml,
      bind: function (card) {
        var j = card.querySelector('[data-jump]');
        if (j) j.addEventListener('click', function () { close(); _ctx.onJump(o); });
        var seq = _reqSeq;
        DataService.getProductionRolls(orderId).then(function (rolls) {
          if (seq !== _reqSeq || !_card) return;
          var box = card.querySelector('.mc-prod-body');
          if (!rolls || !rolls.length) { box.textContent = 'Δεν υπάρχει παραγωγή ακόμα.'; return; }
          var total = rolls.reduce(function (a, r) { return a + (parseFloat(r.qty) || 0); }, 0);
          var pct = o.kilos > 0 ? Math.round(total / o.kilos * 100) : null;
          box.className = 'mc-prod-body';
          box.innerHTML =
            '<div class="mc-prod-sum"><b>' + _num(total) + '</b> / ' + _num(o.kilos || 0) +
            (pct != null ? ' (' + pct + '%)' : '') + ' · <b>' + rolls.length + '</b> ρολά</div>' +
            '<div class="mc-prod-bar"><div style="width:' + Math.min(100, pct || 0) + '%"></div></div>' +
            '<table class="mc-rolls"><thead><tr><th>Lot</th><th>Ημ/νία</th><th>Ποσ.</th></tr></thead><tbody>' +
            rolls.map(function (r) {
              return '<tr><td>' + _esc(r.lot) + '</td><td>' + _esc(_date(r.trndate)) + '</td><td class="n">' + _esc(_num(r.qty)) + '</td></tr>';
            }).join('') + '</tbody></table>';
        }).catch(function (e) {
          if (seq !== _reqSeq || !_card) return;
          card.querySelector('.mc-prod-body').textContent = 'Σφάλμα: ' + (e.message || e);
        });
      },
      load: async function () {
        var d = await DataService.getOrderDetails(orderId) || {};
        var phaseNm = st.phaseNames && st.phaseNames[d.phase != null ? String(d.phase) : o.phase];
        return {
          rows: [
            ['Παραστατικό', d.fincode],
            ['Ημερομηνία', _date(d.trndate)],
            ['Είδος', [d.itemCode, d.itemName].filter(Boolean).join(' ')],
            ['Κωδ. πελάτη', d.customerItemCode],
            ['Πελάτης', d.customer],
            ['Παραγγελία πώλησης', d.salesOrder],
            ['PO πελάτη', d.customerPO],
            ['Παράδοση', _date(d.deliveryDate || o.deliveryDate)],
            ['Μέτρα', d.linearMetres != null ? _num(d.linearMetres) : _num(o.linearMetres)],
            ['Κιλά', d.kilos != null ? _num(d.kilos) : _num(o.kilos)],
            ['Φάση', phaseNm ? phaseNm + ' (' + (d.phase || o.phase) + ')' : (d.phase || o.phase)],
            ['Κατάσταση', STATUS[String(d.status != null ? d.status : o.status)]],
            ['Μηχανή (Soft1)', d.machineName],
            ['Παρατηρήσεις', d.remarks]
          ]
        };
      }
    });
  }

  function init(ctx) {
    if (typeof ctx === 'function') ctx = { getState: ctx };
    Object.keys(ctx || {}).forEach(function (k) { _ctx[k] = ctx[k]; });
    document.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      var label = e.target.closest('.gantt-machine-label');
      if (label && label.dataset.machineId) { e.stopPropagation(); openMachine(label.dataset.machineId, label); return; }
      var block = e.target.closest('.gantt-block');
      if (block && !e.target.closest('.resize-handle')) { e.stopPropagation(); openOrder(block.dataset.orderId, block); return; }
      var card = e.target.closest('.order-card');
      if (card && card.dataset.orderId) { e.stopPropagation(); openOrder(card.dataset.orderId, card); return; }
      if (_card && !_card.contains(e.target)) close();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    window.addEventListener('resize', close);
  }

  global.InfoCard    = { init: init, show: show, close: close, openMachine: openMachine, openOrder: openOrder };
  global.MachineCard = { init: init, open: openMachine, close: close };   // backwards compat
})(window);
