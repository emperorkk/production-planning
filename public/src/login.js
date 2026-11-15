/* Login form handler — POSTs credentials to /api/login and redirects on success. */
(function () {
  'use strict';

  const form   = document.getElementById('login-form');
  const btn    = document.getElementById('btn-login');
  const errBox = document.getElementById('error');

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

    const body = {
      username: form.username.value.trim(),
      password: form.password.value,
      company:  form.company.value || undefined,
      branch:   form.branch.value  || undefined
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
      // Success — go to the planner
      window.location.replace('/production-planner.html');
    } catch (err) {
      showError('Σφάλμα δικτύου: ' + (err.message || err));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Σύνδεση';
    }
  });
})();
