/**
 * Corporate OIDC config contract: discovery/auth-method/response-mode/
 * RP-initiated-logout fields, their defaults and validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OIDC_DISCOVERY_WELL_KNOWN_PATH,
  OIDC_RESPONSE_MODES,
  OIDC_TOKEN_ENDPOINT_AUTH_METHODS,
  identityConfigSchema,
} from '../src/integrations.js';
import { defaultConfig } from '../src/config.js';

const baseIdentity = {
  mode: 'oidc' as const,
  issuer: 'https://sso.example.com/realms/corp',
  audience: 'agil-calls',
  jwksUrl: 'https://sso.example.com/realms/corp/certs',
  userIdClaim: 'sub',
  nameClaim: 'name',
  roleClaim: 'role',
  permissionsClaim: 'permissions',
  verifiedClaim: 'verified',
};

test('corporate OIDC fields default to the backwards-compatible query/post behavior', () => {
  const parsed = identityConfigSchema.parse(baseIdentity);
  assert.equal(parsed.discovery, false);
  assert.equal(parsed.discoveryUrl, '');
  assert.equal(parsed.tokenEndpointAuthMethod, 'client_secret_post');
  assert.equal(parsed.responseMode, 'query');
  assert.equal(parsed.endSessionEndpoint, '');
  assert.equal(parsed.postLogoutRedirectUri, '');
});

test('defaultConfig carries the same new defaults (tenant configs stay valid)', () => {
  const identity = defaultConfig({ tenantId: 'demo' }).integrations.identity;
  assert.equal(identity.discovery, false);
  assert.equal(identity.discoveryUrl, '');
  assert.equal(identity.tokenEndpointAuthMethod, 'client_secret_post');
  assert.equal(identity.responseMode, 'query');
  assert.equal(identity.endSessionEndpoint, '');
  assert.equal(identity.postLogoutRedirectUri, '');
});

test('discovery and RP-initiated logout fields round-trip through the schema', () => {
  const parsed = identityConfigSchema.parse({
    ...baseIdentity,
    discovery: true,
    discoveryUrl: 'https://sso.example.com/metadata.json',
    tokenEndpointAuthMethod: 'client_secret_basic',
    responseMode: 'form_post',
    endSessionEndpoint: 'https://sso.example.com/realms/corp/logout',
    postLogoutRedirectUri: 'https://calls.example.com/dashboard/',
  });
  assert.equal(parsed.discovery, true);
  assert.equal(parsed.discoveryUrl, 'https://sso.example.com/metadata.json');
  assert.equal(parsed.tokenEndpointAuthMethod, 'client_secret_basic');
  assert.equal(parsed.responseMode, 'form_post');
  assert.equal(parsed.endSessionEndpoint, 'https://sso.example.com/realms/corp/logout');
  assert.equal(parsed.postLogoutRedirectUri, 'https://calls.example.com/dashboard/');
});

test('invalid token auth method / response mode / oversized URLs are rejected', () => {
  assert.throws(() => identityConfigSchema.parse({ ...baseIdentity, tokenEndpointAuthMethod: 'private_key_jwt' }));
  assert.throws(() => identityConfigSchema.parse({ ...baseIdentity, tokenEndpointAuthMethod: 'none' }));
  assert.throws(() => identityConfigSchema.parse({ ...baseIdentity, responseMode: 'fragment' }));
  assert.throws(() => identityConfigSchema.parse({ ...baseIdentity, discoveryUrl: `https://x/${'a'.repeat(600)}` }));
  assert.throws(() => identityConfigSchema.parse({ ...baseIdentity, endSessionEndpoint: `https://x/${'a'.repeat(600)}` }));
  assert.throws(() => identityConfigSchema.parse({ ...baseIdentity, discovery: 'yes' }));
});

test('constants expose the OIDC discovery path and the supported auth methods/modes', () => {
  assert.equal(OIDC_DISCOVERY_WELL_KNOWN_PATH, '/.well-known/openid-configuration');
  assert.deepEqual([...OIDC_TOKEN_ENDPOINT_AUTH_METHODS], ['client_secret_post', 'client_secret_basic']);
  assert.deepEqual([...OIDC_RESPONSE_MODES], ['query', 'form_post']);
});
