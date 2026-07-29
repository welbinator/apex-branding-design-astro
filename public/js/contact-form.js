// Apex Branding contact form — client-side submit handler.
// Serializes the form to JSON, attaches the Turnstile token, POSTs to /api/contact,
// and renders inline success/error status without a page reload.
(function () {
  var form = document.getElementById('form_contact-us');
  if (!form) return;
  var statusEl = document.getElementById('cf_form_status');

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = kind === 'error' ? '#b00020' : '#1a7f37';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = form.querySelector('button[type="submit"]');

    // Basic required-field check (server re-validates authoritatively).
    var first = form.first_name.value.trim();
    var last = form.last_name.value.trim();
    var email = form.email.value.trim();
    var message = form.message.value.trim();
    if (!first || !last || !email || !message) {
      setStatus('Please fill in your name, email, and message.', 'error');
      return;
    }

    // Turnstile token (widget injects a hidden input named cf-turnstile-response).
    var tokenInput = form.querySelector('[name="cf-turnstile-response"]');
    var token = tokenInput ? tokenInput.value : '';
    if (!token) {
      setStatus('Please complete the verification challenge and try again.', 'error');
      return;
    }

    var interests = Array.prototype.slice
      .call(form.querySelectorAll('input[name="interests"]:checked'))
      .map(function (el) { return el.value; });

    var outsourcingEl = form.querySelector('input[name="outsourcing"]:checked');

    var payload = {
      first_name: first,
      last_name: last,
      email: email,
      phone: form.phone.value.trim(),
      website: form.website.value.trim(),
      interests: interests,
      outsourcing: outsourcingEl ? outsourcingEl.value : '',
      budget: form.budget.value.trim(),
      message: message,
      follow_up_ok: form.follow_up_ok.checked,
      website_hp: form.website_hp.value,
      turnstile_token: token,
    };

    if (btn) { btn.disabled = true; }
    setStatus('Sending…', 'ok');

    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (r) {
        if (r.ok && r.data && r.data.ok) {
          form.reset();
          setStatus("Thanks! Your message has been sent. We'll be in touch soon.", 'ok');
          if (window.turnstile) { try { window.turnstile.reset(); } catch (_) {} }
        } else {
          setStatus((r.data && r.data.error) || 'Something went wrong. Please try again.', 'error');
          if (window.turnstile) { try { window.turnstile.reset(); } catch (_) {} }
        }
      })
      .catch(function () {
        setStatus('Network error. Please try again.', 'error');
      })
      .finally(function () {
        if (btn) { btn.disabled = false; }
      });
  });
})();
