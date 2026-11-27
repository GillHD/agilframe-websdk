/**
 * Public broadcast viewer. Opens an HLS playlist or a WHEP endpoint without
 * joining the meeting. HLS uses the browser backend or hls.js.
 *
 * URL: /live.html?hls=https%3A%2F%2Fcdn.example.com%2Flive%2Findex.m3u8&title=...
 */
import Hls from 'hls.js';
import { startWhep } from './whep.js';

const params = new URLSearchParams(window.location.search);
const hlsUrl = params.get('hls')?.trim() ?? '';
const whepUrl = params.get('whep')?.trim() ?? '';
const title = params.get('title')?.trim() || 'Трансляция AgilFrame';
const theme = params.get('theme');
const WHEP_RETRY_DELAY_MS = 4000;
const WHEP_RETRY_LIMIT = 3;

const video = document.querySelector<HTMLVideoElement>('#live-video');
const overlay = document.querySelector<HTMLElement>('#live-overlay');
const status = document.querySelector<HTMLElement>('#live-status');
const titleEl = document.querySelector<HTMLElement>('#live-title');
const retry = document.querySelector<HTMLButtonElement>('#live-retry');
const start = document.querySelector<HTMLButtonElement>('#live-start');
const sound = document.querySelector<HTMLButtonElement>('#live-sound');
const badge = document.querySelector<HTMLElement>('#live-badge');

if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
if (titleEl) titleEl.textContent = title;
document.title = `${title} — AgilFrame`;
if (video) video.muted = true;

let hls: Hls | null = null;
let closeWhep: (() => void) | undefined;
let retryTimer: number | null = null;
let loadVersion = 0;
let whepPlayed = false;
let whepRetries = 0;

function clearRetry(): void {
  if (retryTimer === null) return;
  window.clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleWhepRetry(): void {
  if (!whepPlayed || whepRetries >= WHEP_RETRY_LIMIT) return;
  retryTimer = window.setTimeout(() => {
    whepRetries += 1;
    load();
  }, WHEP_RETRY_DELAY_MS);
}

function setStatus(text: string, kind: 'info' | 'error' | 'play' = 'info', retryable = kind === 'error'): void {
  const focused = document.activeElement;
  if (status) status.textContent = text;
  if (overlay) overlay.hidden = false;
  // Only offer a retry when reconnecting can help.
  if (retry) retry.hidden = kind !== 'error' || !retryable;
  if (start) start.hidden = kind !== 'play';
  // Native video fullscreen hides the sibling status overlay and its controls.
  if (video && document.fullscreenElement === video) {
    void document.exitFullscreen().then(() => {
      // Chromium can restore focus to the fullscreen video on exit.
      const active = document.activeElement;
      if (overlay && !overlay.hidden && (active === video || active === document.body)) {
        status?.focus({ preventScroll: true });
      }
    }).catch(() => { /* fullscreen might already be closing */ });
  }
  if (video) video.inert = true;
  if (focused === video || (focused === retry && retry?.hidden) || (focused === start && start?.hidden)) {
    status?.focus({ preventScroll: true });
  }
  if (badge) badge.dataset.state = kind;
}

function fail(text: string, retryable = true): void {
  ++loadVersion;
  clearRetry();
  setStatus(text, 'error', retryable);
  hls?.destroy();
  hls = null;
  closeWhep?.();
  closeWhep = undefined;
  if (whepUrl && video) video.srcObject = null;
}

function play(version: number): void {
  void video?.play().catch((error: unknown) => {
    if (version !== loadVersion) return;
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      setStatus('Нажмите кнопку воспроизведения, чтобы смотреть трансляцию.', 'play');
    } else if (!(error instanceof DOMException && error.name === 'AbortError')) {
      fail('Не удалось воспроизвести трансляцию.');
    }
  });
}

function load(): void {
  if (!video) return;
  const version = ++loadVersion;
  clearRetry();
  closeWhep?.();
  closeWhep = undefined;
  if (whepUrl) {
    if (badge) badge.title = 'WebRTC · низкая задержка';
    setStatus('Подключаемся к трансляции…');
    video.srcObject = null;
    try {
      closeWhep = startWhep(whepUrl, (stream) => {
        if (version !== loadVersion) return;
        video.srcObject = stream;
        play(version);
      }, (failure) => {
        if (version !== loadVersion) return;
        switch (failure) {
          case 'access':
            fail('Для доступа к трансляции попросите организатора прислать новую ссылку.', false);
            break;
          case 'disconnected':
            fail('Связь с трансляцией прервалась.');
            scheduleWhepRetry();
            break;
          case 'unavailable':
            fail('Трансляция сейчас недоступна.');
            scheduleWhepRetry();
            break;
        }
      });
    } catch {
      fail('Не удалось открыть трансляцию. Попросите организатора прислать новую ссылку.', false);
    }
    return;
  }
  if (!hlsUrl) {
    fail('Откройте полную ссылку на трансляцию.', false);
    return;
  }
  if (badge) badge.title = 'HLS';
  hls?.destroy();
  hls = null;
  setStatus('Подключаемся к трансляции…');
  video.autoplay = true;

  const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');
  const jsHls = Hls.isSupported();
  if (nativeHls === 'probably' || (nativeHls && !jsHls)) {
    video.src = hlsUrl;
    play(version);
    return;
  }
  if (!jsHls) {
    fail('Этот браузер не поддерживает HLS. Откройте ссылку в Safari или Chrome.', false);
    return;
  }
  const player = new Hls({ lowLatencyMode: true, backBufferLength: 30 });
  hls = player;
  let recoveredMediaError = false;
  player.on(Hls.Events.MANIFEST_PARSED, () => play(version));
  player.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal || version !== loadVersion) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (data.response?.code === 401 || data.response?.code === 403) {
        fail('Для доступа к трансляции попросите организатора прислать новую ссылку.', false);
        return;
      }
      setStatus('Подключаемся снова…', 'error');
      clearRetry();
      retryTimer = window.setTimeout(load, 4000);
    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMediaError) {
      recoveredMediaError = true;
      setStatus('Восстанавливаем воспроизведение…');
      player.recoverMediaError();
    } else {
      fail('Не удалось воспроизвести трансляцию.');
    }
  });
  player.loadSource(hlsUrl);
  player.attachMedia(video);
}

function onPlaying(): void {
  if (whepUrl) {
    if (!video?.srcObject) return;
    whepPlayed = true;
    whepRetries = 0;
  }
  clearRetry();
  const focusInOverlay = overlay?.contains(document.activeElement);
  if (overlay) overlay.hidden = true;
  if (video) {
    video.inert = false;
    if (focusInOverlay) video.focus({ preventScroll: true });
  }
  if (badge) badge.dataset.state = 'live';
}

video?.addEventListener('playing', onPlaying);
video?.addEventListener('waiting', () => {
  if (video.currentTime === 0 && badge?.dataset.state === 'info') setStatus('Буферизация…');
});
video?.addEventListener('error', () => fail('Не удалось воспроизвести трансляцию.'));

retry?.addEventListener('click', () => {
  whepRetries = 0;
  load();
  status?.focus({ preventScroll: true });
});
start?.addEventListener('click', () => play(loadVersion));
function syncSoundButton(): void {
  if (!video || !sound) return;
  const audible = !video.muted && video.volume > 0;
  sound.setAttribute('aria-pressed', String(audible));
  sound.textContent = audible ? 'Выключить звук' : 'Включить звук';
}
video?.addEventListener('volumechange', syncSoundButton);
sound?.addEventListener('click', () => {
  if (!video) return;
  const audible = !video.muted && video.volume > 0;
  video.muted = audible;
  if (!audible && video.volume === 0) video.volume = 1;
  syncSoundButton();
});

load();
window.addEventListener('pagehide', () => {
  if (!whepUrl) return;
  ++loadVersion;
  clearRetry();
  closeWhep?.();
  closeWhep = undefined;
});
window.addEventListener('pageshow', (event) => { if (event.persisted && whepUrl) load(); });
