'use strict';

const LOG_PREFIX = '[TabRecorder-BG]';
const STATE_KEY = 'recorderState';
const OFFSCREEN_PATH = 'offscreen.html';
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);
const DEFAULT_SETTINGS = { mode: 'crop', maxHeight: 1080, fps: 30, monitorAudio: true };
const ACTIVE_STATES = new Set(['starting', 'recording', 'stopping']);

let cachedState = null;
let creatingOffscreen = null;

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function emptyState() {
  return {
    status: 'idle',
    tabId: null,
    tabTitle: '',
    startedAt: 0,
    settings: null,
    video: null,
    downloadId: null,
    lastResult: null,
    error: null
  };
}

async function getState() {
  if (cachedState) return cachedState;
  const data = await chrome.storage.session.get(STATE_KEY);
  cachedState = Object.assign(emptyState(), data[STATE_KEY] || {});
  return cachedState;
}

async function setState(patch) {
  const current = await getState();
  cachedState = Object.assign({}, current, patch);
  await chrome.storage.session.set({ [STATE_KEY]: cachedState });
  return cachedState;
}

function updateBadge(recording) {
  try {
    chrome.action.setBadgeText({ text: recording ? 'REC' : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#D93025' });
    chrome.action.setTitle({
      title: recording ? 'Tab Video Recorder — gravando' : 'Tab Video Recorder'
    });
  } catch (e) {
    log('badge', errorMessage(e));
  }
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms))
  ]);
}

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [OFFSCREEN_URL]
      });
      return contexts.length > 0;
    } catch (e) {
      log('getContexts falhou', errorMessage(e));
    }
  }
  try {
    const matched = await self.clients.matchAll();
    return matched.some(client => client.url === OFFSCREEN_URL);
  } catch (e) {
    return false;
  }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['USER_MEDIA'],
        justification: 'Gravar o vídeo e o áudio da aba fora da página'
      });
    } catch (e) {
      const message = errorMessage(e);
      if (!/single offscreen|already exists/i.test(message)) throw e;
    } finally {
      creatingOffscreen = null;
    }
  })();
  return creatingOffscreen;
}

async function closeOffscreen() {
  try {
    if (!(await hasOffscreen())) return;
    await chrome.offscreen.closeDocument();
  } catch (e) {
    log('closeOffscreen', errorMessage(e));
  }
}

async function askOffscreen(payload, timeoutMs = 4000) {
  try {
    const message = Object.assign({ target: 'offscreen' }, payload);
    return await withTimeout(chrome.runtime.sendMessage(message), timeoutMs, null);
  } catch (e) {
    log('askOffscreen', errorMessage(e));
    return null;
  }
}

function sanitizeFilename(name) {
  let value = String(name || 'video')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  if (!value) value = 'video';
  if (value.length > 120) value = value.slice(0, 120).trim();
  return value;
}

function formatStamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + '_' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('-');
}

async function startRecording(msg) {
  const state = await getState();
  if (ACTIVE_STATES.has(state.status)) {
    return { ok: false, error: 'Já existe uma gravação em andamento.' };
  }
  if (!msg.streamId || !msg.tabId) {
    return { ok: false, error: 'streamId ou aba ausente.' };
  }

  await ensureOffscreen();
  const live = await askOffscreen({ type: 'TVR_OFFSCREEN_STATUS' }, 2000);
  if (live && live.state && live.state !== 'idle') {
    return { ok: false, error: 'O gravador já está ocupado.' };
  }

  const settings = Object.assign({}, DEFAULT_SETTINGS, msg.settings || {});
  const tabTitle = msg.tabTitle || 'video';

  await setState({
    status: 'starting',
    tabId: msg.tabId,
    tabTitle,
    startedAt: Date.now(),
    settings,
    video: msg.video || null,
    downloadId: null,
    lastResult: null,
    error: null
  });

  let res = await askOffscreen({
    type: 'TVR_OFFSCREEN_START',
    streamId: msg.streamId,
    video: msg.video || null,
    viewport: msg.viewport || null,
    settings,
    directWrite: msg.directWrite !== false,
    tabTitle
  }, 12000);

  if (!res || !res.ok) {
    const check = await askOffscreen({ type: 'TVR_OFFSCREEN_STATUS' }, 2000);
    if (check && check.state === 'recording') {
      res = {
        ok: true,
        startedAt: check.startedAt,
        mode: check.mode,
        width: check.width,
        height: check.height,
        mimeType: check.mimeType
      };
    }
  }

  if (!res || !res.ok) {
    const message = (res && res.error) || 'Não foi possível iniciar a captura (o stream expirou?).';
    await setState({ status: 'idle', error: message });
    updateBadge(false);
    return { ok: false, error: message };
  }

  await setState({
    status: 'recording',
    startedAt: res.startedAt || Date.now(),
    video: Object.assign({}, msg.video || {}, {
      outputWidth: res.width,
      outputHeight: res.height,
      mimeType: res.mimeType,
      storage: res.mode || 'memory'
    })
  });
  updateBadge(true);
  return {
    ok: true,
    width: res.width,
    height: res.height,
    mimeType: res.mimeType,
    mode: res.mode || 'memory'
  };
}

async function stopRecording(reason) {
  const state = await getState();

  if (!ACTIVE_STATES.has(state.status)) {
    const live = await askOffscreen({ type: 'TVR_OFFSCREEN_STATUS' }, 1200);
    if (!live || !live.state || live.state === 'idle') {
      return { ok: false, error: 'Nenhuma gravação ativa.' };
    }
  }

  await setState({ status: 'stopping' });
  const res = await askOffscreen({ type: 'TVR_OFFSCREEN_STOP', reason: reason || 'user-stop' }, 15000);

  if (!res || !res.ok) {
    const message = (res && res.error) || 'Falha ao finalizar a gravação.';
    await setState({ status: 'idle', error: message });
    updateBadge(false);
    return { ok: false, error: message };
  }

  if (res.alreadyStopped) {
    await setState({ status: 'idle' });
    updateBadge(false);
  }
  return res;
}

async function finishRecording(msg) {
  const state = await getState();
  const mimeType = msg.mimeType || 'video/webm';
  const ext = /mp4/i.test(mimeType) ? 'mp4' : 'webm';
  const base = sanitizeFilename(msg.tabTitle || state.tabTitle || 'video');
  const directWrite = !!msg.directWrite;
  const filename = directWrite
    ? sanitizeFilename(msg.filename || `${base}.${ext}`)
    : `TabRecorder/${base}__${formatStamp(new Date())}.${ext}`;

  let downloadId = null;
  let downloadError = null;

  if (directWrite) {
    if (msg.error) downloadError = msg.error;
    else if (!msg.bytes) downloadError = 'Nenhum dado gravado.';
  } else if (msg.blobUrl) {
    try {
      downloadId = await chrome.downloads.download({
        url: msg.blobUrl,
        filename,
        saveAs: false,
        conflictAction: 'uniquify'
      });
    } catch (e) {
      downloadError = errorMessage(e);
    }
  } else {
    downloadError = msg.error || 'Nenhum dado gravado.';
  }

  const lastResult = {
    ok: !downloadError,
    filename,
    mode: directWrite ? 'disk' : 'memory',
    downloadId,
    error: downloadError,
    bytes: msg.bytes || 0,
    durationMs: msg.durationMs || 0,
    width: msg.width || null,
    height: msg.height || null,
    reason: msg.reason || null,
    at: Date.now()
  };

  await setState({ status: 'idle', downloadId, lastResult, error: downloadError });
  updateBadge(false);
  log('Gravação finalizada', lastResult);

  if (directWrite) {
    // Sem download para acompanhar; libera o offscreen logo depois de responder.
    setTimeout(async () => {
      const current = await getState();
      if (current.status !== 'idle') return;
      await closeOffscreen().catch(err => log('closeOffscreen', errorMessage(err)));
    }, 1500);
  }

  return {
    ok: !downloadError,
    error: downloadError || undefined,
    filename,
    downloadId,
    mode: lastResult.mode
  };
}

async function buildStatus() {
  const state = await getState();
  let live = null;

  if (ACTIVE_STATES.has(state.status)) {
    live = await askOffscreen({ type: 'TVR_OFFSCREEN_STATUS' }, 1500);
    if (!live) {
      const message = 'A captura foi encerrada inesperadamente.';
      await setState({ status: 'idle', error: message });
      updateBadge(false);
      return {
        ok: true,
        status: 'idle',
        tabId: state.tabId,
        tabTitle: state.tabTitle,
        startedAt: state.startedAt,
        settings: state.settings,
        video: state.video,
        live: null,
        lastResult: state.lastResult,
        error: message
      };
    }
  }

  return {
    ok: true,
    status: state.status,
    tabId: state.tabId,
    tabTitle: state.tabTitle,
    startedAt: state.startedAt,
    settings: state.settings,
    video: state.video,
    live,
    lastResult: state.lastResult,
    error: state.error
  };
}

async function handleVideoEvent(msg, sender) {
  const state = await getState();
  if (!ACTIVE_STATES.has(state.status)) return { ok: false };
  if (msg.event !== 'ended') return { ok: false };

  const senderTabId = sender && sender.tab ? sender.tab.id : null;
  if (senderTabId !== null && state.tabId !== null && senderTabId !== state.tabId) {
    return { ok: false, error: 'Evento de outra aba.' };
  }

  log('Vídeo terminou; encerrando gravação.');
  await stopRecording('video-ended');
  return { ok: true };
}

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'TVR_PREPARE':
      await ensureOffscreen();
      return { ok: true };
    case 'TVR_START':
      return startRecording(msg);
    case 'TVR_STOP':
      return stopRecording(msg.reason || 'user-stop');
    case 'TVR_STATUS':
      return buildStatus();
    case 'TVR_VIDEO_EVENT':
      return handleVideoEvent(msg, sender);
    case 'TVR_DONE':
      return finishRecording(msg);
    default:
      return { ok: false, error: 'Mensagem desconhecida: ' + msg.type };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return false;
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch(err => {
      log('Erro ao tratar mensagem', msg.type, errorMessage(err));
      sendResponse({ ok: false, error: errorMessage(err) });
    });
  return true;
});

chrome.downloads.onChanged.addListener(async delta => {
  if (!delta.state) return;
  if (delta.state.current !== 'complete' && delta.state.current !== 'interrupted') return;
  const state = await getState();
  if (!state.downloadId || delta.id !== state.downloadId) return;
  log('Download finalizado:', delta.state.current);
  await closeOffscreen();
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const state = await getState();
  if (state.tabId === tabId && ACTIVE_STATES.has(state.status)) {
    await stopRecording('tab-closed');
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  const state = await getState();
  if (state.tabId !== tabId || !ACTIVE_STATES.has(state.status)) return;
  await stopRecording('navigated');
  await setState({ error: 'A aba navegou para outra página; gravação encerrada.' });
});

async function resetStaleState() {
  await getState();
  await setState({ status: 'idle', tabId: null, downloadId: null });
  updateBadge(false);
  await closeOffscreen();
}

chrome.runtime.onStartup.addListener(() => {
  resetStaleState().catch(err => log('onStartup', errorMessage(err)));
});

chrome.runtime.onInstalled.addListener(() => {
  resetStaleState().catch(err => log('onInstalled', errorMessage(err)));
});

getState()
  .then(state => {
    if (ACTIVE_STATES.has(state.status)) updateBadge(true);
  })
  .catch(err => log('init', errorMessage(err)));
