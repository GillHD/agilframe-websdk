import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TENANT_ID,
  defaultConfig,
  enabledFeatures,
  resolveTenantConfig,
  tenantConfigPatchSchema,
  tenantConfigSchema,
} from '../src/config.js';
import {
  DEFAULT_SFU_CAPACITY_PROFILE,
  SFU_CAPACITY_PROFILES,
  resolveSfuCapacityProfile,
} from '../src/scaling.js';

test('defaultConfig validates and has sane defaults', () => {
  const config = defaultConfig({ tenantId: 'acme' });
  assert.equal(config.tenantId, 'acme');
  assert.equal(config.configVersion, 1);
  assert.equal(config.features.chat, true);
  assert.equal(config.video.preferredCodec, 'vp9');
  assert.equal(config.fallback.lowBandwidth.enabled, true);
  assert.equal(config.theme.scheme, 'auto');
  assert.equal(tenantConfigSchema.safeParse(config).success, true);
});

test('defaultConfig accepts theme preset and patch', () => {
  const config = defaultConfig({
    tenantId: 'acme',
    themePreset: 'night',
    themePatch: { colors: { primary: '#ff0055' } } as never,
  });
  assert.equal(config.theme.scheme, 'dark');
  assert.equal(config.theme.colors.primary, '#ff0055');
});

test('resolveTenantConfig applies deep partial patch', () => {
  const base = defaultConfig({ tenantId: 'acme' });
  const patched = resolveTenantConfig(
    {
      features: { recording: true },
      video: { maxResolution: '1080p' },
      theme: { colors: { primary: '#123456' } },
    } as never,
    base,
  );
  assert.equal(patched.features.recording, true);
  assert.equal(patched.video.maxResolution, '1080p');
  assert.equal(patched.theme.colors.primary, '#123456');
  assert.equal(patched.features.chat, true); // untouched
});

test('resolveTenantConfig creates base when missing', () => {
  const patched = resolveTenantConfig({ tenantId: 'newco', features: { chat: false } } as never);
  assert.equal(patched.tenantId, 'newco');
  assert.equal(patched.features.chat, false);
});

test('invalid config is rejected by schema', () => {
  const config = defaultConfig({ tenantId: DEFAULT_TENANT_ID });
  const broken = { ...config, limits: { ...config.limits, maxParticipants: 1 } };
  assert.equal(tenantConfigSchema.safeParse(broken).success, false);
  const brokenTheme = { ...config, theme: { ...config.theme, colors: { ...config.theme.colors, primary: 'not-a-color' } } };
  assert.equal(tenantConfigSchema.safeParse(brokenTheme).success, false);
});

test('patch schema allows empty object', () => {
  assert.deepEqual(tenantConfigPatchSchema.parse({}), {});
});

test('partial updates do not materialize defaults for omitted fields', () => {
  const patch = { theme: { colors: { primary: '#123456' } }, scale: { sip: { trunkId: 'test-trunk' } } };
  assert.deepEqual(tenantConfigPatchSchema.parse(patch), patch);
});

test('gallery video budget override is optional, patchable and range-checked', () => {
  const base = defaultConfig({ tenantId: 'acme' });
  assert.equal(base.limits.galleryVideoBudget, undefined, 'unset = adaptive budget');
  assert.equal(base.scale.maxVisibleVideos, undefined, 'unset = adaptive budget');

  const patch = tenantConfigPatchSchema.safeParse({
    limits: { galleryVideoBudget: 6 },
    scale: { maxVisibleVideos: 4 },
  });
  assert.equal(patch.success, true, JSON.stringify(patch.success ? {} : patch.error.issues));

  const patched = resolveTenantConfig(
    { tenantId: 'acme', limits: { galleryVideoBudget: 6 }, scale: { maxVisibleVideos: 4 } } as never,
    base,
  );
  assert.equal(patched.limits.galleryVideoBudget, 6);
  assert.equal(patched.scale.maxVisibleVideos, 4);
  assert.equal(patched.scale.maxVideoSubscriptions, base.scale.maxVideoSubscriptions, 'hard cap survives');

  assert.equal(tenantConfigPatchSchema.safeParse({ limits: { galleryVideoBudget: 0 } }).success, false);
  assert.equal(tenantConfigPatchSchema.safeParse({ limits: { galleryVideoBudget: 1001 } }).success, false);
  assert.equal(tenantConfigPatchSchema.safeParse({ scale: { maxVisibleVideos: 0 } }).success, false);
});

test('SFU capacity profile: default standard, optional in configs, enum-validated', () => {
  const base = defaultConfig({ tenantId: 'acme' });
  assert.equal(base.scale.sfu.capacityProfile, 'standard', 'new deployments default to standard');
  assert.equal(DEFAULT_SFU_CAPACITY_PROFILE, 'standard');
  assert.deepEqual(
    Object.fromEntries(Object.entries(SFU_CAPACITY_PROFILES).map(([key, spec]) => [key, spec.remoteVideosPerClient])),
    { low: 2, standard: 6, high: 12 },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(SFU_CAPACITY_PROFILES).map(([key, spec]) => [key, spec.participants])),
    { low: 25, standard: 50, high: 200 },
    'participant capacity follows the SFU profile (low pilot = 25, not 200)',
  );
  assert.equal(resolveSfuCapacityProfile('low'), 'low');
  assert.equal(resolveSfuCapacityProfile('high'), 'high');
  assert.equal(resolveSfuCapacityProfile('turbo'), 'standard', 'unknown values fall back to the default');
  assert.equal(resolveSfuCapacityProfile(undefined), 'standard');

  // A persisted pre-profile config (sfu without capacityProfile) still loads.
  const legacy = structuredClone(base);
  delete (legacy.scale.sfu as { capacityProfile?: string }).capacityProfile;
  assert.equal(tenantConfigSchema.safeParse(legacy).success, true);

  const patch = tenantConfigPatchSchema.safeParse({ scale: { sfu: { capacityProfile: 'high' } } });
  assert.equal(patch.success, true, JSON.stringify(patch.success ? {} : patch.error.issues));
  assert.equal(tenantConfigPatchSchema.safeParse({ scale: { sfu: { capacityProfile: 'max' } } }).success, false);

  const patched = resolveTenantConfig({ tenantId: 'acme', scale: { sfu: { capacityProfile: 'high' } } } as never, base);
  assert.equal(patched.scale.sfu.capacityProfile, 'high');

  // Deep-partial patches must not inject the default into an unrelated sfu patch.
  const urlOnly = tenantConfigPatchSchema.safeParse({ scale: { sfu: { url: 'wss://sfu.example' } } });
  assert.equal(urlOnly.success, true);
  assert.equal(
    urlOnly.success ? urlOnly.data.scale?.sfu?.capacityProfile : 'parse-failed',
    undefined,
    'patching another sfu field must not force a profile value',
  );
});

test('enabledFeatures lists only true flags', () => {
  const config = defaultConfig();
  const features = enabledFeatures(config);
  assert.ok(features.includes('chat'));
  assert.ok(!features.includes('recording'));
});

test('scale.sip is off by default, deep-partial patchable and E.164-validated', () => {
  const base = defaultConfig({ tenantId: 'acme' });
  assert.deepEqual(base.scale.sip, {
    enabled: false,
    provider: 'livekit-sip',
    wsUrl: '',
    httpUrl: '',
    trunkId: '',
    dialInNumbers: [],
    callerId: '',
    maxConcurrent: 10,
    maxCallDurationSec: 3600,
    region: '',
  });

  const patch = tenantConfigPatchSchema.safeParse({
    scale: { sip: { enabled: true, trunkId: 'ST_test' } },
  });
  assert.equal(patch.success, true, JSON.stringify(patch.success ? {} : patch.error.issues));

  const patched = resolveTenantConfig(
    {
      scale: {
        sip: {
          enabled: true,
          httpUrl: 'https://sip.example',
          trunkId: 'ST_test',
          dialInNumbers: ['+74951234567'],
          callerId: '+74950000000',
          maxConcurrent: 5,
          maxCallDurationSec: 1800,
          region: 'ru-msk',
        },
      },
    } as never,
    base,
  );
  assert.equal(patched.scale.sip.enabled, true);
  assert.equal(patched.scale.sip.provider, 'livekit-sip');
  assert.equal(patched.scale.sip.trunkId, 'ST_test');
  assert.equal(patched.scale.sip.maxConcurrent, 5);
  assert.equal(patched.scale.sip.maxCallDurationSec, 1800);
  assert.equal(patched.scale.sip.region, 'ru-msk');
  assert.deepEqual(patched.scale.sip.dialInNumbers, ['+74951234567']);
  assert.equal(patched.scale.sip.wsUrl, ''); // untouched sibling field survives
  assert.equal(patched.scale.mediaMode, 'mesh');

  // Minimal deep-partial patch resolves against the stored config.
  assert.equal(patch.success, true);
  if (patch.success) {
    const minimal = resolveTenantConfig({ ...patch.data, tenantId: 'acme' }, base);
    assert.equal(minimal.scale.sip.enabled, true);
    assert.equal(minimal.scale.sip.trunkId, 'ST_test');
    assert.equal(minimal.scale.sip.provider, 'livekit-sip'); // default survives
    assert.equal(minimal.scale.sip.maxConcurrent, 10); // default survives
    assert.equal(minimal.scale.mediaMode, 'mesh'); // sibling scale field survives
  }

  assert.equal(tenantConfigPatchSchema.safeParse({ scale: { sip: { dialInNumbers: ['89991234567'] } } }).success, false);
  assert.equal(tenantConfigPatchSchema.safeParse({ scale: { sip: { callerId: 'not-a-number' } } }).success, false);
});

test('R1: full tenant config without scale.sip (legacy document) defaults SIP and keeps settings', () => {
  const current = defaultConfig({ tenantId: 'legacy' });
  const legacy = structuredClone(current) as Record<string, any>;
  legacy.features.chat = false;
  legacy.branding.productName = 'Legacy Corp';
  delete (legacy.scale as Record<string, unknown>).sip;

  const parsed = tenantConfigSchema.safeParse(legacy);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
  if (!parsed.success) return;
  assert.equal(parsed.data.features.chat, false, 'custom settings are preserved, not replaced by defaults');
  assert.equal(parsed.data.branding.productName, 'Legacy Corp');
  assert.deepEqual(parsed.data.scale.sip, defaultConfig({ tenantId: 'legacy' }).scale.sip);
  assert.equal(parsed.data.scale.mediaMode, current.scale.mediaMode, 'sibling scale settings survive');

  // The patch contract is still deep-partial and does not inject full defaults.
  assert.deepEqual(
    tenantConfigPatchSchema.parse({ scale: { sip: { enabled: true, trunkId: 'ST_legacy' } } }),
    { scale: { sip: { enabled: true, trunkId: 'ST_legacy' } } },
  );
});
