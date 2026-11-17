/* Soft1Bridge — two modes, same API:
     1. WEB   — page served by the Cloudflare Worker; fetch('/api/data' | '/api/save') + session cookie
     2. MOCK  — opened as a local file (file://); uses built-in demo data

   The embedded x=external (window.external COM) mode is DEPRECATED and frozen in
   legacy/embedded/ — no further updates there.

   Every method returns a Promise so DataService can `await` regardless of mode. */
(function (global) {
  'use strict';

  // ─── Mode detection ───────────────────────────────────────────────────────
  var isHttp = (location.protocol === 'http:' || location.protocol === 'https:');
  var MODE   = isHttp ? 'web' : 'mock';

  // ─── Mock data (unchanged) ────────────────────────────────────────────────
  var MOCK_DATA = {
    machines: [
      { id:'CNC-1', name:'CNC Μηχανή 1',  phase:'1001', setupTime:15, waitTime: 5, averageSpeed:12 },
      { id:'CNC-2', name:'CNC Μηχανή 2',  phase:'1001', setupTime:20, waitTime: 5, averageSpeed:10 },
      { id:'WLD-A', name:'Συγκόλληση A',  phase:'2001', setupTime:10, waitTime:15, averageSpeed: 6 },
      { id:'WLD-B', name:'Συγκόλληση B',  phase:'2001', setupTime:10, waitTime:15, averageSpeed: 8 },
      { id:'PNT-1', name:'Βαφή 1',        phase:'3001', setupTime:30, waitTime:45, averageSpeed: 4 },
      { id:'ASM-1', name:'Συναρμολόγηση', phase:'4001', setupTime: 5, waitTime: 0, averageSpeed:15 }
    ],
    phaseMachines: [
      { phase:'1001', machine:'CNC-1', phaseName:'Κοπή' },
      { phase:'1001', machine:'CNC-2', phaseName:'Κοπή' },
      { phase:'1001', machine:'WLD-A', phaseName:'Κοπή' },
      { phase:'2001', machine:'WLD-A', phaseName:'Συγκόλληση' },
      { phase:'2001', machine:'WLD-B', phaseName:'Συγκόλληση' },
      { phase:'3001', machine:'PNT-1', phaseName:'Βαφή' },
      { phase:'4001', machine:'ASM-1', phaseName:'Συναρμολόγηση' },
      { phase:'4001', machine:'WLD-B', phaseName:'Συναρμολόγηση' }
    ],
    productionOrders: [
      { id:'ΠΕ-2401', description:'80398 Κιβώτιο Α', deliveryDate:_nextWeekDate(3), kilos:240, linearMetres:1500, status: 0, phase:'1001', machineId:null,    plannedStart:null, plannedEnd:null, mtrl:80398, salesOrderRef:'SO-501' },
      { id:'ΠΕ-2402', description:'80399 Πλαίσιο Β', deliveryDate:_nextWeekDate(4), kilos:180, linearMetres: 900, status: 0, phase:'2001', machineId:'WLD-A', plannedStart:null, plannedEnd:null, mtrl:80399, salesOrderRef:'SO-501', machineLock:1 },
      { id:'ΠΕ-2403', description:'79728 Βάση Γ',    deliveryDate:_nextWeekDate(2), kilos:520, linearMetres:2400, status: 0, phase:'1001', machineId:null,    plannedStart:null, plannedEnd:null, mtrl:79728, salesOrderRef:'SO-502' },
      { id:'ΠΕ-2404', description:'80401 Στήριγμα Δ',deliveryDate:_nextWeekDate(5), kilos: 90, linearMetres: 600, status:-1, phase:'3001', machineId:null,    plannedStart:null, plannedEnd:null, mtrl:80401, salesOrderRef:'SO-503' },
      { id:'ΠΕ-2405', description:'80400 Καπάκι Ε',  deliveryDate:_nextWeekDate(1), kilos:320, linearMetres:1800, status: 0, phase:'4001', machineId:null,    plannedStart:null, plannedEnd:null, mtrl:80400, salesOrderRef:'SO-504' },
      { id:'ΠΕ-2400', description:'80300 Καπάκι (ολοκληρώθηκε)', deliveryDate:_nextWeekDate(-1), kilos:120, linearMetres:600, status:1, phase:'2001', machineId:'WLD-B', plannedStart:_pastDate(1, 9, 0), plannedEnd:_pastDate(1, 11, 30), mtrl:80300, salesOrderRef:'SO-499' }
    ],
    shifts: [],
    mtrlTree: [
      { mtrl:79728, lineNum:1, raw1:80398, raw2:76737, raw3:null, raw4:null, prdMtrl:79728, phase:'3001', kilos:1.0, metres:45.06 },
      { mtrl:79728, lineNum:2, raw1:80399, raw2:3460,  raw3:null, raw4:null, prdMtrl:80398, phase:'2001', kilos:1.0, metres:45.06 },
      { mtrl:79728, lineNum:3, raw1:6384,  raw2:null,  raw3:80400, raw4:80401, prdMtrl:80399, phase:'1001', kilos:1.0, metres:45.06 }
    ]
  };

  function _pastDate(daysAgo, h, m) {
    var d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h, m, 0, 0);
    return d;
  }
  function _nextWeekDate(dayOffset) {
    var d = new Date();
    d.setDate(d.getDate() + dayOffset);
    return d;
  }

  // ─── Session cache (populated by /api/me on web boot) ────────────────────
  var _webSession = { user: null, company: null, branch: null, expiresAt: null, access: 'full' };

  // ─── Named dataset via /api/data → Foxline.planning/<name> ───────────────
  async function _webDataset(name, params) {
    const res = await fetch('/api/data', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body:    JSON.stringify({ dataset: name, params: params || {} })
    });
    if (res.status === 401) {
      window.location.replace('/login.html');
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
    return data.rows || [];
  }

  // Production calendar via /api/calendar → Foxline.planning (full response object)
  async function _webCalendar(action, body) {
    const res = await fetch('/api/calendar', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body:    JSON.stringify(Object.assign({ action: action }, body))
    });
    if (res.status === 401) {
      window.location.replace('/login.html');
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.error && !data.errors)) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  // Mock calendar store (file:// demo): monday → { rsrc: flags21 }
  var _mockCal = {};
  function _mockCalendar(action, body) {
    var machines = MOCK_DATA.machines;
    if (action === 'get') {
      var wk = _mockCal[body.monday];
      return Promise.resolve({ success: true, exists: !!wk, header: { code: 'demo', wk: '' },
        data: machines.map(function (m) {
          var row = { rsrc: m.id, code: m.id, name: m.name, phase: m.phase, phaseName: '' };
          var f = wk ? (wk[m.id] || '000000000000000000000') : '000000000000000000000';
          for (var i = 0; i < 21; i++) row['S' + (Math.floor(i / 3) + 1) + (i % 3 + 1)] = +f.charAt(i);
          return row;
        }) });
    }
    if (action === 'create') {
      var flags = {}; machines.forEach(function (m) { flags[m.id] = body.copy === 'none' ? '000000000000000000000' : '111111111111111111000'; });
      _mockCal[body.monday] = flags;
      return Promise.resolve({ success: true, code: 'demo', copiedFrom: null });
    }
    if (action === 'save') {
      var w = _mockCal[body.monday] = _mockCal[body.monday] || {};
      body.lines.forEach(function (l) { w[l.rsrc] = l.s; });
      return Promise.resolve({ success: true, updated: body.lines.length, inserted: 0, errors: [] });
    }
    if (action === 'fill')  return Promise.resolve({ success: true, created: [], skipped: [], errors: [] });
    if (action === 'weeks') return Promise.resolve({ success: true, data: [] });
    return Promise.reject(new Error('Unknown action'));
  }

  // Native Soft1 getData via /api/record → { TABLE: [ {field: value} ] }
  async function _webRecord(object, key) {
    const res = await fetch('/api/record', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body:    JSON.stringify({ object: object, key: key })
    });
    if (res.status === 401) {
      window.location.replace('/login.html');
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
    return data.data || {};
  }

  // Batched schedule write via /api/save → Foxline.planning/SaveSchedule.
  // orders: [{ findoc, machine|null, start|null, end|null }]  (dates 'YYYY-MM-DD HH:MM')
  async function _webSave(orders) {
    const res = await fetch('/api/save', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body:    JSON.stringify({ orders: orders })
    });
    if (res.status === 401) {
      window.location.replace('/login.html');
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.error && !data.errors)) throw new Error(data.error || ('HTTP ' + res.status));
    return data;   // { ok, saved, skipped, errors[] }
  }

  // Pulls user/company/branch from the session cookie on first boot.
  async function _loadWebSession() {
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      if (res.status === 401) { window.location.replace('/login.html'); return; }
      const data = await res.json();
      _webSession.user    = data.user;
      _webSession.company = data.company;
      _webSession.branch  = data.branch;
      _webSession.expiresAt = data.expiresAt || null;
      _webSession.access    = data.access === 'production' ? 'production' : 'full';
    } catch (_) { /* keep defaults */ }
  }

  // ─── Public API — always async ───────────────────────────────────────────
  var Soft1Bridge = {
    mode:   MODE,
    isMock: (MODE === 'mock'),
    isWeb:  (MODE === 'web'),

    // One-time init (called by UIController before loading data)
    init: async function () {
      if (MODE === 'web') await _loadWebSession();
    },

    // Named dataset (GetMachines, GetOrdersInWeek, ...). Mock mode returns [] —
    // DataService serves mock data itself.
    dataset: async function (name, params) {
      if (MODE === 'mock') return [];
      return _webDataset(name, params);
    },

    // One record of a Soft1 object (native getData). Mock: built from mock machines.
    record: async function (object, key) {
      if (MODE === 'mock') {
        var m = MOCK_DATA.machines.filter(function (x) { return String(x.id) === String(key); })[0] || {};
        return { RSRC: [{ RSRC: key, CODE: m.id, NAME: m.name, ISACTIVE: 1, SETUPTIME: m.setupTime,
                          WAITTIME: m.waitTime, MPRDQTY: m.averageSpeed, REMARKS: 'Demo' }] };
      }
      return _webRecord(object, key);
    },

    // Production calendar actions: get | weeks | create | save | fill
    calendar: function (action, body) {
      if (MODE === 'mock') return _mockCalendar(action, body || {});
      return _webCalendar(action, body || {});
    },

    // Native Soft1 changePassword (web user) via /api/change-password
    changePassword: async function (oldPw, newPw) {
      if (MODE === 'mock') return true;
      const res = await fetch('/api/change-password', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ old: oldPw, new: newPw })
      });
      if (res.status === 401) { window.location.replace('/login.html'); throw new Error('Session expired'); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
      return true;
    },

    // Native Soft1 setData RSRC via /api/machine. fields: { SETUPTIME, WAITTIME, MPRDQTY, ISACTIVE, REMARKS }
    machineSave: async function (key, fields) {
      if (MODE === 'mock') { console.log('[MOCK MACHINE SAVE]', key, fields); return { RSRC: [Object.assign({ RSRC: key }, fields)] }; }
      const res = await fetch('/api/machine', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ key: key, fields: fields })
      });
      if (res.status === 401) { window.location.replace('/login.html'); throw new Error('Session expired'); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
      return data.data || {};
    },

    // Move production orders in time (same machine) via /api/move → SaveSchedule.
    // orders: [{ findoc, start, end, origMachine, origStart, origEnd }]  ('YYYY-MM-DD HH:MM')
    moveOrders: async function (orders) {
      if (MODE === 'mock') { console.log('[MOCK MOVE]', orders); return { ok: true, saved: orders.length, skipped: 0, errors: [] }; }
      const res = await fetch('/api/move', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ orders: orders })
      });
      if (res.status === 401) { window.location.replace('/login.html'); throw new Error('Session expired'); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !data.errors) throw new Error(data.error || ('HTTP ' + res.status));
      return data;   // { ok, saved, skipped, conflicts, errors[] }
    },

    // Reserve machine (BOOL01) / lock production day (BOOL02) of one order via /api/order-locks.
    // body: { findoc, machineLock: 0|1, dayLock: 0|1, machine?, start?, end? } ('YYYY-MM-DD HH:MM')
    orderLocks: async function (body) {
      if (MODE === 'mock') { console.log('[MOCK LOCKS]', body); return { ok: true, machineLock: body.machineLock, dayLock: body.dayLock }; }
      const res = await fetch('/api/order-locks', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(body)
      });
      if (res.status === 401) { window.location.replace('/login.html'); throw new Error('Session expired'); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    },

    // 'full' (planner + production app) | 'production' (production app only)
    get access() { return MODE === 'web' ? _webSession.access : 'full'; },

    get expiresAt() { return MODE === 'web' ? _webSession.expiresAt : null; },

    // Batched write of planner results.
    saveSchedule: async function (orders) {
      if (MODE === 'mock') { console.log('[MOCK SAVE]', orders); return { ok: true, saved: orders.length, skipped: 0, errors: [] }; }
      return _webSave(orders);
    },

    get user()    {
      if (MODE === 'web') return _webSession.user || 'web-user';
      return 'demo';
    },
    get company() {
      if (MODE === 'web') return _webSession.company || 1000;
      return 1000;
    },
    get branch() {
      if (MODE === 'web') return _webSession.branch || this.company;
      return this.company;
    },

    warn: function (msg) { alert(msg); },

    logout: async function () {
      if (MODE !== 'web') return;
      try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) {}
      window.location.replace('/login.html');
    },

    mockData: MOCK_DATA
  };

  global.Soft1Bridge = Soft1Bridge;

})(window);
