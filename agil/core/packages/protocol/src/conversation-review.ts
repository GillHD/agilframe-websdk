import { z } from 'zod';

const category = z.enum(['ethics', 'disclosure']);
const severity = z.enum(['warn', 'critical']);

export const conversationReviewPolicySchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true),
    retentionMin: z.number().int().min(1).max(120).default(30),
    rules: z.array(z.object({
      id: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
      category,
      severity,
      phrase: z.string().trim().min(3).max(120),
    }).strict()).min(1).max(30).refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, 'Rule IDs must be unique'),
  }).strict(),
]);

export type ConversationReviewPolicy = z.infer<typeof conversationReviewPolicySchema>;

export interface ConversationReviewFinding {
  ruleId: string;
  category: z.infer<typeof category>;
  severity: z.infer<typeof severity>;
  at: number;
}

export interface ConversationReviewReport {
  policy: ConversationReviewPolicy;
  findings: ConversationReviewFinding[];
}
