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

// Heuristic spam scoring — runs at ingest, no external calls.
// Returns { spam: bool, reason: string }. Manual override happens later in Command Center.
const SPAM_KEYWORDS = [
  'viagra', 'cialis', 'casino', 'porn', 'crypto pump', 'forex',
  'bitcoin doubler', 'seo services', 'guest post', 'backlink',
  'loan offer', 'weight loss', 'buy followers',
];
function scoreSpam({ message, first_name, last_name, email, website }) {
  const reasons = [];
  const body = `${message}`.toLowerCase();
  const nameBlob = `${first_name} ${last_name}`.toLowerCase();

  // 1. Link stuffing — genuine contact messages rarely carry several URLs.
  const linkCount = (body.match(/https?:\/\/|www\.|\[url|<a\s/gi) || []).length;
  if (linkCount >= 3) reasons.push(`links:${linkCount}`);

  // 2. Known spam keywords.
  const hitKw = SPAM_KEYWORDS.filter((k) => body.includes(k));
  if (hitKw.length) reasons.push(`kw:${hitKw.slice(0, 3).join('/')}`);

  // 3. BBCode / raw anchor markup — a bot fingerprint.
  if (/\[url=|\[link=|<a\s+href/i.test(message)) reasons.push('markup');

  // 4. Cyrillic / CJK in name field on an English-only agency form.
  if (/[\u0400-\u04FF\u4E00-\u9FFF]/.test(nameBlob)) reasons.push('nonlatin-name');

  // 5. Name equals email (common bot fill).
  if (email && nameBlob.replace(/\s/g, '') === email.toLowerCase()) reasons.push('name=email');

  return { spam: reasons.length > 0, reason: reasons.join(',') };
}

// ── Command Center lead notification ─────────────────────────────────────────
// After a successful NON-SPAM insert we POST a small payload to Command Center's
// /api/push/notify, signed with HMAC-SHA256 (scheme: v0:{ts}:{body}) using the
// shared PUSH_NOTIFY_SECRET. CC drops it in the desktop bell and fires a phone
// Web Push. Fire-and-forget via ctx.waitUntil — never blocks the user response,
// never fails the submission if CC is down.
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function notifyCommandCenter(env, lead) {
  const url = env.CC_NOTIFY_URL || 'https://cc.crweb.design/api/push/notify';
  const secret = env.PUSH_NOTIFY_SECRET;
  if (!secret) return; // not configured — skip silently
  try {
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      name: `${lead.first_name} ${lead.last_name}`.trim(),
      email: lead.email,
      site: 'apexbranding.design',
      message: lead.message,
      ts,
    });
    const sig = await hmacHex(secret, `v0:${ts}:${body}`);
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CC-Signature': `t=${ts},v0=${sig}`,
      },
      body,
    });
  } catch (_) {
    // CC unreachable — the submission is already safely in D1; ignore.
  }
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

async function handleContact(request, env, ctx) {
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

  // Honeypot: real users leave this blank. A filled honeypot is almost
  // certainly a bot — store it flagged as spam (so it surfaces under the
  // spam filter in Command Center) rather than silently dropping it.
  const honeypotTripped = !!clean(body.website_hp, 200);

  const ip = request.headers.get('CF-Connecting-IP') || '';

  // Skip Turnstile when the honeypot already caught the bot — bots don't
  // carry valid tokens, and we still want to STORE the attempt as spam.
  if (!honeypotTripped) {
    const ts = await verifyTurnstile(body.turnstile_token, env.TURNSTILE_SECRET, ip);
    if (!ts.ok) {
      return json({ ok: false, error: 'Verification failed. Please try again.' }, 403);
    }
  }

  // Which form on the site. Defaults to 'contact'. Kept to a safe slug so a
  // site can host several forms and Command Center can filter by name.
  const form_name = (clean(body.form_name, 60) || 'contact')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 60) || 'contact';

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
  // Honeypot bots often submit garbage that fails validation — but we still
  // want the record. Only enforce validation for non-honeypot submissions.
  if (errors.length && !honeypotTripped) {
    return json({ ok: false, error: errors.join(' ') }, 422);
  }

  if (!honeypotTripped && (await rateLimited(env.DB, ip))) {
    return json(
      { ok: false, error: 'Too many submissions. Please try again later.' },
      429
    );
  }

  // Heuristic spam scoring (honeypot is an automatic, definitive flag).
  let is_spam = 0;
  let spam_reason = null;
  if (honeypotTripped) {
    is_spam = 1;
    spam_reason = 'honeypot';
  } else {
    const s = scoreSpam({ message, first_name, last_name, email, website });
    if (s.spam) {
      is_spam = 1;
      spam_reason = s.reason;
    }
  }

  try {
    await env.DB.prepare(
      `INSERT INTO submissions
        (first_name, last_name, email, phone, website, interests, outsourcing,
         budget, message, follow_up_ok, ip_address, user_agent,
         form_name, is_spam, spam_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        (request.headers.get('User-Agent') || '').slice(0, 500),
        form_name,
        is_spam,
        spam_reason
      )
      .run();
  } catch (_) {
    return json(
      { ok: false, error: 'Something went wrong saving your message. Please try again.' },
      500
    );
  }

  // Notify Command Center only for genuine (non-spam) leads. Fire-and-forget so
  // it never delays the user's confirmation or fails the submission.
  if (!is_spam) {
    const notifyPromise = notifyCommandCenter(env, { first_name, last_name, email, message });
    if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise);
    else await notifyPromise.catch(() => {});
  }

  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: 'POST' },
        });
      }
      return handleContact(request, env, ctx);
    }

    // Everything else: serve the static Astro site.
    return env.ASSETS.fetch(request);
  },
};
