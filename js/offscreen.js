'use strict';

const LOG_PREFIX = '[TabRecorder-Offscreen]';
// Teto só do modo memória (fallback). No modo disco não existe limite de tamanho.
const MAX_BYTES = 1.5 * 1024 * 1024 * 1024;
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm'
];

let session = null;
let lastBlobUrl = null;

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function even(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stopTracks(stream) {
  if (!stream) return;
  try {
    stream.getTracks().forEach(track => track.stop());
  } catch (e) {
    log('stopTracks', errMessage(e));
  }
}

function normalizeSettings(settings) {
  const value = Object.assign({ mode: 'crop', maxHeight: 1080, fps: 30, monitorAudio: true }, settings || {});
  value.mode = value.mode === 'tab' ? 'tab' : 'crop';
  value.fps = clamp(Number(value.fps) || 30, 10, 60);
  value.maxHeight = Number(value.maxHeight) || 0;
  value.monitorAudio = value.monitorAudio !== false;
  return value;
}

async function openStream(streamId, settings) {
  const base = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  const attempts = [
    {
      audio: { mandatory: base },
      video: { mandatory: Object.assign({ maxFrameRate: settings.fps }, base) }
    },
    {
      audio: { mandatory: base },
      video: { mandatory: base }
    },
    {
      video: { mandatory: base }
    }
  ];

  let lastError = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      lastError = e;
      log('Tentativa de captura falhou', errMessage(e));
    }
  }
  throw lastError || new Error('Não foi possível capturar a aba.');
}

function pickContent(video, viewport, mode) {
  const viewportWidth = Math.max(2, Number(viewport && viewport.width) || window.innerWidth || 1280);
  const viewportHeight = Math.max(2, Number(viewport && viewport.height) || window.innerHeight || 720);

  if (mode === 'tab' || !video || !video.found) {
    return {
      rect: { x: 0, y: 0, width: viewportWidth, height: viewportHeight },
      aspect: viewportWidth / viewportHeight,
      viewportWidth,
      viewportHeight
    };
  }

  const rect = {
    x: Number(video.rect && video.rect.x) || 0,
    y: Number(video.rect && video.rect.y) || 0,
    width: Math.max(0, Number(video.rect && video.rect.width) || 0),
    height: Math.max(0, Number(video.rect && video.rect.height) || 0)
  };

  if (rect.width < 40 || rect.height < 40) {
    return {
      rect: { x: 0, y: 0, width: viewportWidth, height: viewportHeight },
      aspect: viewportWidth / viewportHeight,
      viewportWidth,
      viewportHeight
    };
  }

  const intrinsicWidth = Number(video.videoWidth) || 0;
  const intrinsicHeight = Number(video.videoHeight) || 0;
  const intrinsic = intrinsicWidth > 0 && intrinsicHeight > 0
    ? intrinsicWidth / intrinsicHeight
    : (rect.width / rect.height || 16 / 9);
  const fit = String(video.objectFit || 'contain').toLowerCase();
  const elementRect = video.elementRect || rect;
  const clipped = elementRect.width > rect.width + 2 || elementRect.height > rect.height + 2;

  if (fit === 'cover' || fit === 'fill' || clipped) {
    return {
      rect,
      aspect: rect.width > 0 && rect.height > 0 ? rect.width / rect.height : intrinsic,
      viewportWidth,
      viewportHeight
    };
  }

  let contentWidth = rect.width;
  let contentHeight = rect.height;
  if (rect.width / rect.height > intrinsic) contentWidth = rect.height * intrinsic;
  else contentHeight = rect.width / intrinsic;

  return {
    rect: {
      x: rect.x + (rect.width - contentWidth) / 2,
      y: rect.y + (rect.height - contentHeight) / 2,
      width: contentWidth,
      height: contentHeight
    },
    aspect: intrinsic,
    viewportWidth,
    viewportHeight
  };
}

function computeOutput(content, trackSettings, settings) {
  const captureWidth = Math.max(2, Number(trackSettings.width) || content.viewportWidth);
  const captureHeight = Math.max(2, Number(trackSettings.height) || content.viewportHeight);
  const scaleX = captureWidth / content.viewportWidth;
  const scaleY = captureHeight / content.viewportHeight;

  let sx = content.rect.x * scaleX;
  let sy = content.rect.y * scaleY;
  let sw = content.rect.width * scaleX;
  let sh = content.rect.height * scaleY;

  sx = clamp(sx, 0, captureWidth - 2);
  sy = clamp(sy, 0, captureHeight - 2);
  sw = clamp(sw, 2, captureWidth - sx);
  sh = clamp(sh, 2, captureHeight - sy);

  let outHeight = Math.min(sh, captureHeight);
  if (settings.maxHeight > 0) outHeight = Math.min(outHeight, settings.maxHeight);
  outHeight = even(outHeight);

  let outWidth = even(outHeight * content.aspect);
  if (outWidth > sw) {
    outWidth = even(sw);
    outHeight = even(outWidth / content.aspect);
  }

  return {
    sx,
    sy,
    sw,
    sh,
    outWidth,
    outHeight,
    captureWidth,
    captureHeight
  };
}

function pickMime(hasAudio) {
  const list = hasAudio
    ? MIME_CANDIDATES
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

  for (const mime of list) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch (e) {
      log('isTypeSupported', mime, errMessage(e));
    }
  }
  return '';
}

async function openDiskTarget() {
  const store = self.TVRFileHandleStore;
  if (!store) return null;

  let handle = null;
  try {
    handle = await store.load();
  } catch (e) {
    log('Falha ao ler o destino no IndexedDB', errMessage(e));
    return null;
  }
  if (!handle || typeof handle.createWritable !== 'function') return null;

  try {
    let permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      permission = await handle.requestPermission({ mode: 'readwrite' });
    }
    if (permission !== 'granted') {
      log('Sem permissão de escrita para', handle.name);
      return null;
    }
    const writable = await handle.createWritable();
    return { handle, writable, name: handle.name };
  } catch (e) {
    log('Falha ao abrir o arquivo escolhido', errMessage(e));
    return null;
  }
}

// Grava cada chunk em sequência, direto no arquivo. Nada fica acumulado na RAM.
function queueWrite(active, blob) {
  const size = blob.size;
  active.pendingBytes += size;
  active.writeChain = active.writeChain
    .then(() => active.writable.write(blob))
    .then(() => {
      active.pendingBytes -= size;
    })
    .catch(err => {
      active.pendingBytes -= size;
      active.writeError = errMessage(err);
      log('Falha ao escrever no disco', active.writeError);
      if (!active.stopping) stopRecording('write-error');
    });
}

function drawFrame(active, source) {
  if (!source) return;
  try {
    active.ctx.drawImage(
      source,
      active.size.sx,
      active.size.sy,
      active.size.sw,
      active.size.sh,
      0,
      0,
      active.size.outWidth,
      active.size.outHeight
    );
  } catch (e) {
    // Frame ainda sem dados ou já fechado: ignora.
  }
}

function setupDrawLoop(active) {
  if (typeof MediaStreamTrackProcessor !== 'undefined') {
    try {
      const processor = new MediaStreamTrackProcessor({ track: active.videoTrack });
      const reader = processor.readable.getReader();
      active.reader = reader;

      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (session !== active) {
              if (value && value.close) value.close();
              break;
            }
            drawFrame(active, value);
            if (value && value.close) value.close();
          }
        } catch (e) {
          if (session === active) log('Loop de frames encerrado', errMessage(e));
        }
      })();
      return;
    } catch (e) {
      log('MediaStreamTrackProcessor falhou; usando fallback', errMessage(e));
    }
  }

  try {
    const videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    videoEl.srcObject = new MediaStream([active.videoTrack]);
    document.body.appendChild(videoEl);
    active.videoEl = videoEl;
    videoEl.play().catch(() => {});

    const paint = () => {
      if (session !== active) return;
      drawFrame(active, videoEl);
      if (typeof videoEl.requestVideoFrameCallback === 'function') {
        active.frameCallback = videoEl.requestVideoFrameCallback(paint);
      }
    };

    if (typeof videoEl.requestVideoFrameCallback === 'function') {
      active.frameCallback = videoEl.requestVideoFrameCallback(paint);
    } else {
      active.timer = setInterval(paint, 1000 / active.settings.fps);
    }
  } catch (e) {
    log('Fallback de desenho falhou', errMessage(e));
  }
}

function cleanupSession(active) {
  session = null;

  if (active.reader) {
    try {
      active.reader.cancel();
    } catch (e) {
      log('reader.cancel', errMessage(e));
    }
  }
  if (active.timer) clearInterval(active.timer);
  if (active.videoEl) {
    try {
      active.videoEl.pause();
      active.videoEl.srcObject = null;
      active.videoEl.remove();
    } catch (e) {
      log('remove videoEl', errMessage(e));
    }
  }
  stopTracks(active.canvasStream);
  stopTracks(active.stream);
  if (active.audioCtx) {
    active.audioCtx.close().catch(() => {});
  }
}

async function notifyBackground(payload) {
  try {
    return await chrome.runtime.sendMessage(Object.assign({ target: 'background' }, payload));
  } catch (e) {
    log('Falha ao avisar o service worker', errMessage(e));
    return null;
  }
}

function anchorDownload(blobUrl, filename) {
  try {
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = String(filename || 'video.webm')
      .replace(/^TabRecorder\//, '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim() || 'video.webm';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => link.remove(), 1000);
  } catch (e) {
    log('Download de fallback falhou', errMessage(e));
  }
}

async function stopRecording(reason) {
  const active = session;
  if (!active) return { ok: true, alreadyStopped: true };
  if (active.stopping) return { ok: true, pending: true };

  active.stopping = true;
  active.reason = reason || 'user-stop';

  if (active.reason === 'video-ended') await sleep(400);

  if (active.recorder && active.recorder.state !== 'inactive') {
    await new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      active.recorder.addEventListener('stop', done, { once: true });
      setTimeout(done, 5000);
      try {
        active.recorder.stop();
      } catch (e) {
        log('recorder.stop', errMessage(e));
        done();
      }
    });
  }

  return finalize(active);
}

async function finalize(active) {
  cleanupSession(active);

  const type = active.mimeType || 'video/webm';
  const durationMs = Date.now() - active.startedAt;
  const base = {
    mimeType: type,
    durationMs,
    reason: active.reason,
    width: active.size.outWidth,
    height: active.size.outHeight,
    tabTitle: active.tabTitle
  };

  if (active.writable) {
    let writeError = active.writeError;
    try {
      await active.writeChain;
      await active.writable.close();
    } catch (e) {
      writeError = writeError || errMessage(e);
    }
    active.writable = null;

    const bytes = active.bytes;
    const error = writeError
      ? `Falha ao escrever no disco: ${writeError}`
      : (bytes ? null : 'Nenhum dado foi gravado.');

    await notifyBackground(Object.assign({
      type: 'TVR_DONE',
      directWrite: true,
      filename: active.fileName,
      bytes,
      error: error || undefined
    }, base));

    if (error) return { ok: false, error, reason: active.reason };

    return {
      ok: true,
      mode: 'disk',
      filename: active.fileName,
      bytes,
      durationMs,
      width: active.size.outWidth,
      height: active.size.outHeight,
      mimeType: type,
      reason: active.reason
    };
  }

  const blob = new Blob(active.chunks, { type });
  active.chunks = [];

  if (!blob.size) {
    const error = 'Nenhum dado foi gravado.';
    await notifyBackground({
      type: 'TVR_DONE',
      error,
      reason: active.reason,
      durationMs,
      mimeType: type,
      bytes: 0,
      tabTitle: active.tabTitle
    });
    return { ok: false, error, reason: active.reason };
  }

  if (lastBlobUrl) {
    try {
      URL.revokeObjectURL(lastBlobUrl);
    } catch (e) {
      log('revokeObjectURL', errMessage(e));
    }
  }
  const blobUrl = URL.createObjectURL(blob);
  lastBlobUrl = blobUrl;

  const response = await notifyBackground({
    type: 'TVR_DONE',
    blobUrl,
    mimeType: type,
    bytes: blob.size,
    durationMs,
    reason: active.reason,
    width: active.size.outWidth,
    height: active.size.outHeight,
    tabTitle: active.tabTitle
  });

  if (!response || response.ok === false) {
    anchorDownload(blobUrl, response && response.filename ? response.filename : active.tabTitle + '.webm');
  }

  return {
    ok: true,
    mode: 'memory',
    bytes: blob.size,
    durationMs,
    width: active.size.outWidth,
    height: active.size.outHeight,
    mimeType: type,
    reason: active.reason
  };
}

async function startRecording(msg) {
  if (session) throw new Error('O gravador já está ativo.');
  if (!msg.streamId) throw new Error('streamId ausente.');

  if (lastBlobUrl) {
    try {
      URL.revokeObjectURL(lastBlobUrl);
    } catch (e) {
      log('revokeObjectURL', errMessage(e));
    }
    lastBlobUrl = null;
  }

  const settings = normalizeSettings(msg.settings);
  const viewport = msg.viewport || { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 };

  let stream = null;
  let canvasStream = null;
  let audioCtx = null;
  let diskTarget = null;
  let active = null;

  try {
    stream = await openStream(msg.streamId, settings);

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('A captura não trouxe vídeo.');

    const trackSettings = videoTrack.getSettings ? videoTrack.getSettings() : {};
    const content = pickContent(msg.video, viewport, settings.mode);
    const size = computeOutput(content, trackSettings, settings);

    const canvas = document.createElement('canvas');
    canvas.width = size.outWidth;
    canvas.height = size.outHeight;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D indisponível.');
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size.outWidth, size.outHeight);

    canvasStream = canvas.captureStream(settings.fps);
    const canvasTrack = canvasStream.getVideoTracks()[0];
    if (!canvasTrack) throw new Error('Não foi possível capturar o canvas.');

    const tabAudio = stream.getAudioTracks()[0] || null;
    if (tabAudio && settings.monitorAudio) {
      try {
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(new MediaStream([tabAudio]));
        const gain = audioCtx.createGain();
        gain.gain.value = 1;
        source.connect(gain);
        gain.connect(audioCtx.destination);
        await audioCtx.resume().catch(() => {});
      } catch (e) {
        log('Monitor de áudio falhou', errMessage(e));
        if (audioCtx) audioCtx.close().catch(() => {});
        audioCtx = null;
      }
    }

    const recordStream = new MediaStream();
    recordStream.addTrack(canvasTrack);
    if (tabAudio) recordStream.addTrack(tabAudio);

    diskTarget = msg.directWrite === false ? null : await openDiskTarget();
    if (msg.directWrite !== false && !diskTarget) {
      log('Escrita direta indisponível; gravando na memória.');
    }

    const mimeType = pickMime(!!tabAudio);
    const videoBitsPerSecond = clamp(
      Math.round(size.outWidth * size.outHeight * settings.fps * 0.11),
      1500000,
      16000000
    );
    const options = {
      videoBitsPerSecond,
      audioBitsPerSecond: 128000
    };
    if (mimeType) options.mimeType = mimeType;

    const recorder = new MediaRecorder(recordStream, options);

    active = {
      stream,
      videoTrack,
      canvas,
      ctx,
      canvasStream,
      canvasTrack,
      tabAudio,
      audioCtx,
      recorder,
      size,
      settings,
      startedAt: Date.now(),
      chunks: [],
      bytes: 0,
      writable: diskTarget ? diskTarget.writable : null,
      fileName: diskTarget ? diskTarget.name : '',
      writeChain: Promise.resolve(),
      writeError: null,
      pendingBytes: 0,
      mimeType: recorder.mimeType || mimeType || 'video/webm',
      stopping: false,
      reason: null,
      reader: null,
      timer: null,
      frameCallback: null,
      videoEl: null,
      tabTitle: msg.tabTitle || ''
    };
    session = active;

    setupDrawLoop(active);

    videoTrack.addEventListener('ended', () => {
      if (session === active && !active.stopping) {
        stopRecording('track-ended');
      }
    });

    recorder.addEventListener('dataavailable', event => {
      if (!event.data || !event.data.size) return;
      active.bytes += event.data.size;
      if (active.writable) {
        queueWrite(active, event.data);
        return;
      }
      active.chunks.push(event.data);
      if (active.bytes >= MAX_BYTES && !active.stopping) {
        log('Limite de memória atingido; encerrando.');
        stopRecording('memory-guard');
      }
    });

    recorder.addEventListener('error', event => {
      log('Erro do MediaRecorder', event.error || event);
      if (!active.stopping) stopRecording('error');
    });

    recorder.start(1000);

    return {
      ok: true,
      startedAt: active.startedAt,
      mode: active.writable ? 'disk' : 'memory',
      width: size.outWidth,
      height: size.outHeight,
      mimeType: active.mimeType,
      captureWidth: size.captureWidth,
      captureHeight: size.captureHeight
    };
  } catch (e) {
    if (active) {
      try {
        if (active.recorder && active.recorder.state !== 'inactive') active.recorder.stop();
      } catch (err) {
        log('recorder.stop no rollback', errMessage(err));
      }
      cleanupSession(active);
    } else {
      stopTracks(canvasStream);
      stopTracks(stream);
      if (audioCtx) audioCtx.close().catch(() => {});
    }
    if (diskTarget) {
      try {
        await diskTarget.writable.abort();
      } catch (err) {
        log('writable.abort no rollback', errMessage(err));
      }
    }
    throw e;
  }
}

function getStatus() {
  if (!session) {
    return { state: 'idle', hasLastBlob: !!lastBlobUrl };
  }
  return {
    state: session.stopping ? 'stopping' : 'recording',
    startedAt: session.startedAt,
    elapsedMs: Date.now() - session.startedAt,
    bytes: session.bytes,
    mode: session.writable ? 'disk' : 'memory',
    width: session.size.outWidth,
    height: session.size.outHeight,
    mimeType: session.mimeType,
    reason: session.reason
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.type === 'TVR_OFFSCREEN_START') {
    startRecording(msg)
      .then(sendResponse)
      .catch(err => {
        log('Falha ao iniciar', errMessage(err));
        sendResponse({ ok: false, error: errMessage(err) });
      });
    return true;
  }

  if (msg.type === 'TVR_OFFSCREEN_STOP') {
    stopRecording(msg.reason)
      .then(sendResponse)
      .catch(err => {
        log('Falha ao parar', errMessage(err));
        sendResponse({ ok: false, error: errMessage(err) });
      });
    return true;
  }

  if (msg.type === 'TVR_OFFSCREEN_STATUS') {
    sendResponse(getStatus());
    return false;
  }

  return false;
});

log('Offscreen pronto');
