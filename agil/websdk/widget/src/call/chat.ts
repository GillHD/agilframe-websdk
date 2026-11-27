/**
 * Chat controller (contract §5, §6).
 *
 * Source of truth is the signaling socket: messages flow over `/ws` and stay
 * available when media degrades. The server applies room permissions before
 * delivering messages.
 */
import type { ChatMessage, FileRecord, Role, ServerMessage, TenantConfig } from '@agil/protocol';
import type { ApiClient } from '../api.js';
import { uid } from '../dom.js';
import type { SignalingClient } from './signaling-client.js';

export interface ChatSelf {
  id: string;
  name: string;
  role: Role;
}

export interface ChatControllerOptions {
  signaling: SignalingClient;
  api: ApiClient;
  getConfig: () => TenantConfig;
  roomId: string;
  self: () => ChatSelf | null;
  onMessage: (message: ChatMessage) => void;
  onSystem: (message: ChatMessage) => void;
  onError: (message: string) => void;
  onFileUploadProgress?: (uploading: boolean) => void;
}

type ChatResult = Extract<ServerMessage, { type: 'chat-result' }>;

export class ChatController {
  private readonly options: ChatControllerOptions;
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, (result?: ChatResult) => void>();
  private uploadInFlight = false;

  constructor(options: ChatControllerOptions) {
    this.options = options;
  }

  /** Accepts a message from signaling; returns false for duplicates. */
  ingest(message: ChatMessage): boolean {
    if (!message || typeof message.id !== 'string') return false;
    if (this.seen.has(message.id)) return false;
    this.seen.add(message.id);
    this.options.onMessage(message);
    return true;
  }

  private makeMessage(text: string, kind: ChatMessage['kind'], attachment?: ChatMessage['attachment']): ChatMessage {
    const self = this.options.self();
    const from = self ?? { id: 'self', name: 'Guest', role: 'guest' as Role };
    return {
      id: uid('msg'),
      roomId: this.options.roomId,
      from: { id: from.id, name: from.name, role: from.role },
      text: text.slice(0, 4000),
      ts: Date.now(),
      kind,
      ...(attachment ? { attachment } : {}),
    };
  }

  async send(text: string): Promise<ChatMessage> {
    const trimmed = text.trim();
    const message = this.makeMessage(trimmed, 'text');
    if (!trimmed) return message;
    if (this.options.signaling.chatAcknowledgements) {
      if (!this.options.signaling.isOpen) throw new Error('delivery_failed');
      const result = await new Promise<ChatResult | undefined>((resolve) => {
        const finish = (reply?: ChatResult): void => {
          clearTimeout(timer);
          this.pending.delete(message.id);
          resolve(reply);
        };
        const timer = setTimeout(finish, 35000);
        this.pending.set(message.id, finish);
        if (!this.options.signaling.send({ type: 'chat', id: message.id, text: trimmed, acknowledge: true })) finish();
      });
      if (!result) throw new Error('delivery_unconfirmed');
      if ('error' in result) throw new Error(result.error);
      return result.message;
    }
    // Older servers only send an echo to the room.
    this.seen.add(message.id);
    this.options.signaling.send({ type: 'chat', id: message.id, text: trimmed });
    this.options.onMessage(message);
    return message;
  }

  handleResult(result: ChatResult): void {
    this.pending.get(result.id)?.(result);
  }

  cancelPending(): void {
    for (const finish of this.pending.values()) finish();
  }

  systemMessage(text: string): ChatMessage {
    const message = this.makeMessage(text, 'system');
    this.seen.add(message.id);
    this.options.onSystem(message);
    return message;
  }

  /** Uploads a file with `POST /v1/files` and sends a `kind:'file'` chat message. */
  async sendFile(file: File): Promise<FileRecord | null> {
    const config = this.options.getConfig();
    if (!config.features.fileShare || !config.session.fileShare.enabled) {
      this.options.onError('fileShareDisabled');
      return null;
    }
    const limitBytes = config.session.fileShare.maxFileSizeMb * 1024 * 1024;
    if (file.size > limitBytes) {
      this.options.onError('file_too_large');
      return null;
    }
    if (this.uploadInFlight) return null;
    this.uploadInFlight = true;
    this.options.onFileUploadProgress?.(true);
    try {
      const record = await this.options.api.uploadFile(file);
      const message = this.makeMessage(record.name, 'file', {
        name: record.name,
        size: record.size,
        mime: record.mime,
        url: record.url,
      });
      this.seen.add(message.id);
      this.options.signaling.send({
        type: 'chat',
        id: message.id,
        text: record.name,
        attachment: { name: record.name, size: record.size, mime: record.mime, url: record.url },
      });
      this.options.onMessage(message);
      return record;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'upload_failed';
      this.options.onError(code === 'unsupported_mime' || code === 'file_too_large' ? code : 'file_upload_failed');
      return null;
    } finally {
      this.uploadInFlight = false;
      this.options.onFileUploadProgress?.(false);
    }
  }

  clear(): void {
    this.seen.clear();
  }
}
