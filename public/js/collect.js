// Collect page: records a story in the browser, then POSTs it to /api/submissions.
(() => {
  const MAX_MINUTES = 10;
  const MAX_SECS = MAX_MINUTES * 60;
  const BARS = 48;
  const MIN_TEXT = 20;
  const AUDIO_BPS = 64000; // plenty for a speaking voice; ~5 MB for a full 10 minutes
  const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
  const TURNSTILE_WAIT_MS = 20 * 1000;
  // First container the browser can record; Safari only does mp4.
  const MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));

  const $ = (id) => document.getElementById(id);
  const form = $('story-form');
  const els = {
    ring: $('rec-ring'), start: $('btn-start'), stop: $('btn-stop'), play: $('btn-play'),
    status: $('rec-status'), time: $('rec-time'), wave: $('rec-wave'),
    rerecordRow: $('rerecord-row'), rerecord: $('btn-rerecord'), denied: $('mic-denied'),
    toggleText: $('btn-toggle-text'), textField: $('text-field'), text: $('w9-story'),
    credit: $('w9-credit'), creditField: $('credit-field'), anon: $('chk-anon'),
    pub: $('chk-pub'), pubWho: $('pub-who'), contact: $('chk-contact'), contactField: $('contact-field'),
    voice: $('chk-voice'), voiceWarning: $('voice-warning'), town: $('w9-town'),
    submit: $('btn-submit'), submitLabel: $('submit-label'), error: $('form-error'),
    upload: $('upload-progress'), uploadFill: $('upload-fill'), uploadLabel: $('upload-label'),
    formView: $('form-view'), doneView: $('done-view'), reset: $('btn-reset'),
    share: $('btn-share'), shareLabel: $('share-label'),
    turnstile: $('turnstile-widget'), refId: $('ref-id'), refMail: $('ref-mail'),
  };

  const state = {
    phase: 'idle', // idle | recording | recorded | denied
    elapsed: 0, level: 0, history: [], recDur: 0,
    blob: null, audioUrl: null, playing: false, progress: 0,
    tried: false, sending: false, notice: '',
    // Reused on retries so a resend after a dropped response can't create a duplicate.
    submissionId: crypto.randomUUID(),
  };
  let stream = null, ctx = null, recorder = null, raf = 0, capTimer = 0, t0 = 0, audio = null, wakeLock = null;

  document.querySelectorAll('[data-max-minutes]').forEach((n) => { n.textContent = MAX_MINUTES; });

  // Waveform bars are created once and restyled on every frame.
  const bars = Array.from({ length: BARS }, () => els.wave.appendChild(document.createElement('div')));

  const TYPE_LABEL = 'Can’t talk right now? Type it instead →';
  const RECORD_LABEL = 'Never mind, I’ll just record it';
  const SHARE_LABEL = 'Send this to a friend with a story';

  const fmt = (s) => { s = Math.floor(s); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };

  function barValues() {
    const { phase, history } = state;
    if (phase === 'recording') {
      const h = history.slice(-BARS);
      return Array(BARS - h.length).fill(0).concat(h);
    }
    if (phase === 'recorded' && history.length) {
      return Array.from({ length: BARS }, (_, i) => {
        const a = Math.floor(i * history.length / BARS);
        const b = Math.max(a + 1, Math.floor((i + 1) * history.length / BARS));
        return Math.max(...history.slice(a, b));
      });
    }
    return Array.from({ length: BARS }, (_, i) => 0.02 + 0.015 * Math.sin(i * 0.7));
  }

  function renderRecorder() {
    const s = state;
    els.start.hidden = !(s.phase === 'idle' || s.phase === 'denied');
    els.stop.hidden = s.phase !== 'recording';
    els.play.hidden = s.phase !== 'recorded';
    els.rerecordRow.hidden = s.phase !== 'recorded';
    els.denied.hidden = s.phase !== 'denied';
    els.play.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    els.play.firstElementChild.className = s.playing ? 'ph-fill ph-pause' : 'ph-fill ph-play';
    const left = MAX_SECS - s.elapsed;
    els.status.textContent = s.notice || {
      idle: 'Tap the mic to start',
      recording: left <= 60 ? '● Under a minute left' : '● Recording… tap to stop',
      recorded: s.playing ? 'Playing back' : 'Got it. Have a listen',
      denied: 'Mic unavailable',
    }[s.phase];
    els.time.textContent = s.phase === 'recorded' ? fmt(s.recDur) : fmt(s.elapsed) + ' / ' + fmt(MAX_SECS);
    els.ring.style.transform = 'scale(' + (s.phase === 'recording' ? (1 + Math.min(0.6, s.level * 3)).toFixed(3) : 1) + ')';
    barValues().forEach((v, i) => {
      const b = bars[i];
      b.style.height = Math.min(100, 6 + v * 320) + '%';
      b.style.background = s.phase === 'recording' ? 'var(--pumpkin-500)'
        : s.phase === 'recorded' ? (i / BARS < s.progress ? 'var(--slime-500)' : 'var(--bone-300)')
        : 'var(--night-600)';
    });
  }

  function cleanupStream() {
    cancelAnimationFrame(raf);
    clearTimeout(capTimer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
    if (wakeLock) wakeLock.release().catch(() => {});
    stream = null; ctx = null; wakeLock = null;
  }

  async function startRec() {
    if (!window.MediaRecorder || !navigator.mediaDevices) {
      state.phase = 'denied'; renderRecorder(); showText(true); return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      state.phase = 'denied'; renderRecorder(); showText(true); return;
    }
    try {
      recorder = new MediaRecorder(stream, MIME ? { mimeType: MIME, audioBitsPerSecond: AUDIO_BPS } : { audioBitsPerSecond: AUDIO_BPS });
    } catch {
      recorder = new MediaRecorder(stream);
    }
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onerror = () => stopRec('The recording hit a snag. Here’s what I got.');
    recorder.onstop = () => {
      const type = (recorder.mimeType || MIME || 'audio/webm');
      state.level = 0;
      if (!chunks.length) {
        Object.assign(state, { phase: 'idle', history: [], elapsed: 0, notice: 'Nothing was recorded. Tap the mic to try again' });
      } else {
        state.blob = new Blob(chunks, { type });
        state.audioUrl = URL.createObjectURL(state.blob);
        state.phase = 'recorded';
      }
      renderRecorder(); renderErrors();
    };
    // A timeslice keeps data flowing in 1 s chunks, so an interrupted recording still keeps what came before.
    recorder.start(1000);
    t0 = Date.now();
    Object.assign(state, { phase: 'recording', history: [], elapsed: 0, recDur: 0, notice: '' });
    // If the OS takes the mic (a phone call, unplugged headset), stop cleanly instead of hanging.
    stream.getAudioTracks().forEach((t) => { t.onended = () => stopRec('The mic cut out. Here’s what I got.'); });
    // requestAnimationFrame pauses in background tabs, so the time limit needs a real timer.
    capTimer = setTimeout(() => stopRec('That’s the ' + MAX_MINUTES + '-minute max. Here’s what I got.'), MAX_SECS * 1000);
    // Keep phones from auto-locking mid-story, which would kill the mic.
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then((l) => { wakeLock = l; }).catch(() => {});

    let an = null, buf = null;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      an = ctx.createAnalyser(); an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      buf = new Uint8Array(an.fftSize);
    } catch {
      an = null; // The waveform is decoration; record without it.
    }
    let last = 0;
    const loop = () => {
      const now = Date.now();
      if (an) {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        state.level = Math.sqrt(sum / buf.length);
      }
      state.elapsed = Math.min(MAX_SECS, (now - t0) / 1000);
      if (now - last > 80) { state.history.push(state.level); last = now; }
      renderRecorder();
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function stopRec(notice) {
    if (!recorder || recorder.state === 'inactive') return;
    state.recDur = Math.min(MAX_SECS, (Date.now() - t0) / 1000);
    state.notice = typeof notice === 'string' ? notice : '';
    recorder.stop();
    cleanupStream();
  }

  function togglePlay() {
    if (!audio) {
      audio = new Audio(state.audioUrl);
      audio.ontimeupdate = () => { state.progress = Math.min(1, audio.currentTime / (state.recDur || 1)); renderRecorder(); };
      audio.onended = () => { state.playing = false; state.progress = 0; renderRecorder(); };
    }
    state.notice = '';
    if (state.playing) { audio.pause(); state.playing = false; }
    else { audio.play().catch(() => { state.playing = false; renderRecorder(); }); state.playing = true; }
    renderRecorder();
  }

  function reRecord() {
    if (audio) { audio.pause(); audio = null; }
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    Object.assign(state, { phase: 'idle', blob: null, audioUrl: null, history: [], elapsed: 0, recDur: 0, playing: false, progress: 0, notice: '' });
    renderRecorder(); renderErrors();
  }

  // Mirrors the fallback in src/worker.js.
  function creditLine() {
    const credit = els.credit.value.trim();
    if (!els.anon.checked && credit) return credit;
    const town = els.town.value.trim();
    return town ? 'a listener from ' + town : 'an anonymous local';
  }

  function renderCredit() {
    els.creditField.hidden = els.anon.checked;
    els.voiceWarning.hidden = !(els.anon.checked && els.voice.checked);
    document.querySelectorAll('[data-credit-line]').forEach((n) => { n.textContent = creditLine(); });
  }

  function showText(show) {
    els.textField.hidden = !show;
    els.toggleText.setAttribute('aria-expanded', String(show));
    els.toggleText.textContent = show ? RECORD_LABEL : TYPE_LABEL;
  }

  async function share() {
    const url = location.origin + '/';
    try {
      if (navigator.share) {
        await navigator.share({ title: document.title, text: 'Got a spooky 518 story? Record it for a Halloween podcast.', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      els.shareLabel.textContent = 'Link copied!';
      setTimeout(() => { els.shareLabel.textContent = SHARE_LABEL; }, 2500);
    } catch {
      // Share sheet dismissed, or clipboard blocked.
    }
  }

  function missing() {
    const m = [];
    if (!state.blob && els.text.value.trim().length < MIN_TEXT) m.push('record (or type) your story');
    if (!els.pub.checked) m.push('check the permission box');
    return m;
  }

  function renderErrors(serverMessage) {
    const miss = missing();
    const msg = serverMessage || (state.tried && miss.length ? 'Almost. Please ' + miss.join(' and ') + '.' : '');
    els.error.textContent = msg;
    els.error.hidden = !msg;
  }

  function renderUpload(fraction) {
    const on = fraction != null;
    els.upload.hidden = !on;
    if (!on) return;
    const pct = Math.round(fraction * 100);
    els.uploadFill.style.width = pct + '%';
    els.upload.setAttribute('aria-valuenow', String(pct));
    els.uploadLabel.textContent = pct < 100 ? 'Uploading… ' + pct + '%' : 'Almost there. Saving your story…';
  }

  // Turnstile bot check. It runs in the background while people fill out the form and only shows
  // a checkbox if Cloudflare wants an interaction. Tokens are single-use, so it resets after every send.
  const SITEKEY = document.querySelector('meta[name="turnstile-sitekey"]')?.content;
  const bot = { id: null, token: '', waiters: [] };

  function settleToken(token) {
    bot.token = token;
    bot.waiters.splice(0).forEach((w) => w(token));
  }

  // Checks for the real API, not just a truthy window.turnstile (an element id can shadow that name).
  const turnstileReady = () => typeof window.turnstile?.render === 'function';

  function renderTurnstile() {
    if (!SITEKEY || !turnstileReady() || bot.id !== null) return;
    // A Turnstile failure must never take the recorder down with it; submit then fails with a clear message.
    try {
      bot.id = turnstile.render(els.turnstile, {
        sitekey: SITEKEY,
        action: 'submit_story',
        appearance: 'interaction-only',
        'response-field': false,
        callback: settleToken,
        'expired-callback': () => { bot.token = ''; },
        // Returning true marks the error handled, so Turnstile doesn't throw it.
        'error-callback': () => { bot.token = ''; return true; },
      }) ?? null;
    } catch (err) {
      console.error('Turnstile render failed', err);
    }
  }

  function turnstileToken() {
    if (bot.token) return Promise.resolve(bot.token);
    renderTurnstile();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = bot.waiters.indexOf(done);
        if (i >= 0) bot.waiters.splice(i, 1);
        reject(new Error('I couldn’t confirm you’re a human (not a ghost). If you use an ad or script blocker, allow challenges.cloudflare.com and hit send again.'));
      }, TURNSTILE_WAIT_MS);
      const done = (token) => { clearTimeout(timer); resolve(token); };
      bot.waiters.push(done);
    });
  }

  function resetTurnstile() {
    bot.token = '';
    if (bot.id === null || !turnstileReady()) return;
    try { turnstile.reset(bot.id); } catch (err) { console.error('Turnstile reset failed', err); }
  }

  // The API script loads async; render as soon as it's there.
  (function waitForTurnstile(tries) {
    if (turnstileReady()) renderTurnstile();
    else if (tries > 0) setTimeout(() => waitForTurnstile(tries - 1), 200);
  })(100);

  // fetch() can't report upload progress, so this uses XHR.
  function send(fd, token) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/submissions');
      xhr.responseType = 'json';
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      // Sent as a header so the server can turn bots away before accepting the upload.
      xhr.setRequestHeader('X-Turnstile-Token', token);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) renderUpload(e.loaded / e.total); };
      xhr.upload.onload = () => renderUpload(1);
      xhr.onload = () => {
        const body = xhr.response || {};
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || 'Something went bump. Please try again.'));
      };
      const lost = 'The upload didn’t go through. Check your connection and hit send again. Your story is still here.';
      xhr.onerror = () => reject(new Error(lost));
      xhr.ontimeout = () => reject(new Error(lost));
      xhr.send(fd);
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (state.sending) return;
    if (state.phase === 'recording') {
      // Wait for the recorder to hand over its final chunk before sending.
      await new Promise((resolve) => { recorder.addEventListener('stop', () => setTimeout(resolve), { once: true }); stopRec(); });
    }
    if (missing().length) { state.tried = true; renderErrors(); return; }
    if (audio) { audio.pause(); state.playing = false; renderRecorder(); }

    const fd = new FormData(form);
    fd.set('id', state.submissionId);
    // Unchecked boxes are omitted by FormData; send explicit booleans.
    for (const name of ['anonymous', 'publish_ok', 'voice_ok', 'contact_ok']) fd.set(name, form.elements[name].checked ? '1' : '0');
    if (!els.contact.checked) fd.delete('contact');
    if (els.anon.checked) fd.delete('credit');
    if (state.blob) {
      const ext = { webm: 'webm', mp4: 'm4a', ogg: 'ogg' }[state.blob.type.split(/[/;]/)[1]] || 'webm';
      fd.set('audio', state.blob, 'story.' + ext);
      fd.set('duration', state.recDur.toFixed(1));
    }

    state.sending = true;
    els.submit.disabled = true;
    els.submit.setAttribute('aria-busy', 'true');
    renderErrors('');
    try {
      els.submitLabel.textContent = 'Checking for ghosts…';
      const token = await turnstileToken();
      els.submitLabel.textContent = 'Sending…';
      renderUpload(0);
      const { id } = await send(fd, token);
      state.submitted = true;
      const ref = String(id || state.submissionId).slice(0, 8).toUpperCase();
      els.refId.textContent = ref;
      els.refMail.href = 'mailto:thefrankmatranga@gmail.com?subject=' + encodeURIComponent('My 518 story (ref ' + ref + ')');
      renderCredit();
      els.formView.hidden = true;
      els.doneView.hidden = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      els.doneView.querySelector('h1').focus({ preventScroll: true });
    } catch (err) {
      renderErrors(err.message || 'Something went bump. Please try again.');
    } finally {
      state.sending = false;
      els.submit.disabled = false;
      els.submit.removeAttribute('aria-busy');
      els.submitLabel.textContent = 'Send my story';
      renderUpload(null);
      resetTurnstile();
    }
  }

  // Warn before leaving with an unsent story or mid-upload.
  function hasUnsent() {
    if (state.submitted) return false;
    return state.sending || state.phase === 'recording' || !!state.blob || els.text.value.trim().length > 0;
  }

  function reset() {
    reRecord();
    state.tried = false;
    state.submitted = false;
    state.submissionId = crypto.randomUUID();
    els.text.value = '';
    showText(false);
    els.pub.checked = false;
    els.contact.checked = false;
    els.contactField.hidden = true;
    form.elements.contact.value = '';
    renderErrors();
    els.doneView.hidden = true;
    els.formView.hidden = false;
    window.scrollTo({ top: 0 });
  }

  els.start.addEventListener('click', startRec);
  els.stop.addEventListener('click', () => stopRec());
  els.play.addEventListener('click', togglePlay);
  els.rerecord.addEventListener('click', reRecord);
  els.toggleText.addEventListener('click', () => {
    const show = els.textField.hidden;
    showText(show);
    if (show) els.text.focus();
  });
  els.text.addEventListener('input', () => renderErrors());
  els.credit.addEventListener('input', renderCredit);
  els.anon.addEventListener('change', renderCredit);
  els.voice.addEventListener('change', renderCredit);
  els.town.addEventListener('input', renderCredit);
  els.share.addEventListener('click', share);
  els.pub.addEventListener('change', () => renderErrors());
  els.contact.addEventListener('change', () => { els.contactField.hidden = !els.contact.checked; });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'who') els.pubWho.textContent = e.target.value === 'me' ? 'my story' : 'this story';
  });
  form.addEventListener('submit', submit);
  els.reset.addEventListener('click', reset);
  window.addEventListener('beforeunload', (e) => { if (hasUnsent()) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('pagehide', () => { stopRec(); cleanupStream(); if (audio) audio.pause(); });

  renderRecorder();
  renderCredit();
})();
