/* DateFmt — European date display/entry everywhere in the UI: dd/mm/yyyy (24h times).
   Internally the app keeps Date objects / ISO 'YYYY-MM-DD'; only what the user sees/types is European.

   d(date)        → 'dd/mm/yyyy'
   dm(date)       → 'dd/mm'           (only where space is tight, e.g. calendar grid)
   dt(date)       → 'dd/mm/yyyy HH:MM'
   t(date)        → 'HH:MM'
   parse(str)     → Date | null       accepts d/m/yyyy, dd.mm.yy, dd-mm-yyyy
   toIso(date)    → 'YYYY-MM-DD'
   fromIso(iso)   → Date (local midnight)
   isoToEu(iso)   → 'dd/mm/yyyy'
   euToIso(str)   → 'YYYY-MM-DD' | ''
   bind(input)    → normalise a text input to dd/mm/yyyy on blur/Enter */
(function (global) {
  'use strict';

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function valid(d) { return d instanceof Date && !isNaN(d.getTime()); }

  function d(x)  { return valid(x) ? pad(x.getDate()) + '/' + pad(x.getMonth() + 1) + '/' + x.getFullYear() : ''; }
  function dm(x) { return valid(x) ? pad(x.getDate()) + '/' + pad(x.getMonth() + 1) : ''; }
  function t(x)  { return valid(x) ? pad(x.getHours()) + ':' + pad(x.getMinutes()) : ''; }
  function dt(x) { return valid(x) ? d(x) + ' ' + t(x) : ''; }

  function parse(str) {
    var m = /^\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})\s*$/.exec(String(str || ''));
    if (!m) return null;
    var y = +m[3]; if (y < 100) y += 2000;
    var r = new Date(y, +m[2] - 1, +m[1]);
    return (r.getDate() === +m[1] && r.getMonth() === +m[2] - 1) ? r : null;
  }
  function toIso(x) { return valid(x) ? x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()) : ''; }
  function fromIso(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function isoToEu(iso) { return d(fromIso(iso)); }
  function euToIso(str) { return toIso(parse(str)); }

  function bind(input) {
    if (!input || input._dateBound) return;
    input._dateBound = true;
    input.setAttribute('placeholder', 'ηη/μμ/εεεε');
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('maxlength', '10');
    function norm() {
      if (!input.value.trim()) { input.classList.remove('date-bad'); return; }
      var p = parse(input.value);
      input.classList.toggle('date-bad', !p);
      if (p) input.value = d(p);
    }
    input.addEventListener('blur', norm);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') norm(); });
  }

  global.DateFmt = { d: d, dm: dm, dt: dt, t: t, parse: parse, toIso: toIso, fromIso: fromIso,
                     isoToEu: isoToEu, euToIso: euToIso, bind: bind };
})(window);
