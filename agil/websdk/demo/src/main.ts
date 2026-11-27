/**
 * Public landing + demo host.
 *
 * The landing is static HTML/CSS; this module only adds behaviour:
 *  - light/dark switch for the page and the widget theme presets;
 *  - room creation against `POST /v1/rooms` and widget mounting (inline/iframe);
 *  - server health pill with the current version;
 *  - the embed snippet, kept in sync with the form.
 *
 * The WebRTC widget and SDK are loaded lazily, so the landing itself ships a
 * small script and the heavy call bundle only arrives when someone joins.
 */
import { themePresets, themePresetNames, toCssVars, type ThemePresetName } from '@agil/protocol';
import type { AgilWidgetInstance } from '@agil/calls-widget';
import './demo.css';

type Scheme = 'light' | 'dark' | 'auto';
type WidgetModule = typeof import('@agil/calls-widget');
type SdkModule = typeof import('@agil/calls-sdk');

interface HealthResponse {
  ok: boolean;
  name: string;
  version: string;
  uptimeSec: number;
  rooms: number;
  tenants: number;
}

interface CreateRoomResponse {
  room: { id: string; name: string; tenantId: string };
  joinUrl: string;
  embedUrl: string;
  token?: string;
}

interface HostInfoResponse {
  tenantId: string;
  resolved: 'domain' | 'default';
  customDomain: string;
  verified: boolean;
  branding: {
    productName: string;
    logoUrl: string;
    faviconUrl: string;
  };
}

const APP_VERSION = '0.1.0';
const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`demo: element ${selector} not found`);
  return element;
};

const serverUrlInput = $<HTMLInputElement>('#server-url');
const tenantInput = $<HTMLInputElement>('#tenant-id');
const roomInput = $<HTMLInputElement>('#room-id');
const nameInput = $<HTMLInputElement>('#participant-name');
const passwordInput = $<HTMLInputElement>('#room-password');
const schemeSelect = $<HTMLSelectElement>('#scheme-select');
const presetSelect = $<HTMLSelectElement>('#preset-select');
const healthPill = $<HTMLSpanElement>('#health-pill');
const formStatus = $<HTMLParagraphElement>('#form-status');
const formStatusWrap = $<HTMLDivElement>('#form-status-wrap');
const formRetry = $<HTMLButtonElement>('#form-retry');
const heroFeedback = $<HTMLDivElement>('#hero-feedback');
const heroFeedbackText = $<HTMLSpanElement>('#hero-feedback .hero-feedback-text');
const heroRetry = $<HTMLButtonElement>('#hero-retry');
const actionToast = $<HTMLDivElement>('#action-toast');
const actionToastText = $<HTMLSpanElement>('#action-toast .action-toast-text');
const toastRetry = $<HTMLButtonElement>('#toast-retry');
const snippetEl = $<HTMLElement>('#snippet');
const callForm = $<HTMLFormElement>('#call-form');
const callSection = $<HTMLElement>('#call-section');
const callContainer = $<HTMLDivElement>('#call-container');
const joinLink = $<HTMLAnchorElement>('#join-link');
const embedLink = $<HTMLAnchorElement>('#embed-link');
const themeToggle = $<HTMLButtonElement>('#theme-toggle');
const createButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-busy-label]'));
const createTriggers = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-create-room]'));
const createButton = $<HTMLButtonElement>('#create-room');
const joinButton = $<HTMLButtonElement>('#join-inline');
const iframeButton = $<HTMLButtonElement>('#join-iframe');
const unmountButton = $<HTMLButtonElement>('#unmount-widget');

type CreateSource = 'hero' | 'header' | 'final' | 'how' | 'mobile' | 'form';

let instance: AgilWidgetInstance | null = null;
let iframe: HTMLIFrameElement | null = null;
let currentScheme: Scheme = 'auto';
let currentPreset: ThemePresetName = 'light';
let lastCreateRoom: CreateRoomResponse | null = null;
let widgetModule: Promise<WidgetModule> | null = null;
let sdkModule: Promise<SdkModule> | null = null;
let creating = false;
let toastTimer = 0;
let joinStatusTimer = 0;

function loadWidget(): Promise<WidgetModule> {
  widgetModule ??= import('@agil/calls-widget');
  return widgetModule;
}

function loadSdk(): Promise<SdkModule> {
  sdkModule ??= import('@agil/calls-sdk');
  return sdkModule;
}

function serverBase(): string {
  const value = serverUrlInput.value.trim();
  if (value) return value.replace(/\/+$/, '');
  return window.location.origin;
}

function isReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollToSection(element: HTMLElement, behavior: 'auto' | 'smooth' = 'smooth'): void {
  if (behavior === 'auto' || isReducedMotion()) {
    // `html { scroll-behavior: smooth }` also applies to `behavior:'auto'`, so
    // override it for the long hero -> demo jump. This keeps the response
    // instant instead of a ~1.5 s animation over 8 000 px.
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    element.scrollIntoView({ behavior: 'auto', block: 'start' });
    root.style.scrollBehavior = previous;
    return;
  }
  element.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Shows the inline form status and, for errors, a working retry action. */
function setStatus(message: string, kind: 'info' | 'error' | 'success' = 'info', retry?: () => void): void {
  formStatusWrap.hidden = false;
  formStatus.hidden = false;
  formStatus.textContent = message;
  formStatus.dataset.kind = kind;
  formStatus.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  formRetry.hidden = kind !== 'error' || !retry;
  formRetry.onclick = retry ? () => retry() : null;
}

/** Inline feedback next to the hero CTA, visible without scrolling to the form. */
function setHeroFeedback(message: string, kind: 'info' | 'error' | 'success' = 'info', retry?: () => void): void {
  heroFeedback.hidden = false;
  heroFeedback.dataset.kind = kind;
  heroFeedbackText.textContent = message;
  heroFeedback.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  heroRetry.hidden = kind !== 'error' || !retry;
  heroRetry.onclick = retry ? () => retry() : null;
}

/** Viewport toast for CTAs outside the hero (header, mobile menu, final). */
function showToast(message: string, kind: 'loading' | 'error' | 'success' = 'loading', retry?: () => void): void {
  window.clearTimeout(toastTimer);
  actionToast.hidden = false;
  actionToast.dataset.kind = kind;
  actionToast.classList.toggle('is-loading', kind === 'loading');
  actionToastText.textContent = message;
  actionToast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  toastRetry.hidden = kind !== 'error' || !retry;
  toastRetry.onclick = retry ? () => retry() : null;
  if (kind === 'success') {
    toastTimer = window.setTimeout(() => {
      actionToast.hidden = true;
    }, 2800);
  }
}

function hideToast(): void {
  window.clearTimeout(toastTimer);
  actionToast.hidden = true;
}

function setBusy(button: HTMLButtonElement | null, busy: boolean, busyLabel?: string): void {
  if (!button) return;
  const label = button.querySelector<HTMLElement>('.btn-label');
  if (busy) {
    if (label && button.dataset.idleLabel === undefined) button.dataset.idleLabel = label.textContent ?? '';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (label && busyLabel) label.textContent = busyLabel;
    return;
  }
  button.disabled = false;
  button.removeAttribute('aria-busy');
  if (label && button.dataset.idleLabel !== undefined) {
    label.textContent = button.dataset.idleLabel;
    delete button.dataset.idleLabel;
  }
}

function setCreateBusy(busy: boolean): void {
  for (const button of createButtons) {
    setBusy(button, busy, button.dataset.busyLabel);
  }
}

/**
 * Network/API errors are mapped to actionable Russian text: the form must never
 * surface raw `Failed to fetch`, `NetworkError` or an English server code.
 */
function humanizeCreateError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'Сервер не ответил за 6 секунд. Проверьте соединение и повторите.';
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'Нет подключения к интернету. Проверьте сеть и повторите.';
  }
  const message = error instanceof Error ? error.message.trim() : '';
  if (
    /failed to fetch|networkerror|network error|load failed|fetch failed|econnrefused|econnreset|err_/i.test(message) ||
    message === ''
  ) {
    return 'Не удалось связаться с сервером. Проверьте соединение и повторите.';
  }
  const http = /^(?:HTTP\s*)?(\d{3})\b/i.exec(message);
  if (http) {
    return `Сервер не принял запрос (HTTP ${http[1]}). Повторите попытку или проверьте адрес сервера.`;
  }
  if (/[\u0400-\u04FF]/.test(message) && !/failed to fetch/i.test(message)) return message;
  return 'Не удалось создать комнату. Повторите попытку.';
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage can be disabled; theme still works for this page view */
  }
}

function resolvedScheme(): 'light' | 'dark' {
  if (currentScheme === 'light' || currentScheme === 'dark') return currentScheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Applies the landing scheme and the selected widget theme tokens.
 *
 * The landing follows the AGIL design system (blue primary / teal accent); the `--agil-*`
 * variables are consumed by the product mockups (hero call, editor preview), so
 * switching a preset visibly re-skins the *product*, not the marketing page.
 */
function applyPageTheme(): void {
  const scheme = resolvedScheme();
  const root = document.documentElement;
  root.dataset.theme = scheme;
  root.dataset.preset = currentPreset;
  root.style.colorScheme = scheme;

  const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeMeta?.setAttribute('content', scheme === 'dark' ? '#080d16' : '#f3f6fb');

  for (const [name, value] of Object.entries(toCssVars(themePresets[currentPreset]))) {
    root.style.setProperty(name, value);
  }

  const dark = scheme === 'dark';
  themeToggle.setAttribute('aria-pressed', String(dark));
  themeToggle.setAttribute('aria-label', dark ? 'Включить светлую тему' : 'Включить тёмную тему');
  themeToggle.setAttribute('title', dark ? 'Включить светлую тему' : 'Включить тёмную тему');
}

function setScheme(scheme: Scheme, persist = true): void {
  currentScheme = scheme;
  schemeSelect.value = scheme;
  if (persist) store('agil-demo-scheme', scheme);
  applyPageTheme();
  applyThemeToWidget();
  renderSnippet();
}

function setPreset(preset: ThemePresetName): void {
  currentPreset = preset;
  presetSelect.value = preset;
  store('agil-demo-preset', preset);
  applyPageTheme();
  applyThemeToWidget();
  renderSnippet();
}

function applyThemeToWidget(): void {
  if (!instance) return;
  try {
    instance.updateTheme(themePresets[currentPreset]);
    instance.setThemeScheme(currentScheme);
  } catch {
    /* the widget may still be booting */
  }
}

function renderSnippet(): void {
  const server = serverBase();
  const room = roomInput.value.trim() || 'team-sync';
  const tenant = tenantInput.value.trim() || 'demo';
  // Never put a real short-lived token into the page or screenshots.
  const token = '<токен из POST /v1/rooms/:id/join>';
  const snippet = `<!-- 1) подключить SDK: один самодостаточный файл -->
<script src="${server}/sdk/agilframe.js"></script>

<!-- 2) контейнер -->
<div id="call" style="height:640px;border-radius:16px;overflow:hidden"></div>

<script>
  const call = await AgilFrame.mount('#call', {
    serverUrl: '${server}', tenantId: '${tenant}',
    room: '${room}', token: '${token}',
    participantName: 'Гость',
    theme: { scheme: '${currentScheme}' },
  });
  call.on('chat', (message) => console.log('chat', message));
</script>`;
  snippetEl.textContent = snippet;
}

function healthVersion(): string {
  return healthPill.dataset.version || APP_VERSION;
}

function renderHealth(state: 'checking' | 'online' | 'offline', label: string, shortLabel: string): void {
  healthPill.dataset.state = state;
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  dot.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'health-state';
  text.textContent = label;
  const short = document.createElement('span');
  short.className = 'health-state-short';
  short.textContent = shortLabel;
  const version = document.createElement('span');
  version.className = 'health-version';
  version.textContent = `v${healthVersion()}`;
  healthPill.replaceChildren(dot, text, short, version);
}

async function checkHealth(): Promise<void> {
  if (!healthPill.dataset.checked) renderHealth('checking', 'Проверяем сервер', 'Проверка');
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${serverBase()}/v1/health`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = (await response.json()) as HealthResponse;
    healthPill.dataset.version = health.version;
    healthPill.dataset.checked = '1';
    healthPill.title = `${health.name} ${health.version} · комнат: ${health.rooms} · организаций: ${health.tenants}`;
    renderHealth('online', 'Сервер доступен', 'Онлайн');
  } catch {
    healthPill.dataset.checked = '1';
    healthPill.title = 'Сервер недоступен — доступен демо-режим без сети';
    renderHealth('offline', 'Демо-режим', 'Демо');
  } finally {
    window.clearTimeout(timer);
  }
}

function teardownWidget(): void {
  instance?.destroy();
  instance = null;
  iframe?.remove();
  iframe = null;
  callContainer.replaceChildren();
  callSection.hidden = true;
}

function loadingNode(title: string, note: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'demo-call-empty is-loading';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const span = document.createElement('span');
  span.textContent = note;
  const skeleton = document.createElement('span');
  skeleton.className = 'demo-skeleton';
  skeleton.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 3; index += 1) {
    const bar = document.createElement('i');
    skeleton.append(bar);
  }
  wrap.append(strong, span, skeleton);
  return wrap;
}

async function createRoom(retry?: () => void): Promise<CreateRoomResponse | null> {
  setStatus('Создаём комнату…');
  const payload: Record<string, unknown> = {
    tenantId: tenantInput.value.trim() || 'demo',
    name: roomInput.value.trim() || undefined,
  };
  if (passwordInput.value.trim()) payload.password = passwordInput.value.trim();

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${serverBase()}/v1/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
    }
    const created = (await response.json()) as CreateRoomResponse;
    lastCreateRoom = created;
    roomInput.value = created.room.id;
    joinLink.href = created.embedUrl || created.joinUrl;
    joinLink.hidden = false;
    embedLink.href = created.embedUrl;
    embedLink.hidden = false;
    setStatus(`Комната создана: ${created.room.id}. Можно открывать виджет или звать второго участника.`, 'success');
    renderSnippet();
    void checkHealth();
    return created;
  } catch (error) {
    lastCreateRoom = null;
    const message = humanizeCreateError(error);
    setStatus(message, 'error', retry);
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

interface JoinInlineOptions {
  /** `now` opens the demo section immediately, before the widget chunk loads. */
  scroll?: 'now' | 'after' | 'none';
}

async function joinInline(options: JoinInlineOptions = {}): Promise<boolean> {
  const room = roomInput.value.trim();
  if (!room) {
    setStatus('Укажите идентификатор комнаты или создайте комнату.', 'error');
    roomInput.focus();
    return false;
  }

  teardownWidget();
  callSection.hidden = false;
  callContainer.replaceChildren(loadingNode('Подключаем виджет…', 'Загружаем интерфейс звонка. Это займёт пару секунд.'));
  setStatus('Подключаем виджет…');
  if (options.scroll === 'now') scrollToSection(callSection, 'auto');

  try {
    const { mountWidget } = await loadWidget();
    callContainer.replaceChildren();
    const token = lastCreateRoom?.room.id === room ? lastCreateRoom.token : undefined;
    instance = await mountWidget(callContainer, {
      serverUrl: serverBase(),
      tenantId: tenantInput.value.trim() || 'demo',
      room,
      token,
      participantName: nameInput.value.trim() || undefined,
      theme: { scheme: currentScheme },
      config: { layout: { videoFit: 'contain' } },
    });
    instance.on('joined', () => {
      const role = instance?.getState().self?.role ?? 'guest';
      const roleLabel = role === 'host' ? 'организатор' : role === 'moderator' ? 'модератор' : 'участник';
      setStatus(`Вы в звонке как ${roleLabel}. Виджет подключён к комнате.`, 'success');
    });
    instance.on('error', () => setStatus('Ошибка виджета. Технические подробности — в консоли браузера.', 'error'));
    instance.on('chat', (message) => console.info('[demo] chat event', message));
    setStatus(
      token
        ? 'Комната создана — входим в звонок как организатор. Виджет уже открыт.'
        : 'Виджет открыт. Войдите в комнату или позовите второго участника по ссылке.',
      'success',
    );
    // With a host token the widget auto-joins during `mountWidget`, i.e. before
    // this listener is attached. Poll the real phase once and correct the
    // status, so the demo never tells an already-joined host to press «Войти».
    const mounted = instance;
    const announceJoined = (): void => {
      const role = mounted.getState().self?.role ?? 'guest';
      const roleLabel = role === 'host' ? 'организатор' : role === 'moderator' ? 'модератор' : 'участник';
      setStatus(`Вы в звонке как ${roleLabel}. Виджет подключён к комнате.`, 'success');
    };
    window.clearInterval(joinStatusTimer);
    if (mounted.getState().phase === 'joined') {
      announceJoined();
    } else if (token) {
      let checks = 0;
      joinStatusTimer = window.setInterval(() => {
        checks += 1;
        if (instance !== mounted || checks > 20) {
          window.clearInterval(joinStatusTimer);
          return;
        }
        if (mounted.getState().phase === 'joined') {
          announceJoined();
          window.clearInterval(joinStatusTimer);
        }
      }, 500);
    }
    if (options.scroll !== 'none') scrollToSection(callSection, 'auto');
    return true;
  } catch (error) {
    const message = humanizeCreateError(error);
    setStatus(`Не удалось открыть виджет. ${message}`, 'error', () => void joinInline({ scroll: 'now' }));
    callSection.hidden = true;
    callContainer.replaceChildren();
    return false;
  }
}

async function joinIframe(): Promise<boolean> {
  const room = roomInput.value.trim();
  if (!room) {
    setStatus('Укажите идентификатор комнаты или создайте комнату.', 'error');
    roomInput.focus();
    return false;
  }

  teardownWidget();
  callSection.hidden = false;
  callContainer.replaceChildren(loadingNode('Открываем встроенное окно…', 'Готовим iframe с изолированными стилями.'));

  try {
    const { createEmbed } = await loadSdk();
    const token = lastCreateRoom?.room.id === room ? lastCreateRoom.token : undefined;
    const embed = createEmbed({
      serverUrl: serverBase(),
      room,
      token,
      tenantId: tenantInput.value.trim() || 'demo',
      participantName: nameInput.value.trim() || undefined,
      theme: { scheme: currentScheme },
      height: 640,
    });
    callContainer.replaceChildren();
    if (embed.iframe) {
      iframe = embed.iframe;
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      callContainer.replaceChildren(iframe);
      setStatus('Виджет открыт во встроенном окне (iframe).', 'success');
      scrollToSection(callSection, 'auto');
      return true;
    }
    const fallback = document.createElement('pre');
    fallback.className = 'demo-pre';
    fallback.textContent = embed.html;
    callContainer.replaceChildren(fallback);
    setStatus('Не удалось встроить окно. Показан код для вставки.', 'info');
    return false;
  } catch (error) {
    const message = humanizeCreateError(error);
    setStatus(`Не удалось открыть встроенное окно. ${message}`, 'error', () => void joinIframe());
    callSection.hidden = true;
    callContainer.replaceChildren();
    return false;
  }
}

async function createFromForm(): Promise<void> {
  if (creating) return;
  creating = true;
  setBusy(createButton, true, createButton.dataset.busyLabel);
  setStatus('Создаём комнату…');
  try {
    await createRoom(() => void createFromForm());
  } finally {
    creating = false;
    setBusy(createButton, false);
  }
}

async function joinFromForm(): Promise<void> {
  setBusy(joinButton, true);
  try {
    await joinInline({ scroll: 'now' });
  } finally {
    setBusy(joinButton, false);
  }
}

async function openIframeFromForm(): Promise<void> {
  setBusy(iframeButton, true);
  try {
    await joinIframe();
  } finally {
    setBusy(iframeButton, false);
  }
}

function createSourceFor(button: HTMLButtonElement): CreateSource {
  if (button.id === 'hero-create') return 'hero';
  if (button.id === 'final-create') return 'final';
  if (button.id === 'how-create') return 'how';
  if (button.id === 'menu-create') return 'mobile';
  return 'header';
}

/**
 * One behaviour for every «Создать комнату» CTA: react on the same tick (label
 * + spinner + inline feedback/toast), call `POST /v1/rooms`, then jump to the
 * demo section immediately and mount the widget behind a skeleton. The long
 * scroll is `auto`, so the perceived response is not a 1.5 s animation.
 */
async function createAndOpen(source: CreateSource): Promise<void> {
  if (creating) return;
  const inline = source === 'hero';
  creating = true;
  setCreateBusy(true);
  setStatus('Создаём комнату…');
  if (inline) setHeroFeedback('Создаём комнату…', 'info');
  else showToast('Создаём комнату…', 'loading');

  try {
    const created = await createRoom(() => void createAndOpen(source));
    if (!created) {
      const message = formStatus.textContent?.trim() || 'Не удалось создать комнату. Повторите попытку.';
      if (inline) setHeroFeedback(message, 'error', () => void createAndOpen(source));
      else showToast(message, 'error', () => void createAndOpen(source));
      return;
    }

    if (inline) setHeroFeedback(`Комната ${created.room.id} создана — открываем демо.`, 'success');
    else showToast(`Комната ${created.room.id} создана — открываем демо.`, 'success');

    // Keep the CTA in its busy state while the widget chunk mounts behind the
    // demo skeleton; `creating` also ignores a second click.
    const joined = await joinInline({ scroll: 'now' });
    if (!joined) {
      const message = 'Комната создана, но виджет не открылся. Проверьте соединение и повторите.';
      if (inline) setHeroFeedback(message, 'error', () => void joinInline({ scroll: 'now' }));
      else showToast(message, 'error', () => void joinInline({ scroll: 'now' }));
    }
  } finally {
    creating = false;
    setCreateBusy(false);
  }
}

function bindEvents(): void {
  for (const trigger of createTriggers) {
    trigger.addEventListener('click', () => void createAndOpen(createSourceFor(trigger)));
  }
  iframeButton.addEventListener('click', () => void openIframeFromForm());
  unmountButton.addEventListener('click', () => teardownWidget());

  themeToggle.addEventListener('click', () => {
    setScheme(resolvedScheme() === 'dark' ? 'light' : 'dark');
  });

  schemeSelect.addEventListener('change', () => {
    setScheme(schemeSelect.value as Scheme);
  });

  presetSelect.addEventListener('change', () => {
    setPreset(presetSelect.value as ThemePresetName);
  });

  for (const input of [serverUrlInput, tenantInput, roomInput]) {
    input.addEventListener('change', () => {
      renderSnippet();
      if (input === serverUrlInput) void checkHealth();
    });
  }

  let enterSubmit = false;
  callForm.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) enterSubmit = true;
  });

  callForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const byEnter = enterSubmit;
    enterSubmit = false;
    if (creating) return;
    const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
    if (byEnter) {
      // Enter on any field: create when the room is empty, otherwise open it.
      if (roomInput.value.trim()) void joinFromForm();
      else void createFromForm();
      return;
    }
    if (submitter?.id === 'join-inline') {
      void joinFromForm();
      return;
    }
    void createFromForm();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentScheme === 'auto') applyPageTheme();
  });
}

/**
 * White-label bootstrap: a verified custom domain resolves to a tenant on the
 * server, so the same static landing serves that tenant's brand without any
 * build-time host. The default host keeps the AGIL markup untouched.
 */
async function applyHostTenant(): Promise<void> {
  try {
    const response = await fetch('/v1/host', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) return;
    const info = (await response.json()) as HostInfoResponse;
    if (info.resolved !== 'domain' || !info.verified) return;
    tenantInput.value = info.tenantId;
    const productName = info.branding.productName?.trim();
    if (productName) {
      document.title = `${productName} — видеозвонки`;
      for (const element of document.querySelectorAll<HTMLElement>('.brand-name')) {
        element.textContent = productName;
      }
      for (const element of document.querySelectorAll<HTMLAnchorElement>('a.brand')) {
        element.setAttribute('aria-label', `${productName} — на главную`);
      }
    }
    if (info.branding.logoUrl) {
      for (const image of document.querySelectorAll<HTMLImageElement>('.brand-mark')) image.src = info.branding.logoUrl;
    }
    if (info.branding.faviconUrl) {
      for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) link.href = info.branding.faviconUrl;
    }
    renderSnippet();
  } catch {
    /* static landing must keep working when /v1/host is unreachable */
  }
}

function init(): void {
  serverUrlInput.placeholder = window.location.origin;
  serverUrlInput.value = window.location.origin;
  hideToast();

  const savedPreset = stored('agil-demo-preset');
  if (savedPreset && (themePresetNames as readonly string[]).includes(savedPreset)) {
    currentPreset = savedPreset as ThemePresetName;
  } else {
    // A matching default theme keeps the hero call in the same light/dark key
    // as the page; the preset switcher still demonstrates all five themes.
    currentPreset = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  const savedScheme = stored('agil-demo-scheme');
  if (savedScheme === 'light' || savedScheme === 'dark' || savedScheme === 'auto') {
    currentScheme = savedScheme;
  }

  schemeSelect.value = currentScheme;
  presetSelect.value = currentPreset;
  applyPageTheme();
  bindEvents();
  renderSnippet();
  void applyHostTenant();
  void checkHealth();
  window.setInterval(() => void checkHealth(), 20_000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
