(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const body = document.body;
  const API = body.dataset.api;
  const BASE = body.dataset.base || '';
  let WEB_TOKEN = null;
  const CIRC = 339.292;

  const VIEWS = ['home', 'search', 'about', 'terms-of-service', 'privacy-policy', 'support'];
  const ALIAS = { download: 'home' };
  const TAB = { home: 'home', search: 'search', about: 'about', 'terms-of-service': 'about', 'privacy-policy': 'about', support: 'about' };
  const TITLES = {
    home: 'M-TUBE — Download What You Love', search: 'Search · M-TUBE', about: 'About · M-TUBE',
    'terms-of-service': 'Terms of Service · M-TUBE', 'privacy-policy': 'Privacy Policy · M-TUBE', support: 'Support · M-TUBE'
  };

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const states = root => $$(':scope > .state', root);
  const setState = (root, name) => states(root).forEach(s => { s.hidden = s.dataset.state !== name; });
  const fmtTime = s => {
    if (!s) return '';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };
  const fmtSize = b => !b ? '' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

  /* ---------- routing: 3 tabs + About sub-pages, no reloads ---------- */
  const fromLocation = () => {
    const first = location.search.replace(/^\?/, '').split('&')[0].split('=')[0];
    const v = ALIAS[first] || first;
    return VIEWS.includes(v) ? v : 'home';
  };
  const pathFor = v => BASE + '/' + (v === 'home' ? '' : '?' + v);

  function show(v, push = true) {
    if (!VIEWS.includes(v)) v = 'home';
    $$('.view').forEach(s => { s.hidden = s.dataset.view !== v; });
    body.dataset.view = v;
    body.dataset.tab = TAB[v];
    document.title = TITLES[v];
    $$('.nav a').forEach(a => { if (a.dataset.nav === TAB[v]) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (push && fromLocation() !== v) history.pushState({ v }, '', pathFor(v));
    if (matchMedia('(pointer:fine)').matches) {
      const f = v === 'home' ? '#dl-url' : v === 'search' ? '#sr-q' : null;
      if (f) setTimeout(() => $(f).focus({ preventScroll: true }), 60);
    }
    const sc = $('.view[data-view="' + v + '"] .doc-scroll');
    if (sc) sc.scrollTop = 0;
  }
  window.addEventListener('popstate', () => show(fromLocation(), false));
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-nav]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button > 0) return;
    e.preventDefault();
    show(a.dataset.nav);
  });

  /* ---------- API ---------- */
  async function ensureToken(force) {
    if (WEB_TOKEN && !force) return WEB_TOKEN;
    const r = await fetch(API + '/token', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.data) {
      const err = new Error((j && j.error && j.error.message) || 'Could not start a session (' + r.status + ')');
      err.status = r.status; err.code = j && j.error && j.error.code;
      throw err;
    }
    WEB_TOKEN = j.data.token;
    return WEB_TOKEN;
  }
  async function api(path, opts = {}, retried = false) {
    const token = await ensureToken();
    const res = await fetch(API + '/' + path, {
      method: 'POST', credentials: 'same-origin', signal: opts.signal,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Web-Token': token },
      body: JSON.stringify(opts.body || {})
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (res.status === 401 && !retried) { await ensureToken(true); return api(path, opts, true); }
    if (!res.ok || !data || data.ok === false) {
      const err = new Error((data && data.error && data.error.message) || 'Request failed (' + res.status + ')');
      err.code = data && data.error && data.error.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }
  const friendly = e => {
    if (e.name === 'AbortError') return 'Cancelled.';
    if (!e.status) return 'Network problem. Check your connection and try again.';
    if (e.code === 'not_configured') return 'No media provider is configured yet. The site owner needs to add API keys.';
    if (e.code === 'rate_limited') return 'You are going too fast. Please wait a moment and try again.';
    if (e.code === 'unauthorized') return 'Your session expired. Reload the page and try again.';
    return e.message;
  };
  const parseName = h => {
    if (!h) return '';
    let m = /filename\*=UTF-8''([^;]+)/i.exec(h);
    if (m) { try { return decodeURIComponent(m[1]); } catch (_) { /* ignore */ } }
    m = /filename="([^"]+)"/i.exec(h);
    return m ? m[1] : '';
  };
  function saveUrl(href, name) {
    const a = document.createElement('a');
    a.href = href; a.download = name || ''; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---------- reusable media panel (detect -> choose -> download) ---------- */
  function makePanel(root, opts) {
    const f = n => $('[data-f="' + n + '"]', root);
    const P = { media: null, fmt: null, ctrl: null, url: '', ctx: 'resolve', timer: null, seq: 0 };
    const st = n => setState(root, n);
    f('finish').textContent = opts.finishLabel;

    const rotate = on => {
      clearInterval(P.timer);
      if (!on) return;
      const steps = [['Detecting media…', 'Please wait a moment'], ['Contacting providers…', 'Finding the best source'], ['Reading formats…', 'Almost there']];
      let i = 0;
      P.timer = setInterval(() => {
        i = (i + 1) % steps.length;
        f('detect-title').textContent = steps[i][0];
        f('detect-sub').textContent = steps[i][1];
      }, 1800);
    };
    const fail = (title, msg, ctx) => {
      P.ctx = ctx;
      f('err-title').textContent = title;
      f('err-msg').textContent = msg;
      st('error');
    };

    function chip(fm) {
      const b = el('button', 'chip');
      b.type = 'button';
      b.dataset.id = fm.id;
      b.setAttribute('aria-pressed', 'false');
      b.append(document.createTextNode(fm.quality_label));
      const sub = [fm.ext ? fm.ext.toUpperCase() : '', fmtSize(fm.size)].filter(Boolean).join(' · ');
      if (sub) b.append(el('small', '', sub));
      b.addEventListener('click', () => select(fm.id));
      return b;
    }
    function select(id) {
      P.fmt = P.media.formats.find(x => x.id === id) || null;
      $$('.chip', root).forEach(c => c.setAttribute('aria-pressed', String(c.dataset.id === id)));
    }
    function render(m) {
      const img = f('thumb');
      img.hidden = !m.thumbnail;
      img.onerror = () => { img.hidden = true; };
      img.src = m.thumbnail || '';
      f('dur').textContent = fmtTime(m.duration);
      f('title').textContent = m.title;
      f('artist').textContent = m.artist || '';
      f('platform').textContent = m.platform;
      f('provider').textContent = 'via ' + m.provider;
      for (const type of ['audio', 'video']) {
        const list = m.formats.filter(x => x.type === type);
        f(type).replaceChildren(...list.map(chip));
        f(type + '-wrap').hidden = !list.length;
        const exts = [...new Set(list.map(x => x.ext).filter(Boolean))];
        f(type + '-ext').textContent = exts.length ? '(' + exts.map(x => x.toUpperCase()).join(', ') + ')' : '';
      }
      const first = m.formats.find(x => x.type === 'audio') || m.formats[0];
      if (first) select(first.id);
    }

    async function resolve(url) {
      const seq = ++P.seq;
      P.url = url; P.media = null; P.fmt = null;
      f('detect-title').textContent = 'Detecting media…';
      f('detect-sub').textContent = 'Please wait a moment';
      st('detecting');
      rotate(true);
      try {
        const r = await api('resolve', { body: { url } });
        if (seq !== P.seq) return;
        P.media = r.data;
        render(r.data);
        st('media');
      } catch (e) {
        if (seq === P.seq) fail('Could not detect media', friendly(e), 'resolve');
      } finally { if (seq === P.seq) rotate(false); }
    }

    const setProgress = (p, sub) => {
      const ring = f('ring');
      if (p == null) { ring.classList.add('indeterminate'); f('pct').textContent = '…'; }
      else {
        ring.classList.remove('indeterminate');
        f('ring-fg').style.strokeDashoffset = String(CIRC * (1 - p / 100));
        f('pct').textContent = p + '%';
      }
      if (sub) f('prog-sub').textContent = sub;
    };

    async function download() {
      const m = P.media, fm = P.fmt;
      if (!m || !fm) return;
      f('p-thumb').src = m.thumbnail || '';
      f('p-thumb').hidden = !m.thumbnail;
      f('p-name').textContent = m.title;
      f('p-meta').textContent = [fm.type === 'audio' ? 'Audio' : 'Video', fm.quality_label, fm.ext && fm.ext.toUpperCase()].filter(Boolean).join(' · ');
      f('prog-title').textContent = 'Preparing…';
      setProgress(0, 'Please keep this page open');
      st('progress');
      const ctrl = new AbortController();
      P.ctrl = ctrl;
      try {
        const prep = (await api('download', { body: { ref: m.ref, format: fm.id }, signal: ctrl.signal })).data;
        f('prog-title').textContent = 'Downloading your file…';
        if (prep.mode === 'file') setProgress(null, 'Preparing your file on the server…');
        let name = prep.filename;
        const big = prep.size && prep.size > 150 * 1048576;
        const unknownVideo = !prep.size && prep.type === 'video';
        if (big || unknownVideo || prep.mode === 'redirect' || !window.ReadableStream) {
          setProgress(null, 'Your browser is saving the file…');
          saveUrl(prep.download_url, prep.filename);
          await sleep(2500);
        } else {
          const res = await fetch(prep.download_url, { signal: ctrl.signal, credentials: 'same-origin' });
          if (!res.ok) {
            let msg = 'Download failed (' + res.status + ').';
            try { msg = (await res.json()).error.message; } catch (_) { /* ignore */ }
            throw new Error(msg);
          }
          setProgress(0, 'Please keep this page open');
          const total = Number(res.headers.get('Content-Length')) || Number(res.headers.get('X-Estimated-Size')) || prep.size || 0;
          const reader = res.body.getReader();
          const chunks = [];
          let got = 0;
          if (!total) setProgress(null);
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value); got += value.length;
            if (total) setProgress(Math.min(99, Math.floor(got / total * 100)), fmtSize(got) + ' downloaded');
          }
          if (!got) throw new Error('The file was empty.');
          name = parseName(res.headers.get('Content-Disposition')) || name;
          const url = URL.createObjectURL(new Blob(chunks, { type: res.headers.get('Content-Type') || 'application/octet-stream' }));
          saveUrl(url, name);
          setTimeout(() => URL.revokeObjectURL(url), 60000);
          setProgress(100);
          await sleep(350);
        }
        f('done-sub').textContent = name + ' has been saved.';
        st('done');
      } catch (e) {
        if (e.name === 'AbortError') { st('media'); return; }
        fail('Download failed', friendly(e), 'download');
      } finally { P.ctrl = null; }
    }

    f('start').addEventListener('click', download);
    f('again').addEventListener('click', download);
    f('cancel').addEventListener('click', () => { if (P.ctrl) P.ctrl.abort(); });
    f('finish').addEventListener('click', () => opts.onFinish && opts.onFinish());
    f('retry').addEventListener('click', () => {
      if (P.ctx === 'download' && P.media) download();
      else if (P.url) resolve(P.url);
    });

    return {
      resolve,
      abort() { P.seq++; if (P.ctrl) P.ctrl.abort(); rotate(false); },
      reset() {
        this.abort(); P.media = null; P.fmt = null;
        if ($(':scope > .state[data-state="idle"]', root)) st('idle'); else states(root).forEach(s => { s.hidden = true; });
      }
    };
  }

  /* clear-button helper for inputs */
  function bindClear(input, btn, onClear) {
    const sync = () => { btn.hidden = !input.value; };
    input.addEventListener('input', sync);
    btn.addEventListener('click', () => { input.value = ''; sync(); input.focus(); if (onClear) onClear(); });
    sync();
    return sync;
  }

  /* ---------- Home: URL downloader ---------- */
  const dlInput = $('#dl-url');
  const home = makePanel($('[data-dl="home"]'), {
    finishLabel: 'Download another',
    onFinish() { home.reset(); dlInput.value = ''; syncDl(); }
  });
  const syncDl = bindClear(dlInput, $('#dl-clear'), () => home.reset());
  $('#dl-form').addEventListener('submit', e => {
    e.preventDefault();
    const url = dlInput.value.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      const root = $('[data-dl="home"]');
      $('[data-f="err-title"]', root).textContent = 'Invalid link';
      $('[data-f="err-msg"]', root).textContent = 'Paste a full link that starts with http:// or https://';
      setState(root, 'error');
      return;
    }
    dlInput.blur();
    home.resolve(url);
  });

  /* ---------- Search ---------- */
  const srStage = $('#sr-stage');
  const srInput = $('#sr-q');
  let query = '';
  let hasResults = false;
  const detail = makePanel($('[data-dl="search"]'), {
    finishLabel: 'Back to results',
    onFinish() { backToResults(); }
  });
  function backToResults() {
    detail.reset();
    setState(srStage, hasResults ? 'results' : 'idle');
  }
  bindClear(srInput, $('#sr-clear'), () => { detail.reset(); hasResults = false; query = ''; setState(srStage, 'idle'); });
  $('#sr-back').addEventListener('click', backToResults);

  function openDetail(url) {
    detail.reset();
    setState(srStage, 'detail');
    srStage.scrollTop = 0;
    detail.resolve(url);
  }
  function resultItem(it) {
    const li = el('li');
    const b = el('button', 'result glass');
    b.type = 'button';
    const th = el('div', 'r-thumb');
    if (it.thumbnail) {
      const img = document.createElement('img');
      img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.remove();
      img.src = it.thumbnail;
      th.append(img);
    }
    if (it.duration) th.append(el('span', 'dur', fmtTime(it.duration)));
    const info = el('div', 'r-body');
    info.append(el('b', '', it.title), el('span', '', it.artist || ''));
    const tags = el('div', 'r-tags');
    tags.append(el('span', 'tag', it.platform));
    (it.kinds || []).forEach(k => tags.append(el('span', 'tag soft', k === 'audio' ? 'Audio' : 'Video')));
    info.append(tags);
    b.append(th, info);
    b.addEventListener('click', () => openDetail(it.url));
    li.append(b);
    return li;
  }
  async function search(q) {
    query = q;
    if (/^https?:\/\//i.test(q)) { openDetail(q); return; }
    detail.reset();
    hasResults = false;
    setState(srStage, 'scanning');
    try {
      const r = (await api('search', { body: { query: q } })).data;
      const list = r.results || [];
      if (!list.length) { setState(srStage, 'empty'); return; }
      $('#sr-count').textContent = list.length + ' result' + (list.length > 1 ? 's' : '') + (r.provider ? ' · via ' + r.provider : '');
      $('#sr-list').replaceChildren(...list.map(resultItem));
      hasResults = true;
      setState(srStage, 'results');
      srStage.scrollTop = 0;
    } catch (e) {
      $('#sr-err-msg').textContent = friendly(e);
      setState(srStage, 'error');
    }
  }
  $('#sr-form').addEventListener('submit', e => {
    e.preventDefault();
    const q = srInput.value.trim();
    if (q.length < 2) { $('#sr-err-msg').textContent = 'Please enter at least 2 characters.'; setState(srStage, 'error'); return; }
    srInput.blur();
    search(q);
  });
  $('#sr-retry').addEventListener('click', () => { if (query.length >= 2) search(query); else setState(srStage, 'idle'); });

  /* ---------- init ---------- */
  const start = fromLocation();
  history.replaceState({ v: start }, '', location.href);
  show(start, false);
  const pre = new URLSearchParams(location.search).get('u');
  if (start === 'home' && pre && /^https?:\/\//i.test(pre)) { dlInput.value = pre; syncDl(); home.resolve(pre); }
})();
