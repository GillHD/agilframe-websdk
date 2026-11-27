import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessPolicySchema,
  defaultConfig,
  DEFAULT_ACCESS_POLICY,
  featureKeys,
  tenantConfigSchema,
} from '../src/config.js';
import {
  describeAccess,
  isFeatureAllowed,
  resolveAccess,
  resolveKnowledgeAgentAccess,
} from '../src/access.js';
import type { FeatureKey } from '../src/config.js';

test('default config has a valid access policy covering every feature', () => {
  const config = defaultConfig();
  assert.equal(accessPolicySchema.safeParse(config.security.accessPolicy).success, true);
  assert.deepEqual(new Set(config.security.accessPolicy.roleDefaults.host), new Set(featureKeys));
  assert.deepEqual(new Set(config.security.accessPolicy.roleDefaults.moderator), new Set(featureKeys));
  assert.equal(config.security.accessPolicy.roleDefaults.guest.includes('knowledgeAgent'), false);
  assert.equal(tenantConfigSchema.safeParse(config).success, true);
});

test('role defaults resolve and respect enabled feature flags', () => {
  const config = defaultConfig();
  config.features.recording = true; // feature flag is off by default in DEFAULT_FEATURES
  const guest = resolveAccess({ config, role: 'guest' });
  assert.equal(guest.source, 'role-defaults');
  assert.ok(guest.allowed.includes('chat'));
  assert.ok(!guest.allowed.includes('recording'));
  assert.ok(!guest.allowed.includes('knowledgeAgent'));
  const host = resolveAccess({ config, role: 'host' });
  assert.ok(host.allowed.includes('recording'));
  assert.ok(host.allowed.length > guest.allowed.length);
  assert.ok(describeAccess(host).includes('role=host'));
});

test('disabled feature flag removes permission even for host', () => {
  const config = defaultConfig();
  config.features.recording = false;
  assert.equal(isFeatureAllowed({ config, role: 'host' }, 'recording'), false);
});

test('deniedFeatures beats role defaults', () => {
  const config = defaultConfig();
  config.security.accessPolicy.deniedFeatures.push('chat');
  const host = resolveAccess({ config, role: 'host' });
  assert.ok(!host.allowed.includes('chat'));
  assert.ok(host.denied.includes('chat'));
});

test('per-user override replaces role defaults', () => {
  const config = defaultConfig();
  config.security.accessPolicy.mode = 'strict';
  config.security.accessPolicy.userOverrides['user-42'] = ['chat', 'knowledgeAgent'];
  const resolved = resolveAccess({ config, role: 'guest', userId: 'user-42' });
  assert.equal(resolved.source, 'user-override');
  assert.deepEqual(resolved.allowed.sort(), ['chat', 'knowledgeAgent']);
});

test('strict mode without grants allows nothing', () => {
  const config = defaultConfig();
  config.security.accessPolicy.mode = 'strict';
  const resolved = resolveAccess({ config, role: 'host' });
  assert.equal(resolved.source, 'strict');
  assert.equal(resolved.allowed.length, 0);
});

test('token permissions replace everything (issuer decides)', () => {
  const config = defaultConfig();
  config.features.recording = false;
  const permissions: FeatureKey[] = ['chat', 'recording', 'knowledgeAgent'];
  const resolved = resolveAccess({ config, role: 'guest', tokenPermissions: permissions });
  assert.equal(resolved.source, 'token');
  assert.ok(resolved.allowed.includes('chat'));
  // flag is off in tenant config -> filtered out
  assert.ok(!resolved.allowed.includes('recording'));
  assert.ok(resolved.allowed.includes('knowledgeAgent'));
});

test('knowledge agent access is gated by config, role and permission', () => {
  const config = defaultConfig();
  assert.equal(resolveKnowledgeAgentAccess({ config, role: 'host' }).reason, 'disabled');

  config.session.knowledgeAgent.enabled = true;
  config.session.knowledgeAgent.endpoint = 'https://wiki.company/ask';
  assert.equal(resolveKnowledgeAgentAccess({ config, role: 'host' }).allowed, true);
  assert.equal(resolveKnowledgeAgentAccess({ config, role: 'guest' }).reason, 'role');

  config.session.knowledgeAgent.allowedRoles = ['host', 'moderator', 'guest'];
  config.session.knowledgeAgent.requirePermission = true;
  assert.equal(resolveKnowledgeAgentAccess({ config, role: 'guest' }).reason, 'permission');
  const granted = resolveKnowledgeAgentAccess({
    config,
    role: 'guest',
    tokenPermissions: ['knowledgeAgent'],
  });
  assert.equal(granted.allowed, true);

  config.session.knowledgeAgent.endpoint = '';
  assert.equal(resolveKnowledgeAgentAccess({ config, role: 'host' }).reason, 'not_configured');
});

test('default policy clone is not shared between configs', () => {
  const a = defaultConfig();
  const b = defaultConfig();
  a.security.accessPolicy.roleDefaults.guest.push('recording');
  assert.ok(!b.security.accessPolicy.roleDefaults.guest.includes('recording'));
  assert.ok(!DEFAULT_ACCESS_POLICY.roleDefaults.guest.includes('recording'));
});
