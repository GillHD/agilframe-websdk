/**
 * Demo: fully host-rendered ("build your own UI") call.
 *
 * The SDK mounts with `ui: 'headless'`: it renders no built-in markup,
 * but joins, publishes/subscribes media, chat and state through the public
 * instance API. Everything below is ordinary host DOM.
 */
import { browserRecordingEnabled } from '@agil/protocol';
import { mount, type AgilWidgetInstance } from '@agil/calls-sdk';
import type { CallState } from '@agil/calls-widget';

type ToastKind = 'info' | 'success' | 'warning' | 'error';
type ToggleAction = 'mic' | 'camera' | 'screen' | 'hand' | 'record';

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`custom-ui: element ${selector} not found`);
  return element;
};

const stage = $<HTMLDivElement>('#custom-ui-stage');
const joinForm = $<HTMLFormElement>('#cui-join-form');
const joinSubmit = $<HTMLButtonElement>('#cui-join-form button[type="submit"]');
const serverInput = $<HTMLInputElement>('#cui-server');
const roomInput = $<HTMLInputElement>('#cui-room');
const nameInput = $<HTMLInputElement>('#cui-name');
const tokenInput = $<HTMLInputElement>('#cui-token');
const statusEl = $<HTMLParagraphElement>('#cui-status');
const participantsEl = $<HTMLUListElement>('#cui-participants');
const chatLog = $<HTMLDivElement>('#cui-chat-log');
const chatForm = $<HTMLFormElement>('#cui-chat-form');
const chatInput = $<HTMLInputElement>('#cui-chat-input');
const chatSubmit = $<HTMLButtonElement>('#cui-chat-form button[type="submit"]');
const reactionsEl = $<HTMLDivElement>('#cui-reactions');

let instance: AgilWidgetInstance | null = null;
let current: CallState | null = null;
let statusTimer = 0;
let joining = false;
let recordingPending = false;
/** Inputs captured at mount; a later retry with different values remounts. */
let mountedKey = '';
const tiles = new Map<string, { figure: HTMLElement; video: HTMLVideoElement; caption: HTMLElement }>();

serverInput.value = window.location.origin;

function setStatus(text: string, kind: ToastKind = 'info'): void {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind === 'error' ? 'error' : kind === 'success' ? 'ok' : '';
  window.clearTimeout(statusTimer);
  if (kind === 'success' || kind === 'info') {
    statusTimer = window.setTimeout(() => {
      statusEl.textContent = '';
      statusEl.dataset.kind = '';
      render();
    }, 5000);
  }
}

function serverBase(): string {
  return (serverInput.value.trim() || window.location.origin).replace(/\/+$/, '');
}

/** Builds the host-owned markup that lives inside the widget's headless root. */
function buildCustomUi(): HTMLElement {
  const root = document.createElement('section');
  root.className = 'cui';
  root.setAttribute('aria-label', 'Кастомный интерфейс звонка');

  const videos = document.createElement('div');
  videos.className = 'cui-videos';
  videos.id = 'cui-videos';
  root.appendChild(videos);

  const toolbar = document.createElement('div');
  toolbar.className = 'cui-toolbar';
  toolbar.id = 'cui-toolbar';
  root.appendChild(toolbar);

  const recording = document.createElement('div');
  recording.id = 'cui-recording';
  recording.setAttribute('role', 'status');
  recording.hidden = true;
  root.append(recording);

  return root;
}

function button(label: string, onClick: (event: MouseEvent) => void, action?: ToggleAction): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.className = 'cui-btn';
  if (action) element.dataset.cuiAction = action;
  element.addEventListener('click', onClick);
  return element;
}

function buildToolbar(ui: HTMLElement): void {
  const toolbar = ui.querySelector<HTMLElement>('#cui-toolbar');
  if (!toolbar) return;
  toolbar.replaceChildren(
    button('Микрофон', () => {
      void instance?.toggleMic().then(() => render());
    }, 'mic'),
    button('Камера', () => {
      void instance?.toggleCamera().then(() => render());
    }, 'camera'),
    button('Экран', () => {
      void instance?.toggleScreenShare().then(() => render());
    }, 'screen'),
    button('Рука', () => {
      instance?.raiseHand(!current?.settings.handRaised);
      render();
    }, 'hand'),
    button('👋 Реакция', () => {
      instance?.sendReaction('👋');
    }),
    button('Начать запись', (event) => {
      if (event.currentTarget instanceof HTMLButtonElement) void toggleRecording(event.currentTarget);
    }, 'record'),
    button('Выйти', () => {
      instance?.leave();
      setStatus('Вы вышли из звонка');
    }),
  );
}

function confirmRecording(): Promise<boolean> {
  const dialog = document.createElement('dialog');
  dialog.className = 'cui-recording-dialog';
  dialog.setAttribute('aria-labelledby', 'cui-recording-title');
  dialog.setAttribute('aria-describedby', 'cui-recording-description');
  dialog.innerHTML = `<form method="dialog">
    <h2 id="cui-recording-title">Начать запись?</h2>
    <p id="cui-recording-description">Убедитесь, что участники согласны на запись разговора.</p>
    <div class="cui-dialog-actions">
      <button value="cancel" autofocus>Отмена</button>
      <button value="record" class="primary">Начать запись</button>
    </div>
  </form>`;
  stage.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === 'record';
      dialog.remove();
      resolve(confirmed);
    }, { once: true });
    dialog.showModal();
  });
}

async function toggleRecording(trigger: HTMLButtonElement): Promise<void> {
  const widget = instance;
  if (!widget || recordingPending) return;
  const { recording, config, phase } = widget.getState();
  if (phase !== 'joined') return;
  recordingPending = true;
  try {
    if (recording.active) {
      await widget.stopRecording();
      setStatus('Запись остановлена', 'success');
    } else {
      const consent = !config.session.recording.consentRequired || await confirmRecording();
      if (!consent || instance !== widget || widget.getState().phase !== 'joined') return;
      const started = await widget.startRecording({ consent });
      setStatus(started ? 'Запись началась' : 'Запись недоступна', started ? 'success' : 'error');
    }
  } catch {
    setStatus('Не удалось переключить запись', 'error');
  } finally {
    recordingPending = false;
    render();
    if (document.activeElement === document.body) trigger.focus({ preventScroll: true });
  }
}

function showReaction(text: string): void {
  const line = document.createElement('div');
  line.textContent = text;
  reactionsEl.appendChild(line);
  while (reactionsEl.children.length > 5) reactionsEl.firstElementChild?.remove();
}

function videoTile(participantId: string, name: string, stream: MediaStream, self: boolean): void {
  let tile = tiles.get(participantId);
  if (!tile) {
    const figure = document.createElement('figure');
    figure.className = 'cui-tile';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = self;
    const caption = document.createElement('figcaption');
    figure.appendChild(video);
    figure.appendChild(caption);
    document.querySelector<HTMLElement>('#cui-videos')?.appendChild(figure);
    tile = { figure, video, caption };
    tiles.set(participantId, tile);
  }
  if (tile.video.srcObject !== stream) {
    tile.video.srcObject = stream;
    void tile.video.play().catch(() => undefined);
  }
  tile.video.muted = self;
  tile.caption.textContent = `${name}${self ? ' (вы)' : ''}`;
}

function renderVideos(state: CallState): void {
  const host = document.querySelector<HTMLElement>('#cui-videos');
  if (!host) return;
  const desired = new Set<string>();
  const local = instance?.getScreenStream() ?? instance?.getLocalStream() ?? null;
  if (local && state.self) {
    desired.add(state.self.id);
    videoTile(state.self.id, state.self.name, local, true);
  }
  const remotes = instance?.getRemoteStreams() ?? {};
  for (const participant of state.participants) {
    const stream = remotes[participant.id];
    if (!stream) continue;
    desired.add(participant.id);
    videoTile(participant.id, participant.name, stream, false);
  }
  for (const [id, tile] of [...tiles]) {
    if (desired.has(id)) continue;
    // Detach the media element before dropping the tile (docs/custom-ui.md §2).
    tile.video.srcObject = null;
    tile.figure.remove();
    tiles.delete(id);
  }
}

function renderToolbar(state: CallState): void {
  const root = stage.querySelector<HTMLElement>('.cui');
  const toolbar = root?.querySelector<HTMLElement>('#cui-toolbar');
  if (!toolbar) return;
  const states: Record<ToggleAction, boolean> = {
    mic: state.settings.micEnabled,
    camera: state.settings.camEnabled,
    screen: state.settings.screenSharing,
    hand: state.settings.handRaised,
    record: state.recording.active,
  };
  for (const child of toolbar.querySelectorAll<HTMLButtonElement>('[data-cui-action]')) {
    const active = states[child.dataset.cuiAction as ToggleAction];
    child.classList.toggle('is-active', active);
    child.setAttribute('aria-pressed', String(active));
    if (child.dataset.cuiAction === 'record') {
      child.hidden = !active && !(state.phase === 'joined' && browserRecordingEnabled(state.config) && state.permissions?.includes('recording'));
      child.disabled = recordingPending;
      child.textContent = active ? 'Остановить запись' : 'Начать запись';
    }
  }
  const recording = root?.querySelector<HTMLElement>('#cui-recording');
  if (recording) {
    const message = state.recording.active ? 'Вы записываете звонок' : state.recording.remoteActive ? 'Идёт запись звонка' : '';
    recording.hidden = !message;
    if (recording.textContent !== message) recording.textContent = message;
  }
  const leave = toolbar.children[toolbar.children.length - 1];
  if (leave instanceof HTMLButtonElement) leave.disabled = state.phase !== 'joined';
}

function renderParticipants(state: CallState): void {
  const names: string[] = [];
  if (state.phase === 'joined') {
    if (state.self) names.push(`${state.self.name} (вы)`);
    for (const participant of state.participants) names.push(participant.name);
  }
  participantsEl.replaceChildren(
    ...names.map((name) => {
      const item = document.createElement('li');
      item.textContent = name;
      return item;
    }),
  );
}

function renderChat(state: CallState): void {
  const chat = state.phase === 'joined' ? state.chat : [];
  const previous = chatLog.dataset.signature ?? '';
  const signature = `${chat.length}:${chat.at(-1)?.id ?? ''}`;
  if (signature === previous) return;
  chatLog.dataset.signature = signature;
  chatLog.replaceChildren(
    ...chat.map((message) => {
      const row = document.createElement('div');
      row.className = 'cui-chat-msg';
      const author = document.createElement('b');
      author.textContent = `${message.from.name}: `;
      row.appendChild(author);
      row.appendChild(document.createTextNode(message.kind === 'system' ? `— ${message.text}` : message.text));
      return row;
    }),
  );
  chatLog.scrollTop = chatLog.scrollHeight;
}

function updateFormControls(state: CallState | null): void {
  const connected = state?.phase === 'joined';
  joinSubmit.disabled = joining || connected;
  const chatAvailable = connected && state.config.features.chat && state.permissions?.includes('chat');
  chatInput.disabled = chatSubmit.disabled = !chatAvailable;
}

function render(): void {
  const state = current ?? instance?.getState() ?? null;
  updateFormControls(state);
  if (!state) return;
  current = state;
  renderVideos(state);
  renderToolbar(state);
  renderParticipants(state);
  renderChat(state);
  if (state.phase !== 'joined') reactionsEl.replaceChildren();
  const phase = state.phase === 'joined' ? 'в звонке' : state.phase;
  const room = state.room?.name ?? roomInput.value.trim();
  setStatusText(state.phase === 'left' ? 'Вы вышли из звонка' :
    `${room || '—'} · ${phase} · участников: ${state.participants.length + (state.self ? 1 : 0)}`);
}

function setStatusText(text: string): void {
  // Do not erase an active error/info toast; only update a neutral status line.
  if (statusEl.dataset.kind) return;
  statusEl.textContent = text;
}

function wire(widget: AgilWidgetInstance): void {
  widget.on('state', (payload) => {
    current = payload as CallState;
    render();
  });
  widget.on('remote-stream', () => renderVideos(current ?? widget.getState()));
  widget.on('participant-joined', () => render());
  widget.on('participant-left', () => render());
  widget.on('media-state', () => render());
  widget.on('chat', () => renderChat(widget.getState()));
  widget.on('reaction', (payload) => {
    const reaction = payload as { emoji?: string; name?: string; self?: boolean };
    if (reaction.emoji) showReaction(`${reaction.self ? 'Вы' : reaction.name ?? 'Гость'}: ${reaction.emoji}`);
  });
  widget.on('error', (payload) => {
    const error = payload as { code?: string; message?: string };
    setStatus(`Ошибка: ${error.message ?? error.code ?? 'unknown'}`, 'error');
  });
  widget.on('toast', (payload) => {
    const toast = payload as { message?: string; kind?: ToastKind };
    if (toast.message) setStatus(toast.message, toast.kind ?? 'info');
  });
}

async function join(): Promise<void> {
  const room = roomInput.value.trim();
  if (!room) {
    setStatus('Укажите комнату', 'error');
    return;
  }
  const server = serverBase();
  const name = nameInput.value.trim() || 'Гость';
  const token = tokenInput.value.trim() || undefined;
  const key = JSON.stringify([server, room, name, token ?? '']);
  // A failed first join must be retryable with corrected inputs (QA P3-1):
  // the widget captures room/server/token at mount, so remount when they change.
  if (instance && mountedKey !== key && instance.getState().phase !== 'joined') {
    instance.destroy();
    instance = null;
    current = null;
    tiles.clear();
  }
  if (!instance) {
    setStatus('Подключение…');
    try {
      instance = await mount(stage, {
        ui: 'headless',
        serverUrl: server,
        room,
        participantName: name,
        token,
        locale: 'ru',
        customCss: [
          ':root { --cui-accent: var(--agil-color-primary); }',
          '.cui-btn { border-color: color-mix(in srgb, var(--agil-color-primary) 35%, transparent); }',
          '.cui-btn.is-active { outline: 2px solid var(--agil-color-primary); }',
        ].join('\n'),
      });
      mountedKey = key;
      const root = stage.querySelector<HTMLElement>('.agil-root');
      const ui = buildCustomUi();
      (root ?? stage).appendChild(ui);
      buildToolbar(ui);
      wire(instance);
      if (!token) await instance.join();
      render();
      setStatus(instance.getState().phase === 'joined' ? 'Готово' : 'Не удалось войти — проверьте комнату и сервер', instance.getState().phase === 'joined' ? 'success' : 'error');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    }
    return;
  }
  if (instance.getState().phase !== 'joined') {
    try {
      await instance.join();
      render();
      setStatus(instance.getState().phase === 'joined' ? 'Готово' : 'Не удалось войти — проверьте комнату и сервер', instance.getState().phase === 'joined' ? 'success' : 'error');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }
}

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (joining || instance?.getState().phase === 'joined') return;
  joining = true;
  updateFormControls(current);
  void join().finally(() => {
    joining = false;
    updateFormControls(instance?.getState() ?? null);
  });
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !instance || chatSubmit.disabled) return;
  chatInput.value = '';
  void instance
    .sendChat(text)
    .then(() => renderChat(instance?.getState() ?? (current as CallState)))
    .catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), 'error'));
});

updateFormControls(null);
