// POST /api/contact  — Apex Branding contact form handler
// Cloudflare Pages Function. Bindings (set in dashboard / wrangler.json):
//   DB                -> D1 database (apex-contact-submissions)
//   TURNSTILE_SECRET  -> secret (Cloudflare Turnstile secret key)
//   ALLOWED_ORIGIN    -> e.g. https://apexbranding.design  (optional; falls back to request host)
//
// Security posture:
//  - POST-only, JSON body, hard size cap
//  - Origin check (same-site only)
//  - Honeypot field silently drops bots
//  - Cloudflare Turnstile server-side verification
//  - Per-IP rate limiting via D1 (sliding window)
//  - Strict field validation + length caps
//  - Parameterized D1 insert (no string interpolation -> no SQLi)
//  - No internal errors leaked to client

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
const RATE_LIMIT_MAX = 5; // submissions
const RATE_LIMIT_WINDOW_MIN = 10; // per N minutes per IP
const MAX_BODY_BYTES = 16 * 1024;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function isEmail(s) {
  // Pragmatic, not RFC-exhaustive. One @, dot in domain, no spaces.
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
    // Fail open on counting errors — never block a real lead over a rate-check bug.
    return false;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // --- Origin / same-site check ---
  const url = new URL(request.url);
  const allowed = env.ALLOWED_ORIGIN || `${url.protocol}//${url.host}`;
  const origin = request.headers.get('Origin');
  if (origin && origin !== allowed) {
    return json({ ok: false, error: 'Invalid origin.' }, 403);
  }

  // --- Body size cap ---
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

  // --- Honeypot: real users leave this blank. Bots fill it. Silently succeed. ---
  if (clean(body.website_hp, 200)) {
    return json({ ok: true }); // pretend success, store nothing
  }

  // --- Turnstile ---
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ts = await verifyTurnstile(body.turnstile_token, env.TURNSTILE_SECRET, ip);
  if (!ts.ok) {
    return json({ ok: false, error: 'Verification failed. Please try again.' }, 403);
  }

  // --- Validate + normalize fields ---
  const first_name = clean(body.first_name, LIMITS.first_name);
  const last_name = clean(body.last_name, LIMITS.last_name);
  const email = clean(body.email, LIMITS.email);
  const phone = clean(body.phone, LIMITS.phone);
  const website = clean(body.website, LIMITS.website);
  const budget = clean(body.budget, LIMITS.budget);
  const message = clean(body.message, LIMITS.message);
  const outsourcing = body.outsourcing === 'Yes' ? 'Yes' : body.outsourcing === 'No' ? 'No' : '';
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

  // --- Rate limit ---
  if (await rateLimited(env.DB, ip)) {
    return json(
      { ok: false, error: 'Too many submissions. Please try again later.' },
      429
    );
  }

  // --- Insert (parameterized) ---
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

// Reject non-POST methods cleanly.
export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: 'POST' },
  });
}
