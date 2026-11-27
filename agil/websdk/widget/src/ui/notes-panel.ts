/**
 * Notes panel: summary, verbatim excerpts with timecodes ("перейти"),
 * action items, risks, decisions, topics, and the compliance findings list with
 * severity badges for moderators.
 */
import type { ComplianceFinding, ComplianceSeverity, MeetingNotes } from '@agil/protocol';
import { formatDuration, h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';
import { canFeature } from '../permissions.js';
import type { CallState } from '../types.js';

export interface NotesPanelActions {
  onClose: () => void;
  onSeek: (seconds: number) => void;
}

const SEVERITY_CLASS: Record<ComplianceSeverity, string> = {
  info: 'agil-badge-info',
  warn: 'agil-badge-warning',
  critical: 'agil-badge-danger',
};

function severityLabel(i18n: I18n, severity: ComplianceSeverity): string {
  if (severity === 'critical') return i18n.t('complianceSeverityCritical');
  if (severity === 'warn') return i18n.t('complianceSeverityWarn');
  return i18n.t('complianceSeverityInfo');
}

export class NotesPanel {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly actions: NotesPanelActions;
  private readonly body: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly sourceEl: HTMLSpanElement;
  private renderedNotes: MeetingNotes | null | undefined;
  private renderedFindings: readonly ComplianceFinding[] | null | undefined;
  private renderedCanSeek = false;

  constructor(i18n: I18n, actions: NotesPanelActions) {
    this.i18n = i18n;
    this.actions = actions;
    this.body = h('div', { class: 'agil-notes-body' });
    this.empty = h('div', { class: 'agil-panel-empty', text: i18n.t('notesEmpty') });
    this.sourceEl = h('span', { class: 'agil-pill' });
    const close = h('button', { class: 'agil-icon-btn', title: i18n.t('close') });
    close.type = 'button';
    close.setAttribute('aria-label', i18n.t('close'));
    close.appendChild(icon('close', 18));
    close.addEventListener('click', () => actions.onClose());
    const header = h(
      'div',
      { class: 'agil-panel-header' },
      h('h2', { class: 'agil-panel-title' }, i18n.t('notesTitle'), this.sourceEl),
      close,
    );
    this.element = h(
      'section',
      { class: 'agil-panel agil-notes-panel', attrs: { 'aria-label': i18n.t('notesTitle') } },
      header,
      this.body,
      this.empty,
    );
  }

  update(state: CallState): void {
    const notes = canFeature(state, 'meetingNotes') ? state.notes : null;
    const findings = canFeature(state, 'aiCompliance') ? state.findings : null;
    const canSeek = canFeature(state, 'captions');
    if (notes === this.renderedNotes && findings === this.renderedFindings && canSeek === this.renderedCanSeek) return;
    this.renderedNotes = notes;
    this.renderedFindings = findings;
    this.renderedCanSeek = canSeek;
    this.body.replaceChildren();
    const hasContent = Boolean(notes && (notes.summary || notes.excerpts.length > 0)) || Boolean(findings?.length);
    this.empty.style.display = hasContent ? 'none' : '';
    this.body.hidden = !hasContent;
    this.sourceEl.textContent = notes
      ? notes.source === 'external'
        ? this.i18n.t('notesSourceExternal')
        : notes.source === 'hybrid'
          ? this.i18n.t('notesSourceHybrid')
          : this.i18n.t('notesSourceLocal')
      : '';
    this.sourceEl.style.display = notes ? '' : 'none';
    if (notes) this.renderNotes(notes, canSeek);
    if (findings) this.renderFindings(findings);
  }

  private section(title: string): HTMLDivElement {
    return h('div', { class: 'agil-notes-section' }, h('h3', { class: 'agil-notes-section-title', text: title }));
  }

  private renderNotes(notes: MeetingNotes, canSeek: boolean): void {
    if (notes.summary) {
      const summary = this.section(this.i18n.t('notesSummary'));
      summary.appendChild(h('p', { class: 'agil-notes-summary', text: notes.summary }));
      this.body.appendChild(summary);
    }
    if (notes.excerpts.length > 0) {
      const section = this.section(this.i18n.t('notesExcerpts'));
      for (const excerpt of notes.excerpts) {
        const row = h(
          'div',
          { class: 'agil-excerpt', dataset: { kind: excerpt.kind } },
          h(
            'div',
            { class: 'agil-excerpt-head' },
            h('span', { class: 'agil-excerpt-author', text: excerpt.participantName || '' }),
            canSeek
              ? h('button', { class: 'agil-excerpt-jump', text: `${formatDuration(excerpt.start)} · ${this.i18n.t('notesJump')}` })
              : h('span', { text: formatDuration(excerpt.start) }),
          ),
          h('blockquote', { class: 'agil-excerpt-text', text: excerpt.text }),
        );
        const jump = row.querySelector('.agil-excerpt-jump');
        jump?.addEventListener('click', () => this.actions.onSeek(excerpt.start));
        section.appendChild(row);
      }
      this.body.appendChild(section);
    }
    if (notes.actionItems.length > 0) {
      const section = this.section(this.i18n.t('notesActions'));
      const list = h('ul', { class: 'agil-notes-list' });
      for (const item of notes.actionItems) {
        const li = h('li', { text: item.text });
        if (item.owner) li.appendChild(h('span', { class: 'agil-notes-meta', text: ` — ${item.owner}` }));
        list.appendChild(li);
      }
      section.appendChild(list);
      this.body.appendChild(section);
    }
    if (notes.decisions.length > 0) {
      const section = this.section(this.i18n.t('notesDecisions'));
      const list = h('ul', { class: 'agil-notes-list' });
      for (const decision of notes.decisions) list.appendChild(h('li', { text: decision }));
      section.appendChild(list);
      this.body.appendChild(section);
    }
    if (notes.risks.length > 0) {
      const section = this.section(this.i18n.t('notesRisks'));
      const list = h('ul', { class: 'agil-notes-list agil-notes-risks' });
      for (const risk of notes.risks) list.appendChild(h('li', { text: risk }));
      section.appendChild(list);
      this.body.appendChild(section);
    }
    if (notes.topics.length > 0) {
      const section = this.section(this.i18n.t('notesTopics'));
      const tags = h('div', { class: 'agil-topic-tags' });
      for (const topic of notes.topics) tags.appendChild(h('span', { class: 'agil-topic-tag', text: `#${topic}` }));
      section.appendChild(tags);
      this.body.appendChild(section);
    }
  }

  private renderFindings(findings: ComplianceFinding[]): void {
    const section = this.section(this.i18n.t('complianceTitle'));
    const badge = h('span', { class: 'agil-badge agil-badge-info' });
    badge.textContent = String(findings.length);
    section.querySelector('h3')?.appendChild(badge);
    if (findings.length === 0) {
      section.appendChild(h('p', { class: 'agil-notes-muted', text: this.i18n.t('complianceEmpty') }));
    } else {
      for (const finding of findings.slice(0, 30)) {
        const row = h(
          'div',
          { class: `agil-finding agil-finding-${finding.severity}` },
          h(
            'div',
            { class: 'agil-finding-head' },
            h('span', { class: `agil-badge ${SEVERITY_CLASS[finding.severity]}`, text: severityLabel(this.i18n, finding.severity) }),
            h('span', { class: 'agil-finding-rule', text: finding.ruleName }),
          ),
          h('blockquote', { class: 'agil-finding-excerpt', text: finding.excerpt }),
          finding.recommendation ? h('p', { class: 'agil-finding-recommendation', text: finding.recommendation }) : null,
        );
        section.appendChild(row);
      }
    }
    this.body.appendChild(section);
  }

  destroy(): void {
    this.element.remove();
  }
}
