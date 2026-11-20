'use strict';

const $ = selector => document.querySelector(selector);

const SETTINGS_KEY = 'recorderSettings';
const DEFAULT_SETTINGS = { mode: 'crop', maxHeight: 1080, monitorAudio: true, fps: 30 };
const ACTIVE_STATES = ['starting', 'recording', 'stopping'];

const elements = {
  tabTitle: $('#tabTitle'),
  tabUrl: $('#tabUrl'),
  status: $('#status'),
  detectBadge: $('#detectBadge'),
  detectInfo: $('#detectInfo'),
  detectHint: $('#detectHint'),
  recCard: $('#recCard'),
  recTime: $('#recTime'),
  recSize: $('#recSize'),
  recMeta: $('#recMeta'),
  optWholeTab: $('#optWholeTab'),
  optMaxHeight: $('#optMaxHeight'),
  optMonitor: $('#optMonitor'),
  btnRecord: $('#btnRecord'),
  btnStop: $('#btnStop'),
  btnRefresh: $('#btnRefresh'),
  lastResult: $('#lastResult'),
  toast: $('#toast')
};

let tab = null;
let detection = null;
let settings = Object.assign({}, DEFAULT_SETTINGS);
let state = null;
let live = null;
let busy = false;
let pollTimer = null;
let prevStatus = null;

function log(...args) {
  console.log('[TabRecorder-Popup]', ...args);
}

function formatClock(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

function showStatus(message, type) {
  elements.status.textContent = message;
  elements.status.className = 'status status-' + (type || 'info');
  elements.status.classList.remove('hidden');
}

function hideStatus() {
  elements.status.classList.add('hidden');
}

function showToast(message, type) {
  elements.toast.textContent = message;
  elements.toast.className = 'toast ' + (type || '');
  elements.toast.classList.remove('hidden');
  setTimeout(() => elements.toast.classList.add('hidden'), 3200);
}

function friendlyError(err) {
  const message = err && err.message ? err.message : String(err);
  if (/invalid stream|stream id|expired/i.test(message)) {
    return 'A captura expirou antes de começar. Tente novamente.';
  }
  if (/already being captured|cannot capture/i.test(message)) {
    return 'Esta aba já está sendo capturada por outro programa.';
  }
  if (/not been invoked|activeTab|permission/i.test(message)) {
    return 'O navegador não autorizou a captura desta aba.';
  }
  return message;
}

function suggestFileName(title) {
  const name = String(title || 'video')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
  return (name || 'video') + '.webm';
}

// Precisa ser chamado ainda dentro do gesto do clique (sem awaits antes).
async function chooseTargetFile() {
  const store = window.TVRFileHandleStore;
  if (typeof window.showSaveFilePicker !== 'function' || !store) return 'memory';

  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: suggestFileName(tab && tab.title),
      startIn: 'downloads',
      types: [{ description: 'Vídeo WebM', accept: { 'video/webm': ['.webm'] } }]
    });
    await store.save(handle);
    return 'disk';
  } catch (e) {
    if (e && e.name === 'AbortError') return null;
    log('showSaveFilePicker', e);
    showStatus('Não foi possível escolher o arquivo: ' + friendlyError(e), 'error');
    return null;
  }
}

async function loadSettings() {
  try {
    const data = await chrome.storage.sync.get(SETTINGS_KEY);
    return Object.assign({}, DEFAULT_SETTINGS, data[SETTINGS_KEY] || {});
  } catch (e) {
    log('loadSettings', e);
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

function applySettingsToUI() {
  elements.optWholeTab.checked = settings.mode === 'tab';
  elements.optMaxHeight.value = String(settings.maxHeight);
  elements.optMonitor.checked = settings.monitorAudio !== false;
}

function saveSettingsFromUI() {
  settings = {
    mode: elements.optWholeTab.checked ? 'tab' : 'crop',
    maxHeight: Number(elements.optMaxHeight.value) || 0,
    monitorAudio: elements.optMonitor.checked,
    fps: settings.fps || 30
  };
  chrome.storage.sync.set({ [SETTINGS_KEY]: settings }).catch(err => log('saveSettings', err));
  updateButtons();
}

function pageIsRecordable() {
  return !!tab && /^(https?|file):/i.test(tab.url || '');
}

function renderTab() {
  elements.tabTitle.textContent = (tab && tab.title) || '—';
  elements.tabUrl.textContent = (tab && tab.url) || '';
}

function renderDetection() {
  const video = detection && detection.video;

  if (!detection || detection.ok === false || !video) {
    elements.detectBadge.textContent = 'nenhum';
    elements.detectBadge.className = 'badge badge-muted';
    elements.detectInfo.textContent = (detection && detection.error) || 'Nenhum vídeo encontrado nesta aba.';

    const hints = [];
    if (detection && detection.ok) {
      hints.push('Ative "Gravar a aba inteira" para capturar a aba mesmo sem um vídeo detectado.');
    }
    elements.detectHint.textContent = hints.join(' ');
    elements.detectHint.classList.toggle('hidden', hints.length === 0);
    updateButtons();
    return;
  }

  const resolution = video.videoWidth && video.videoHeight
    ? `${video.videoWidth}×${video.videoHeight}`
    : 'resolução desconhecida';
  const duration = video.duration !== null && video.duration > 0
    ? formatClock(video.duration)
    : 'ao vivo/indefinido';

  elements.detectInfo.textContent = `${resolution} · ${duration}`;
  elements.detectBadge.textContent = video.paused ? 'pausado' : 'pronto';
  elements.detectBadge.className = 'badge ' + (video.paused ? 'badge-warn' : 'badge-ok');

  const hints = [];
  if (video.drm) hints.push('Conteúdo protegido (DRM): a gravação pode sair preta.');
  if (video.loop) hints.push('O vídeo está em loop; a gravação não para sozinha.');
  if (video.duration === null) hints.push('Transmissão ao vivo: pare manualmente.');
  if (!video.paused && video.duration !== null && video.duration > 0) {
    hints.push(`A gravação para sozinha no fim do vídeo (${formatClock(video.duration)}).`);
  }

  elements.detectHint.textContent = hints.join(' ');
  elements.detectHint.classList.toggle('hidden', hints.length === 0);
  updateButtons();
}

function updateButtons() {
  const status = state ? state.status : 'idle';
  const recording = ACTIVE_STATES.includes(status);
  const hasVideo = !!(detection && detection.video);
  const canRecord = pageIsRecordable() && (settings.mode === 'tab' || hasVideo);

  elements.btnRecord.classList.toggle('hidden', recording);
  elements.btnStop.classList.toggle('hidden', !recording);
  elements.btnRecord.disabled = busy || !canRecord;
  elements.btnStop.disabled = busy || status === 'stopping';

  [elements.optWholeTab, elements.optMaxHeight, elements.optMonitor].forEach(control => {
    control.disabled = recording;
  });
}

function renderStatus() {
  const status = state ? state.status : 'idle';
  const recording = ACTIVE_STATES.includes(status);

  if (state && state.error) {
    showStatus(state.error, 'error');
  }

  elements.recCard.classList.toggle('hidden', !recording);

  if (recording) {
    const elapsedMs = live && typeof live.elapsedMs === 'number'
      ? live.elapsedMs
      : (state.startedAt ? Date.now() - state.startedAt : 0);
    elements.recTime.textContent = formatClock(elapsedMs / 1000);
    elements.recSize.textContent = formatBytes(live && live.bytes ? live.bytes : 0);

    const width = (live && live.width) || (state.video && state.video.outputWidth) || null;
    const height = (live && live.height) || (state.video && state.video.outputHeight) || null;
    const parts = [];
    parts.push(status === 'starting' ? 'Iniciando captura…' : status === 'stopping' ? 'Finalizando…' : 'Gravando');
    if (width && height) parts.push(`${width}×${height}`);
    parts.push(live && live.mode === 'memory' ? 'na memória' : 'direto no disco');
    if (state.tabTitle) parts.push(state.tabTitle);
    elements.recMeta.textContent = parts.join(' · ');
  }

  if (state && state.lastResult) {
    elements.lastResult.textContent = state.lastResult.ok
      ? `Salvo: ${state.lastResult.filename.split('/').pop()}`
      : 'Falha ao salvar';
    elements.lastResult.className = 'last-result ' + (state.lastResult.ok ? 'ok' : 'err');
    elements.lastResult.classList.remove('hidden');
  }

  if (prevStatus && prevStatus !== 'idle' && status === 'idle' && state && state.lastResult) {
    if (state.lastResult.ok) {
      const name = String(state.lastResult.filename || '').split('/').pop();
      showToast(name ? `Vídeo salvo: ${name}` : 'Vídeo salvo', 'success');
    } else {
      showToast(state.lastResult.error || 'Não foi possível salvar o vídeo', 'error');
    }
  }
  prevStatus = status;

  updateButtons();
}

async function refreshStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ target: 'background', type: 'TVR_STATUS' });
    if (response && response.ok) {
      state = response;
      live = response.live || null;
    }
  } catch (e) {
    log('refreshStatus', e);
  }
  renderStatus();
}

async function scan() {
  if (!tab || !tab.id) {
    detection = { ok: false, error: 'Nenhuma aba ativa.' };
    renderDetection();
    return;
  }

  if (!pageIsRecordable()) {
    detection = { ok: false, error: 'Esta página não pode ser gravada pelo navegador.' };
    renderDetection();
    return;
  }

  elements.detectBadge.textContent = '…';
  elements.detectBadge.className = 'badge';
  elements.detectInfo.textContent = 'Procurando vídeo…';

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['js/detector.js']
    });
    const response = await chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'TVR_WATCH' });
    detection = response && response.ok
      ? response
      : { ok: false, error: (response && response.error) || 'Falha ao detectar o vídeo.' };
  } catch (e) {
    log('scan', e);
    detection = { ok: false, error: friendlyError(e) };
  }

  renderDetection();
}

async function startRecording() {
  if (busy || !tab || !tab.id) return;
  if (settings.mode === 'crop' && !(detection && detection.video)) return;

  busy = true;
  hideStatus();
  updateButtons();

  try {
    if (!chrome.tabCapture || !chrome.tabCapture.getMediaStreamId) {
      throw new Error('A API de captura de aba não está disponível neste navegador.');
    }

    // Primeiro o destino: o seletor de arquivo exige o gesto do clique.
    const target = await chooseTargetFile();
    if (target === null) return;

    await chrome.runtime.sendMessage({ target: 'background', type: 'TVR_PREPARE' });
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

    const response = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'TVR_START',
      streamId,
      tabId: tab.id,
      tabTitle: tab.title || (detection && detection.title) || 'video',
      video: detection && detection.video ? detection.video : null,
      viewport: detection && detection.viewport ? detection.viewport : null,
      settings,
      directWrite: target === 'disk'
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'Não foi possível iniciar a gravação.');
    }

    if (response.mode === 'disk') {
      showToast('Gravando direto no arquivo escolhido', 'success');
    } else {
      showToast('Gravando na memória (limite de 1,5 GB)', 'error');
    }
  } catch (e) {
    log('startRecording', e);
    showStatus(friendlyError(e), 'error');
  } finally {
    busy = false;
    await refreshStatus();
  }
}

async function stopRecording() {
  if (busy) return;

  busy = true;
  showStatus('Finalizando e salvando…', 'info');
  updateButtons();

  try {
    const response = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'TVR_STOP',
      reason: 'user-stop'
    });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'Falha ao finalizar a gravação.');
    }
    hideStatus();
  } catch (e) {
    log('stopRecording', e);
    showStatus(friendlyError(e), 'error');
  } finally {
    busy = false;
    await refreshStatus();
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    refreshStatus();
  }, 1000);
}

async function init() {
  elements.btnRecord.addEventListener('click', startRecording);
  elements.btnStop.addEventListener('click', stopRecording);
  elements.btnRefresh.addEventListener('click', scan);
  elements.optWholeTab.addEventListener('change', saveSettingsFromUI);
  elements.optMaxHeight.addEventListener('change', saveSettingsFromUI);
  elements.optMonitor.addEventListener('change', saveSettingsFromUI);

  settings = await loadSettings();
  applySettingsToUI();

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0] ? tabs[0] : null;
  } catch (e) {
    log('tabs.query', e);
    tab = null;
  }

  renderTab();
  updateButtons();
  await refreshStatus();
  await scan();
  startPolling();
}

window.addEventListener('unload', () => {
  if (pollTimer) clearInterval(pollTimer);
});

document.addEventListener('DOMContentLoaded', init);
