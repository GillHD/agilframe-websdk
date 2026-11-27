/**
 * Corporate AI-agent integration and compliance contracts.
 *
 * Local policy rules always run first (phrase/regex/PII). When
 * `session.aiAgent.mode` is 'external'|'hybrid' and an endpoint is configured,
 * the server forwards a batch to the corporate AI agent over HTTPS with an HMAC
 * signature. Findings are broadcast to moderators, written to the audit log and
 * attached to the recording transcript.
 *
 * External AI output is untrusted input: it is schema-validated, length-clamped
 * and never executed.
 */
import { z } from 'zod';

export type ComplianceSeverity = 'info' | 'warn' | 'critical';
export const complianceSeveritySchema = z.enum(['info', 'warn', 'critical']);

export type ComplianceSource = 'local' | 'external' | 'manual';
export type ComplianceAction = 'flag' | 'warn' | 'mute' | 'block';
export const complianceActionSchema = z.enum(['flag', 'warn', 'mute', 'block']);

export type ComplianceRuleType = 'phrase' | 'regex' | 'pii' | 'external';
export const complianceRuleTypeSchema = z.enum(['phrase', 'regex', 'pii', 'external']);

export interface CompliancePolicyRule {
  id: string;
  name: string;
  type: ComplianceRuleType;
  /** Phrase (case-insensitive) or regex source. Ignored for type 'external'/'pii'. */
  pattern: string;
  severity: ComplianceSeverity;
  action: ComplianceAction;
  enabled: boolean;
}

export const compliancePolicyRuleSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  type: complianceRuleTypeSchema,
  pattern: z.string().max(500),
  severity: complianceSeveritySchema,
  action: complianceActionSchema,
  enabled: z.boolean(),
});

/**
 * Machine translation attached to a transcript segment.
 *
 * `provider` names the *class* of engine, `model`/`engine` name the concrete
 * local model or LLM. Translation is best-effort and must never be presented as
 * human-quality: the UI labels it as machine translation.
 */
export interface TranscriptTranslation {
  text: string;
  lang: 'ru' | 'en';
  provider: 'local' | 'llm' | 'stub';
  /** Concrete engine/model label (e.g. `opus-mt`, `qwen2.5:7b`). Never a secret. */
  engine?: string;
}

export const transcriptTranslationSchema = z.object({
  text: z.string().min(1).max(8000),
  lang: z.enum(['ru', 'en']),
  provider: z.enum(['local', 'llm', 'stub']),
  engine: z.string().max(120).optional(),
});

export interface TranscriptSegment {
  id: string;
  participantId: string;
  participantName: string;
  text: string;
  /** Seconds since call start. */
  start: number;
  end: number;
  isFinal: boolean;
  lang?: 'ru' | 'en';
  ts: number;
  /** Machine translation of {@link text} (opt-in per tenant). */
  translation?: TranscriptTranslation;
}

export const transcriptSegmentSchema = z.object({
  id: z.string().min(1).max(64),
  participantId: z.string().min(1).max(64),
  participantName: z.string().max(120),
  text: z.string().min(1).max(4000),
  start: z.number().min(0),
  end: z.number().min(0),
  isFinal: z.boolean(),
  lang: z.enum(['ru', 'en']).optional(),
  ts: z.number(),
  translation: transcriptTranslationSchema.optional(),
});

export interface ComplianceFinding {
  id: string;
  ts: number;
  ruleId: string;
  ruleName: string;
  source: ComplianceSource;
  severity: ComplianceSeverity;
  action: ComplianceAction;
  participantId?: string;
  participantName?: string;
  excerpt: string;
  confidence?: number;
  recommendation?: string;
}

export const complianceFindingSchema = z.object({
  id: z.string().min(1).max(64),
  ts: z.number(),
  ruleId: z.string().min(1).max(64),
  ruleName: z.string().min(1).max(160),
  source: z.enum(['local', 'external', 'manual']),
  severity: complianceSeveritySchema,
  action: complianceActionSchema,
  participantId: z.string().max(64).optional(),
  participantName: z.string().max(120).optional(),
  excerpt: z.string().max(600),
  confidence: z.number().min(0).max(1).optional(),
  recommendation: z.string().max(600).optional(),
});

export interface ComplianceReport {
  id: string;
  roomId: string;
  tenantId: string;
  createdAt: number;
  segmentsAnalyzed: number;
  findings: ComplianceFinding[];
  summary?: string;
  provider?: string;
  model?: string;
  notes?: MeetingNotes;
}

/* ------------------------------------------------------------------ */
/* Meeting notes: excerpts, summary, decisions, action items           */
/* ------------------------------------------------------------------ */

export type ExcerptKind = 'key_point' | 'decision' | 'action_item' | 'risk' | 'question';

export const excerptKindSchema = z.enum(['key_point', 'decision', 'action_item', 'risk', 'question']);

/** A verbatim quote from the transcript that supports a summary point. */
export interface TranscriptExcerpt {
  id: string;
  kind: ExcerptKind;
  /** Exact quote, never AI-paraphrased. */
  text: string;
  participantId?: string;
  participantName?: string;
  /** Seconds since call start. */
  start: number;
  end: number;
  /** Why this excerpt matters (from the local extractor or the AI agent). */
  note?: string;
}

export const transcriptExcerptSchema = z.object({
  id: z.string().min(1).max(64),
  kind: excerptKindSchema,
  text: z.string().min(1).max(600),
  participantId: z.string().max(64).optional(),
  participantName: z.string().max(120).optional(),
  start: z.number().min(0),
  end: z.number().min(0),
  note: z.string().max(600).optional(),
});

export interface ActionItem {
  id: string;
  text: string;
  owner?: string;
  due?: string;
  sourceTs?: number;
  excerptId?: string;
}

export const actionItemSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(600),
  owner: z.string().max(120).optional(),
  due: z.string().max(64).optional(),
  sourceTs: z.number().optional(),
  excerptId: z.string().max(64).optional(),
});

/** Structured notes produced from the transcript (local extractor and/or AI agent). */
export interface MeetingNotes {
  summary: string;
  /** Quotes that back the summary — the "выдержки" feature. */
  excerpts: TranscriptExcerpt[];
  actionItems: ActionItem[];
  decisions: string[];
  risks: string[];
  topics: string[];
  sentiment?: 'positive' | 'neutral' | 'negative';
  /** 'local' = deterministic extractive summarizer, 'external' = corporate AI agent. */
  source: 'local' | 'external' | 'hybrid';
  segmentsAnalyzed: number;
  createdAt: number;
  language?: 'ru' | 'en';
}

export const meetingNotesSchema = z.object({
  summary: z.string().max(4000),
  excerpts: z.array(transcriptExcerptSchema).max(50),
  actionItems: z.array(actionItemSchema).max(50),
  decisions: z.array(z.string().max(600)).max(50),
  risks: z.array(z.string().max(600)).max(50),
  topics: z.array(z.string().max(120)).max(30),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  source: z.enum(['local', 'external', 'hybrid']),
  segmentsAnalyzed: z.number().min(0),
  createdAt: z.number(),
  language: z.enum(['ru', 'en']).optional(),
});

/** Request payload for the corporate AI agent (signed webhook to `endpoint`). */
export const aiAgentRequestSchema = z.object({
  requestId: z.string().min(1),
  tenantId: z.string().min(1),
  roomId: z.string().min(1),
  roomName: z.string().max(120),
  locale: z.enum(['ru', 'en']),
  participants: z.array(
    z.object({
      id: z.string(),
      name: z.string().max(120),
      role: z.enum(['host', 'moderator', 'guest']),
      country: z.string().length(2).optional(),
      verified: z.boolean(),
    }),
  ),
  segments: z.array(transcriptSegmentSchema).max(200),
  chat: z
    .array(
      z.object({
        id: z.string(),
        fromName: z.string().max(120),
        text: z.string().max(4000),
        ts: z.number(),
      }),
    )
    .max(200),
  policy: z.object({
    rules: z.array(compliancePolicyRuleSchema).max(100),
    policyText: z.string().max(20000),
  }),
  meetingContext: z
    .object({
      startedAt: z.number().optional(),
      hostName: z.string().max(120).optional(),
    })
    .optional(),
});

export type AiAgentRequest = z.infer<typeof aiAgentRequestSchema>;

/** Answer expected from the corporate AI agent. */
export const aiAgentResponseSchema = z.object({
  requestId: z.string().min(1).max(128),
  summary: z.string().max(4000).optional(),
  findings: z
    .array(
      z.object({
        ruleId: z.string().min(1).max(64).default('ai.custom'),
        ruleName: z.string().min(1).max(160),
        severity: complianceSeveritySchema,
        action: complianceActionSchema.default('flag'),
        participantId: z.string().max(64).optional(),
        excerpt: z.string().max(600),
        confidence: z.number().min(0).max(1).optional(),
        recommendation: z.string().max(600).optional(),
      }),
    )
    .max(50),
  model: z.string().max(120).optional(),
  provider: z.string().max(120).optional(),
  /** Optional structured notes (summary/excerpts/action items) from the agent. */
  notes: meetingNotesSchema
    .omit({ createdAt: true, source: true, segmentsAnalyzed: true })
    .partial()
    .optional(),
});

export type AiAgentResponse = z.infer<typeof aiAgentResponseSchema>;

export interface AiAgentConfig {
  enabled: boolean;
  mode: 'local' | 'external' | 'hybrid';
  /** Corporate AI agent endpoint; must be HTTPS in production. */
  endpoint: string;
  /** Reference to a secret, resolved server-side from the environment. */
  apiKeyEnv: string;
  timeoutMs: number;
  sendTranscripts: boolean;
  sendChat: boolean;
  batchSize: number;
  retentionMin: number;
  notifyModerators: boolean;
  policyText: string;
  policyRules: CompliancePolicyRule[];
}

export const aiAgentConfigSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['local', 'external', 'hybrid']),
  endpoint: z.string().max(300),
  apiKeyEnv: z.string().max(100),
  timeoutMs: z.number().int().min(500).max(30000),
  sendTranscripts: z.boolean(),
  sendChat: z.boolean(),
  batchSize: z.number().int().min(1).max(200),
  retentionMin: z.number().int().min(1).max(10080),
  notifyModerators: z.boolean(),
  policyText: z.string().max(20000),
  policyRules: z.array(compliancePolicyRuleSchema).max(100),
});

/** Validates untrusted AI output. Returns null when the payload is unusable. */
export function parseAiAgentResponse(raw: unknown): AiAgentResponse | null {
  const result = aiAgentResponseSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/* ------------------------------------------------------------------ */
/* Knowledge agent (corporate wiki / internal resources Q&A)           */
/* ------------------------------------------------------------------ */

export interface KnowledgeCitation {
  title: string;
  url: string;
  snippet?: string;
}

export const knowledgeCitationSchema = z.object({
  title: z.string().max(300),
  url: z.string().max(2000),
  snippet: z.string().max(1000).optional(),
});

/** Whether an external source is suitable for rendering as a clickable web link. */
export function isKnowledgeCitationWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Request sent to the company's knowledge agent. The company decides which
 * internal resources this user may see — we only forward the identity and the
 * already-enforced permission context, never internal content.
 */
export const knowledgeQueryRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  tenantId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  userId: z.string().max(128).optional(),
  participantId: z.string().max(64).optional(),
  participantName: z.string().max(120).optional(),
  role: z.enum(['host', 'moderator', 'guest']),
  question: z.string().min(1).max(2000),
  locale: z.enum(['ru', 'en']).optional(),
  context: z
    .object({
      roomName: z.string().max(120).optional(),
      /** Short tail of the transcript for pronoun resolution; opt-in per tenant. */
      transcriptTail: z.string().max(4000).optional(),
      systemPrompt: z.string().max(4000).optional(),
      citations: z.boolean().optional(),
      maxAnswerChars: z.number().int().min(100).max(20000).optional(),
    })
    .optional(),
});

export type KnowledgeQueryRequest = z.infer<typeof knowledgeQueryRequestSchema>;

export const knowledgeQueryResponseSchema = z.object({
  requestId: z.string().min(1).max(128),
  answer: z.string().max(20000),
  citations: z.array(knowledgeCitationSchema).max(20).default([]),
  confidence: z.number().min(0).max(1).optional(),
  refused: z.boolean().optional(),
  model: z.string().max(120).optional(),
  provider: z.string().max(120).optional(),
});

export type KnowledgeQueryResponse = z.infer<typeof knowledgeQueryResponseSchema>;

/** Validates the answer of the company's knowledge agent (untrusted input). */
export function parseKnowledgeQueryResponse(raw: unknown): KnowledgeQueryResponse | null {
  const result = knowledgeQueryResponseSchema.safeParse(raw);
  return result.success ? result.data : null;
}
