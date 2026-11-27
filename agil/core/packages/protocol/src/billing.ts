/**
 * Billing / quota metering baseline.
 *
 * The tenant config carries a `billing` block (plan, included minutes, hard
 * participant/room limits); usage counters are persisted by the server. Plans
 * are entitlement presets — no payment integrations and no card data.
 */
import { z } from 'zod';

export const billingPlanSchema = z.enum(['free', 'team', 'business', 'enterprise']);
export type BillingPlanName = z.infer<typeof billingPlanSchema>;
export const billingPlanNames = billingPlanSchema.options;

/**
 * What happens when a quota is exceeded:
 *  - `allow` — meter only, never warn or block;
 *  - `warn`  — allow the operation but return a warning (default, soft);
 *  - `block` — reject the operation (402 on create, 429 on join).
 */
export const billingOveragePolicySchema = z.enum(['allow', 'warn', 'block']);
export type BillingOveragePolicy = z.infer<typeof billingOveragePolicySchema>;

/**
 * Per-tenant billing configuration (lives inside TenantConfig.billing).
 * `enabled=false` keeps metering but disables quota enforcement.
 */
export const billingConfigSchema = z.object({
  enabled: z.boolean(),
  plan: billingPlanSchema,
  /** Room minutes included per calendar month (UTC). */
  includedMinutes: z.number().int().min(0).max(10_000_000),
  /** Max concurrent participants across the tenant (also caps per-room joins). */
  maxParticipants: z.number().int().min(2).max(50_000),
  /** Max concurrent rooms across the tenant. */
  maxRooms: z.number().int().min(1).max(10_000),
  overagePolicy: billingOveragePolicySchema,
});

export type BillingConfig = z.infer<typeof billingConfigSchema>;

/** Entitlements only (no policy/enabled) for the plan catalog. */
export interface BillingPlanLimits {
  includedMinutes: number;
  maxParticipants: number;
  maxRooms: number;
}

/**
 * Plan catalog used when an admin switches plans: explicit entitlement fields
 * in the PATCH body always win over the catalog values.
 */
export const BILLING_PLANS: Record<BillingPlanName, BillingPlanLimits> = {
  free: { includedMinutes: 0, maxParticipants: 12, maxRooms: 5 },
  team: { includedMinutes: 3000, maxParticipants: 25, maxRooms: 50 },
  business: { includedMinutes: 15000, maxParticipants: 100, maxRooms: 500 },
  enterprise: { includedMinutes: 100000, maxParticipants: 500, maxRooms: 5000 },
};

/** Default: free plan, enforcement off, soft-warning policy. */
export const DEFAULT_BILLING: BillingConfig = {
  enabled: false,
  plan: 'free',
  includedMinutes: BILLING_PLANS.free.includedMinutes,
  maxParticipants: BILLING_PLANS.free.maxParticipants,
  maxRooms: BILLING_PLANS.free.maxRooms,
  overagePolicy: 'warn',
};

/**
 * Admin PATCH body for /v1/admin/billing/plan. Strict: unknown keys (for
 * example card data) are rejected by zod instead of being stored.
 */
export const billingPlanPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    plan: billingPlanSchema.optional(),
    includedMinutes: z.number().int().min(0).max(10_000_000).optional(),
    maxParticipants: z.number().int().min(2).max(50_000).optional(),
    maxRooms: z.number().int().min(1).max(10_000).optional(),
    overagePolicy: billingOveragePolicySchema.optional(),
  })
  .strict();

export type BillingPlanPatch = z.infer<typeof billingPlanPatchSchema>;

/**
 * Applies a plan patch on top of the current billing config. Switching the
 * plan first applies the catalog entitlements; explicit fields in the patch
 * then override them. `enabled`/`overagePolicy` are preserved unless provided.
 */
export function applyBillingPlanPatch(current: BillingConfig, patch: BillingPlanPatch): BillingConfig {
  const base: BillingConfig =
    patch.plan && patch.plan !== current.plan
      ? { ...current, ...BILLING_PLANS[patch.plan], plan: patch.plan }
      : { ...current };
  const next: BillingConfig = {
    ...base,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.plan !== undefined ? { plan: patch.plan } : {}),
    ...(patch.includedMinutes !== undefined ? { includedMinutes: patch.includedMinutes } : {}),
    ...(patch.maxParticipants !== undefined ? { maxParticipants: patch.maxParticipants } : {}),
    ...(patch.maxRooms !== undefined ? { maxRooms: patch.maxRooms } : {}),
    ...(patch.overagePolicy !== undefined ? { overagePolicy: patch.overagePolicy } : {}),
  };
  return billingConfigSchema.parse(next);
}
