/**
 * In-call polls/Q&A panel (protocol: RoomPoll, WS `poll.updated`).
 * Guest can vote; host/moderator can create and close polls. All text uses
 * textContent; results are announced via aria-live.
 */
import { h } from '../dom.js';
import type { I18n } from '../i18n.js';
import type { AgilPoll, AgilPollOption } from '../types.js';

export type PollOption = AgilPollOption;
export type PollView = AgilPoll;
export interface PollsActions {
  list: () => Promise<PollView[]>;
  create: (input: { question: string; options: string[]; multiple: boolean; anonymous: boolean; kind: 'poll' | 'qna' }) => Promise<PollView>;
  vote: (pollId: string, optionIds: string[]) => Promise<PollView>;
  close: (pollId: string) => Promise<PollView>;
  canManage: () => boolean;
}

function mergePoll(current: PollView, update: PollView): PollView {
  // Votes only increase and a closed poll cannot reopen.
  const newest = current.votes > update.votes || (current.status === 'closed' && update.status === 'active')
    ? current : update;
  const myVotes = update.myVotes?.length ? update.myVotes : current.myVotes ?? update.myVotes;
  return myVotes ? { ...newest, myVotes } : newest;
}

export class PollsPanel {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly actions: PollsActions;
  private polls: PollView[] = [];
  private busy = false;
  private readonly list: HTMLDivElement;
  private readonly form: HTMLFormElement;
  private readonly status: HTMLDivElement;
  private openFlag = false;
  private returnFocus: HTMLElement | null = null;
  private refreshUpdates: Set<string> | null = null;

  constructor(root: HTMLElement, i18n: I18n, actions: PollsActions) {
    this.i18n = i18n;
    this.actions = actions;
    this.list = h('div', { class: 'agil-polls-list', attrs: { 'aria-live': 'polite' } });
    this.status = h('div', { class: 'agil-polls-status', attrs: { role: 'status' } });
    this.form = this.buildForm();
    this.form.hidden = true;
    const close = h('button', { class: 'agil-icon-btn agil-polls-close', title: i18n.t('close'), attrs: { 'aria-label': i18n.t('close') } });
    close.type = 'button';
    close.textContent = '×';
    close.addEventListener('click', () => this.close());
    const card = h(
      'section',
      { class: 'agil-polls-card', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': i18n.t('pollsTitle') } },
      h('div', { class: 'agil-polls-head' }, h('h2', { class: 'agil-panel-title', text: i18n.t('pollsTitle') }), close),
      this.status,
      this.list,
      this.form,
    );
    this.element = h('div', { class: 'agil-polls-overlay' }, card);
    this.element.hidden = true;
    this.element.addEventListener('click', (event) => {
      if (event.target === this.element) this.close();
    });
    this.element.addEventListener('keydown', (event) => this.handleKeyDown(event));
    root.appendChild(this.element);
  }

  private buildForm(): HTMLFormElement {
    const i18n = this.i18n;
    const question = h('input', { class: 'agil-input', attrs: { maxlength: '500', placeholder: i18n.t('pollQuestion'), 'aria-label': i18n.t('pollQuestion') } });
    const options = h('textarea', { class: 'agil-input', attrs: { rows: '3', maxlength: '1200', placeholder: i18n.t('pollOptionsHint'), 'aria-label': i18n.t('pollOptionsHint') } });
    const multiple = h('input', { attrs: { type: 'checkbox' } });
    const kind = h('select', { class: 'agil-video-select' });
    kind.appendChild(h('option', { text: i18n.t('pollKindPoll'), attrs: { value: 'poll' } }));
    kind.appendChild(h('option', { text: i18n.t('pollKindQna'), attrs: { value: 'qna' } }));
    const submit = h('button', { class: 'agil-btn agil-btn-primary', text: i18n.t('pollCreate') });
    submit.type = 'submit';
    const form = h(
      'form',
      { class: 'agil-polls-form' },
      h('label', { class: 'agil-field' }, h('span', { class: 'agil-field-label', text: i18n.t('pollQuestion') }), question),
      h('label', { class: 'agil-field' }, h('span', { class: 'agil-field-label', text: i18n.t('pollOptions') }), options),
      h('label', { class: 'agil-check' }, multiple, h('span', { text: i18n.t('pollMultiple') })),
      h('label', { class: 'agil-field-label' }, h('span', { text: i18n.t('pollKind') }), kind),
      h('p', { class: 'agil-chat-meta', text: i18n.t('pollResultsScope') }),
      submit,
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.busy) return;
      const texts = options.value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 10);
      if (question.value.trim().length < 3 || texts.length < 2) {
        this.setStatus(this.i18n.t('pollInvalid'), true);
        return;
      }
      this.busy = true;
      submit.disabled = true;
      void this.actions
        .create({ question: question.value.trim(), options: texts, multiple: multiple.checked, anonymous: true, kind: kind.value === 'qna' ? 'qna' : 'poll' })
        .then((poll) => { this.upsert(poll); question.value = ''; options.value = ''; this.setStatus(this.i18n.t('pollCreated'), false); })
        .catch(() => this.setStatus(this.i18n.t('pollError'), true))
        .finally(() => { this.busy = false; submit.disabled = false; });
    });
    return form;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(this.element.querySelectorAll<HTMLElement>('button:enabled, input:enabled, select:enabled, textarea:enabled'))
      .filter((control) => control.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    const active = this.element.ownerDocument.activeElement;
    if (active !== (event.shiftKey ? first : last)) return;
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  }

  open(): void {
    const active = this.element.ownerDocument.activeElement;
    this.returnFocus = active instanceof HTMLElement ? active : null;
    this.openFlag = true;
    this.element.hidden = false;
    this.render();
    void this.refresh();
    this.element.querySelector<HTMLElement>(this.form.hidden ? '.agil-polls-close' : '.agil-polls-form input')?.focus();
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.refreshUpdates = null;
    this.element.hidden = true;
    this.returnFocus?.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  isOpen(): boolean {
    return this.openFlag;
  }

  async refresh(): Promise<void> {
    const updates = new Set<string>();
    this.refreshUpdates = updates;
    try {
      const snapshots = await this.actions.list();
      if (this.refreshUpdates !== updates) return;
      // A delayed list response may predate changes already received in this panel.
      const live = new Map(this.polls.filter((poll) => updates.has(poll.id)).map((poll) => [poll.id, poll]));
      const refreshed = snapshots.map((snapshot) => {
        const changed = live.get(snapshot.id);
        live.delete(snapshot.id);
        return changed ? mergePoll(snapshot, changed) : snapshot;
      });
      this.polls = [...live.values(), ...refreshed];
      this.setStatus('', false, true);
      this.render();
    } catch {
      if (this.refreshUpdates === updates) this.setStatus(this.i18n.t('pollsUnavailable'), true);
    } finally {
      if (this.refreshUpdates === updates) this.refreshUpdates = null;
    }
  }

  handleEvent(poll: PollView): void {
    this.upsert(poll);
  }

  private upsert(poll: PollView): void {
    const index = this.polls.findIndex((item) => item.id === poll.id);
    const previous = this.polls[index];
    if (previous) this.polls[index] = mergePoll(previous, poll);
    else this.polls.unshift(poll);
    this.refreshUpdates?.add(poll.id);
    this.render();
  }

  private setStatus(text: string, error: boolean, clear = false): void {
    if (clear) { this.status.hidden = true; this.status.textContent = ''; return; }
    this.status.hidden = text === '';
    this.status.textContent = text;
    this.status.dataset.kind = error ? 'error' : 'success';
  }

  private render(): void {
    this.form.hidden = !this.actions.canManage();
    const focusedOption = this.list.querySelector<HTMLInputElement>('input:focus')?.value;
    const focusedButton = this.list.querySelector<HTMLButtonElement>('button:focus');
    const focusedPollId = focusedButton?.closest<HTMLElement>('[data-poll-id]')?.dataset.pollId;
    const draft = new Set(Array.from(this.list.querySelectorAll<HTMLInputElement>('input:checked:enabled'), (input) => input.value));
    this.list.replaceChildren();
    if (this.polls.length === 0) {
      this.list.appendChild(h('div', { class: 'agil-panel-empty', text: this.i18n.t('pollsEmpty') }));
      return;
    }
    for (const poll of this.polls) this.list.appendChild(this.renderPoll(poll, draft));
    if (focusedOption || focusedButton) {
      const nextControl = focusedOption
        ? this.list.querySelector<HTMLElement>(`input:enabled[value="${CSS.escape(focusedOption)}"]`)
        : this.list.querySelector<HTMLElement>(`[data-poll-id="${CSS.escape(focusedPollId ?? '')}"] button:enabled[type="${focusedButton?.type}"]`);
      (nextControl ?? this.element.querySelector<HTMLElement>('.agil-polls-close'))?.focus({ preventScroll: true });
    }
  }

  private renderPoll(poll: PollView, draft: ReadonlySet<string>): HTMLElement {
    const form = h('form', { class: 'agil-poll', dataset: { pollId: poll.id } });
    form.appendChild(h('div', { class: 'agil-poll-question', text: poll.question }));
    const meta = h(
      'div', { class: 'agil-chat-meta' },
      h('span', { text: this.i18n.t(poll.kind === 'qna' ? 'pollKindQna' : 'pollKindPoll') }),
      h('span', { text: this.i18n.plural(poll.votes, 'pollVotesOne', 'pollVotes', 'pollVotesFew') }),
      h('span', { text: this.i18n.t(poll.status === 'closed' ? 'pollClosed' : 'pollActive') }),
    );
    form.appendChild(meta);
    const voted = Boolean(poll.myVotes && poll.myVotes.length);
    const inputs: HTMLInputElement[] = [];
    for (const option of poll.options) {
      const input = h('input', { attrs: { type: poll.multiple ? 'checkbox' : 'radio', name: `poll-${poll.id}`, value: option.id } });
      input.disabled = poll.status === 'closed' || voted;
      input.checked = Boolean(poll.myVotes?.includes(option.id)) || (!input.disabled && draft.has(option.id));
      inputs.push(input);
      const share = option.share ?? (poll.votes > 0 ? option.votes / poll.votes : 0);
      const label = h(
        'label',
        { class: 'agil-poll-option' },
        input,
        h('span', { class: 'agil-poll-option-text', text: option.text }),
        h('span', { class: 'agil-poll-count', text: String(option.votes) }),
      );
      const bar = h('div', { class: 'agil-poll-bar' }, h('span', { attrs: { style: `width:${Math.round(share * 100)}%` } }));
      label.appendChild(bar);
      form.appendChild(label);
    }
    if (poll.status === 'active' && !voted) {
      const vote = h('button', { class: 'agil-btn agil-btn-primary', text: this.i18n.t('pollVote') });
      vote.type = 'submit';
      form.appendChild(vote);
    } else if (voted) {
      form.appendChild(h('div', { class: 'agil-panel-empty', text: this.i18n.t('pollAlreadyVoted') }));
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (poll.status === 'closed' || voted || this.busy) return;
      const selected = inputs.filter((input) => input.checked).map((input) => input.value);
      if (selected.length === 0) { this.setStatus(this.i18n.t('pollSelectOption'), true); return; }
      this.busy = true;
      void this.actions.vote(poll.id, selected)
        .then((updated) => { this.upsert(updated); this.setStatus('', false, true); })
        .catch(() => this.setStatus(this.i18n.t('pollError'), true))
        .finally(() => { this.busy = false; });
    });
    if (this.actions.canManage() && poll.status === 'active') {
      const close = h('button', { class: 'agil-btn agil-btn-ghost', text: this.i18n.t('pollClose') });
      close.type = 'button';
      close.addEventListener('click', () => {
        void this.actions.close(poll.id).then((updated) => this.upsert(updated)).catch(() => this.setStatus(this.i18n.t('pollError'), true));
      });
      form.appendChild(close);
    }
    return form;
  }
}
