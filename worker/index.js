// Cloudflare Worker entry for apexbranding.design
// - Serves the static Astro site from the ASSETS binding (./dist)
// - Handles POST /api/contact: validation, Turnstile, parameterized D1 insert, rate limit
//
// Bindings (see wrangler.jsonc):
//   ASSETS            -> static assets (dist/)
//   DB                -> D1 database (apex-contact-submissions)
// Secrets (set via `wrangler secret put` / dashboard):
//   TURNSTILE_SECRET  -> Cloudflare Turnstile secret key
//   ALLOWED_ORIGIN    -> e.g. https://apexbranding.design (optional; falls back to request host)

const LIMITS = {
  first_name: 100,
  last_name: 100,
  email: 254,
  phone: 40,
  website: 300,
  budget: 100,
  message: 5000,
};
const VALID_INTERESTS = new Set([
  'Rebrand/Brand Development',
  'Website Design',
  'Graphic Design',
  'eCommerce',
]);
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MIN = 10;
const MAX_BODY_BYTES = 16 * 1024;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

async function verifyTurnstile(token, secret, ip) {
  if (!secret) return { ok: false, reason: 'no-secret' };
  if (!token) return { ok: false, reason: 'no-token' };
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', body: form }
  );
  const data = await res.json().catch(() => ({ success: false }));
  return { ok: !!data.success, reason: (data['error-codes'] || []).join(',') };
}

async function rateLimited(db, ip) {
  if (!ip) return false;
  try {
    const sinceIso = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    const row = await db
      .prepare(
        'SELECT COUNT(*) AS c FROM submissions WHERE ip_address = ? AND created_at >= ?'
      )
      .bind(ip, sinceIso)
      .first();
    return row && row.c >= RATE_LIMIT_MAX;
  } catch (_) {
    return false;
  }
}

async function handleContact(request, env) {
  const url = new URL(request.url);
  const allowed = env.ALLOWED_ORIGIN || `${url.protocol}//${url.host}`;
  const origin = request.headers.get('Origin');
  if (origin && origin !== allowed) {
    return json({ ok: false, error: 'Invalid origin.' }, 403);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'Payload too large.' }, 413);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    return json({ ok: false, error: 'Invalid request.' }, 400);
  }

  // Honeypot: real users leave this blank. Pretend success, store nothing.
  if (clean(body.website_hp, 200)) {
    return json({ ok: true });
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ts = await verifyTurnstile(body.turnstile_token, env.TURNSTILE_SECRET, ip);
  if (!ts.ok) {
    return json({ ok: false, error: 'Verification failed. Please try again.' }, 403);
  }

  const first_name = clean(body.first_name, LIMITS.first_name);
  const last_name = clean(body.last_name, LIMITS.last_name);
  const email = clean(body.email, LIMITS.email);
  const phone = clean(body.phone, LIMITS.phone);
  const website = clean(body.website, LIMITS.website);
  const budget = clean(body.budget, LIMITS.budget);
  const message = clean(body.message, LIMITS.message);
  const outsourcing =
    body.outsourcing === 'Yes' ? 'Yes' : body.outsourcing === 'No' ? 'No' : '';
  const follow_up_ok = body.follow_up_ok ? 1 : 0;

  let interests = [];
  if (Array.isArray(body.interests)) {
    interests = body.interests.filter((i) => VALID_INTERESTS.has(i)).slice(0, 10);
  }

  const errors = [];
  if (!first_name) errors.push('First name is required.');
  if (!last_name) errors.push('Last name is required.');
  if (!email || !isEmail(email)) errors.push('A valid email is required.');
  if (!message) errors.push('Message is required.');
  if (errors.length) {
    return json({ ok: false, error: errors.join(' ') }, 422);
  }

  if (await rateLimited(env.DB, ip)) {
    return json(
      { ok: false, error: 'Too many submissions. Please try again later.' },
      429
    );
  }

  try {
    await env.DB.prepare(
      `INSERT INTO submissions
        (first_name, last_name, email, phone, website, interests, outsourcing,
         budget, message, follow_up_ok, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        first_name,
        last_name,
        email,
        phone,
        website,
        JSON.stringify(interests),
        outsourcing,
        budget,
        message,
        follow_up_ok,
        ip,
        (request.headers.get('User-Agent') || '').slice(0, 500)
      )
      .run();
  } catch (_) {
    return json(
      { ok: false, error: 'Something went wrong saving your message. Please try again.' },
      500
    );
  }

  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: 'POST' },
        });
      }
      return handleContact(request, env);
    }

    // Everything else: serve the static Astro site.
    return env.ASSETS.fetch(request);
  },
};
