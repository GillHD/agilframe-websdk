/**
 * Breakout rooms: the host splits participants into sub-rooms, each gets its
 * own room token, and closing the breakouts returns everyone to the main call.
 */
import { z } from 'zod';

export const breakoutRoomInputSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  participantIds: z.array(z.string().min(1)).optional(),
});

export const createBreakoutSchema = z.object({
  mode: z.enum(['random', 'manual']).optional().default('random'),
  /** Explicit groups (manual) or number of rooms to distribute randomly. */
  rooms: z.array(breakoutRoomInputSchema).min(2).max(20).optional(),
  count: z.number().int().min(2).max(20).optional(),
  durationMin: z.number().int().min(1).max(240).optional(),
  allowReturn: z.boolean().optional().default(true),
});

export type BreakoutMode = 'random' | 'manual';

export interface BreakoutRoomInfo {
  id: string;
  /** Underlying room id (child room) that participants join. */
  roomId: string;
  name: string;
  index: number;
  participantIds: string[];
  status: 'open' | 'closed';
}

export interface BreakoutAssignment {
  participantId: string;
  participantName: string;
  breakoutRoomId: string;
  roomId: string;
  /** Short-lived token to join the child room (returned to that participant only). */
  token?: string;
  joinUrl?: string;
}

export interface BreakoutPlan {
  id: string;
  mainRoomId: string;
  status: 'active' | 'closed';
  mode: BreakoutMode;
  rooms: BreakoutRoomInfo[];
  assignments: Record<string, string>;
  allowReturn: boolean;
  createdAt: number;
  endsAt?: number;
  closedAt?: number;
}

export interface BreakoutPlanResponse {
  plan: BreakoutPlan;
}

export interface BreakoutAssignedMessage {
  planId: string;
  breakoutRoomId: string;
  roomId: string;
  name: string;
  token: string;
  joinUrl: string;
}

export interface BreakoutListResponse {
  roomId: string;
  plan?: BreakoutPlan;
}
