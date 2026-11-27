/**
 * Host/moderator breakout-rooms panel.
 *
 * Pure renderer of `state.breakout`: the controller in `index.ts` owns the
 * REST calls, the WS state and the room switch. The panel only collects the
 * start options (mode, groups and assignments, duration, allow-return), shows the
 * live countdown and the groups with participant names, and exposes
 * «Запустить» / «Закрыть все».
 *
 * The join token of a sub-room never reaches this module: the plan only lists
 * participant ids and names, which are rendered with textContent.
 */
import type { BreakoutPlan, BreakoutRoomInfo } from '@agil/protocol';
import { ApiError, isBreakoutFeatureUnavailable } from '../api.js';
import { formatDuration, h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';
import type { BreakoutState, CallState } from '../types.js';

export interface BreakoutStartOptions {
  mode: 'random' | 'manual';
  count: number;
  durationMin: number;
  allowReturn: boolean;
  assignments?: string[][];
}

export interface BreakoutPanelActions {
  onStart: (input: BreakoutStartOptions) => Promise<void>;
  onCloseAll: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onClosePanel: () => void;
  canManage: () => boolean;
}

/** Maps API failures/status codes to human-readable i18n copy. */
export function breakoutErrorText(
  i18n: I18n,
  error: unknown,
  context: 'manage' | 'return' = 'manage',
): string {
  if (isBreakoutFeatureUnavailable(error)) return i18n.t('breakoutUnavailable');
  const apiError = error instanceof ApiError ? error : null;
  if (!apiError) return i18n.t('breakoutErrorGeneric');
  switch (apiError.status) {
    case 401:
      return i18n.t('breakoutErrorUnauthorized');
    case 403:
      return context === 'return' ? i18n.t('breakoutReturnDisabled') : i18n.t('breakoutErrorForbidden');
    case 404:
    case 405:
    case 501:
      return i18n.t('breakoutUnavailable');
    case 409:
      if (apiError.code === 'breakout_active') return i18n.t('breakoutErrorActive');
      if (apiError.code === 'not_enough_participants') return i18n.t('breakoutErrorNotEnough');
      return i18n.t('breakoutErrorGeneric');
    default:
      if (apiError.code === 'breakout_active') return i18n.t('breakoutErrorActive');
      if (apiError.code === 'not_enough_participants') return i18n.t('breakoutErrorNotEnough');
      if (apiError.code === 'network_error' || apiError.code === 'timeout') return i18n.t('breakoutErrorNetwork');
      if (apiError.code === 'forbidden') return context === 'return' ? i18n.t('breakoutReturnDisabled') : i18n.t('breakoutErrorForbidden');
      if (apiError.code === 'unauthorized') return i18n.t('breakoutErrorUnauthorized');
      return i18n.t('breakoutErrorGeneric');
  }
}

const MIN_GROUPS = 2;
const MAX_GROUPS = 10;
const MIN_DURATION = 5;
const MAX_DURATION = 120;

export class BreakoutPanel {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly actions: BreakoutPanelActions;
  private readonly statusEl: HTMLDivElement;
  private readonly stateBadge: HTMLSpanElement;
  private readonly planEl: HTMLDivElement;
  private readonly timerRow: HTMLDivElement;
  private readonly timerEl: HTMLSpanElement;
  private readonly roomsEl: HTMLDivElement;
  private readonly inviteEl: HTMLParagraphElement;
  private readonly emptyEl: HTMLParagraphElement;
  private readonly unavailableEl: HTMLParagraphElement;
  private readonly form: HTMLFormElement;
  private readonly modeSelect: HTMLSelectElement;
  private readonly manualHint: HTMLParagraphElement;
  private readonly assignmentsList: HTMLDivElement;
  private readonly countSelect: HTMLSelectElement;
  private readonly durationInput: HTMLInputElement;
  private readonly allowReturnInput: HTMLInputElement;
  private readonly startButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly refreshButton: HTMLButtonElement;
  private signature = '';
  private assignmentsSignature = '';
  private state: CallState | null = null;
  private busy = false;

  constructor(i18n: I18n, actions: BreakoutPanelActions) {
    this.i18n = i18n;
    this.actions = actions;

    this.stateBadge = h('span', { class: 'agil-breakout-state', dataset: { agilBreakoutState: '' } });
    this.stateBadge.hidden = true;
    const closePanel = h('button', {
      class: 'agil-icon-btn',
      title: i18n.t('close'),
      dataset: { agilAction: 'breakout-close-panel' },
    });
    closePanel.type = 'button';
    closePanel.setAttribute('aria-label', i18n.t('close'));
    closePanel.appendChild(icon('close', 18));
    closePanel.addEventListener('click', () => actions.onClosePanel());

    this.refreshButton = h('button', {
      class: 'agil-icon-btn',
      title: i18n.t('lobbyRefresh'),
      dataset: { agilBreakoutRefresh: '' },
    });
    this.refreshButton.type = 'button';
    this.refreshButton.setAttribute('aria-label', i18n.t('lobbyRefresh'));
    this.refreshButton.appendChild(icon('refresh', 18));
    this.refreshButton.addEventListener('click', () => {
      void this.actions.onRefresh();
    });

    const header = h(
      'div',
      { class: 'agil-panel-header' },
      h('h2', { class: 'agil-panel-title' }, this.i18n.t('breakoutPanelTitle'), this.stateBadge),
      this.refreshButton,
      closePanel,
    );

    this.statusEl = h('div', {
      class: 'agil-panel-status',
      dataset: { agilBreakoutStatus: '' },
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    this.statusEl.hidden = true;

    this.timerEl = h('span', { class: 'agil-breakout-timer', dataset: { agilBreakoutTimer: '' }, attrs: { 'aria-live': 'off' } });
    this.timerRow = h(
      'div',
      { class: 'agil-breakout-timer-row' },
      h('span', { class: 'agil-breakout-timer-label', text: this.i18n.t('breakoutActive') }),
      this.timerEl,
    );
    this.roomsEl = h('div', { class: 'agil-breakout-rooms', dataset: { agilBreakoutRooms: '' }, attrs: { role: 'list' } });
    this.inviteEl = h('p', {
      class: 'agil-breakout-invite',
      text: this.i18n.t('breakoutInviteHint'),
      dataset: { agilBreakoutInvite: '' },
    });
    this.inviteEl.hidden = true;
    this.closeButton = h('button', {
      class: 'agil-btn agil-btn-danger agil-breakout-close-all',
      text: this.i18n.t('breakoutCloseAll'),
      dataset: { agilBreakoutClose: '' },
    });
    this.closeButton.type = 'button';
    this.closeButton.addEventListener('click', () => {
      void this.closeAll();
    });
    this.planEl = h(
      'div',
      { class: 'agil-breakout-plan', dataset: { agilBreakoutActive: '' } },
      this.timerRow,
      this.roomsEl,
      this.inviteEl,
      h('div', { class: 'agil-breakout-plan-actions' }, this.closeButton),
    );
    this.planEl.hidden = true;

    this.emptyEl = h('p', {
      class: 'agil-panel-empty agil-breakout-empty',
      text: this.i18n.t('breakoutNoPlan'),
      dataset: { agilBreakoutEmpty: '' },
    });
    this.unavailableEl = h('p', {
      class: 'agil-panel-empty agil-warning agil-breakout-unavailable',
      text: this.i18n.t('breakoutUnavailable'),
      dataset: { agilBreakoutUnavailable: '' },
    });
    this.unavailableEl.hidden = true;

    /* ---- start form ---- */
    this.modeSelect = h('select', { class: 'agil-video-select', dataset: { agilBreakoutMode: '' } });
    this.modeSelect.appendChild(h('option', { text: this.i18n.t('breakoutModeRandom'), attrs: { value: 'random' } }));
    this.modeSelect.appendChild(h('option', { text: this.i18n.t('breakoutModeManual'), attrs: { value: 'manual' } }));
    this.modeSelect.value = 'random';

    this.manualHint = h('p', {
      class: 'agil-breakout-hint agil-breakout-manual-hint',
      text: this.i18n.t('breakoutManualHint'),
      dataset: { agilBreakoutManualHint: '' },
    });
    this.manualHint.hidden = true;
    this.assignmentsList = h('div', { class: 'agil-breakout-assignments', dataset: { agilBreakoutAssignments: '' } });
    this.assignmentsList.hidden = true;

    this.countSelect = h('select', { class: 'agil-video-select', dataset: { agilBreakoutCount: '' } });
    for (let count = MIN_GROUPS; count <= MAX_GROUPS; count += 1) {
      this.countSelect.appendChild(h('option', { text: String(count), attrs: { value: String(count) } }));
    }
    this.countSelect.value = String(MIN_GROUPS);

    this.durationInput = h('input', {
      class: 'agil-input',
      attrs: {
        type: 'number',
        min: String(MIN_DURATION),
        max: String(MAX_DURATION),
        step: '5',
        inputmode: 'numeric',
        'aria-label': this.i18n.t('breakoutDuration'),
      },
      dataset: { agilBreakoutDuration: '' },
    });
    this.durationInput.value = '15';

    this.allowReturnInput = h('input', { attrs: { type: 'checkbox' }, dataset: { agilBreakoutAllowReturn: '' } });
    this.allowReturnInput.checked = true;

    this.startButton = h('button', {
      class: 'agil-btn agil-btn-primary agil-breakout-start',
      text: this.i18n.t('breakoutStart'),
      dataset: { agilBreakoutStart: '' },
    });
    this.startButton.type = 'submit';

    this.form = h(
      'form',
      { class: 'agil-breakout-form', dataset: { agilBreakoutForm: '' } },
      h('label', { class: 'agil-field-label' }, h('span', { text: this.i18n.t('breakoutMode') }), this.modeSelect),
      this.manualHint,
      h('label', { class: 'agil-field-label' }, h('span', { text: this.i18n.t('breakoutGroups') }), this.countSelect),
      this.assignmentsList,
      h(
        'label',
        { class: 'agil-field-label' },
        h('span', { text: this.i18n.t('breakoutDuration') }),
        this.durationInput,
      ),
      h('label', { class: 'agil-check' }, this.allowReturnInput, h('span', { text: this.i18n.t('breakoutAllowReturn') })),
      this.startButton,
    );
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.start();
    });
    this.modeSelect.addEventListener('change', () => this.renderAssignments());
    this.countSelect.addEventListener('change', () => this.renderAssignments());

    this.element = h(
      'section',
      {
        class: 'agil-panel agil-breakout-panel',
        dataset: { agilBreakoutPanel: '' },
        attrs: { 'aria-label': this.i18n.t('breakoutPanelTitle') },
      },
      header,
      h(
        'div',
        { class: 'agil-breakout-body' },
        this.statusEl,
        this.unavailableEl,
        this.planEl,
        this.emptyEl,
        this.form,
        h('p', { class: 'agil-breakout-hint agil-breakout-panel-hint', text: this.i18n.t('breakoutPanelHint') }),
      ),
    );
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.actions.onClosePanel();
      }
    });
  }

  update(state: CallState): void {
    this.state = state;
    const breakout: BreakoutState = state.breakout;
    const active = breakout.plan?.status === 'active';
    const canManage = this.actions.canManage();

    this.stateBadge.hidden = !breakout.plan;
    if (breakout.plan) {
      this.stateBadge.textContent = active ? this.i18n.t('breakoutActive') : this.i18n.t('breakoutClosed');
      this.stateBadge.dataset.status = breakout.plan.status;
    }

    /* status line: loading → error → hidden */
    if (breakout.loading) {
      this.setStatus(this.i18n.t('loading'), false);
    } else if (breakout.error) {
      this.setStatus(breakout.error, true);
    } else {
      this.setStatus('', false);
    }

    this.unavailableEl.hidden = !breakout.unavailable;
    this.form.hidden = breakout.unavailable;
    this.emptyEl.hidden = Boolean(breakout.plan) || breakout.unavailable;
    this.planEl.hidden = !breakout.plan;

    if (active) {
      this.timerRow.hidden = false;
      this.timerEl.hidden = false;
      this.timerEl.textContent = breakout.plan?.endsAt
        ? this.i18n.t('breakoutEndsIn', { time: formatDuration(breakout.remainingSec) })
        : '';
      this.closeButton.hidden = !canManage;
      this.closeButton.disabled = breakout.busy;
      this.inviteEl.hidden = false;
    } else {
      this.timerRow.hidden = true;
      this.timerEl.hidden = true;
      this.timerEl.textContent = '';
      this.closeButton.hidden = true;
      this.inviteEl.hidden = true;
    }

    const busy = breakout.busy || this.busy;
    this.startButton.disabled = busy || active || breakout.unavailable;
    this.startButton.textContent = busy && !active ? this.i18n.t('breakoutStarting') : this.i18n.t('breakoutStart');
    this.closeButton.textContent = busy ? this.i18n.t('breakoutClosing') : this.i18n.t('breakoutCloseAll');
    this.form.dataset.disabled = String(active || busy || breakout.unavailable);
    this.renderAssignments();

    if (breakout.plan) {
      const signature = this.planSignature(breakout.plan, state);
      if (signature !== this.signature) {
        this.signature = signature;
        this.renderRooms(breakout.plan, state);
      }
    } else {
      this.signature = '';
      this.roomsEl.replaceChildren();
    }
  }

  private renderAssignments(): void {
    const manual = this.modeSelect.value === 'manual' && this.state?.breakout.plan?.status !== 'active';
    this.manualHint.hidden = !manual;
    this.assignmentsList.hidden = !manual;
    if (!manual || !this.state) return;
    const { self, participants } = this.state;
    const members = [...(self ? [self] : []), ...participants];
    const count = Number(this.countSelect.value);
    const signature = JSON.stringify([count, members.map(({ id, name }) => [id, name])]);
    if (signature === this.assignmentsSignature) return;
    this.assignmentsSignature = signature;

    const oldSelections = Array.from(this.assignmentsList.querySelectorAll<HTMLSelectElement>('select'));
    const previous = new Map(oldSelections.map((select) => [select.dataset.agilBreakoutAssignment, Number(select.value)]));
    const focused = oldSelections.find((select) => select === this.assignmentsList.ownerDocument.activeElement);
    this.assignmentsList.replaceChildren();
    for (const { id, name } of members) {
      const select = h('select', { class: 'agil-video-select', dataset: { agilBreakoutAssignment: id } });
      select.appendChild(h('option', { text: this.i18n.t('breakoutAssignAutomatically'), attrs: { value: '' } }));
      for (let index = 1; index <= count; index += 1) {
        select.appendChild(h('option', { text: this.i18n.t('breakoutGroup', { n: index }), attrs: { value: String(index) } }));
      }
      const group = previous.get(id) ?? 0;
      if (group > 0 && group <= count) select.value = String(group);
      this.assignmentsList.appendChild(h('label', { class: 'agil-field-label' }, h('span', { text: name }), select));
      if (focused?.dataset.agilBreakoutAssignment === id) select.focus({ preventScroll: true });
    }
  }

  private planSignature(plan: BreakoutPlan, state: CallState): string {
    const assignment = state.breakout.assignment?.breakoutRoomId ?? '';
    const rooms = plan.rooms
      .map((room) => `${room.id}:${room.index}:${room.name}:${room.status}:${room.participantIds.join(',')}`)
      .join('|');
    const names = plan.rooms
      .flatMap((room) => room.participantIds)
      .map((id) => `${id}:${this.nameFor(id, state)}`)
      .join('|');
    return `${plan.id}|${plan.status}|${plan.allowReturn}|${assignment}|${rooms}|${names}`;
  }

  private renderRooms(plan: BreakoutPlan, state: CallState): void {
    this.roomsEl.replaceChildren();
    for (const room of plan.rooms) this.roomsEl.appendChild(this.renderRoom(room, state));
  }

  private renderRoom(room: BreakoutRoomInfo, state: CallState): HTMLElement {
    const own = state.breakout.assignment?.breakoutRoomId === room.id;
    const names = room.participantIds.map((id) => this.nameFor(id, state));
    const name = room.name || this.i18n.t('breakoutGroup', { n: room.index + 1 });
    return h(
      'div',
      {
        class: `agil-breakout-group${own ? ' is-own' : ''}`,
        dataset: {
          agilBreakoutRoom: room.id,
          agilBreakoutRoomIndex: String(room.index + 1),
          agilBreakoutRoomStatus: room.status,
        },
        attrs: { role: 'listitem' },
      },
      h(
        'div',
        { class: 'agil-breakout-group-head' },
        h('span', { class: 'agil-breakout-group-name', text: name }),
        h('span', { class: 'agil-breakout-group-count', text: this.i18n.t('breakoutGroupMeta', { n: room.participantIds.length }) }),
        own ? h('span', { class: 'agil-breakout-own', text: this.i18n.t('breakoutYourGroup') }) : null,
      ),
      h('div', {
        class: 'agil-breakout-group-names',
        text: names.length > 0 ? names.join(', ') : this.i18n.t('breakoutNoParticipants'),
        dataset: { agilBreakoutParticipant: room.participantIds.join(',') },
      }),
    );
  }

  private nameFor(participantId: string, state: CallState): string {
    const cached = state.breakout.names[participantId];
    if (cached) return cached;
    if (state.self?.id === participantId) return state.self.name;
    return state.participants.find((participant) => participant.id === participantId)?.name ?? this.i18n.t('participant');
  }

  private setStatus(text: string, error: boolean): void {
    this.statusEl.hidden = text === '';
    this.statusEl.textContent = text;
    this.statusEl.dataset.kind = error ? 'error' : 'info';
  }

  private readOptions(): BreakoutStartOptions {
    const mode = this.modeSelect.value === 'manual' ? 'manual' : 'random';
    const count = Math.max(MIN_GROUPS, Math.min(MAX_GROUPS, Number(this.countSelect.value) || MIN_GROUPS));
    const rawDuration = Number(this.durationInput.value) || 15;
    const durationMin = Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.round(rawDuration)));
    this.durationInput.value = String(durationMin);
    const options: BreakoutStartOptions = { mode, count, durationMin, allowReturn: this.allowReturnInput.checked };
    if (mode === 'manual') {
      options.assignments = Array.from({ length: count }, () => []);
      for (const select of this.assignmentsList.querySelectorAll<HTMLSelectElement>('select')) {
        const id = select.dataset.agilBreakoutAssignment;
        if (id && select.value) options.assignments[Number(select.value) - 1]?.push(id);
      }
    }
    return options;
  }

  private async start(): Promise<void> {
    if (this.busy || this.startButton.disabled) return;
    const options = this.readOptions();
    this.busy = true;
    this.startButton.disabled = true;
    this.statusEl.hidden = true;
    try {
      await this.actions.onStart(options);
    } catch (error) {
      this.setStatus(breakoutErrorText(this.i18n, error), true);
    } finally {
      this.busy = false;
      if (this.state) this.update(this.state);
    }
  }

  private async closeAll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.closeButton.disabled = true;
    try {
      await this.actions.onCloseAll();
    } catch (error) {
      this.setStatus(breakoutErrorText(this.i18n, error), true);
    } finally {
      this.busy = false;
      if (this.state) this.update(this.state);
    }
  }

  focus(): void {
    this.statusEl.hidden = true;
    (this.element.querySelector<HTMLElement>('[data-agil-breakout-mode]') as HTMLElement | null)?.focus();
  }

  isOpen(): boolean {
    return !this.element.hidden;
  }

  destroy(): void {
    this.element.remove();
  }
}
