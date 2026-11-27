/**
 * Host/moderator waiting-room panel.
 *
 * Lists pending lobby requests with name, country, waiting time and TTL, and
 * exposes admit / reject / admit-all. The panel is a pure renderer of
 * `state.lobbyQueue`; the controller feeds it from WS `lobby.*` events and a
 * 5 s polling fallback while the panel is open.
 *
 * Every string goes through textContent (request names are untrusted input),
 * and the admitted guest's token never reaches this module.
 */
import type { LobbyRequestInfo } from '@agil/protocol';
import { ApiError } from '../api.js';
import { formatDuration, h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';
import type { CallState } from '../types.js';

export interface LobbyPanelActions {
  onAdmit: (requestId: string) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
  onAdmitAll: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}

/** Maps API failures/status codes to human-readable i18n copy (401/403/409/404). */
export function lobbyErrorText(i18n: I18n, error: unknown): string {
  const apiError = error instanceof ApiError ? error : null;
  if (!apiError) return i18n.t('lobbyErrorGeneric');
  switch (apiError.status) {
    case 401:
      return i18n.t('lobbyErrorUnauthorized');
    case 403:
      return i18n.t('lobbyErrorForbidden');
    case 404:
      return i18n.t('lobbyErrorGone');
    case 409:
      return i18n.t('lobbyErrorConflict');
    default:
      if (apiError.code === 'room_full') return i18n.t('lobbyErrorConflict');
      if (apiError.code === 'not_found') return i18n.t('lobbyErrorGone');
      if (apiError.code === 'forbidden') return i18n.t('lobbyErrorForbidden');
      if (apiError.code === 'unauthorized') return i18n.t('lobbyErrorUnauthorized');
      return i18n.t('lobbyErrorGeneric');
  }
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join('');
}

export class LobbyPanel {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly actions: LobbyPanelActions;
  private readonly list: HTMLDivElement;
  private readonly countEl: HTMLSpanElement;
  private readonly statusEl: HTMLDivElement;
  private readonly admitAllButton: HTMLButtonElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly emptyEl: HTMLParagraphElement;
  private readonly rowElements = new Map<string, HTMLElement>();
  private queue: LobbyRequestInfo[] = [];
  private signature = '';
  private busy = false;

  constructor(i18n: I18n, actions: LobbyPanelActions) {
    this.i18n = i18n;
    this.actions = actions;
    this.countEl = h('span', { class: 'agil-pill agil-lobby-count', dataset: { agilLobbyCount: '' } });
    const close = h('button', { class: 'agil-icon-btn', title: i18n.t('close'), dataset: { agilAction: 'lobby-close' } });
    close.type = 'button';
    close.setAttribute('aria-label', i18n.t('close'));
    close.appendChild(icon('close', 18));
    close.addEventListener('click', () => actions.onClose());
    this.refreshButton = h('button', {
      class: 'agil-icon-btn',
      title: i18n.t('lobbyRefresh'),
      dataset: { agilAction: 'lobby-refresh' },
    });
    this.refreshButton.type = 'button';
    this.refreshButton.setAttribute('aria-label', i18n.t('lobbyRefresh'));
    this.refreshButton.appendChild(icon('refresh', 18));
    this.refreshButton.addEventListener('click', () => {
      void this.run(() => this.actions.onRefresh(), '');
    });
    const header = h(
      'div',
      { class: 'agil-panel-header' },
      h('h2', { class: 'agil-panel-title' }, this.i18n.t('lobbyPanelTitle'), this.countEl),
      this.refreshButton,
      close,
    );
    this.admitAllButton = h('button', {
      class: 'agil-btn agil-btn-primary agil-lobby-admit-all',
      text: i18n.t('lobbyAdmitAll'),
      dataset: { agilLobbyAdmitAll: '' },
    });
    this.admitAllButton.type = 'button';
    this.admitAllButton.addEventListener('click', () => {
      // The controller reports the exact admitted count with a toast.
      void this.run(() => this.actions.onAdmitAll(), '');
    });
    this.statusEl = h('div', { class: 'agil-lobby-panel-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.statusEl.hidden = true;
    this.emptyEl = h('p', { class: 'agil-panel-empty agil-lobby-empty', text: i18n.t('lobbyEmpty') });
    this.list = h('div', { class: 'agil-lobby-list', attrs: { role: 'list', 'aria-live': 'polite' } });
    const body = h(
      'div',
      { class: 'agil-lobby-body' },
      this.statusEl,
      this.emptyEl,
      this.list,
      h('div', { class: 'agil-lobby-panel-actions' }, this.admitAllButton),
      h('p', { class: 'agil-lobby-panel-hint', text: i18n.t('lobbyPanelHint') }),
    );
    this.element = h(
      'section',
      {
        class: 'agil-panel agil-lobby-panel',
        dataset: { agilLobbyPanel: '' },
        attrs: { 'aria-label': i18n.t('lobbyPanelTitle') },
      },
      header,
      body,
    );
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.actions.onClose();
      }
    });
  }

  update(state: CallState): void {
    this.queue = state.lobbyQueue;
    const count = this.queue.length;
    this.countEl.textContent = String(count);
    this.countEl.dataset.count = String(count);
    this.countEl.hidden = count === 0;
    this.admitAllButton.hidden = count === 0;
    this.admitAllButton.disabled = this.busy || count === 0;
    this.emptyEl.hidden = count > 0;
    const signature = this.queue.map((request) => `${request.id}:${request.createdAt}:${request.expiresAt}`).join('|');
    if (signature !== this.signature) {
      this.signature = signature;
      this.renderList();
    }
    this.syncBusy();
    this.refreshTimers();
  }

  private renderList(): void {
    this.list.replaceChildren();
    this.rowElements.clear();
    for (const request of this.queue) {
      const row = this.renderRow(request);
      this.rowElements.set(request.id, row);
      this.list.appendChild(row);
    }
  }

  private renderRow(request: LobbyRequestInfo): HTMLElement {
    const country = request.country ? request.country.toUpperCase() : this.i18n.t('lobbyCountryUnknown');
    const admit = h('button', {
      class: 'agil-btn agil-btn-primary agil-lobby-row-admit',
      text: this.i18n.t('lobbyAdmit'),
      dataset: { agilLobbyAdmit: request.id },
    });
    admit.type = 'button';
    admit.addEventListener('click', () => {
      void this.run(() => this.actions.onAdmit(request.id), this.i18n.t('lobbyAdmittedToast', { name: request.name }));
    });
    const reject = h('button', {
      class: 'agil-btn agil-btn-ghost agil-lobby-row-reject',
      text: this.i18n.t('lobbyReject'),
      dataset: { agilLobbyReject: request.id },
    });
    reject.type = 'button';
    reject.addEventListener('click', () => {
      void this.run(() => this.actions.onReject(request.id), this.i18n.t('lobbyRejectedToast', { name: request.name }));
    });
    const waiting = h('span', {
      class: 'agil-lobby-waiting',
      dataset: { agilLobbyWaiting: '', created: String(request.createdAt) },
    });
    const ttl = h('span', {
      class: 'agil-lobby-ttl',
      dataset: { agilLobbyTtl: '', expires: String(request.expiresAt) },
    });
    return h(
      'div',
      {
        class: 'agil-lobby-row',
        dataset: { agilLobbyRequest: request.id },
        attrs: { role: 'listitem' },
      },
      h('span', { class: 'agil-avatar-small agil-lobby-avatar', text: initials(request.name) || '?' }),
      h(
        'div',
        { class: 'agil-lobby-row-info' },
        h('div', { class: 'agil-lobby-row-name', text: request.name }),
        h(
          'div',
          { class: 'agil-lobby-row-meta' },
          h('span', { class: 'agil-lobby-country', text: country }),
          waiting,
          ttl,
        ),
      ),
      h('div', { class: 'agil-lobby-row-actions' }, admit, reject),
    );
  }

  private refreshTimers(): void {
    const now = Date.now();
    for (const row of this.rowElements.values()) {
      const waiting = row.querySelector<HTMLElement>('[data-agil-lobby-waiting]');
      if (waiting) {
        const created = Number(waiting.dataset.created ?? '0');
        const elapsed = Math.max(0, Math.floor((now - created) / 1000));
        waiting.textContent = this.i18n.t('lobbyWaitingForShort', { time: formatDuration(elapsed) });
      }
      const ttl = row.querySelector<HTMLElement>('[data-agil-lobby-ttl]');
      if (ttl) {
        const expires = Number(ttl.dataset.expires ?? '0');
        const remaining = Math.floor((expires - now) / 1000);
        const expired = remaining <= 0;
        ttl.textContent = expired ? this.i18n.t('lobbyTtlExpired') : this.i18n.t('lobbyTtl', { time: formatDuration(remaining) });
        ttl.classList.toggle('is-expired', expired);
      }
    }
  }

  private syncBusy(): void {
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('button')) {
      if (button === this.refreshButton) continue;
      button.disabled = this.busy;
    }
  }

  private async run(work: () => Promise<void>, successText: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.syncBusy();
    this.setStatus('', false);
    try {
      await work();
      if (successText) this.setStatus(successText, false);
    } catch (error) {
      this.setStatus(lobbyErrorText(this.i18n, error), true);
    } finally {
      this.busy = false;
      this.syncBusy();
    }
  }

  private setStatus(text: string, error: boolean): void {
    this.statusEl.hidden = text === '';
    this.statusEl.textContent = text;
    this.statusEl.dataset.kind = error ? 'error' : 'success';
  }

  focus(): void {
    // A reopening panel must not show a stale result from the previous session.
    this.setStatus('', false);
    const first = this.element.querySelector<HTMLElement>('[data-agil-lobby-admit], [data-agil-lobby-admit-all]');
    (first ?? this.element.querySelector<HTMLElement>('button'))?.focus();
  }

  destroy(): void {
    this.element.remove();
  }
}
