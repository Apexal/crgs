// Handles /api/* for the collect page and the /admin viewer. Static files in public/ are served by the assets binding.

import { handleAdmin, WHO_LABEL, fmtDuration } from './admin.js';

const MAX_AUDIO_BYTES = 30 * 1024 * 1024; // 10 min at the page's 64 kbps is ~5 MB; headroom for browsers that ignore the bitrate
const MAX_DURATION_S = 10 * 60 + 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIN_STORY_CHARS = 20;
const WHO = new Set(['me', 'known', 'legend']);
const AUDIO_EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
const TURNSTILE_ACTION = 'submit_story';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/submissions') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
      return createSubmission(request, env, ctx);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return handleAdmin(request, env, url);
    if (url.pathname === '/' || url.pathname === '/index.html') return collectPage(request, env);

    return env.ASSETS.fetch(request);
  },
};

// The page reads its Turnstile sitekey from a meta tag, so dev (.dev.vars test key) and prod can differ.
async function collectPage(request, env) {
  const res = await env.ASSETS.fetch(request);
  if (!res.headers.get('Content-Type')?.includes('text/html')) return res;
  return new HTMLRewriter()
    .on('meta[name="turnstile-sitekey"]', { element: (el) => el.setAttribute('content', env.TURNSTILE_SITE_KEY || '') })
    .transform(res);
}

async function createSubmission(request, env, ctx) {
  // Browsers always send Origin on POST; reject cross-site form posts.
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: 'Forbidden' }, 403);

  // Both checks run before reading the body, so a bot never gets to upload anything.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (env.SUBMIT_LIMITER && !(await env.SUBMIT_LIMITER.limit({ key: ip })).success) {
    return json({ error: 'Whoa, that’s a lot of stories at once. Give it a minute and try again.' }, 429);
  }
  if (!(await verifyTurnstile(request.headers.get('X-Turnstile-Token'), ip, env))) {
    return json({ error: 'I couldn’t confirm you’re a human (not a ghost). Please hit send again.' }, 403);
  }

  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_AUDIO_BYTES + 1024 * 1024) return json({ error: 'That recording is too large.' }, 413);

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Expected a multipart form submission.' }, 400);
  }

  const text = (name, max) => {
    const v = form.get(name);
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
  };
  const flag = (name) => (form.get(name) === '1' ? 1 : 0);

  const who = text('who', 10) || 'me';
  const town = text('town', 120);
  const story = text('story', 20000);
  const anonymous = flag('anonymous');
  const credit = anonymous ? null : text('credit', 120);
  const contactOk = flag('contact_ok');
  const contact = contactOk ? text('contact', 200) : null;
  const audio = form.get('audio');
  const hasAudio = audio instanceof File && audio.size > 0;

  if (!WHO.has(who)) return json({ error: 'Pick whose story it is.' }, 400);
  if (!flag('publish_ok')) return json({ error: 'Please check the permission box.' }, 400);
  if (!hasAudio && (!story || story.length < MIN_STORY_CHARS)) return json({ error: 'Please record (or type) your story.' }, 400);

  // The page sends its own id and reuses it on retry, so a resend after a lost response is a no-op.
  const clientId = text('id', 36);
  const id = clientId && UUID.test(clientId.toLowerCase()) ? clientId.toLowerCase() : crypto.randomUUID();
  if (await env.DB.prepare('SELECT 1 FROM submissions WHERE id = ?').bind(id).first()) return json({ id }, 200);

  let audioKey = null, audioType = null;

  if (hasAudio) {
    audioType = audio.type.split(';')[0].toLowerCase();
    if (!audioType.startsWith('audio/')) return json({ error: 'That file doesn’t look like audio.' }, 400);
    if (audio.size > MAX_AUDIO_BYTES) return json({ error: 'That recording is too large.' }, 413);
    audioKey = `submissions/${id}.${AUDIO_EXT[audioType] || 'bin'}`;
    await env.AUDIO.put(audioKey, audio.stream(), {
      httpMetadata: { contentType: audio.type || audioType },
      customMetadata: { submissionId: id },
    });
  }

  const duration = Number(form.get('duration'));
  try {
    await env.DB.prepare(
      `INSERT INTO submissions
         (id, town, who, story, audio_key, audio_type, audio_bytes, duration_s,
          anonymous, credit, credit_line, publish_ok, voice_ok, contact_ok, contact)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).bind(
      id, town, who, story,
      audioKey, audioType, hasAudio ? audio.size : null, Number.isFinite(duration) && duration > 0 ? Math.min(duration, MAX_DURATION_S) : null,
      anonymous, credit, creditLine(credit, town),
      flag('voice_ok'), contactOk, contact
    ).run();
  } catch (err) {
    // A concurrent retry with the same id already saved it; that copy owns the audio.
    if (String(err).includes('UNIQUE') || String(err).includes('PRIMARY KEY')) return json({ id }, 200);
    // Don't leave orphaned audio behind if the row didn't land.
    if (audioKey) await env.AUDIO.delete(audioKey).catch(() => {});
    console.error('submission insert failed', err);
    return json({ error: 'Something went bump on our end. Please try again.' }, 500);
  }

  ctx.waitUntil(notify(env, request, {
    id, town, who, story, credit_line: creditLine(credit, town), hasAudio,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null, voiceOk: flag('voice_ok'), contact,
  }));
  return json({ id }, 201);
}

// Canonical siteverify: fails closed on a missing secret, network error, wrong action or wrong hostname.
async function verifyTurnstile(token, ip, env) {
  const hostnames = new Set((env.TURNSTILE_HOSTNAMES || '').split(',').map((h) => h.trim()).filter(Boolean));
  if (!env.TURNSTILE_SECRET || typeof token !== 'string' || !token || token.length > 2048) return false;
  let result;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
    if (!r.ok) throw new Error(`siteverify ${r.status}`);
    result = await r.json();
  } catch (err) {
    console.error('turnstile siteverify failed', err);
    return false;
  }
  if (!result.success) return false;
  // Cloudflare's local test keys return hostname example.com and no action; only .dev.vars uses them.
  if (result.metadata?.result_with_testing_key) return true;
  return result.action === TURNSTILE_ACTION && hostnames.has(result.hostname);
}

// Emails a heads-up for each new story. Best-effort: a failed email never fails the submission.
async function notify(env, request, s) {
  if (!env.NOTIFY || !env.NOTIFY_FROM) return;
  const admin = `${new URL(request.url).origin}/admin#s-${s.id}`;
  const excerpt = s.story ? (s.story.length > 600 ? s.story.slice(0, 600) + '…' : s.story) : null;
  const lines = [
    `From: ${s.credit_line}`,
    `Where: ${s.town || 'not given'}`,
    `Whose: ${WHO_LABEL[s.who] || s.who}`,
    s.hasAudio ? `Recording: ${fmtDuration(s.duration)}${s.voiceOk ? '' : ' (retell only, don’t play their voice)'}` : 'Recording: none (typed)',
    s.contact ? `Contact: ${s.contact}` : null,
    '',
    excerpt,
    '',
    `Listen / read: ${admin}`,
  ].filter((l) => l !== null);
  try {
    await env.NOTIFY.send({
      from: { email: env.NOTIFY_FROM, name: 'Upstate NY Ghost Stories' },
      to: env.NOTIFY_TO,
      subject: `New Upstate NY story${s.town ? ` from ${s.town}` : ''}${s.hasAudio ? ' 🎙️' : ''}`,
      text: lines.join('\n'),
    });
  } catch (err) {
    console.error('notification email failed', err);
  }
}

// Mirrors creditLine() in public/js/collect.js. `credit` is already null when anonymous.
function creditLine(credit, town) {
  if (credit) return credit;
  return town ? `a listener from ${town}` : 'an anonymous local';
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
