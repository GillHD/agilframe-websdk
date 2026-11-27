/**
 * Опросы и Q&A внутри комнаты.
 *
 * Опрос создаёт host/moderator; участники голосуют через REST (идемпотентно),
 * результаты и статус транслируются по WS (`poll.updated`).
 */
import { z } from 'zod';

export const pollOptionInputSchema = z.object({
  text: z.string().min(1).max(200),
});

export const createPollSchema = z.object({
  question: z.string().min(3).max(500),
  options: z.array(pollOptionInputSchema).min(2).max(10),
  /** Разрешить выбрать несколько вариантов. */
  multiple: z.boolean().optional().default(false),
  /** Сохраняется для совместимости. Именные ответы не выдаются при обоих значениях. */
  anonymous: z.boolean().optional().default(true),
  /** Q&A-режим: один вариант-ответ не нужен, вопрос задаётся как poll с вариантом «Задать вопрос». */
  kind: z.enum(['poll', 'qna']).optional().default('poll'),
});

export const votePollSchema = z.object({
  optionIds: z.array(z.string().min(1)).min(1).max(10),
});

export interface PollOptionResult {
  id: string;
  text: string;
  votes: number;
  /** Доля от общего числа голосов (0..1). */
  share: number;
  /** Выбран ли текущим участником (персонализируется в ответе). */
  selected?: boolean;
}

export interface RoomPoll {
  id: string;
  roomId: string;
  tenantId: string;
  question: string;
  options: PollOptionResult[];
  multiple: boolean;
  anonymous: boolean;
  kind: 'poll' | 'qna';
  status: 'open' | 'closed';
  createdBy: { id: string; name: string; role: string };
  createdAt: number;
  closedAt?: number;
  totalVotes: number;
  /** Проголосовал ли текущий участник. */
  voted?: boolean;
}

export interface PollListResponse {
  roomId: string;
  polls: RoomPoll[];
}

export interface PollVoteResponse {
  poll: RoomPoll;
  accepted: boolean;
  /** Повторный голос не учитывается (если не multiple). */
  reason?: string;
}

export type PollEventReason = 'created' | 'voted' | 'closed';
