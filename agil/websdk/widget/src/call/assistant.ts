/**
 * Knowledge assistant ("спросить ассистента", contract §18).
 *
 * The widget never talks to the corporate RAG endpoint directly: it sends a
 * `{type:'assistant-query', id, question}` over the existing signaling socket
 * and the server enforces permissions, rate limits, signing and validation.
 * Answers are rendered as plain text (never HTML) and citations as links with
 * `rel="noopener noreferrer"`.
 */
import type { KnowledgeCitation, ServerMessage } from '@agil/protocol';
import type { AssistantEntry } from '../types.js';
import { uid } from '../dom.js';
import type { SignalingClient } from './signaling-client.js';

export type AssistantAnswerMessage = Extract<ServerMessage, { type: 'assistant-answer' }>;

export interface AssistantOptions {
  signaling: SignalingClient;
  maxQuestionChars?: number;
  onChange: () => void;
  onDenied?: (message: string) => void;
}

const MAX_ANSWER_CHARS = 8000;

export class AssistantController {
  private readonly options: AssistantOptions;
  private entries: AssistantEntry[] = [];
  private readonly maxQuestionChars: number;
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: AssistantOptions) {
    this.options = options;
    this.maxQuestionChars = options.maxQuestionChars ?? 2000;
  }

  get history(): AssistantEntry[] {
    return this.entries;
  }

  get pending(): boolean {
    return this.entries.some((entry) => entry.pending);
  }

  /** Returns the created entry, or null when the question is invalid/duplicated. */
  ask(question: string): AssistantEntry | null {
    const trimmed = question.trim();
    if (!trimmed || trimmed.length > this.maxQuestionChars) return null;
    if (this.pending) return null;
    const entry: AssistantEntry = {
      id: uid('ask'),
      question: trimmed,
      answer: '',
      citations: [],
      pending: true,
      ts: Date.now(),
    };
    this.entries = [entry, ...this.entries].slice(0, 20);
    this.options.onChange();
    this.options.signaling.send({ type: 'assistant-query', id: entry.id, question: trimmed });
    const timeout = setTimeout(() => {
      this.timeouts.delete(entry.id);
      this.finish(entry.id, { answer: '', citations: [], error: 'timeout' });
    }, 25_000);
    this.timeouts.set(entry.id, timeout);
    return entry;
  }

  handleAnswer(message: AssistantAnswerMessage): void {
    const timeout = this.timeouts.get(message.id);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(message.id);
    }
    const citations: KnowledgeCitation[] = Array.isArray(message.citations) ? message.citations.filter(isCitation) : [];
    const answer = typeof message.answer === 'string' ? message.answer.slice(0, MAX_ANSWER_CHARS) : '';
    const error = typeof message.error === 'string' && message.error ? message.error : undefined;
    if (error === 'forbidden') this.options.onDenied?.('assistantForbidden');
    this.finish(message.id, {
      answer,
      citations,
      error,
      confidence: typeof message.confidence === 'number' ? message.confidence : undefined,
    });
  }

  private finish(
    id: string,
    patch: { answer: string; citations: KnowledgeCitation[]; error?: string; confidence?: number },
  ): void {
    this.entries = this.entries.map((entry) =>
      entry.id === id
        ? { ...entry, pending: false, answer: patch.answer, citations: patch.citations, error: patch.error, confidence: patch.confidence }
        : entry,
    );
    this.options.onChange();
  }

  clear(): void {
    for (const timeout of this.timeouts.values()) clearTimeout(timeout);
    this.timeouts.clear();
    this.entries = [];
    this.options.onChange();
  }
}

function isCitation(value: unknown): value is KnowledgeCitation {
  if (typeof value !== 'object' || value === null) return false;
  const citation = value as { title?: unknown; url?: unknown };
  return typeof citation.title === 'string' && typeof citation.url === 'string';
}
