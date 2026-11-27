/** Transcript panel: final STT segments + live interim caption + .txt export. */
import { formatDuration, h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';
import type { CallState } from '../types.js';

export interface TranscriptPanelActions {
  onClose: () => void;
  onExport: () => void;
}

export class TranscriptPanel {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly actions: TranscriptPanelActions;
  private readonly list: HTMLDivElement;
  private readonly interim: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly unavailable: HTMLDivElement;
  private readonly notice: HTMLDivElement;

  constructor(i18n: I18n, actions: TranscriptPanelActions) {
    this.i18n = i18n;
    this.actions = actions;
    // `role="log"` is an implicit polite live region; name it so the transcript
    // is identifiable among the other widget landmarks (WCAG 1.3.1/4.1.2).
    this.list = h('div', {
      class: 'agil-transcript-list',
      attrs: { role: 'log', 'aria-live': 'polite', 'aria-label': i18n.t('transcriptTitle') },
    });
    this.interim = h('div', { class: 'agil-transcript-interim' });
    this.empty = h('div', { class: 'agil-panel-empty', text: i18n.t('transcriptEmpty') });
    this.unavailable = h('div', { class: 'agil-panel-empty agil-warning', text: i18n.t('transcriptUnavailable') });
    this.unavailable.hidden = true;
    this.notice = h('div', { class: 'agil-transcript-notice', text: i18n.t('transcriptTranslationNotice') });
    this.notice.hidden = true;

    const exportButton = h('button', { class: 'agil-icon-btn', title: i18n.t('transcriptExport') });
    exportButton.type = 'button';
    exportButton.setAttribute('aria-label', i18n.t('transcriptExport'));
    exportButton.appendChild(icon('download', 18));
    exportButton.addEventListener('click', () => actions.onExport());
    const close = h('button', { class: 'agil-icon-btn', title: i18n.t('close') });
    close.type = 'button';
    close.setAttribute('aria-label', i18n.t('close'));
    close.appendChild(icon('close', 18));
    close.addEventListener('click', () => actions.onClose());

    const header = h(
      'div',
      { class: 'agil-panel-header' },
      h('h2', { class: 'agil-panel-title', text: i18n.t('transcriptTitle') }),
      h('div', { class: 'agil-panel-actions' }, exportButton, close),
    );
    this.element = h(
      'section',
      { class: 'agil-panel agil-transcript-panel', attrs: { 'aria-label': i18n.t('transcriptTitle') } },
      header,
      this.list,
      this.interim,
      this.empty,
      this.unavailable,
      this.notice,
    );
  }

  update(state: CallState): void {
    const transcripts = state.transcripts;
    this.list.replaceChildren();
    let hasTranslation = false;
    for (const segment of transcripts) {
      const body = h('div', { class: 'agil-transcript-body' }, h('span', { class: 'agil-transcript-text', text: segment.text }));
      if (segment.translation) {
        hasTranslation = true;
        body.appendChild(
          h('span', {
            class: 'agil-transcript-translation',
            // The translation is machine output: name the language and label it
            // so it is never mistaken for what the participant actually said.
            attrs: { lang: segment.translation.lang },
            text: `${this.i18n.t('transcriptTranslation')} (${segment.translation.lang}): ${segment.translation.text}`,
          }),
        );
      }
      const row = h(
        'div',
        { class: 'agil-transcript-row' },
        h('span', { class: 'agil-transcript-time', text: formatDuration(segment.start) }),
        h('span', { class: 'agil-transcript-speaker', text: segment.participantName || this.i18n.t('you') }),
        body,
      );
      this.list.appendChild(row);
    }
    const sttEnabled = state.config.session.transcription.enabled;
    this.empty.textContent = !sttEnabled
      ? this.i18n.t('transcriptOff')
      : !state.settings.captionsVisible
        ? this.i18n.t('transcriptDisabled')
        : this.i18n.t('transcriptEmpty');
    const last = state.captions[state.captions.length - 1];
    this.interim.textContent = last && !last.isFinal
      ? `${last.text}${last.translation ? ` — ${last.translation}` : ''}`
      : '';
    this.empty.style.display = transcripts.length === 0 ? '' : 'none';
    this.unavailable.hidden = !(state.capabilities.captions === false && state.config.session.transcription.enabled);
    this.notice.hidden = !(hasTranslation || state.config.session.transcription.translateTo !== 'none');
  }

  destroy(): void {
    this.element.remove();
  }
}
