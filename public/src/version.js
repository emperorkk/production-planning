/* Fills every [data-app-version] element with the deployed version (from /api/version). */
(function () {
  'use strict';
  function paint(text) {
    var els = document.querySelectorAll('[data-app-version]');
    for (var i = 0; i < els.length; i++) els[i].textContent = text;
  }
  if (location.protocol !== 'http:' && location.protocol !== 'https:') { paint('mock'); return; }
  fetch('/api/version', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) { paint(d.version ? 'v' + d.version : ''); })
    .catch(function () { paint(''); });
})();
