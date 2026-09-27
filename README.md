# Upstate NY ghost story collector

A one-page site where listeners record (or type) a spooky Upstate NY story. It runs as a single Cloudflare Worker:

- `public/` is the static page, served through Workers static assets. It was built from the claude.ai design project's `templates/collect-page/CollectPage.dc.html` using the Wednesday at 9PM design tokens and component CSS.
- `src/worker.js` handles `POST /api/submissions`. It validates the form, puts the recording in **R2** (`AUDIO`) and inserts a row in **D1** (`DB`).
- `src/admin.js` serves a password-protected viewer at `/admin`: every submission, newest first, with an inline player and a download link for each recording.
- `migrations/` holds the D1 schema.

Submissions are guarded by a per-IP rate limit (5/min) and Cloudflare Turnstile. Both are checked before the upload body is read. The Turnstile token travels in the `X-Turnstile-Token` header, and the Worker injects the sitekey into the page's `<meta name="turnstile-sitekey">`. Each new story sends an email to `NOTIFY_TO` through the `NOTIFY` send_email binding.

## Local development

```sh
npm install
npm run dev              # applies local D1 migrations, then wrangler dev on http://localhost:8787
npm run submissions:local  # list the latest local submissions
```

Local D1 and R2 data live in `.wrangler/state` and are simulated by Miniflare, so no Cloudflare account is needed. To pull a local recording:

```sh
npx wrangler r2 object get crgs-audio/submissions/<id>.webm --local --file story.webm
```

`.dev.vars` holds Cloudflare's Turnstile test keys, so the bot check always passes locally. Notification emails aren't sent in dev; wrangler logs them and writes the body under `.wrangler/tmp/email/`.

Microphone access needs a secure context. `localhost` counts; a LAN IP does not.

## Admin viewer

`/admin` uses HTTP Basic auth. Any username works; the password is the `ADMIN_PASSWORD` secret. If the secret isn't set, `/admin` returns 503.

- Locally: put `ADMIN_PASSWORD=...` in `.dev.vars` (gitignored), then open http://localhost:8787/admin.
- In production: `npx wrangler secret put ADMIN_PASSWORD`.

## Deploying

```sh
npx wrangler login
npx wrangler r2 bucket create crgs-audio
npx wrangler d1 create crgs     # paste the printed database_id into wrangler.jsonc
npm run deploy                  # applies remote migrations, then deploys
```

The Worker is served only at `stories.wednesdayatninepm.com` (custom domain in `wrangler.jsonc`), and the `wednesdayatninepm.com` zone must be in the same Cloudflare account. One-time setup in that account:

1. **Turnstile:** create a widget (Managed mode) for `stories.wednesdayatninepm.com`, `localhost` and `127.0.0.1`. Put its sitekey in `TURNSTILE_SITE_KEY` in `wrangler.jsonc`, then `npx wrangler secret put TURNSTILE_SECRET`. Until the secret is set, every submission is rejected.
2. **Email alerts:** `npx wrangler email sending enable wednesdayatninepm.com` so the Worker can send from `stories@wednesdayatninepm.com`.
3. After deploying, paste the URL into [LinkedIn's Post Inspector](https://www.linkedin.com/post-inspector/) to check (and refresh) the preview card. The image is `public/assets/og.jpg`.
