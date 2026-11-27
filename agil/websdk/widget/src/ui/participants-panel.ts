/** Participants panel: search, presence, roles, countries, mic/cam/hand, integrity. */
import type { Participant } from '@agil/protocol';
import { formatParticipantCount } from '../call/large-room.js';
import { h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';
import type { CallState } from '../types.js';

export interface ParticipantsPanelActions {
  onClose: () => void;
  /** Jump to a participant: pin it and open its gallery page. */
  onLocate?: (participantId: string) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return `${(parts[0] ?? '').slice(0, 1)}${(parts[1] ?? '').slice(0, 1)}`.toUpperCase();
}

export class ParticipantsPanel {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly actions: ParticipantsPanelActions;
  private readonly list: HTMLDivElement;
  private readonly countEl: HTMLSpanElement;
  private readonly search: HTMLInputElement;
  private readonly emptyEl: HTMLDivElement;
  private query = '';
  private listSignature = '';

  constructor(i18n: I18n, actions: ParticipantsPanelActions) {
    this.i18n = i18n;
    this.actions = actions;
    this.list = h('div', { class: 'agil-participants-list', role: 'list' });
    this.countEl = h('span', { class: 'agil-pill', dataset: { agilParticipantsCount: '' } });
    this.search = h('input', {
      class: 'agil-input agil-participants-search',
      attrs: {
        type: 'search',
        placeholder: i18n.t('participantsSearch'),
        'aria-label': i18n.t('participantsSearch'),
        autocomplete: 'off',
      },
      dataset: { agilParticipantsSearch: '' },
    });
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase();
      this.listSignature = '';
      this.renderList();
    });
    this.emptyEl = h('div', { class: 'agil-participants-empty', text: i18n.t('participantsNoResults') });
    this.emptyEl.hidden = true;
    const close = h('button', { class: 'agil-icon-btn', title: i18n.t('close') });
    close.type = 'button';
    close.setAttribute('aria-label', i18n.t('close'));
    close.appendChild(icon('close', 18));
    close.addEventListener('click', () => actions.onClose());
    const header = h(
      'div',
      { class: 'agil-panel-header' },
      h('h2', { class: 'agil-panel-title' }, this.i18n.t('participantsTitle'), this.countEl),
      close,
    );
    this.element = h(
      'section',
      { class: 'agil-panel agil-participants-panel', attrs: { 'aria-label': i18n.t('participantsTitle') } },
      header,
      h('div', { class: 'agil-participants-search-row' }, this.search),
      this.list,
      this.emptyEl,
    );
    this.element.dataset.participantsTotal = '0';
  }

  update(state: CallState, speaking: ReadonlySet<string> = new Set()): void {
    this.state = state;
    this.speaking = speaking;
    const total = state.participants.length + (state.self ? 1 : 0);
    this.countEl.textContent = formatParticipantCount(total);
    this.countEl.dataset.count = String(total);
    this.element.dataset.participantsTotal = String(total);
    // The store emits on every timer/quality tick; rebuilding 200 rows each
    // second is wasteful and would drop focus in the search input. Re-render
    // only when something the list actually displays changed.
    const signature = [
      this.query,
      total,
      state.self?.name ?? '',
      state.settings.micEnabled ? '1' : '0',
      state.settings.camEnabled ? '1' : '0',
      state.settings.handRaised ? '1' : '0',
      state.participants
        .map(
          (participant) =>
            `${participant.id}|${participant.name}|${participant.role}|${participant.state.mic}|${participant.state.cam}|${participant.state.handRaised}|${participant.integrity}|${participant.presence ?? 'online'}|${participant.country ?? ''}|${participant.verified ? 1 : 0}|${participant.location?.city ?? ''}`,
        )
        .join(','),
      [...speaking].sort().join(','),
    ].join('~');
    if (signature === this.listSignature) return;
    this.listSignature = signature;
    this.renderList();
  }

  private state: CallState | null = null;
  private speaking: ReadonlySet<string> = new Set();

  private matches(participant: Participant | null, state: CallState): boolean {
    if (!this.query) return true;
    if (!participant) return false;
    const role = participant.role;
    const haystack = [
      participant.name,
      role,
      participant.country ?? '',
      state.integrity[participant.id]?.status ?? participant.integrity,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(this.query);
  }

  private renderList(): void {
    const state = this.state;
    if (!state) return;
    const speaking = this.speaking;
    this.list.replaceChildren();
    let shown = 0;
    if (state.self && this.matches(state.self, state)) {
      this.list.appendChild(this.renderRow(state.self, state, true, speaking));
      shown += 1;
    }
    for (const participant of state.participants) {
      if (!this.matches(participant, state)) continue;
      this.list.appendChild(this.renderRow(participant, state, false, speaking));
      shown += 1;
    }
    this.emptyEl.hidden = shown > 0;
    this.element.dataset.participantsShown = String(shown);
  }

  private renderRow(participant: Participant, state: CallState, isSelf: boolean, speaking: ReadonlySet<string>): HTMLElement {
    const isSelfActive = isSelf;
    const mic = isSelfActive ? state.settings.micEnabled : participant.state.mic === 'on';
    const cam = isSelfActive ? state.settings.camEnabled : participant.state.cam === 'on';
    const integrity = state.integrity[participant.id]?.status ?? participant.integrity;
    const reconnecting = !isSelf && participant.presence === 'reconnecting';
    const status = h('div', { class: 'agil-participant-status' });
    status.appendChild(
      this.statusIcon(mic ? 'mic' : 'mic-off', mic ? this.i18n.t('micOn') : this.i18n.t('micMuted'), !mic),
    );
    status.appendChild(
      this.statusIcon(cam ? 'camera' : 'camera-off', cam ? this.i18n.t('cameraOn') : this.i18n.t('camOff'), !cam),
    );
    if (participant.state.handRaised) {
      status.appendChild(this.statusIcon('hand', this.i18n.t('handIsRaised'), false, 'is-hand'));
    }
    const badges = h('div', { class: 'agil-participant-badges' });
    if (reconnecting) {
      // Peers see the same `presence: reconnecting` frame the server broadcasts
      // during the resume-grace lease (docs/call-continuity.md §6.2).
      const presence = h('span', {
        class: 'agil-badge agil-badge-warning agil-presence-badge',
        title: this.i18n.t('presenceReconnecting'),
        text: this.i18n.t('presenceReconnecting'),
        dataset: { agilPresence: 'reconnecting' },
      });
      presence.appendChild(icon('refresh', 12));
      badges.appendChild(presence);
    }
    if (participant.verified) badges.appendChild(this.badge('user-check', this.i18n.t('verified')));
    if (integrity === 'suspicious') badges.appendChild(this.badge('warning', this.i18n.t('integritySuspicious')));
    const privileged = state.self?.role === 'host' || state.self?.role === 'moderator';
    const location = participant.location;
    const country = location?.country ?? participant.country;
    if (country) badges.appendChild(h('span', { class: 'agil-country', text: country }));
    if (privileged && location) {
      if (location.city) badges.appendChild(h('span', { class: 'agil-country', text: location.city, title: this.i18n.t('locationTitle') }));
      if (location.source === 'gps') badges.appendChild(h('span', { class: 'agil-badge agil-badge-info', text: this.i18n.t('locationGps') }));
      if (location.vpnSuspected) badges.appendChild(h('span', { class: 'agil-badge agil-badge-warning', text: this.i18n.t('locationVpn') }));
    }

    const roleText =
      participant.role === 'host'
        ? this.i18n.t('roleHost')
        : participant.role === 'moderator'
          ? this.i18n.t('roleModerator')
          : this.i18n.t('roleGuest');
    const locate = isSelf
      ? null
      : h('button', {
          class: 'agil-icon-btn agil-participant-locate',
          title: this.i18n.t('participantsLocate'),
          dataset: { agilParticipantLocate: participant.id },
          attrs: { 'aria-label': this.i18n.t('participantsLocate') },
        });
    if (locate) {
      locate.type = 'button';
      locate.appendChild(icon('chevron-right', 16));
      locate.addEventListener('click', (event) => {
        event.stopPropagation();
        this.actions.onLocate?.(participant.id);
      });
    }
    const row = h(
      'div',
      {
        class: `agil-participant-row${speaking.has(participant.id) ? ' is-speaking' : ''}${isSelf ? '' : ' is-locatable'}${reconnecting ? ' is-reconnecting' : ''}`,
        dataset: {
          participantId: participant.id,
          presence: participant.presence ?? 'online',
        },
        attrs: { role: 'listitem' },
      },
      h('span', { class: 'agil-avatar-small', text: initials(participant.name) }),
      h(
        'div',
        { class: 'agil-participant-info' },
        h(
          'div',
          { class: 'agil-participant-name-row' },
          h('span', { class: 'agil-participant-name', text: participant.name + (isSelf ? ` (${this.i18n.t('you')})` : '') }),
          h('span', { class: 'agil-role-tag', dataset: { role: participant.role }, text: roleText }),
        ),
        h('div', { class: 'agil-participant-status-row' }, status, badges),
      ),
      ...(locate ? [locate] : []),
    );
    return row;
  }

  private statusIcon(iconName: Parameters<typeof icon>[0], label: string, off = false, className = ''): HTMLSpanElement {
    const span = h('span', { class: `agil-status-icon${off ? ' is-off' : ''}${className ? ` ${className}` : ''}`, title: label });
    span.setAttribute('aria-label', label);
    span.appendChild(icon(iconName, 16));
    return span;
  }

  private badge(iconName: Parameters<typeof icon>[0], label: string): HTMLSpanElement {
    const span = h('span', { class: 'agil-badge agil-badge-muted', title: label });
    span.appendChild(icon(iconName, 16));
    return span;
  }

  destroy(): void {
    this.element.remove();
  }
}
