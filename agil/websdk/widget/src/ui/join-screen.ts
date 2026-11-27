/**
 * Join screen: camera preview, display name, room password (only when needed),
 * human-readable join errors and the offline/demo fallback.
 */
import { h, uid } from '../dom.js';
import type { I18n, I18nKey } from '../i18n.js';
import { icon } from '../icons.js';
import type { CallState } from '../types.js';

export interface JoinInput {
  name: string;
  password?: string;
  identityToken?: string;
  listenOnly?: boolean;
}

export interface JoinScreenActions {
  onJoin: (input: JoinInput) => void;
  onOfflineDemo: () => void;
  onToggleMic: () => void;
  onToggleCamera: () => void;
}

const ERROR_KEYS: Record<string, I18nKey> = {
  room_not_found: 'roomNotFound',
  not_found: 'roomNotFound',
  room_locked: 'roomLocked',
  room_full: 'roomFull',
  rate_limited: 'joinRateLimited',
  forbidden: 'joinForbidden',
  host_not_joined: 'joinWaitingForHost',
  password_required: 'passwordRequired',
  password_invalid: 'passwordInvalid',
  identity_required: 'identityRequired',
  invalid_identity_token: 'identityInvalid',
  geo_blocked: 'geoBlocked',
  unauthorized: 'unauthorized',
  network_error: 'networkError',
  timeout: 'networkError',
  socket_failed: 'networkError',
  origin_not_allowed: 'originNotAllowed',
  connection_closed: 'connectionClosed',
  reconnect_exhausted: 'reconnectExhausted',
  server_timeout: 'serverTimeout',
  call_browser_unsupported: 'callBrowserUnsupported',
};

export class JoinScreen {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly actions: JoinScreenActions;
  private readonly video: HTMLVideoElement;
  private readonly placeholder: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly passwordField: HTMLElement;
  private readonly identityField: HTMLElement;
  private readonly identityInput: HTMLInputElement;
  private forceIdentity = false;
  private readonly passwordInput: HTMLInputElement;
  private readonly errorEl: HTMLDivElement;
  private readonly errorText: HTMLSpanElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly joinButton: HTMLButtonElement;
  private readonly listenButton: HTMLButtonElement;
  private readonly micButton: HTMLButtonElement;
  private readonly cameraButton: HTMLButtonElement;
  private readonly previewHint: HTMLDivElement;
  private readonly welcomeMessage: HTMLParagraphElement;
  private readonly offlineBlock: HTMLDivElement;
  private readonly serverLine: HTMLDivElement;
  private forcePassword = false;
  private offline = false;
  private busy = false;

  constructor(i18n: I18n, actions: JoinScreenActions) {
    this.i18n = i18n;
    this.actions = actions;
    this.video = h('video', { class: 'agil-join-video' });
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    this.placeholder = h('div', { class: 'agil-join-placeholder' }, icon('camera-off', 40));
    this.nameInput = h('input', {
      class: 'agil-input',
      attrs: { type: 'text', maxlength: '120', placeholder: i18n.t('yourNamePlaceholder'), autocomplete: 'name' },
    });
    this.nameInput.setAttribute('aria-label', i18n.t('yourName'));
    this.passwordInput = h('input', {
      class: 'agil-input',
      attrs: { type: 'password', maxlength: '200', placeholder: i18n.t('passwordPlaceholder'), autocomplete: 'current-password' },
    });
    this.passwordInput.setAttribute('aria-label', i18n.t('passwordLabel'));
    this.passwordField = h(
      'label',
      { class: 'agil-field' },
      h('span', { class: 'agil-field-label', text: i18n.t('passwordLabel') }),
      this.passwordInput,
    );
    this.passwordField.hidden = true;
    this.identityInput = h('input', {
      class: 'agil-input',
      attrs: { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: i18n.t('identityTokenPlaceholder') },
    });
    this.identityInput.dataset.agilIdentityToken = '';
    this.identityInput.setAttribute('aria-label', i18n.t('identityLabel'));
    this.identityField = h(
      'label',
      { class: 'agil-field' },
      h('span', { class: 'agil-field-label', text: i18n.t('identityLabel') }),
      this.identityInput,
      h('span', { class: 'agil-settings-hint', text: i18n.t('identityHint') }),
    );
    this.identityField.hidden = true;
    this.errorText = h('span', { class: 'agil-join-error-text', attrs: { id: uid('agil-join-error-') } });
    this.retryButton = h('button', { class: 'agil-btn agil-btn-ghost agil-join-error-retry', text: i18n.t('retry') });
    this.retryButton.type = 'button';
    this.retryButton.addEventListener('click', () => this.submit(false));
    this.errorEl = h(
      'div',
      { class: 'agil-join-error', attrs: { role: 'alert', tabindex: '-1' } },
      this.errorText,
      this.retryButton,
    );
    this.errorEl.hidden = true;
    this.joinButton = h('button', { class: 'agil-btn agil-btn-primary agil-join-submit' });
    this.joinButton.type = 'button';
    this.joinButton.appendChild(icon('camera', 18));
    this.joinButton.appendChild(h('span', { text: i18n.t('joinButton') }));
    this.joinButton.addEventListener('click', () => this.submit(false));
    this.listenButton = h('button', { class: 'agil-btn agil-btn-ghost', text: i18n.t('onlyListen') });
    this.listenButton.type = 'button';
    this.listenButton.addEventListener('click', () => this.submit(true));
    this.micButton = h('button', { class: 'agil-icon-btn', title: i18n.t('micOff') });
    this.micButton.type = 'button';
    this.micButton.setAttribute('aria-label', i18n.t('micOff'));
    this.micButton.appendChild(icon('mic', 18));
    this.micButton.addEventListener('click', () => actions.onToggleMic());
    this.cameraButton = h('button', { class: 'agil-icon-btn', title: i18n.t('cameraOff') });
    this.cameraButton.type = 'button';
    this.cameraButton.setAttribute('aria-label', i18n.t('cameraOff'));
    this.cameraButton.appendChild(icon('camera', 18));
    this.cameraButton.addEventListener('click', () => actions.onToggleCamera());
    this.serverLine = h('div', { class: 'agil-join-server' });
    const demoButton = h('button', { class: 'agil-btn agil-btn-ghost', text: i18n.t('offlineDemo') });
    demoButton.type = 'button';
    demoButton.addEventListener('click', () => actions.onOfflineDemo());
    this.offlineBlock = h(
      'div',
      { class: 'agil-join-offline' },
      h('div', { class: 'agil-join-offline-title', text: i18n.t('serverOfflineTitle') }),
      h('div', { class: 'agil-join-offline-text', text: i18n.t('serverOfflineHint') }),
      demoButton,
    );
    this.offlineBlock.hidden = true;

    const previewBadges = h('div', { class: 'agil-join-preview-actions' }, this.micButton, this.cameraButton);
    this.previewHint = h('div', { class: 'agil-join-preview-hint', text: i18n.t('previewLoading') });
    this.previewHint.hidden = true;
    const preview = h(
      'div',
      { class: 'agil-join-preview' },
      this.video,
      this.placeholder,
      this.previewHint,
    );

    // Compact prejoin: the shortcuts moved into a small “?” affordance instead
    // of a full paragraph, and the server URL is no longer repeated in the
    // modal (the page/header already carries the connection state).
    const helpButton = h('button', {
      class: 'agil-join-help',
      text: '?',
      title: i18n.t('shortcutsHint'),
      attrs: { type: 'button', 'aria-label': i18n.t('shortcutsHint') },
    });
    const head = h(
      'div',
      { class: 'agil-join-head' },
      h('h1', { class: 'agil-join-title', text: i18n.t('joinTitle') }),
      helpButton,
    );
    this.welcomeMessage = h('p', { class: 'agil-join-welcome', dataset: { agilJoinWelcome: '' } });
    this.welcomeMessage.hidden = true;
    this.serverLine.hidden = true;
    this.serverLine.setAttribute('aria-hidden', 'true');

    this.element = h(
      'div',
      { class: 'agil-join' },
      h(
        'div',
        { class: 'agil-join-card' },
        h(
          'div',
          { class: 'agil-join-preview-wrap' },
          preview,
          previewBadges,
        ),
        h(
          'form',
          { class: 'agil-join-form', attrs: { 'aria-label': i18n.t('joinTitle') } },
          head,
          this.welcomeMessage,
          h('label', { class: 'agil-field' }, h('span', { class: 'agil-field-label', text: i18n.t('yourName') }), this.nameInput),
          this.passwordField,
          this.identityField,
          this.errorEl,
          this.offlineBlock,
          h('div', { class: 'agil-join-actions' }, this.joinButton, this.listenButton),
          // Kept in the DOM (hidden) so `setServerLine()` stays a no-op for
          // hosts that call it, without printing a long URL in the modal.
          this.serverLine,
        ),
      ),
    );
    const form = this.element.querySelector('form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit(false);
    });
    this.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submit(false);
      }
    });
    this.passwordInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submit(false);
      }
    });
  }

  private submit(listenOnly: boolean): void {
    if (this.busy) return;
    const name = this.nameInput.value.trim();
    const password = this.passwordInput.value;
    const identityToken = this.identityField.hidden ? undefined : this.identityInput.value.trim() || undefined;
    this.clearError();
    this.actions.onJoin({ name, password: password || undefined, identityToken, listenOnly });
  }

  setStream(stream: MediaStream | null): void {
    this.video.srcObject = stream;
    if (stream) {
      void this.video.play().catch(() => undefined);
      this.video.style.display = '';
      this.placeholder.style.display = 'none';
    } else {
      this.video.style.display = 'none';
      this.placeholder.style.display = '';
    }
  }

  setName(name: string): void {
    this.nameInput.value = name;
  }

  setServerLine(text: string): void {
    this.serverLine.textContent = text;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.joinButton.disabled = busy;
    this.joinButton.setAttribute('aria-busy', String(busy));
    this.listenButton.disabled = busy;
    const label = this.joinButton.querySelector('span');
    if (label) label.textContent = busy ? this.i18n.t('joining') : this.i18n.t('joinButton');
  }

  showError(code: string, message?: string): void {
    // An automatic join inside an iframe can finish while the host has focus.
    // Show the error without moving the reader away from the host's controls.
    const canFocus = this.element.ownerDocument.hasFocus();
    const key = ERROR_KEYS[code];
    // Never surface the raw English server message/code to the user.
    this.errorText.textContent = key ? this.i18n.t(key) : this.i18n.t('genericJoinError');
    void message;
    this.errorEl.hidden = false;
    let field: HTMLInputElement | null = null;
    if (code === 'password_required' || code === 'password_invalid') {
      this.forcePassword = true;
      this.passwordField.hidden = false;
      field = this.passwordInput;
    }
    if (code === 'identity_required' || code === 'invalid_identity_token') {
      this.forceIdentity = true;
      this.identityField.hidden = false;
      field = this.identityInput;
    }
    if (field) {
      field.setAttribute('aria-describedby', this.errorText.id);
      if (code === 'password_invalid' || code === 'invalid_identity_token') field.setAttribute('aria-invalid', 'true');
      if (canFocus) {
        field.focus();
        if (field.getAttribute('aria-invalid') === 'true') field.select();
      }
    } else if (canFocus) {
      this.errorEl.focus({ preventScroll: true });
    }
  }

  clearError(): void {
    this.errorEl.hidden = true;
    this.errorText.textContent = '';
    for (const field of [this.passwordInput, this.identityInput]) {
      field.removeAttribute('aria-describedby');
      field.removeAttribute('aria-invalid');
    }
  }

  setOffline(offline: boolean): void {
    this.offline = offline;
    this.offlineBlock.hidden = !offline;
    this.joinButton.style.display = offline ? 'none' : '';
    this.listenButton.style.display = offline ? 'none' : '';
  }

  get isOffline(): boolean {
    return this.offline;
  }

  update(state: CallState): void {
    const welcome = state.config.room.welcomeMessage.trim();
    if (this.welcomeMessage.textContent !== welcome) this.welcomeMessage.textContent = welcome;
    this.welcomeMessage.hidden = !welcome;
    if (state.phase === 'joined') {
      this.passwordInput.value = '';
      this.identityInput.value = '';
    }
    const passwordRequired = state.config.security.passwordRequired || this.forcePassword;
    this.passwordField.hidden = !passwordRequired;
    this.previewHint.hidden = state.phase !== 'joining' || !state.settings.camEnabled || Boolean(state.localStream) || Boolean(state.mediaError);
    this.micButton.replaceChildren(icon(state.settings.micEnabled ? 'mic' : 'mic-off', 18));
    this.cameraButton.hidden = Boolean(state.audioOnly);
    this.cameraButton.replaceChildren(icon(state.settings.camEnabled ? 'camera' : 'camera-off', 18));
    this.micButton.classList.toggle('is-active', !state.settings.micEnabled);
    this.cameraButton.classList.toggle('is-active', !state.settings.camEnabled);
    if (state.mediaError) {
      this.placeholder.replaceChildren(icon('camera-off', 40), h('span', { class: 'agil-join-placeholder-text', text: this.i18n.t('previewUnavailable') }));
      this.placeholder.style.display = '';
      this.video.style.display = 'none';
    }
  }

  focus(): void {
    this.nameInput.focus();
  }

  destroy(): void {
    this.video.srcObject = null;
    this.element.remove();
  }
}
