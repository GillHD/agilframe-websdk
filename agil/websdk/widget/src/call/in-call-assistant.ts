/**
 * In-call AI assistant with user-scoped tool calling (contract: assistant.ts,
 * docs/in-call-agent.md).
 *
 * The agent acts on behalf of the connected user: every proposed tool is checked
 * against the user's effective permissions with the *same* protocol helpers the
 * server uses (`filterAssistantActions`/`isAssistantToolAllowed`). The server
 * re-checks and audits the same rules.
 *
 * Modes:
 *  - `local`   — deterministic offline engine (`localAssistantReply`), no network;
 *  - `external`— `POST /v1/rooms/:id/assistant` with the join token;
 *  - `hybrid`  — external with local fallback; 501/404 (local-only server) also
 *                falls back locally so the panel always works.
 */
import {
  assistantActionNeedsConfirmation,
  assistantReplySchema,
  filterAssistantActions,
  isAssistantSpotlightAllowed,
  isAssistantToolAllowed,
  localAssistantReply,
  sanitizeAssistantAction,
  type AssistantAction,
  type AssistantReply,
  type AssistantSpotlight,
  type Role,
  type TenantConfig,
} from '@agil/protocol';
import { ApiError, type ApiClient } from '../api.js';
import { uid } from '../dom.js';
import type { I18n } from '../i18n.js';
import type { InCallAssistantMessage } from '../types.js';

export interface InCallAssistantCompactState {
  participants: number;
  recording: boolean;
  mic: 'on' | 'off';
  camera: 'on' | 'off';
  screenSharing: boolean;
  chatOpen: boolean;
  layoutMode: string;
  qualityTier: string;
}

export interface InCallAssistantOptions {
  api: ApiClient;
  i18n: I18n;
  roomId: () => string;
  getConfig: () => TenantConfig;
  getRole: () => Role;
  getPermissions: () => readonly string[];
  getState: () => InCallAssistantCompactState;
  /** Executes one allowed tool through the public widget instance methods. */
  executeAction: (action: AssistantAction) => Promise<boolean>;
  confirmAction: (action: AssistantAction, execute: () => void) => void;
  showSpotlight: (steps: AssistantSpotlight[]) => void;
  onChange: (state: { messages: InCallAssistantMessage[]; busy: boolean }) => void;
  onDenied: (message: string) => void;
  onError: (message: string, code?: string) => void;
}

const MAX_HISTORY = 30;

export class InCallAssistantController {
  private readonly options: InCallAssistantOptions;
  private messages: InCallAssistantMessage[] = [];
  private busy = false;
  private generation = 0;

  constructor(options: InCallAssistantOptions) {
    this.options = options;
  }

  get available(): boolean {
    return this.options.getConfig().session.inCallAgent.enabled;
  }

  get history(): InCallAssistantMessage[] {
    return this.messages;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Sends the utterance to the configured engine and executes the reply. */
  async ask(text: string): Promise<void> {
    const question = text.trim().slice(0, 2000);
    if (!question || this.busy) return;
    const config = this.options.getConfig().session.inCallAgent;
    if (!config.enabled) return;
    const generation = ++this.generation;
    this.busy = true;
    this.pushMessage({
      id: uid('user'),
      role: 'user',
      text: question,
      actions: [],
      spotlight: [],
      source: 'local',
      pending: false,
      ts: Date.now(),
    });
    this.notify();
    try {
      const reply = await this.resolveReply(question);
      if (generation !== this.generation || !this.available) return;
      this.pushMessage({
        id: reply.id || uid('reply'),
        role: 'assistant',
        text: reply.text,
        actions: reply.actions,
        spotlight: reply.spotlight,
        source: reply.source,
        securityPolicy: reply.securityPolicy,
        pending: false,
        ts: reply.ts || Date.now(),
      });
      this.notify();
      await this.executeReplyActions(reply, generation);
      const current = this.options.getConfig().session.inCallAgent;
      if (generation === this.generation && current.enabled && current.spotlight && reply.spotlight.length > 0) {
        this.options.showSpotlight(reply.spotlight);
      }
    } catch (error) {
      if (generation !== this.generation || !this.available) return;
      const message = this.options.i18n.t('assistantExternalFailed');
      this.pushMessage({
        id: uid('err'),
        role: 'assistant',
        text: message,
        actions: [],
        spotlight: [],
        source: 'external',
        pending: false,
        error: error instanceof Error ? error.message : String(error),
        ts: Date.now(),
      });
      this.notify();
      this.options.onError(message, error instanceof ApiError ? error.code : 'assistant_error');
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.notify();
      }
    }
  }

  private async resolveReply(question: string): Promise<AssistantReply> {
    const config = this.options.getConfig().session.inCallAgent;
    if (config.mode === 'local') return this.localReply(question);
    try {
      return await this.externalReply(question);
    } catch (error) {
      const localOnly =
        error instanceof ApiError &&
        (error.status === 501 || error.status === 404 || error.code === 'assistant_local_only' || error.code === 'not_found');
      if (error instanceof ApiError && ([401, 403, 423, 429].includes(error.status) || error.code === 'assistant_policy_unverified')) throw error;
      if (config.mode === 'hybrid' || localOnly) {
        const local = this.localReply(question);
        if (config.mode === 'external' && localOnly) return local;
        return { ...local, source: 'local' };
      }
      throw error;
    }
  }

  private localReply(question: string): AssistantReply {
    const config = this.options.getConfig().session.inCallAgent;
    return localAssistantReply(
      question,
      {
        locale: this.options.i18n.current,
        role: this.options.getRole(),
        permissions: this.options.getPermissions(),
        tools: config.allowedTools,
        spotlight: config.spotlight,
        state: this.options.getState(),
      },
      {
        id: uid('local'),
        maxActions: config.maxActionsPerReply,
        denyMessage: config.denyMessage,
      },
    );
  }

  private async externalReply(question: string): Promise<AssistantReply> {
    const config = this.options.getConfig().session.inCallAgent;
    const raw = await this.options.api.askAssistant(this.options.roomId(), {
      text: question,
      locale: this.options.i18n.current,
      state: { ...this.options.getState() },
    });
    const candidate =
      typeof raw === 'object' && raw !== null && 'reply' in raw ? (raw as { reply: unknown }).reply : raw;
    const parsed = assistantReplySchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ApiError('bad_reply', 'Assistant returned an invalid payload', 0);
    }
    const reply = parsed.data;
    const access = { role: this.options.getRole(), permissions: this.options.getPermissions(), tools: config.allowedTools };
    return {
      id: reply.id || uid('ext'),
      text: reply.text,
      actions: reply.actions,
      spotlight: config.spotlight ? reply.spotlight.filter(({ target }) => isAssistantSpotlightAllowed(target, access)) : [],
      source: 'external',
      securityPolicy: reply.securityPolicy,
      ts: reply.ts || Date.now(),
    };
  }

  /** Filters the model-proposed actions by tenant tools + user permissions, then runs them. */
  private async executeReplyActions(reply: AssistantReply, generation: number): Promise<void> {
    const config = this.options.getConfig().session.inCallAgent;
    if (reply.actions.length === 0) return;
    const allowedTools = new Set(config.allowedTools);
    const candidates = reply.actions.filter((action) => allowedTools.has(action.tool));
    const context = { role: this.options.getRole(), permissions: this.options.getPermissions() };
    const { allowed, denied } = filterAssistantActions(candidates, context);
    const blocked = denied.length + (reply.actions.length - candidates.length);
    if (blocked > 0) {
      this.options.onDenied(config.denyMessage || this.options.i18n.t('assistantDenied'));
    }
    const limit = Math.max(1, Math.min(config.maxActionsPerReply, allowed.length));
    for (const action of allowed.slice(0, limit)) {
      if (generation !== this.generation || !this.available) return;
      if (!this.options.getConfig().session.inCallAgent.allowedTools.includes(action.tool)) continue;
      const suggestion = reply.source === 'external' ? sanitizeAssistantAction(action) : action;
      if (!suggestion) continue;
      if (reply.source === 'external' && assistantActionNeedsConfirmation(suggestion.tool)) {
        let accepted = false;
        this.options.confirmAction(suggestion, () => {
          const current = this.options.getConfig().session.inCallAgent;
          if (accepted || generation !== this.generation || !current.enabled || !isAssistantToolAllowed(suggestion.tool, {
            role: this.options.getRole(), permissions: this.options.getPermissions(), tools: current.allowedTools,
          })) return;
          accepted = true;
          void this.options.executeAction(suggestion).catch(() => this.options.onError(this.options.i18n.t('assistantExternalFailed')));
        });
        continue;
      }
      try {
        await this.options.executeAction(suggestion);
      } catch {
        this.options.onError(this.options.i18n.t('assistantExternalFailed'));
      }
    }
  }

  private pushMessage(message: InCallAssistantMessage): void {
    this.messages = [...this.messages, message].slice(-MAX_HISTORY);
  }

  private notify(): void {
    this.options.onChange({ messages: this.messages, busy: this.busy });
  }

  clear(): void {
    this.generation += 1;
    this.messages = [];
    this.busy = false;
    this.notify();
  }
}
