# Apex Branding & Design

Static [Astro](https://astro.build) site for apexbranding.design, deployed on **Cloudflare Pages**.

## Architecture

- **Static site** — Astro builds pre-rendered HTML into `dist/`.
- **Contact form** — a Cloudflare Pages Function at `functions/api/contact.js` receives form POSTs and writes to **D1**.
- **Images** — served from **R2** via the custom domain `assets.apexbranding.design` (see `PUBLIC_ASSET_HOST`).
- **Spam protection** — Cloudflare **Turnstile** (server-verified) + honeypot + per-IP rate limiting.

## Local development

```bash
npm install
npm run dev          # http://localhost:4321  (images served locally from /uploads/)
```

To preview with production R2 image URLs:

```bash
PUBLIC_ASSET_HOST=https://assets.apexbranding.design npm run build && npm run preview
```

## Build settings (Cloudflare Pages)

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Environment variable | `PUBLIC_ASSET_HOST` = `https://assets.apexbranding.design` |

## Bindings (configured in the Pages dashboard)

> Note: bindings are set in the Cloudflare Pages dashboard (Settings → Functions →
> Bindings), **not** in a `wrangler.json`. A `wrangler.json` in the repo makes Pages'
> CI attempt a Workers-style `wrangler deploy` and the build fails with
> "Missing entry-point to Worker script". Keep it out of the repo.

- **D1 database** — binding name `DB` → database `apex-contact-submissions` (id `1d22749c-daa7-4c64-b39b-6b898a34181c`)
- **R2 bucket** — binding name `ASSETS_BUCKET` → bucket `apex-assets`

## Secrets (Pages → Settings → Environment variables, encrypted)

- `TURNSTILE_SECRET` — Turnstile secret key for the contact-form widget
- `ALLOWED_ORIGIN` — `https://apexbranding.design` (optional; defaults to request host)

## Database schema

See `schema.sql`. The `submissions` table stores contact-form entries; the
Command Center reads them via the Cloudflare D1 REST API.
