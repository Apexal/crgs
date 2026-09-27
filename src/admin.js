// Password-protected submissions viewer at /admin. Auth is HTTP Basic against the ADMIN_PASSWORD secret
// (any username). Browsers resend the credentials for /admin/*, so <audio> and download links just work.

export const WHO_LABEL = { me: 'Happened to them', known: 'Someone they know', legend: 'Local legend' };

export async function handleAdmin(request, env, url) {
  if (!env.ADMIN_PASSWORD) return text('Admin is not configured. Set the ADMIN_PASSWORD secret.', 503);
  if (!(await authorized(request, env.ADMIN_PASSWORD))) {
    return text('Authentication required.', 401, { 'WWW-Authenticate': 'Basic realm="crgs admin", charset="UTF-8"' });
  }

  const del = url.pathname.match(/^\/admin\/submissions\/([0-9a-f-]{36})\/delete$/);
  if (del) {
    if (request.method !== 'POST') return text('Method not allowed', 405, { Allow: 'POST' });
    return deleteSubmission(request, env, del[1]);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405, { Allow: 'GET, HEAD' });

  if (url.pathname === '/admin' || url.pathname === '/admin/') return listPage(env, url);

  const audio = url.pathname.match(/^\/admin\/audio\/([0-9a-f-]{36})$/);
  if (audio) return audioFile(request, env, audio[1], url.searchParams.has('download'));

  return text('Not found', 404);
}

async function authorized(request, password) {
  const header = request.headers.get('Authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  let decoded;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  } catch {
    return false;
  }
  const supplied = decoded.slice(decoded.indexOf(':') + 1);
  // Hash both sides so the constant-time compare always sees equal-length inputs.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(supplied)),
    crypto.subtle.digest('SHA-256', enc.encode(password)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// The browser resends Basic auth on any request to /admin, including a cross-site form post,
// so a delete must come from this origin's own page.
async function deleteSubmission(request, env, id) {
  const origin = request.headers.get('Origin');
  if (!origin || new URL(origin).host !== new URL(request.url).host) return text('Forbidden', 403);

  const row = await env.DB.prepare('SELECT audio_key FROM submissions WHERE id = ?').bind(id).first();
  if (row) {
    // Audio first: if the row delete then fails, retrying still works (deleting a missing object is a no-op).
    if (row.audio_key) await env.AUDIO.delete(row.audio_key);
    await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(id).run();
  }
  return new Response(null, { status: 303, headers: { Location: `/admin?deleted=${id.slice(0, 8)}`, 'Cache-Control': 'no-store' } });
}

async function audioFile(request, env, id, download) {
  const row = await env.DB.prepare('SELECT audio_key, audio_type, created_at, town FROM submissions WHERE id = ?').bind(id).first();
  if (!row?.audio_key) return text('Not found', 404);

  // Honor Range so players can seek (Safari won't play audio without it).
  const obj = await env.AUDIO.get(row.audio_key, { range: request.headers });
  if (!obj) return text('Recording missing from storage', 404);

  const headers = new Headers({
    'Content-Type': obj.httpMetadata?.contentType || row.audio_type || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    ETag: obj.httpEtag,
  });
  if (download) {
    const ext = row.audio_key.split('.').pop();
    const slug = (row.town || 'story').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'story';
    headers.set('Content-Disposition', `attachment; filename="${row.created_at.slice(0, 10)}-${slug}-${id.slice(0, 8)}.${ext}"`);
  }

  const body = request.method === 'HEAD' ? null : obj.body;
  if (obj.range && request.headers.has('Range')) {
    const { offset = 0, length = obj.size - offset } = obj.range;
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('Content-Length', String(length));
    return new Response(body, { status: 206, headers });
  }
  headers.set('Content-Length', String(obj.size));
  return new Response(body, { headers });
}

async function listPage(env, url) {
  const { results } = await env.DB.prepare('SELECT * FROM submissions ORDER BY created_at DESC').all();
  const withAudio = results.filter((r) => r.audio_key).length;
  const deleted = url.searchParams.get('deleted');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Submissions · Upstate NY Ghost Stories</title>
<link rel="icon" href="/assets/ghost.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Grenze+Gotisch:wght@500;600;700&family=Spectral:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/bold/style.css">
<link rel="stylesheet" href="/css/styles.css">
<link rel="stylesheet" href="/css/admin.css">
</head>
<body>
<div class="cp">
  <div class="cp-stars"></div>
  <div class="cp-fog"></div>
  <main class="ad">
    <header class="ad-head">
      <h1>Submissions</h1>
      <p class="ad-count">${results.length} ${results.length === 1 ? 'story' : 'stories'} · ${withAudio} with recordings</p>
    </header>
    ${deleted && /^[0-9a-f]{8}$/.test(deleted) ? `<p class="ad-notice" role="status"><i class="ph-bold ph-check"></i>Deleted story ${deleted.toUpperCase()} and its recording.</p>` : ''}
    ${results.length ? results.map(card).join('\n') : '<p class="ad-empty">Nothing yet. The void is quiet.</p>'}
  </main>
</div>
</body>
</html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' },
  });
}

function card(r) {
  const when = new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
  const flags = [
    flag('Voice OK', r.voice_ok),
    flag('Contact OK', r.contact_ok),
    r.anonymous ? '<span class="ad-tag ad-tag--anon">Anonymous</span>' : '',
  ].join('');
  const src = `/admin/audio/${r.id}`;

  return `<article class="cp-card ad-card" id="s-${esc(r.id)}">
      <div class="ad-card__top">
        <div>
          <h2>${esc(r.town || 'Somewhere in Upstate NY')}</h2>
          <p class="ad-meta">${esc(when)} · ${esc(WHO_LABEL[r.who] || r.who)}</p>
        </div>
        <div class="ad-tags">${flags}</div>
      </div>
      <dl class="ad-facts">
        <div><dt>Credit</dt><dd>${esc(r.credit_line)}</dd></div>
        ${r.contact ? `<div><dt>Contact</dt><dd>${esc(r.contact)}</dd></div>` : ''}
        <div><dt>Ref</dt><dd class="ad-id" title="${esc(r.id)}">${esc(r.id.slice(0, 8).toUpperCase())}</dd></div>
      </dl>
      ${r.audio_key ? `<div class="ad-audio">
        <audio controls preload="none" src="${src}"></audio>
        <span class="ad-mono">${fmtDuration(r.duration_s)}${r.audio_bytes ? ` · ${fmtBytes(r.audio_bytes)}` : ''}</span>
        <a class="w9-btn w9-btn--ghost w9-btn--sm" href="${src}?download"><span class="w9-btn__icon"><i class="ph-bold ph-download-simple"></i></span>Download</a>
      </div>` : ''}
      ${r.story ? `<div class="ad-story">${esc(r.story)}</div>` : ''}
      <details class="ad-delete">
        <summary><i class="ph-bold ph-trash"></i>Delete…</summary>
        <form method="post" action="/admin/submissions/${esc(r.id)}/delete">
          <p>Permanently delete this story${r.audio_key ? ' and its recording' : ''}? This can’t be undone.</p>
          <button type="submit" class="w9-btn w9-btn--sm ad-btn-danger"><span class="w9-btn__icon"><i class="ph-bold ph-trash"></i></span>Yes, delete it</button>
        </form>
      </details>
    </article>`;
}

const flag = (label, on) => `<span class="ad-tag ${on ? 'ad-tag--on' : 'ad-tag--off'}">${on ? '✓' : '✗'} ${label}</span>`;

export function fmtDuration(s) {
  if (!s) return '--:--';
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function fmtBytes(n) {
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}
