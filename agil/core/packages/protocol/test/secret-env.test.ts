/**
 * Tenant config secret references must only name server-owned env namespaces
 * (`AGIL_INTEGRATION_*`, `AGIL_WEBHOOK_*`, `AGIL_SIEM_*`, `AGIL_SFU_*`,
 * `AGIL_TURN_*`). Anything else is an arbitrary `process.env` read primitive
 * for a tenant admin and must be rejected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeTenantSecretEnv,
  isAllowedTenantSecretEnv,
  isAllowedTenantSecretEnvName,
  normaliseTenantSecretEnvRef,
  TENANT_SECRET_ENV_KINDS,
  TENANT_SECRET_ENV_PREFIX,
  tenantSecretEnvRule,
} from '../src/secret-env.js';

const REJECTED = [
  'AGIL_TOKEN_SECRET',
  'AGIL_PLATFORM_KEY',
  'AGIL_API_KEYS',
  'AGIL_SCIM_TOKEN',
  'AGIL_E2EE_SECRET',
  'AGIL_DEEPSEEK_API_KEY',
  'AGIL_EGRESS_S3_SECRET_KEY',
  'AGIL_PUBLIC_ORIGIN',
  'AWS_SECRET_ACCESS_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'DATABASE_URL',
  'NODE_OPTIONS',
  'HOME',
  'PATH',
];

test('accepts only the documented prefix for each kind', () => {
  assert.equal(isAllowedTenantSecretEnv('AGIL_INTEGRATION_AI_KEY', 'integration'), true);
  assert.equal(isAllowedTenantSecretEnv('AGIL_INTEGRATION_FILES_PROVIDER_KEY', 'integration'), true);
  assert.equal(isAllowedTenantSecretEnv('AGIL_WEBHOOK_BILLING_SECRET', 'webhook'), true);
  assert.equal(isAllowedTenantSecretEnv('AGIL_SIEM_COLLECTOR_SECRET', 'siem'), true);
  assert.equal(isAllowedTenantSecretEnv('AGIL_SFU_API_KEY', 'sfu'), true);
  assert.equal(isAllowedTenantSecretEnv('AGIL_TURN_MSK_SECRET', 'turn'), true);
  // Empty = "not configured", always acceptable.
  for (const kind of TENANT_SECRET_ENV_KINDS) {
    assert.equal(isAllowedTenantSecretEnv('', kind), true);
  }
});

test('rejects arbitrary server variables for every kind', () => {
  for (const kind of TENANT_SECRET_ENV_KINDS) {
    for (const name of REJECTED) {
      assert.equal(isAllowedTenantSecretEnv(name, kind), false, `${kind}: ${name}`);
      assert.equal(isAllowedTenantSecretEnvName(name), false, name);
    }
  }
});

test('rejects cross-kind references so a secret cannot be sent through another surface', () => {
  assert.equal(isAllowedTenantSecretEnv('AGIL_WEBHOOK_SHARED', 'integration'), false);
  assert.equal(isAllowedTenantSecretEnv('AGIL_SIEM_SHARED', 'integration'), false);
  assert.equal(isAllowedTenantSecretEnv('AGIL_INTEGRATION_SHARED', 'webhook'), false);
  assert.equal(isAllowedTenantSecretEnv('AGIL_INTEGRATION_SHARED', 'siem'), false);
  assert.equal(isAllowedTenantSecretEnv('AGIL_TURN_SHARED', 'sfu'), false);
  assert.equal(isAllowedTenantSecretEnv('AGIL_SFU_SHARED', 'turn'), false);
});

test('rejects malformed names, whitespace and lowercase', () => {
  for (const name of ['AGIL_INTEGRATION_', 'AGIL_INTEGRATION_lower', 'agil_integration_x', ' AGIL_INTEGRATION_X', 'AGIL_INTEGRATION_X ', 'AGIL-WEBHOOK-X', '1AGIL_WEBHOOK_X', '']) {
    if (name === '') continue; // empty is "not configured" and allowed
    assert.equal(isAllowedTenantSecretEnv(name, 'integration'), false, name);
  }
  assert.equal(isAllowedTenantSecretEnv('AGIL_INTEGRATION_' + 'X'.repeat(200), 'integration'), false);
  assert.equal(isAllowedTenantSecretEnv(undefined, 'integration'), false);
  assert.equal(isAllowedTenantSecretEnv(42, 'integration'), false);
});

test('keeps the shipped agent/provider key names as an explicit legacy allowlist', () => {
  assert.equal(isAllowedTenantSecretEnv('AGIL_AI_AGENT_KEY', 'integration'), true);
  assert.equal(isAllowedTenantSecretEnv('AGIL_KNOWLEDGE_AGENT_KEY', 'integration'), true);
  assert.equal(isAllowedTenantSecretEnv('AGIL_INCALL_AGENT_KEY', 'integration'), true);
  assert.equal(isAllowedTenantSecretEnv('AGIL_CHAT_PROVIDER_KEY', 'integration'), true);
  assert.equal(isAllowedTenantSecretEnv('AGIL_STT_PROVIDER_KEY', 'integration'), true);
  // Legacy names are integration-only, not a universal bypass.
  assert.equal(isAllowedTenantSecretEnv('AGIL_AI_AGENT_KEY', 'webhook'), false);
  assert.equal(isAllowedTenantSecretEnv('AGIL_CHAT_PROVIDER_KEY', 'webhook'), false);
});

test('snapshot filter accepts any allowlisted namespace and nothing else', () => {
  assert.equal(isAllowedTenantSecretEnvName('AGIL_INTEGRATION_X'), true);
  assert.equal(isAllowedTenantSecretEnvName('AGIL_WEBHOOK_X'), true);
  assert.equal(isAllowedTenantSecretEnvName('AGIL_SIEM_X'), true);
  assert.equal(isAllowedTenantSecretEnvName('AGIL_SFU_X'), true);
  assert.equal(isAllowedTenantSecretEnvName('AGIL_TURN_X'), true);
  assert.equal(isAllowedTenantSecretEnvName('AGIL_TOKEN_SECRET'), false);
});

test('server tuning knobs that share a secret prefix are not accepted', () => {
  for (const name of ['AGIL_WEBHOOK_TIMEOUT_MS', 'AGIL_WEBHOOK_RETRIES']) {
    assert.equal(isAllowedTenantSecretEnv(name, 'webhook'), false, name);
    assert.equal(isAllowedTenantSecretEnvName(name), false, name);
  }
  for (const name of ['AGIL_SFU_URL', 'AGIL_SFU_ENABLED', 'AGIL_SFU_NODE_ID', 'AGIL_SFU_NODES', 'AGIL_SFU_PROFILE']) {
    assert.equal(isAllowedTenantSecretEnv(name, 'sfu'), false, name);
    assert.equal(isAllowedTenantSecretEnvName(name), false, name);
  }
});

test('human-readable rules match the prefix table', () => {
  assert.equal(tenantSecretEnvRule('webhook'), 'AGIL_WEBHOOK_*');
  for (const kind of TENANT_SECRET_ENV_KINDS) {
    assert.ok(describeTenantSecretEnv(kind).startsWith(TENANT_SECRET_ENV_PREFIX[kind]));
  }
  assert.equal(normaliseTenantSecretEnvRef('  AGIL_WEBHOOK_X  '), 'AGIL_WEBHOOK_X');
  assert.equal(normaliseTenantSecretEnvRef(undefined), '');
});
