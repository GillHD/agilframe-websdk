/**
 * The small UI surface `AgilWidgetSession` uses while joining/controlling a
 * call. `WidgetApp` (default UI) and `HeadlessUi` both implement it, so the
 * controller never assumes that built-in markup exists.
 */
import type { CallState } from '../types.js';
import type { ToastAction } from './toasts.js';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface WidgetUi {
  closeControlPopovers?(): void;
  readonly toasts: { clear(): void; dismissMessage?(message: string, kind?: ToastKind): void };
  update(state: CallState): void;
  setSpotlightFollowSpeaker(participantId: string): void;
  setSpeaking(participantId: string, speaking: boolean): void;
  showToast(message: string, kind?: ToastKind, timeoutMs?: number, actions?: ToastAction[]): void;
  showParticipantNotice?(name: string, joined: boolean): void;
  clearParticipantNotice?(): void;
  showJoinError(code: string, message?: string): void;
  setJoinOffline(offline: boolean): void;
  setJoinBusy(busy: boolean): void;
  joinScreenName(name: string): void;
  joinScreenServer(text: string): void;
  focusJoin(): void;
  setChatUploading?(uploading: boolean): void;
  focusSettingsDevices(): void;
  showReaction(emoji: string, name: string): void;
  destroy(): void;
}
