/**
 * Guest waiting room screen (`security.waitingRoom`).
 *
 * Replaces the whole join-screen area while the join request is pending. It is
 * a pure renderer of `state.lobby`: the controller polls the lobby capability
 * endpoint, ticks `elapsedSec` and switches terminal states. The admitted token
 * never reaches this module (or the DOM) — the controller stores it privately
 * and enters the call automatically.
 */
import { DEFAULT_ROOM } from '@agil/protocol';
import { formatDuration, h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';
import type { CallState, LobbyGuestStatus } from '../types.js';

export interface LobbyScreenActions {
  /** Stop waiting and return to the join form (no server call is possible). */
  onCancel: () => void;
  /** Re-submit the same join request (new lobby request). */
  onRetry: () => void;
  /** Return to the join form without retrying. */
  onBack: () => void;
}

interface StatusCopy {
  title: string;
  message: string;
  hint: string;
  pending: boolean;
  terminal: boolean;
}

export class LobbyScreen {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly roomId: string;
  private readonly actions: LobbyScreenActions;
  private readonly card: HTMLDivElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly roomEl: HTMLParagraphElement;
  private readonly messageEl: HTMLParagraphElement;
  private readonly timerEl: HTMLParagraphElement;
  private readonly hintEl: HTMLParagraphElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;
  private readonly spinner: HTMLDivElement;
  private readonly badgeEl: HTMLSpanElement;
  private status: LobbyGuestStatus = 'idle';

  constructor(i18n: I18n, roomId: string, actions: LobbyScreenActions) {
    this.i18n = i18n;
    this.roomId = roomId;
    this.actions = actions;
    this.spinner = h('div', { class: 'agil-lobby-spinner', attrs: { 'aria-hidden': 'true' } }, icon('user-check', 30));
    this.badgeEl = h('span', { class: 'agil-lobby-badge-dot', attrs: { 'aria-hidden': 'true' } });
    this.titleEl = h('h1', { class: 'agil-lobby-title', dataset: { agilLobbyTitle: '' }, attrs: { id: 'agil-lobby-title' } });
    this.roomEl = h('p', { class: 'agil-lobby-room', dataset: { agilLobbyRoom: '' } });
    this.messageEl = h('p', {
      class: 'agil-lobby-message',
      dataset: { agilLobbyStatus: '' },
      attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    this.timerEl = h('p', { class: 'agil-lobby-timer', dataset: { agilLobbyTimer: '' } });
    this.timerEl.hidden = true;
    this.hintEl = h('p', { class: 'agil-lobby-hint', dataset: { agilLobbyHint: '' } });

    this.cancelButton = h('button', {
      class: 'agil-btn agil-btn-ghost agil-lobby-cancel',
      text: i18n.t('lobbyCancel'),
      dataset: { agilAction: 'lobby-cancel' },
    });
    this.cancelButton.type = 'button';
    this.cancelButton.addEventListener('click', () => this.actions.onCancel());

    this.retryButton = h('button', {
      class: 'agil-btn agil-btn-primary agil-lobby-retry',
      text: i18n.t('lobbyRetry'),
      dataset: { agilAction: 'lobby-retry' },
    });
    this.retryButton.type = 'button';
    this.retryButton.addEventListener('click', () => this.actions.onRetry());

    this.backButton = h('button', {
      class: 'agil-btn agil-btn-ghost agil-lobby-back',
      text: i18n.t('lobbyBack'),
      dataset: { agilAction: 'lobby-back' },
    });
    this.backButton.type = 'button';
    this.backButton.addEventListener('click', () => this.actions.onBack());

    this.card = h(
      'div',
      {
        class: 'agil-lobby-card',
        dataset: { agilLobbyCard: '' },
        attrs: { role: 'region', 'aria-labelledby': 'agil-lobby-title', tabindex: '-1' },
      },
      h('div', { class: 'agil-lobby-head' }, this.spinner, this.badgeEl),
      this.titleEl,
      this.roomEl,
      this.messageEl,
      this.timerEl,
      h('div', { class: 'agil-lobby-actions' }, this.cancelButton, this.retryButton, this.backButton),
      this.hintEl,
    );
    this.element = h('div', { class: 'agil-lobby', dataset: { agilLobby: '', status: 'idle' } }, this.card);
    this.element.hidden = true;
    this.element.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (this.status === 'pending') this.actions.onCancel();
      else this.actions.onBack();
    });
  }

  private copy(status: LobbyGuestStatus, state: CallState): StatusCopy {
    const i18n = this.i18n;
    switch (status) {
      case 'pending': {
        const message = (state.lobby.waitingMessage ?? state.config.room.waitingMessage).trim();
        return {
          title: i18n.t('lobbyWaitTitle'),
          message: message && message !== DEFAULT_ROOM.waitingMessage ? message : i18n.t('lobbyWaitMessage'),
          hint: i18n.t('lobbyWaitHint'),
          pending: true,
          terminal: false,
        };
      }
      case 'admitted':
        return {
          title: i18n.t('lobbyAdmittedTitle'),
          message: i18n.t('lobbyAdmittedMessage'),
          hint: '',
          pending: false,
          terminal: false,
        };
      case 'rejected':
        return {
          title: i18n.t('lobbyRejectedTitle'),
          message: i18n.t('lobbyRejectedMessage'),
          hint: '',
          pending: false,
          terminal: true,
        };
      case 'expired':
        return {
          title: i18n.t('lobbyExpiredTitle'),
          message: i18n.t('lobbyExpiredMessage'),
          hint: '',
          pending: false,
          terminal: true,
        };
      case 'timeout':
        return {
          title: i18n.t('lobbyTimeoutTitle'),
          message: i18n.t('lobbyTimeoutMessage'),
          hint: '',
          pending: false,
          terminal: true,
        };
      case 'error':
        return {
          title: i18n.t('lobbyErrorTitle'),
          message: state.lobby.reason || i18n.t('lobbyErrorMessage'),
          hint: '',
          pending: false,
          terminal: true,
        };
      case 'cancelled':
        return {
          title: i18n.t('lobbyWaitTitle'),
          message: i18n.t('lobbyCancelled'),
          hint: '',
          pending: false,
          terminal: true,
        };
      default:
        return { title: '', message: '', hint: '', pending: false, terminal: false };
    }
  }

  update(state: CallState): void {
    const lobby = state.lobby;
    const status = lobby.status;
    this.status = status;
    const visible = state.phase === 'lobby' && status !== 'idle';
    this.element.hidden = !visible;
    if (!visible) return;

    const copy = this.copy(status, state);
    this.element.dataset.status = status;
    this.titleEl.textContent = copy.title;
    const configuredName = state.room?.name || state.config.room.name || '';
    // Before admission the server does not expose the real room name (admin key
    // required); fall back to the room id instead of a duplicated default label.
    const generic = !configuredName || configuredName === 'Комната' || configuredName === 'Room';
    const roomName = generic ? this.roomId : configuredName;
    const showId = !generic && Boolean(this.roomId) && this.roomId !== roomName;
    this.roomEl.textContent = roomName
      ? `${this.i18n.t('lobbyRoomLabel')}: ${roomName}${showId ? ` · ${this.roomId}` : ''}`
      : '';
    this.roomEl.hidden = !roomName;
    this.messageEl.textContent = copy.message;
    this.messageEl.dataset.status = status;
    this.hintEl.textContent = copy.hint;
    this.hintEl.hidden = !copy.hint;
    this.spinner.classList.toggle('is-pending', copy.pending);
    this.badgeEl.hidden = !copy.pending;
    this.cancelButton.hidden = !copy.pending;
    this.retryButton.hidden = copy.pending || !copy.terminal;
    this.backButton.hidden = copy.pending || !copy.terminal;

    if (copy.pending) {
      this.timerEl.hidden = false;
      const elapsed = formatDuration(lobby.elapsedSec);
      let line = this.i18n.t('lobbyWaitingFor', { time: elapsed });
      if (lobby.expiresAt) {
        const remainingSec = Math.max(0, Math.round((lobby.expiresAt - Date.now()) / 1000));
        line += ` · ${this.i18n.t('lobbyExpiresIn', { time: formatDuration(remainingSec) })}`;
      }
      this.timerEl.textContent = line;
    } else {
      this.timerEl.hidden = true;
      this.timerEl.textContent = '';
    }
  }

  focus(): void {
    this.card.focus();
  }

  destroy(): void {
    this.element.remove();
  }
}
