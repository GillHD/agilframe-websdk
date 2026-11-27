import { z } from 'zod';
import {
  ALL_FEATURE_KEYS,
  effectiveMediaMode,
  featureKeySchema,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type FeatureKey,
  type Role,
} from '@agil/protocol';
import { ApiClient, ApiError } from '../../widget/src/api.js';

export interface RoomProfileRef {
  schemaVersion: 1;
  id: string;
  version: number;
}

export interface RoomProfileV1 extends RoomProfileRef {
  room: {
    mode: 'direct' | 'group';
    media: 'tenant' | 'p2p' | 'sfu';
  };
  features: readonly FeatureKey[];
  roles: Readonly<Record<Role, readonly FeatureKey[]>>;
}

export type RoomProfileCreateOptions = Pick<CreateRoomRequest,
  'roomId' | 'name' | 'password' | 'ttlSec' | 'maxParticipants' | 'context' | 'allowedParticipantIds'> & { tenantId: string };

export interface CreateProfileRoomOptions {
  serverUrl: string;
  apiKey: string;
  profile: RoomProfileV1;
  room: RoomProfileCreateOptions;
}

export interface ProfileRoomResult extends CreateRoomResponse {
  profile: RoomProfileRef;
}

const roomProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  version: z.number().int().positive(),
  room: z.strictObject({ mode: z.enum(['direct', 'group']), media: z.enum(['tenant', 'p2p', 'sfu']) }),
  features: z.array(featureKeySchema),
  roles: z.strictObject({
    host: z.array(featureKeySchema),
    moderator: z.array(featureKeySchema),
    guest: z.array(featureKeySchema),
  }),
});

/** Compile a profile owned by the integrating service into the existing Core room request. */
export function compileRoomProfile(profile: RoomProfileV1, room: RoomProfileCreateOptions): CreateRoomRequest {
  const parsed = roomProfileSchema.parse(profile);
  const enabled = new Set(parsed.features);
  for (const [role, features] of Object.entries(parsed.roles)) {
    for (const feature of features) {
      if (!enabled.has(feature)) throw new TypeError(`Role ${role} grants a feature outside the room profile: ${feature}`);
    }
  }
  const p2p = parsed.room.media === 'p2p';
  if (parsed.room.mode === 'direct' && room.maxParticipants !== undefined && room.maxParticipants !== 2) {
    throw new TypeError('Direct room profiles have exactly two seats');
  }
  if (p2p && (parsed.room.mode !== 'direct' || enabled.has('liveStreaming') || enabled.has('webinarMode'))) {
    throw new TypeError('P2P requires a direct room profile without live streaming or webinar');
  }
  const features: Partial<Record<FeatureKey, boolean>> = {};
  for (const feature of ALL_FEATURE_KEYS) features[feature] = enabled.has(feature);
  const { tenantId, roomId, name, password, ttlSec, maxParticipants, context, allowedParticipantIds } = room;
  return {
    tenantId, roomId, name, password, ttlSec, maxParticipants, context, allowedParticipantIds,
    mode: parsed.room.mode,
    ...(p2p ? { transport: 'p2p' as const } : {}),
    configOverrides: {
      features,
      security: { accessPolicy: { roleDefaults: parsed.roles } },
      // The same tenant can host SFU streams and direct peer-to-peer rooms.
      ...(p2p ? {
        scale: { streaming: { enabled: false }, webinar: { enabled: false } },
        mediaProcessing: { egress: false },
      } : {}),
    },
  };
}

/** Run on the integrating service. Only its server may use a tenant API key. */
export async function createProfileRoom(options: CreateProfileRoomOptions): Promise<ProfileRoomResult> {
  if (typeof window !== 'undefined') throw new TypeError('createProfileRoom requires a trusted backend');
  const key = options.apiKey.trim();
  if (!key) throw new TypeError('A tenant API key is required');
  const { profile, room } = options;
  const request = compileRoomProfile(profile, room);
  const expectedMedia = profile.room.media === 'p2p' ? 'mesh' : profile.room.media === 'sfu' ? 'sfu' : undefined;
  const ref: RoomProfileRef = { schemaVersion: 1, id: profile.id, version: profile.version };
  const api = new ApiClient({ baseUrl: options.serverUrl });
  if (expectedMedia === 'sfu') {
    const config = await api.getConfig(room.tenantId);
    if (effectiveMediaMode(config.scale, request.mode) !== 'sfu') {
      throw new ApiError('room_profile_media_mismatch', 'The tenant must provide SFU media for this profile', 409);
    }
  }
  const result = await api.createRoom(request, key);
  if (expectedMedia && result.room.mediaMode !== expectedMedia) {
    throw new ApiError('room_profile_media_mismatch', 'Core changed the media assignment during creation', 409, { roomId: result.room.id });
  }
  return { ...result, profile: ref };
}
