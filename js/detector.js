'use strict';

(function () {
  if (window.__tabVideoRecorderInjected) return;
  window.__tabVideoRecorderInjected = true;

  const MIN_SIDE = 40;
  const END_TOLERANCE = 0.3;

  let watched = null;
  let endedNotified = false;

  function log(...args) {
    console.log('[TabRecorder-Detector]', ...args);
  }

  function send(message) {
    try {
      const promise = chrome.runtime.sendMessage(message);
      if (promise && promise.catch) promise.catch(() => {});
    } catch (e) {
      log('Falha ao enviar mensagem', e);
    }
  }

  function scan(doc, ox, oy, depth, deep, list) {
    if (!doc || depth > 3) return;

    let videos = [];
    try {
      videos = Array.from(doc.querySelectorAll('video'));
    } catch (e) {
      videos = [];
    }
    videos.forEach(video => list.push({ video, ox, oy }));

    if (deep) {
      try {
        Array.from(doc.querySelectorAll('*')).forEach(el => {
          if (el.shadowRoot) scan(el.shadowRoot, ox, oy, depth + 1, true, list);
        });
      } catch (e) {
        log('Falha ao varrer shadow DOM', e);
      }
    }

    try {
      Array.from(doc.querySelectorAll('iframe')).forEach(frame => {
        let child = null;
        try {
          child = frame.contentDocument;
        } catch (e) {
          child = null;
        }
        if (!child) return;
        const rect = frame.getBoundingClientRect();
        const view = child.defaultView;
        scan(
          child,
          ox + rect.left - (view ? view.scrollX : 0),
          oy + rect.top - (view ? view.scrollY : 0),
          depth + 1,
          deep,
          list
        );
      });
    } catch (e) {
      log('Falha ao varrer iframes', e);
    }
  }

  function collectVideos() {
    const list = [];
    let deep = false;
    try {
      deep = document.querySelectorAll('video').length === 0;
    } catch (e) {
      deep = false;
    }
    scan(document, 0, 0, 0, deep, list);
    return list;
  }

  function describe(entry) {
    const video = entry.video;
    if (!video || video.tagName !== 'VIDEO') return null;

    let rect = null;
    try {
      rect = video.getBoundingClientRect();
    } catch (e) {
      return null;
    }

    const x = rect.left + entry.ox;
    const y = rect.top + entry.oy;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const left = Math.max(0, Math.min(viewportW, x));
    const top = Math.max(0, Math.min(viewportH, y));
    const right = Math.max(0, Math.min(viewportW, x + rect.width));
    const bottom = Math.max(0, Math.min(viewportH, y + rect.height));
    const visible = {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    };

    let style = null;
    try {
      style = window.getComputedStyle(video);
    } catch (e) {
      style = null;
    }
    const hidden = !style ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0;

    const width = Number(video.videoWidth) || 0;
    const height = Number(video.videoHeight) || 0;
    const rawDuration = Number(video.duration);
    const duration = isFinite(rawDuration) ? rawDuration : null;
    const playing = !video.paused && !video.ended && video.readyState >= 2;

    let score = visible.width * visible.height;
    if (playing) score *= 3;
    if (width > 0 && height > 0) score += 100000;
    if (duration !== null) score += 20000;
    if (hidden) score = -1;
    if (visible.width < MIN_SIDE || visible.height < MIN_SIDE) score = Math.min(score, 1);

    return {
      score,
      found: true,
      videoWidth: width,
      videoHeight: height,
      duration,
      currentTime: Number(video.currentTime) || 0,
      paused: !!video.paused,
      ended: !!video.ended,
      muted: !!video.muted,
      loop: !!video.loop,
      drm: !!(video.mediaKeys || video.webkitKeys),
      objectFit: style ? style.objectFit : 'contain',
      rect: visible,
      elementRect: { x, y, width: rect.width, height: rect.height }
    };
  }

  function analyze() {
    const entries = collectVideos();
    const infos = [];

    entries.forEach(entry => {
      const info = describe(entry);
      if (!info || info.score < 0) return;
      if (info.rect.width < MIN_SIDE || info.rect.height < MIN_SIDE) return;
      if (!info.videoWidth && info.duration === null) return;
      infos.push({ info, entry });
    });

    infos.sort((a, b) => b.info.score - a.info.score);
    const best = infos[0] || null;

    return {
      best,
      result: {
        ok: true,
        title: document.title,
        url: location.href,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio || 1
        },
        video: best ? best.info : null,
        candidates: infos.length,
        at: Date.now()
      }
    };
  }

  function attach(video) {
    if (watched === video) return;
    detach();
    watched = video;
    endedNotified = false;
    video.addEventListener('ended', onEnded);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('play', onPlay);
    video.addEventListener('seeked', onSeeked);
  }

  function detach() {
    if (!watched) return;
    try {
      watched.removeEventListener('ended', onEnded);
      watched.removeEventListener('pause', onPause);
      watched.removeEventListener('timeupdate', onTimeUpdate);
      watched.removeEventListener('play', onPlay);
      watched.removeEventListener('seeked', onSeeked);
    } catch (e) {
      log('Falha ao remover listeners', e);
    }
    watched = null;
  }

  function watch() {
    const { result, best } = analyze();
    if (best) attach(best.entry.video);
    else detach();
    return result;
  }

  function onEnded() {
    notifyEnded('ended');
  }

  // Alguns players pausam no último frame em vez de disparar `ended`.
  function onPause() {
    if (!watched) return;
    const duration = Number(watched.duration);
    if (!isFinite(duration) || duration <= 0 || watched.loop) return;
    if (watched.currentTime >= duration - END_TOLERANCE) notifyEnded('pause');
  }

  function onTimeUpdate() {
    if (!watched) return;
    const duration = Number(watched.duration);
    if (!isFinite(duration) || duration <= 0 || watched.loop) return;
    if (watched.currentTime >= duration - END_TOLERANCE) notifyEnded('timeupdate');
  }

  function onPlay() {
    endedNotified = false;
  }

  function onSeeked() {
    if (!watched) return;
    const duration = Number(watched.duration);
    if (isFinite(duration) && duration > 0 && watched.currentTime < duration - 1) {
      endedNotified = false;
    }
  }

  function notifyEnded(source) {
    if (endedNotified) return;
    endedNotified = true;

    const { result } = analyze();
    send({
      target: 'background',
      type: 'TVR_VIDEO_EVENT',
      event: 'ended',
      source,
      video: result.video,
      viewport: result.viewport
    });
  }

  document.addEventListener('play', event => {
    const video = event.target;
    if (!video || video.tagName !== 'VIDEO') return;
    if (watched === video) {
      endedNotified = false;
      return;
    }
    if (!watched || watched.paused) attach(video);
  }, true);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'content') return false;

    if (msg.type === 'TVR_WATCH') {
      sendResponse(watch());
      return false;
    }
    if (msg.type === 'TVR_DETECT') {
      sendResponse(analyze().result);
      return false;
    }
    return false;
  });

  log('Detector carregado');
})();
