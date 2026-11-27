/**
 * Assistant panel with two backends:
 *  - in-call AI assistant (local rules or corporate LLM) — chat-like messages,
 *    tool badges and spotlight hints (docs/in-call-agent.md);
 *  - knowledge assistant (WS `assistant-query`) — citations from the company wiki.
 *
 * All content is inserted with `textContent` only (never HTML); links use
 * `rel="noopener noreferrer"`.
 */
import { isKnowledgeCitationWebUrl } from '@agil/protocol';
import { h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';
import type { AssistantEntry, CallState, InCallAssistantMessage } from '../types.js';

export interface AssistantPanelActions {
  onClose: () => void;
  onAsk: (question: string) => void;
}

export class AssistantPanel {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly actions: AssistantPanelActions;
  private readonly historyEl: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private readonly askButton: HTMLButtonElement;
  private readonly empty: HTMLDivElement;
  private readonly titleEl: HTMLHeadingElement;
  private lastRenderedId = '';
  private lastInCallCount = -1;
  private composing = false;
  private busy = false;
  private readonly enterHint: HTMLDivElement;

  constructor(i18n: I18n, actions: AssistantPanelActions) {
    this.i18n = i18n;
    this.actions = actions;
    this.historyEl = h('div', { class: 'agil-assistant-history' });
    this.empty = h('div', { class: 'agil-panel-empty', text: i18n.t('assistantEmpty') });
    this.input = h('textarea', {
      class: 'agil-assistant-input',
      attrs: { maxlength: '2000', rows: '2', placeholder: i18n.t('assistantPlaceholder') },
    });
    this.input.dataset.agilAssistantInput = '';
    this.input.setAttribute('aria-label', i18n.t('assistantPlaceholder'));
    this.askButton = h('button', { class: 'agil-btn agil-btn-primary' });
    this.askButton.type = 'button';
    this.askButton.dataset.agilAssistantSend = '';
    this.askButton.appendChild(icon('send', 16));
    this.askButton.appendChild(h('span', { text: i18n.t('assistantAsk') }));
    this.askButton.addEventListener('click', () => this.submit());
    this.input.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    this.input.addEventListener('compositionend', () => {
      this.composing = false;
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      // Never submit while an IME (Cyrillic/CJK) composition is active.
      if (event.isComposing || this.composing || event.keyCode === 229) return;
      event.preventDefault();
      this.submit();
    });
    this.enterHint = h('div', { class: 'agil-assistant-enter-hint' });

    const close = h('button', { class: 'agil-icon-btn', title: i18n.t('close') });
    close.type = 'button';
    close.setAttribute('aria-label', i18n.t('close'));
    close.appendChild(icon('close', 18));
    close.addEventListener('click', () => actions.onClose());
    this.titleEl = h('h2', { class: 'agil-panel-title', text: i18n.t('assistantTitle') });
    const header = h('div', { class: 'agil-panel-header' }, this.titleEl, close);
    const composer = h('div', { class: 'agil-assistant-composer' }, this.input, this.askButton, this.enterHint);
    this.element = h(
      'section',
      {
        class: 'agil-panel agil-assistant-panel',
        attrs: { 'aria-label': i18n.t('assistantTitle') },
        dataset: { agilAssistantPanel: '' },
      },
      header,
      this.historyEl,
      this.empty,
      composer,
    );
  }

  private submit(): void {
    if (this.busy) return;
    const question = this.input.value.trim();
    if (!question) return;
    this.input.value = '';
    this.askButton.disabled = true;
    this.askButton.classList.add('is-loading');
    this.actions.onAsk(question);
  }

  focusInput(): void {
    this.input.focus();
  }

  update(state: CallState): void {
    const inCall = state.inCallAssistant.available;
    this.element.dataset.mode = inCall ? 'in-call' : 'knowledge';
    if (inCall) {
      this.updateInCall(state);
      return;
    }
    this.titleEl.textContent = this.i18n.t('assistantTitle');
    this.input.placeholder = this.i18n.t('assistantPlaceholder');
    this.input.setAttribute('aria-label', this.i18n.t('assistantPlaceholder'));
    const entries = state.assistant.entries;
    this.empty.textContent = this.i18n.t('assistantEmpty');
    this.empty.style.display = entries.length === 0 ? '' : 'none';
    this.historyEl.hidden = entries.length === 0;
    this.busy = state.assistant.asking;
    this.enterHint.textContent = state.assistant.available
      ? this.i18n.t('assistantEnterHint')
      : this.i18n.t('assistantEnterHintDenied');
    this.askButton.disabled = state.assistant.asking || !state.assistant.available;
    this.askButton.classList.toggle('is-loading', state.assistant.asking);
    this.historyEl.replaceChildren();
    for (const entry of entries) this.historyEl.appendChild(this.renderEntry(entry));
    const newest = entries[0];
    if (newest && newest.id !== this.lastRenderedId) {
      this.lastRenderedId = newest.id;
      this.historyEl.scrollTop = 0;
    }
  }

  private updateInCall(state: CallState): void {
    const assistant = state.inCallAssistant;
    this.titleEl.textContent = this.i18n.t('assistantInCallTitle');
    this.input.placeholder = this.i18n.t('assistantInCallPlaceholder');
    this.input.setAttribute('aria-label', this.i18n.t('assistantInCallPlaceholder'));
    this.empty.textContent = this.i18n.t('assistantInCallHint');
    this.empty.style.display = assistant.messages.length === 0 ? '' : 'none';
    this.historyEl.hidden = assistant.messages.length === 0;
    this.busy = assistant.busy;
    this.enterHint.textContent = this.i18n.t('assistantEnterHint');
    this.askButton.disabled = assistant.busy;
    this.askButton.classList.toggle('is-loading', assistant.busy);
    this.historyEl.replaceChildren();
    for (const message of assistant.messages) this.historyEl.appendChild(this.renderInCallMessage(message));
    this.historyEl.classList.toggle('is-busy', assistant.busy);
    if (assistant.messages.length !== this.lastInCallCount) {
      this.lastInCallCount = assistant.messages.length;
      this.historyEl.scrollTop = this.historyEl.scrollHeight;
    }
  }

  private renderInCallMessage(message: InCallAssistantMessage): HTMLElement {
    const bubble = h('div', {
      class: `agil-assistant-message agil-assistant-message-${message.role}`,
      dataset: { agilAssistantMessage: message.role },
    });
    if (message.role === 'user') {
      bubble.appendChild(h('div', { class: 'agil-assistant-question', text: message.text }));
      return bubble;
    }
    const answer = h('div', { class: 'agil-assistant-answer agil-assistant-in-call-answer' });
    answer.dataset.agilAssistantAnswer = '';
    if (message.error) {
      answer.appendChild(h('div', { class: 'agil-warning', text: message.text }));
      answer.appendChild(h('div', { class: 'agil-assistant-confidence', text: message.error }));
    } else {
      const policy = message.securityPolicy;
      const source = message.source === 'local' ? this.i18n.t('assistantLocalSource')
        : policy ? this.i18n.t(policy.environment === 'production' ? 'assistantProductionPolicy' : 'assistantTestPolicy', { version: policy.version })
          : this.i18n.t('assistantExternalSource');
      answer.appendChild(h('p', { class: 'agil-assistant-confidence', text: source }));
      answer.appendChild(h('p', { class: 'agil-assistant-text', text: message.text }));
      if (message.actions.length > 0) {
        const tools = h('div', { class: 'agil-assistant-tools' });
        for (const action of message.actions) {
          tools.appendChild(h('span', { class: 'agil-topic-tag', text: action.tool }));
        }
        answer.appendChild(tools);
      }
      if (message.spotlight.length > 0) {
        answer.appendChild(
          h('div', { class: 'agil-assistant-confidence', text: this.i18n.t('assistantSpotlightHint') }),
        );
      }
    }
    bubble.appendChild(answer);
    return bubble;
  }

  /** Maps server error codes to human sentences (never raw internal_error). */
  private knowledgeErrorText(error: string): string {
    switch (error) {
      case 'forbidden':
        return this.i18n.t('assistantForbidden');
      case 'knowledge_not_configured':
      case 'not_configured':
        return this.i18n.t('knowledgeNotConfigured');
      case 'provider_failed':
      case 'upstream_error':
        return this.i18n.t('knowledgeProviderFailed');
      case 'rate_limited':
        return this.i18n.t('rateLimited');
      case 'timeout':
        return this.i18n.t('knowledgeTimeout');
      default:
        return this.i18n.t('knowledgeGenericError');
    }
  }

  private renderEntry(entry: AssistantEntry): HTMLElement {
    const answer = h('div', { class: 'agil-assistant-answer' });
    answer.dataset.agilAssistantAnswer = '';
    if (entry.pending) {
      answer.appendChild(h('div', { class: 'agil-assistant-loading', text: this.i18n.t('assistantThinking') }));
    } else if (entry.error) {
      const message = this.knowledgeErrorText(entry.error);
      answer.appendChild(h('div', { class: 'agil-warning', text: message }));
      if (entry.error !== 'forbidden') {
        const retry = h('button', { class: 'agil-btn agil-btn-ghost agil-assistant-retry', text: this.i18n.t('retry') });
        retry.type = 'button';
        retry.addEventListener('click', () => this.actions.onAsk(entry.question));
        answer.appendChild(retry);
      }
    } else {
      answer.appendChild(h('p', { class: 'agil-assistant-text', text: entry.answer }));
      if (entry.citations.length > 0) {
        const sources = h('div', { class: 'agil-assistant-sources' }, h('h4', { text: this.i18n.t('assistantCitations') }));
        for (const citation of entry.citations) {
          const text = citation.title || citation.url;
          const link = isKnowledgeCitationWebUrl(citation.url)
            ? h('a', { class: 'agil-assistant-citation', attrs: { href: citation.url, target: '_blank', rel: 'noopener noreferrer' }, text })
            : h('span', { class: 'agil-assistant-citation', text });
          sources.appendChild(link);
        }
        answer.appendChild(sources);
      }
      if (typeof entry.confidence === 'number') {
        answer.appendChild(
          h('div', { class: 'agil-assistant-confidence', text: `${this.i18n.t('assistantConfidence')}: ${Math.round(entry.confidence * 100)}%` }),
        );
      }
    }
    return h(
      'div',
      { class: 'agil-assistant-entry' },
      h('div', { class: 'agil-assistant-question', text: entry.question }),
      answer,
    );
  }

  destroy(): void {
    this.element.remove();
  }
}
