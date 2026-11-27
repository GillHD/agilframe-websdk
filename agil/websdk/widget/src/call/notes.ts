/**
 * Notes / compliance controller (contract §13).
 *
 * The server broadcasts `{type:'analysis'}` with `findings` and, optionally,
 * `notes` (MeetingNotes). When no AI analysis has arrived yet the widget builds
 * deterministic local notes from the transcript (extractive fallback), so the
 * "Notes" panel is useful even with a local-only deployment.
 */
import type {
  ActionItem,
  ComplianceFinding,
  ExcerptKind,
  MeetingNotes,
  TranscriptExcerpt,
  TranscriptSegment,
} from '@agil/protocol';

const ACTION_RE =
  /(надо|нужно|сдела|сделаю|подготов|отправ|провер|запланир|will|need to|todo|action item|follow up|assign|deadline)/i;
const DECISION_RE = /(решили|решение|договорились|согласова|утверди|decision|agreed|approved|resolve)/i;
const RISK_RE = /(риск|проблем|блокер|задерж|risk|concern|issue|blocker|danger)/i;
const QUESTION_RE = /[?？]\s*$/;
const POSITIVE_RE = /(спасибо|отлично|хорошо|согласен|great|thanks|good|agree|perfect)/i;
const NEGATIVE_RE = /(плохо|проблем|риск|не согласен|bad|problem|risk|disagree|blocker)/i;

const STOP_WORDS = new Set(
  'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между the a an and or to of in on for is are was were be been it this that with as at by from we you they i he she not no yes do does did can will would should could have has had'.split(
    /\s+/,
  ),
);

export interface AnalysisPayload {
  findings: ComplianceFinding[];
  notes?: MeetingNotes | null;
  summary?: string;
}

export class NotesController {
  private segments: TranscriptSegment[] = [];
  private findings: ComplianceFinding[] = [];
  private serverNotes: MeetingNotes | null = null;
  private lastLocalBuild = 0;

  addSegment(segment: TranscriptSegment): void {
    if (!segment.isFinal) return;
    this.segments.push(segment);
    if (this.segments.length > 500) this.segments = this.segments.slice(-500);
  }

  setAnalysis(payload: AnalysisPayload): void {
    this.findings = payload.findings.filter((finding) => finding && finding.id);
    if (payload.notes) this.serverNotes = payload.notes;
  }

  get complianceFindings(): ComplianceFinding[] {
    return this.findings;
  }

  get transcriptSegments(): TranscriptSegment[] {
    return this.segments;
  }

  get notes(): MeetingNotes | null {
    return this.serverNotes;
  }

  /** Local deterministic notes; memoized to at most once per 5 s. */
  buildLocalNotes(language: 'ru' | 'en' = 'ru'): MeetingNotes | null {
    const now = Date.now();
    if (now - this.lastLocalBuild < 5000 && this.serverNotes) return this.serverNotes;
    this.lastLocalBuild = now;
    const finals = this.segments.filter((segment) => segment.isFinal && segment.text.trim().length > 1);
    if (finals.length === 0) return this.serverNotes;
    const excerpts: TranscriptExcerpt[] = [];
    const actionItems: ActionItem[] = [];
    const decisions: string[] = [];
    const risks: string[] = [];
    const sentences: Array<{ text: string; segment: TranscriptSegment }> = [];
    for (const segment of finals) {
      for (const sentence of splitSentences(segment.text)) {
        if (sentence.length < 8) continue;
        sentences.push({ text: sentence, segment });
      }
    }
    const pushExcerpt = (kind: ExcerptKind, sentence: { text: string; segment: TranscriptSegment }): void => {
      if (excerpts.length >= 12) return;
      excerpts.push({
        id: `excerpt-${excerpts.length + 1}`,
        kind,
        text: sentence.text.slice(0, 400),
        participantId: sentence.segment.participantId,
        participantName: sentence.segment.participantName,
        start: sentence.segment.start,
        end: sentence.segment.end,
      });
    };
    for (const sentence of sentences) {
      if (ACTION_RE.test(sentence.text)) {
        pushExcerpt('action_item', sentence);
        actionItems.push({ id: `action-${actionItems.length + 1}`, text: sentence.text.slice(0, 300), sourceTs: sentence.segment.start });
      } else if (DECISION_RE.test(sentence.text)) {
        pushExcerpt('decision', sentence);
        if (decisions.length < 10) decisions.push(sentence.text.slice(0, 300));
      } else if (RISK_RE.test(sentence.text)) {
        pushExcerpt('risk', sentence);
        if (risks.length < 10) risks.push(sentence.text.slice(0, 300));
      } else if (QUESTION_RE.test(sentence.text)) {
        pushExcerpt('question', sentence);
      }
    }
    if (excerpts.length === 0) {
      for (const sentence of sentences.slice(0, 3)) pushExcerpt('key_point', sentence);
    }
    const topics = extractTopics(sentences.map((sentence) => sentence.text)).slice(0, 6);
    const summary = buildSummary(sentences, finals.length, language);
    const sentiment = scoreSentiment(sentences.map((sentence) => sentence.text));
    return {
      summary,
      excerpts,
      actionItems,
      decisions,
      risks,
      topics,
      sentiment,
      source: 'local',
      segmentsAnalyzed: finals.length,
      createdAt: now,
      language,
    };
  }

  clear(): void {
    this.segments = [];
    this.findings = [];
    this.serverNotes = null;
  }
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function extractTopics(texts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      const word = raw.trim();
      if (word.length < 4 || STOP_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

function buildSummary(sentences: Array<{ text: string }>, segments: number, language: 'ru' | 'en' = 'ru'): string {
  const highlights = sentences.slice(0, 3).map((sentence) => sentence.text);
  if (highlights.length === 0) return '';
  const suffix = language === 'en' ? `${segments} fragments` : `${segments} фрагм.`;
  return `${highlights.join(' ')} (${suffix})`;
}

function scoreSentiment(texts: string[]): 'positive' | 'neutral' | 'negative' {
  let positive = 0;
  let negative = 0;
  for (const text of texts) {
    if (POSITIVE_RE.test(text)) positive += 1;
    if (NEGATIVE_RE.test(text)) negative += 1;
  }
  if (positive > negative + 1) return 'positive';
  if (negative > positive + 1) return 'negative';
  return 'neutral';
}
