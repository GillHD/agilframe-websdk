/**
 * OIDC client-secret env names are server-owned (`AGIL_OIDC_CLIENT_SECRET[_*]`)
 * and — P2 — tenant-bound: a tenant may only select its own
 * `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>` (or a name explicitly mapped to it
 * in `AGIL_OIDC_TENANT_SECRETS`). A globally allowlisted name is not enough.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedOidcClientSecretEnv,
  isOidcClientSecretEnvBoundToTenant,
  normalizeOidcTenantSegment,
  oidcClientSecretEnvTenant,
} from '../src/integrations.js';

test('clientSecretEnv only names the server-owned OIDC secret namespace', () => {
  for (const name of [
    '',
    'AGIL_OIDC_CLIENT_SECRET',
    'AGIL_OIDC_CLIENT_SECRET_DEMO_A',
    'AGIL_OIDC_CLIENT_SECRET_ACME_B',
    // The namespace check trims; the config/flow code stores the trimmed name.
    ' AGIL_OIDC_CLIENT_SECRET_DEMO_A ',
  ]) {
    assert.equal(isAllowedOidcClientSecretEnv(name), true, name);
  }
  for (const name of [
    'AGIL_TOKEN_SECRET',
    'AGIL_PLATFORM_KEY',
    'AGIL_API_KEYS',
    'AGIL_OIDC_TENANT_SECRETS',
    'agil_oidc_client_secret_demo_a',
    'AGIL_OIDC_CLIENT_SECRET_',
    'AGIL_OIDC_CLIENT_SECRET_DEMO-A',
  ]) {
    assert.equal(isAllowedOidcClientSecretEnv(name), false, name);
  }
  assert.equal(isAllowedOidcClientSecretEnv(undefined), false);
  assert.equal(isAllowedOidcClientSecretEnv(42), false);
});

test('tenant segments normalise predictably and the convention is parsed only for <TENANT>_<NAME>', () => {
  // The helper is lossy by design (diagnostics only) — it is NOT used for
  // authorization; see the exact convention/map tests below.
  assert.equal(normalizeOidcTenantSegment('demo'), 'DEMO');
  assert.equal(normalizeOidcTenantSegment(' ACME '), 'ACME');
  assert.equal(normalizeOidcTenantSegment('demo-eu'), 'DEMO_EU');
  assert.equal(normalizeOidcTenantSegment('demo.eu'), 'DEMO_EU');
  // The lossy aliasing that P2-1 exploited still exists in this deprecated
  // helper, which is why authorization must never call it.
  for (const colliding of ['a-b', 'a_b', 'a.b', 'A_B']) {
    assert.equal(normalizeOidcTenantSegment(colliding), 'A_B', colliding);
  }
  assert.equal(normalizeOidcTenantSegment(''), '');
  assert.equal(normalizeOidcTenantSegment(undefined), '');

  assert.equal(oidcClientSecretEnvTenant('AGIL_OIDC_CLIENT_SECRET_DEMO_A'), 'DEMO');
  assert.equal(oidcClientSecretEnvTenant('AGIL_OIDC_CLIENT_SECRET_demo_a'), 'DEMO');
  assert.equal(oidcClientSecretEnvTenant('AGIL_OIDC_CLIENT_SECRET_ACME_B_C'), 'ACME');
  // Global / legacy names carry no tenant segment.
  assert.equal(oidcClientSecretEnvTenant('AGIL_OIDC_CLIENT_SECRET'), null);
  assert.equal(oidcClientSecretEnvTenant('AGIL_OIDC_CLIENT_SECRET_TEST'), null);
  assert.equal(oidcClientSecretEnvTenant('AGIL_OIDC_CLIENT_SECRET_DEMO_'), null);
  assert.equal(oidcClientSecretEnvTenant(undefined), null);
});

test('the naming convention only binds canonical lower-case tenant ids', () => {
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_DEMO_A', 'demo'), true);
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_DEMO_A', 'acme'), false);
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_ACME_B', 'acme'), true);
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_ACME_B', 'demo'), false);
  // Case-only colliding ids are distinct in TenantStore; the convention is
  // defined for the canonical lower-case id, so `DEMO` may not use demo's name.
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_DEMO_A', 'DEMO'), false);
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_DEMO_A', 'Demo'), false);
  // Ids containing separators cannot express a convention segment at all; the
  // `_A_B_*` name parses as tenant `A`, never as `a-b`/`a_b`/`a.b`/`A_B`.
  for (const separatorId of ['a-b', 'a_b', 'a.b', 'A_B']) {
    assert.equal(
      isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_A_B_X', separatorId),
      false,
      separatorId,
    );
    assert.equal(
      isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_A_B_X', separatorId, {
        [separatorId]: 'AGIL_OIDC_CLIENT_SECRET_A_B_X',
      }),
      true,
      `${separatorId} works through the exact map`,
    );
  }
  // Unbound legacy/global names and arbitrary variables are never accepted.
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET', 'demo'), false);
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_TEST', 'demo'), false);
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_TOKEN_SECRET', 'demo'), false);
  // Empty = not configured.
  assert.equal(isOidcClientSecretEnvBoundToTenant('', 'demo'), true);
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_DEMO_A', ''), false);
});

test('an explicit AGIL_OIDC_TENANT_SECRETS entry is authoritative and never shared', () => {
  const map = {
    demo: 'AGIL_OIDC_CLIENT_SECRET',
    acme: 'AGIL_OIDC_CLIENT_SECRET_ACME_B',
  };
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET', 'demo', map), true);
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET', 'acme', map), false);
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_ACME_B', 'acme', map), true);
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_ACME_B', 'demo', map), false);

  // The map wins over the naming convention in both directions: a name mapped
  // to acme is rejected for demo even though its suffix looks like demo's.
  const conflicting = { acme: 'AGIL_OIDC_CLIENT_SECRET_DEMO_A' };
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_DEMO_A', 'acme', conflicting), true);
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_DEMO_A', 'demo', conflicting), false);
});

test('P2: exact tenant-id map comparison rejects every normalisation collision', () => {
  // One distinct secret per colliding tenant id.
  const map = {
    'a-b': 'AGIL_OIDC_CLIENT_SECRET_MAP_DASH',
    a_b: 'AGIL_OIDC_CLIENT_SECRET_MAP_UNDERSCORE',
    'a.b': 'AGIL_OIDC_CLIENT_SECRET_MAP_DOT',
    A_B: 'AGIL_OIDC_CLIENT_SECRET_MAP_UPPER',
    demo: 'AGIL_OIDC_CLIENT_SECRET_MAP_DEMO',
    DEMO: 'AGIL_OIDC_CLIENT_SECRET_MAP_DEMO_UPPER',
  };
  const tenants = Object.keys(map);
  for (const tenant of tenants) {
    for (const other of tenants) {
      assert.equal(
        isOidcClientSecretEnvBoundToTenant(map[other as keyof typeof map], tenant, map),
        tenant === other,
        `${tenant} selecting a name mapped to ${other}`,
      );
    }
  }
  // A name mapped to two tenants is ambiguous and must be rejected for both.
  const ambiguous = { 'a-b': 'AGIL_OIDC_CLIENT_SECRET_SHARED', a_b: 'AGIL_OIDC_CLIENT_SECRET_SHARED' };
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_SHARED', 'a-b', ambiguous), false);
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_SHARED', 'a_b', ambiguous), false);
  // Exact case policy: the map key itself is not case-folded.
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_MAP_DEMO', 'DEMO', map), false);
  assert.equal(isOidcClientSecretEnvBoundToTenant('AGIL_OIDC_CLIENT_SECRET_MAP_DEMO_UPPER', 'demo', map), false);
});
