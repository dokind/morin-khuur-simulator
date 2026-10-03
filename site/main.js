/* Morin Khuur Simulator — landing page behaviour. Vanilla, no tracking.
   - МН / EN switch (both languages are in the HTML; this flips <html lang> and the attributes)
   - platform-aware download area (decided in <head>) + latest release from the GitHub API
     (static v0.1.0 links stay if the API is unavailable; cached 30 min, 10 min back-off)
   - audio demos: waveform seek bars, A/B style switch, the hero remote, a "now playing" bar
   - mobile menu, screenshot lightbox, copy buttons, header state, gentle reveal on scroll */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var REPO = 'dokind/morin-khuur-simulator';
  var SITE_URL = 'https://khuur.vercel.app/';
  var LANG_KEY = 'mkhuur.site.lang';
  var RELEASE_KEY = 'mkhuur.site.release.v2';
  var STATIC_VERSION = '0.1.0';

  var T = {
    en: {
      title: 'Morin Khuur Simulator — the horsehead fiddle on your computer',
      desc: 'Free, open-source Windows app that simulates the Mongolian morin khuur (horsehead fiddle) with a real-time physical model — no recorded samples.',
      play: 'Play', pause: 'Pause', seek: 'Playback position',
      playing: 'Playing', paused: 'Paused',
      styles: ['Khalkh stage', 'Long song · urtiin duu']
    },
    mn: {
      title: 'Морин хуурын симулятор — морин хуур таны компьютер дээр',
      desc: 'Монгол морин хуурыг бодит хугацаанд физик загвараар дуугаргадаг үнэгүй, нээлттэй эх кодтой Windows програм. Бэлэн бичлэг ашигладаггүй.',
      play: 'Тоглуулах', pause: 'Зогсоох', seek: 'Тоглуулах байрлал',
      playing: 'Тоглож байна', paused: 'Зогссон',
      styles: ['Халхын тайз', 'Уртын дуу']
    }
  };

  /* Loudness envelopes of the demo files (72 bins, 0–100), measured from the MP3s. */
  var PEAKS = {
    'hooves-whinny.mp3': [4,37,7,18,20,31,5,16,26,23,6,5,25,4,22,4,42,14,8,42,35,14,7,56,24,14,44,52,17,15,81,94,82,93,68,57,45,29,10,26,4,30,4,6,39,100,85,89,73,59,47,32,89,96,96,97,95,91,90,34,18,8,5,4,4,4,4,4,4,4,4,4],
    'joroo-amble-tatlaga.mp3': [4,66,80,77,79,82,85,80,74,72,70,71,72,70,72,74,77,72,66,64,55,19,43,40,62,52,56,38,34,58,72,58,36,24,21,25,28,53,100,95,90,88,86,20,71,80,77,79,82,84,79,74,71,69,73,72,71,72,75,77,71,66,64,51,13,4,4,4,4,4,4,4],
    'long-song-hide-top.mp3': [17,88,89,92,94,90,84,80,20,32,36,39,43,45,40,34,58,73,76,71,71,66,55,42,41,47,52,59,63,71,70,67,65,77,100,99,74,74,77,68,70,74,63,75,68,65,70,77,72,85,91,91,90,91,93,93,94,94,95,93,90,88,85,84,82,74,16,4,4,4,4,4],
    'long-song-stage.mp3': [4,61,71,73,75,74,73,68,65,71,74,73,65,65,69,60,58,87,95,93,93,97,98,90,86,78,73,74,67,67,74,70,71,90,100,91,76,67,69,62,69,75,65,62,74,93,98,87,71,69,69,67,66,67,70,72,70,69,67,67,66,62,60,60,19,9,4,4,4,4,4,4],
    'long-song-urtiin-duu.mp3': [13,70,68,70,74,70,64,62,14,33,36,38,43,44,40,35,60,76,79,73,68,64,53,35,35,34,37,38,40,38,36,35,33,58,77,78,82,98,97,83,68,71,62,78,68,62,89,100,90,72,73,70,70,72,74,72,73,76,74,72,71,71,66,65,66,59,10,4,4,4,4,4],
    'open-strings.mp3': [4,38,72,70,71,72,69,65,62,57,63,64,65,65,61,58,56,86,87,87,89,86,81,78,72,77,78,80,80,76,72,64,69,74,68,60,72,84,75,58,68,73,66,67,83,80,71,84,94,95,97,98,95,93,94,95,97,96,93,92,92,100,48,21,7,4,4,4,4,4,4,4]
  };

  function $(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }
  function lang() { return root.lang === 'mn' ? 'mn' : 'en'; }
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.round(t);
    return Math.floor(t / 60) + ':' + (t % 60 < 10 ? '0' : '') + (t % 60);
  }
  function store(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } }
  function read(k) { try { return localStorage.getItem(k); } catch { return null; } }
  /* only touch the DOM when the text really changes (once a second while playing) */
  function setText(el, s) { if (el && el.textContent !== s) el.textContent = s; }
  function setAttr(el, k, v) { if (el && el.getAttribute(k) !== v) el.setAttribute(k, v); }
  /* the visible language's text, without forcing a layout (innerText would) */
  function textOf(el) {
    if (!el) return '';
    var part = el.querySelector('[data-l="' + lang() + '"]');
    return ((part || el).textContent || '').replace(/\s+/g, ' ').trim();
  }

  root.classList.add('enhanced');
  if (navigator.share) root.classList.add('can-share');

  /* ------------------------------------------------------------------ language */
  var langListeners = [];

  function applyLang(l, save) {
    l = l === 'mn' ? 'mn' : 'en';
    root.lang = l;
    doc.title = T[l].title;
    var meta = $('meta[name="description"]');
    if (meta) meta.setAttribute('content', T[l].desc);
    $$('[data-label-' + l + ']').forEach(function (el) { el.setAttribute('aria-label', el.getAttribute('data-label-' + l)); });
    $$('img[data-alt-' + l + ']').forEach(function (el) { el.setAttribute('alt', el.getAttribute('data-alt-' + l)); });
    $$('title[data-text-' + l + ']').forEach(function (el) { el.textContent = el.getAttribute('data-text-' + l); });
    $$('[data-set-lang]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-set-lang') === l)); });
    if (save) {
      store(LANG_KEY, l);
      if (/[?&]lang=/.test(location.search) && window.history && history.replaceState) {
        try { history.replaceState(null, '', location.pathname + location.search.replace(/([?&]lang=)(mn|en)\b/, '$1' + l) + location.hash); } catch { /* ignore */ }
      }
    }
    langListeners.forEach(function (fn) { fn(l); });
  }
  $$('[data-set-lang]').forEach(function (b) {
    b.addEventListener('click', function () { applyLang(b.getAttribute('data-set-lang'), true); });
  });

  /* ------------------------------------------------------------------ menu */
  var header = $('.site-header');
  var menuBtn = $('.menu-btn');
  var nav = $('#site-nav');
  function setMenu(open, focusBtn) {
    if (!menuBtn || !nav) return;
    menuBtn.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('open', open);
    header.classList.toggle('menu-open', open);
    if (!open && focusBtn) menuBtn.focus();
  }
  if (menuBtn && nav) {
    menuBtn.addEventListener('click', function () { setMenu(menuBtn.getAttribute('aria-expanded') !== 'true'); });
    $$('a', nav).forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menuBtn.getAttribute('aria-expanded') === 'true') setMenu(false, true);
    });
    doc.addEventListener('click', function (e) {
      if (menuBtn.getAttribute('aria-expanded') === 'true' && !nav.contains(e.target) && !menuBtn.contains(e.target)) setMenu(false);
    });
    window.addEventListener('resize', function () { if (window.innerWidth >= 1160) setMenu(false); });
  }

  /* ------------------------------------------------------------------ downloads */
  var downloads = {
    x64: 'https://github.com/' + REPO + '/releases/download/v0.1.0/MorinKhuurSimulator-Setup-0.1.0-x64.exe',
    arm64: 'https://github.com/' + REPO + '/releases/download/v0.1.0/MorinKhuurSimulator-Setup-0.1.0-arm64.exe',
    portable: 'https://github.com/' + REPO + '/releases/download/v0.1.0/MorinKhuurSimulator-Portable-0.1.0.exe'
  };
  var os = root.getAttribute('data-os') || 'win';

  function updatePrimary() {
    var arm = root.getAttribute('data-arch') === 'arm';
    $$('[data-dl="primary"]').forEach(function (a) { a.href = arm ? downloads.arm64 : downloads.x64; });
  }
  if (os === 'win' && navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function') {
    navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness']).then(function (v) {
      if (v && v.architecture === 'arm') { root.setAttribute('data-arch', 'arm'); updatePrimary(); }
    }).catch(function () {});
  }

  function parseRelease(j) {
    if (!j || j.draft || j.prerelease || !Array.isArray(j.assets)) return null;
    var v = String(j.tag_name || '').replace(/^v/i, '');
    if (!/^\d+\.\d+\.\d+([.+-][0-9A-Za-z.-]+)?$/.test(v)) return null;
    var out = { version: v, assets: {} };
    j.assets.forEach(function (a) {
      var name = (a && a.name) || '';
      var url = (a && a.browser_download_url) || '';
      if (url.indexOf('https://github.com/' + REPO + '/') !== 0) return;
      var key = /Portable-.*\.exe$/i.test(name) ? 'portable' : /-arm64\.exe$/i.test(name) ? 'arm64' : /-x64\.exe$/i.test(name) ? 'x64' : null;
      if (key && !out.assets[key]) out.assets[key] = { url: url, size: Number(a.size) || 0 };
    });
    return out.assets.x64 ? out : null;
  }

  function applyRelease(r) {
    if (!r || !r.assets) return;
    Object.keys(r.assets).forEach(function (key) {
      var asset = r.assets[key];
      if (!asset || typeof asset.url !== 'string' || asset.url.indexOf('https://github.com/' + REPO + '/') !== 0) return;
      downloads[key] = asset.url;
      $$('[data-dl="' + key + '"]').forEach(function (a) { a.href = asset.url; });
      if (asset.size > 0) {
        var mb = String(Math.floor(asset.size / 1048576));
        $$('[data-size="' + key + '"]').forEach(function (el) { el.textContent = mb; });
      }
    });
    if (r.version) {
      $$('[data-version]').forEach(function (el) { el.textContent = r.version; });
      $$('[data-first-release]').forEach(function (el) { el.hidden = r.version !== STATIC_VERSION; });
    }
    updatePrimary();
  }

  function loadRelease() {
    var cached = null;
    try { cached = JSON.parse(read(RELEASE_KEY) || 'null'); } catch { cached = null; }
    if (cached && cached.r) applyRelease(cached.r); // the last known release, even when stale
    var ttl = cached && cached.fail ? 10 * 60 * 1000 : 30 * 60 * 1000;
    if (cached && typeof cached.t === 'number' && Date.now() - cached.t < ttl) return;
    if (!window.fetch) return;
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 7000);
    fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status); // rate limit, no release yet…
      return res.json();
    }).then(function (json) {
      var r = parseRelease(json);
      if (!r) throw new Error('no usable release');
      applyRelease(r);
      store(RELEASE_KEY, JSON.stringify({ t: Date.now(), r: r }));
    }).catch(function () {
      /* keep the links we have; try again in a few minutes */
      store(RELEASE_KEY, JSON.stringify({ t: Date.now(), r: cached && cached.r ? cached.r : null, fail: true }));
    }).then(function () { clearTimeout(timer); });
  }
  updatePrimary();
  loadRelease();

  /* "send this page to your PC" (phones) */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = doc.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      doc.body.appendChild(ta); ta.select();
      try { if (doc.execCommand('copy')) resolve(); else reject(); } catch (err) { reject(err); }
      doc.body.removeChild(ta);
    });
  }
  function flashDone(btn) {
    btn.classList.add('is-done');
    clearTimeout(btn._t);
    btn._t = setTimeout(function () { btn.classList.remove('is-done'); }, 2200);
  }
  $$('[data-share-link]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (navigator.share) {
        navigator.share({ title: doc.title, url: SITE_URL }).catch(function () {});
        return;
      }
      copyText(SITE_URL).then(function () { flashDone(btn); }, function () {});
    });
  });
  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var src = doc.getElementById(btn.getAttribute('data-copy'));
      if (src) copyText(src.textContent.trim()).then(function () { flashDone(btn); }, function () {});
    });
  });

  /* ------------------------------------------------------------------ audio */
  var players = [];
  var live = $('#live');
  var heroEl = $('.hero');
  var raf = 0;

  function waveSVG(file, cls) {
    var peaks = PEAKS[file] || [];
    var d = '';
    for (var i = 0; i < peaks.length; i++) {
      var h = Math.max(5, peaks[i] * 0.94);
      d += 'M' + (i * 5 + 1) + ' ' + (50 - h / 2).toFixed(1) + 'h3v' + h.toFixed(1) + 'h-3z';
    }
    return '<svg class="' + cls + '" viewBox="0 0 ' + (peaks.length * 5) + ' 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="' + d + '"/></svg>';
  }

  function makePlayer(el) {
    var audios = $$('audio', el);
    if (!audios.length) return null;
    var btn = $('.p-play', el);
    var wave = $('[data-wave]', el);
    var now = $('.p-now', el);
    var total = $('.p-total', el);
    var styleName = $('.p-style-name', el);
    var titleEl = $('.p-title', el);
    var isAB = el.hasAttribute('data-ab');
    var idx = 0;
    var pending = null;
    var seek;
    var api;

    function cur() { return audios[idx]; }
    function dur(a) {
      a = a || cur();
      return (isFinite(a.duration) && a.duration > 0) ? a.duration : (parseFloat(a.getAttribute('data-duration')) || 0);
    }
    function time() { var a = cur(); return pending != null ? pending * dur(a) : a.currentTime; }
    function title() {
      var name = textOf(titleEl);
      return isAB ? name + ' — ' + T[lang()].styles[idx] : name;
    }
    function drawWave() {
      var file = cur().getAttribute('data-file');
      wave.innerHTML = waveSVG(file, 'w-base') + waveSVG(file, 'w-played') + '<span class="p-head" aria-hidden="true"></span>' +
        '<input class="p-seek" type="range" min="0" max="1000" step="10" value="0">';
      seek = $('.p-seek', wave);
      seek.addEventListener('input', function () { seekTo(Number(seek.value) / 1000); });
      seek.addEventListener('keydown', function (e) {
        var D = dur(), t = time(), step = null;
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); return; }
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step = 2;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step = -2;
        else if (e.key === 'PageUp') step = 5;
        else if (e.key === 'PageDown') step = -5;
        else if (e.key === 'Home') step = -t;
        else if (e.key === 'End') step = D - t - 0.05;
        if (step === null || !D) return;
        e.preventDefault();
        var f = Math.min(1, Math.max(0, (t + step) / D));
        seekTo(f);
        seek.value = String(Math.round(f * 100) * 10);
      });
      labels();
    }
    function render() {
      var D = dur();
      var t = time();
      var f = D ? Math.min(1, Math.max(0, t / D)) : 0;
      wave.style.setProperty('--p', (f * 100).toFixed(2) + '%');
      var v = String(Math.round(f * 100) * 10);
      if (seek && doc.activeElement !== seek && seek.value !== v) seek.value = v;
      setText(now, fmt(t));
      setText(total, fmt(D));
      if (seek) {
        var vt = fmt(t) + ' / ' + fmt(D);
        if (seek.getAttribute('aria-valuetext') !== vt) seek.setAttribute('aria-valuetext', vt);
      }
    }
    function playing() { return !cur().paused && !cur().ended; }
    function labels() {
      var L = T[lang()];
      var name = title();
      btn.setAttribute('aria-label', (playing() ? L.pause : L.play) + (name ? ': ' + name : ''));
      if (seek) seek.setAttribute('aria-label', L.seek + (name ? ': ' + name : ''));
      if (styleName) styleName.textContent = isAB ? L.styles[idx] : '';
    }
    function applyPending() {
      var a = cur();
      if (pending != null && isFinite(a.duration) && a.duration > 0) {
        try { a.currentTime = pending * a.duration; pending = null; } catch { /* not seekable yet */ }
      }
    }
    function warmOthers() {
      audios.forEach(function (a) { if (a !== cur() && a.preload === 'none') { a.preload = 'auto'; a.load(); } });
    }
    function play() {
      players.forEach(function (p) { if (p !== api) p.pause(); });
      var a = cur();
      applyPending();
      var pr = a.play(); // called synchronously inside the click: Safari-safe
      if (pr && pr.catch) pr.catch(function () { changed(); });
      if (isAB) warmOthers();
    }
    function pause() { audios.forEach(function (a) { if (!a.paused) a.pause(); }); }
    function toggle() { if (playing()) pause(); else play(); }
    function seekTo(f) {
      var a = cur();
      el.classList.add('has-played');
      if (a.readyState >= 1 && isFinite(a.duration) && a.duration > 0) {
        a.currentTime = f * a.duration;
        pending = null;
      } else {
        pending = f;
        if (a.preload === 'none') { a.preload = 'metadata'; a.load(); }
      }
      render();
      sync();
    }
    function select(i, autoplay) {
      if (!audios[i]) return;
      if (i === idx) { if (autoplay && !playing()) play(); return; }
      var from = cur();
      var was = playing() || autoplay;
      var D = dur(from);
      var f = pending != null ? pending : (D ? from.currentTime / D : 0);
      if (!from.paused) from.pause();
      idx = i;
      el.setAttribute('data-active', String(i));
      $$('input[type="radio"]', el).forEach(function (r) { r.checked = Number(r.value) === i; });
      pending = f >= 0.995 ? 0 : f;
      drawWave();
      if (was) play();
      else changed();
      render();
    }
    function changed() {
      el.classList.toggle('is-playing', playing());
      labels();
      sync();
    }

    btn.addEventListener('click', toggle);
    audios.forEach(function (a, i) {
      a.removeAttribute('controls');
      a.addEventListener('loadedmetadata', function () { if (i === idx) { applyPending(); render(); } });
      a.addEventListener('timeupdate', function () { if (i === idx && !raf) { render(); sync(); } });
      a.addEventListener('play', function () { if (i === idx) { el.classList.add('has-played'); changed(); announce(api, true); } });
      a.addEventListener('pause', function () { if (i === idx) { changed(); if (!a.ended) announce(api, false); } });
      a.addEventListener('ended', function () {
        if (i !== idx) return;
        try { a.currentTime = 0; } catch { /* ignore */ }
        changed();
        render();
      });
    });
    if (isAB) {
      el.setAttribute('data-active', '0');
      $$('input[type="radio"]', el).forEach(function (r) {
        r.addEventListener('change', function () { if (r.checked) select(Number(r.value)); });
      });
    }
    drawWave();
    render();
    langListeners.push(labels);

    api = {
      el: el, isAB: isAB, play: play, pause: pause, toggle: toggle, playing: playing, select: select, render: render,
      title: title, time: time, duration: function () { return dur(); },
      index: function () { return idx; },
      file: function () { return cur().getAttribute('data-file'); },
      files: function () { return audios.map(function (a) { return a.getAttribute('data-file'); }); }
    };
    return api;
  }

  var abPlayer = null;
  $$('[data-player]').forEach(function (el) {
    var p = makePlayer(el);
    if (!p) return;
    players.push(p);
    if (p.isAB) abPlayer = p;
  });
  function playerFor(file) {
    for (var i = 0; i < players.length; i++) if (players[i].files().indexOf(file) >= 0) return players[i];
    return null;
  }
  function active() {
    for (var i = 0; i < players.length; i++) if (players[i].playing()) return players[i];
    return null;
  }

  function announce(p, on) {
    if (!live) return;
    var L = T[lang()];
    live.textContent = (on ? L.playing : L.paused) + ': ' + p.title();
  }

  /* hero remote */
  var hp = $('[data-hero-player]');
  var hpSource = abPlayer;
  var hpPlay = hp && $('[data-hp-play]', hp);
  var hpNow = hp && $('[data-hp-now]', hp);
  var hpNowDefault = hpNow ? hpNow.innerHTML : '';
  var hpTime = hp && $('[data-hp-time]', hp);
  var hpFill = hp && $('[data-hp-fill]', hp);
  var hpStyles = hp ? $$('[data-hp-style]', hp) : [];
  var hpPads = hp ? $$('[data-hp-pad]', hp) : [];
  var hpLastNow = null;

  function hpProgress(p) {
    var D = p.duration(), t = p.time();
    if (hpFill) hpFill.style.setProperty('--f', D ? Math.min(1, t / D).toFixed(4) : '0');
    setText(hpTime, (t > 0.05 || p.playing()) ? fmt(t) + ' / ' + fmt(D) : fmt(D));
  }
  function hpSync() {
    if (!hp || !hpSource) return;
    var p = active() || hpSource;
    var on = p.playing();
    var L = T[lang()];
    hp.classList.toggle('is-playing', on);
    setAttr(hpPlay, 'aria-label', (on ? L.pause : L.play) + ': ' + p.title());
    hpStyles.forEach(function (b) {
      setAttr(b, 'aria-pressed', String(p === abPlayer && p.index() === Number(b.getAttribute('data-hp-style'))));
    });
    hpPads.forEach(function (b) {
      setAttr(b, 'aria-pressed', String(p !== abPlayer && on && p.files().indexOf(b.getAttribute('data-hp-pad')) >= 0));
    });
    var nowKey = p === abPlayer ? '' : p.title() + lang();
    if (hpNow && nowKey !== hpLastNow) {
      hpLastNow = nowKey;
      if (p === abPlayer) hpNow.innerHTML = hpNowDefault;
      else hpNow.textContent = '· ' + p.title();
    }
    hpProgress(p);
  }
  if (hp && abPlayer) {
    hpPlay.addEventListener('click', function () {
      var p = active() || hpSource;
      hpSource = p;
      p.toggle();
    });
    hpStyles.forEach(function (b) {
      b.addEventListener('click', function () {
        hpSource = abPlayer;
        abPlayer.select(Number(b.getAttribute('data-hp-style')), true);
      });
    });
    hpPads.forEach(function (b) {
      b.addEventListener('click', function () {
        var p = playerFor(b.getAttribute('data-hp-pad'));
        if (!p) return;
        if (p.playing()) { p.pause(); return; }
        hpSource = p;
        p.play();
      });
    });
    langListeners.push(function () { hpLastNow = null; hpSync(); });
  }

  /* now-playing bar: appears when the playing clip's own controls are out of view */
  var mini = $('#mini');
  var miniTarget = null;
  var miniClosed = false;
  var visible = typeof WeakMap === 'function' ? new WeakMap() : null;
  var heroPlayerVisible = true;
  var miniPlay = mini && $('.mini-play', mini);
  var miniTitle = mini && $('.mini-title', mini);
  var miniTime = mini && $('.mini-time', mini);
  var miniBar = mini && $('.mini-bar span', mini);

  function miniSync() {
    if (!mini) return;
    var a = active();
    if (a) { if (a !== miniTarget) miniClosed = false; miniTarget = a; }
    var p = miniTarget;
    var show = !!(p && !miniClosed && visible && visible.get(p.el) === false && !(heroPlayerVisible && hp) && (p.playing() || p.time() > 0.05));
    if (mini.hidden === show) mini.hidden = !show;
    if (!show) return;
    var L = T[lang()];
    var D = p.duration(), t = p.time();
    mini.classList.toggle('is-playing', p.playing());
    var ml = (p.playing() ? L.pause : L.play) + ': ' + p.title();
    if (miniPlay.getAttribute('aria-label') !== ml) miniPlay.setAttribute('aria-label', ml);
    setText(miniTitle, p.title());
    setText(miniTime, fmt(t) + ' / ' + fmt(D));
    miniBar.style.setProperty('--f', D ? Math.min(1, t / D).toFixed(4) : '0');
  }
  if (mini) {
    miniPlay.addEventListener('click', function () { if (miniTarget) miniTarget.toggle(); });
    $('.mini-close', mini).addEventListener('click', function () {
      if (miniTarget) miniTarget.pause();
      miniClosed = true;
      mini.hidden = true;
    });
    if ('IntersectionObserver' in window && visible) {
      var vio = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.target === hp) heroPlayerVisible = en.isIntersecting;
          else visible.set(en.target, en.isIntersecting);
        });
        miniSync();
      }, { threshold: 0 });
      players.forEach(function (p) { visible.set(p.el, true); vio.observe(p.el); });
      if (hp) vio.observe(hp);
    }
  }

  /* one loop while anything plays: progress, hero remote, mini bar, string glow */
  function tick() {
    var a = active();
    if (a) {
      a.render();
      hpSync();
      miniSync();
      var peaks = PEAKS[a.file()] || [];
      var D = a.duration();
      var v = peaks.length && D ? peaks[Math.min(peaks.length - 1, Math.floor(a.time() / D * peaks.length))] / 100 : 0.8;
      if (heroEl) heroEl.style.setProperty('--amp', (0.2 + 0.8 * v).toFixed(2));
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
    }
  }
  function sync() {
    var any = !!active();
    root.classList.toggle('audio-on', any);
    hpSync();
    miniSync();
    if (any && !raf) raf = requestAnimationFrame(tick);
  }
  langListeners.push(function () { miniSync(); });
  hpSync();

  /* ------------------------------------------------------------------ lightbox */
  var dlg = $('#lightbox');
  if (dlg && typeof dlg.showModal === 'function') {
    var big = null;
    $$('a[data-lightbox]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        var thumb = $('img', a);
        var wide = window.innerWidth * (window.devicePixelRatio || 1) > 1700;
        if (!big) {
          big = doc.createElement('img');
          big.width = 2880; big.height = 1800; big.decoding = 'async';
          dlg.appendChild(big);
        }
        big.src = wide ? a.getAttribute('href') : a.getAttribute('href').replace('-2880.', '-1440.');
        big.alt = thumb ? thumb.alt : '';
        dlg.showModal();
      });
    });
    dlg.addEventListener('click', function (e) { if (e.target === dlg || e.target === big) dlg.close(); });
    $('.lightbox-close', dlg).addEventListener('click', function () { dlg.close(); });
  }

  /* ------------------------------------------------------------------ header */
  function onScroll() { header.classList.toggle('is-scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ------------------------------------------------------------------ motion */
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* the hero's ambient animations stop when it is off screen or the tab is hidden */
  if (heroEl && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      heroEl.classList.toggle('anim-off', !entries[0].isIntersecting);
    }).observe(heroEl);
  }
  doc.addEventListener('visibilitychange', function () { root.classList.toggle('anim-off', doc.hidden); });

  if ('IntersectionObserver' in window && !reduce) {
    var items = $$('.reveal');
    items.forEach(function (el) {
      var sibs = Array.prototype.filter.call(el.parentNode.children, function (c) { return c.classList.contains('reveal'); });
      var i = sibs.indexOf(el);
      if (i > 0) el.style.transitionDelay = Math.min(i, 5) * 70 + 'ms';
    });
    root.classList.add('reveal-on');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    items.forEach(function (el) { io.observe(el); });
    window.addEventListener('beforeprint', function () { items.forEach(function (el) { el.classList.add('in'); }); });
  }

  /* Final: apply the language picked in <head> to attributes and labels. */
  applyLang(lang(), false);
})();
