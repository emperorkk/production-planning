/* Login form handler — POSTs credentials + access level to /api/login, then lands on:
     desktop + full access → Προγραμματισμός (production-planner.html)
     phone or production access → Διαχείριση παραγωγής (production.html)
   Access level = Soft1 appId: full → 1199, production → 1200 (worker/access.js). */
(function () {
  'use strict';

  const form   = document.getElementById('login-form');
  const btn    = document.getElementById('btn-login');
  const errBox = document.getElementById('error');
  const ACCESS_KEY = 'pp-access';

  function isMobile() {
    const ua = navigator.userAgent || '';
    if (/Mobi|Android.+Mobile|iPhone|iPod|Windows Phone/i.test(ua)) return true;
    return !!(window.matchMedia && matchMedia('(max-width: 700px) and (pointer: coarse)').matches);
  }

  // Default access: remembered choice → phone = production, desktop = full
  let saved = null;
  try { saved = localStorage.getItem(ACCESS_KEY); } catch (_) {}
  const initial = (saved === 'full' || saved === 'production') ? saved : (isMobile() ? 'production' : 'full');
  const radio = form.querySelector('input[name="access"][value="' + initial + '"]');
  if (radio) radio.checked = true;

  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.add('visible');
  }
  function clearError() {
    errBox.textContent = '';
    errBox.classList.remove('visible');
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    clearError();
    btn.disabled = true;
    btn.textContent = 'Σύνδεση…';

    const accessEl = form.querySelector('input[name="access"]:checked');
    const access = accessEl ? accessEl.value : 'full';
    const body = {
      username: form.username.value.trim(),
      password: form.password.value,
      company:  form.company.value || undefined,
      branch:   form.branch.value  || undefined,
      access
    };

    try {
      const res = await fetch('/api/login', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
        credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(data.error || ('Αποτυχία σύνδεσης (' + res.status + ')'));
        return;
      }
      try { localStorage.setItem(ACCESS_KEY, access); } catch (_) {}
      const target = (data.access || access) === 'full' && !isMobile()
        ? '/production-planner.html'
        : '/production.html';
      window.location.replace(target);
    } catch (err) {
      showError('Σφάλμα δικτύου: ' + (err.message || err));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Σύνδεση';
    }
  });
})();
