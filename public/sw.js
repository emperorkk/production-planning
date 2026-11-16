/* Service worker for the installable «Διαχείριση παραγωγής» app.
   Network only (live Soft1 data must never come from a cache); when offline, page
   navigations get a short Greek notice instead of the browser error page. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  if (e.request.mode !== 'navigate') return;          // everything else: default network
  e.respondWith(fetch(e.request).catch(function () {
    return new Response(
      '<!doctype html><html lang="el"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Εκτός σύνδεσης</title><body style="font-family:sans-serif;padding:24px;text-align:center">' +
      '<h2 style="color:#ee1c25">Εκτός σύνδεσης</h2><p>Δεν υπάρχει σύνδεση στο δίκτυο. Δοκιμάστε ξανά.</p>' +
      '<button onclick="location.reload()" style="padding:10px 18px">Επανάληψη</button></body></html>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }));
});
