/**
 * Clean headless path: no built-in markup is created. The widget root stays as
 * an empty, themed container so a host can render its own UI inside it (or
 * elsewhere) and use the `--agil-*` CSS variables. Controller state is surfaced
 * through `instance.subscribe()` / `instance.on('state' | 'media-state' | ...)`.
 */
import type { CallStore } from '../state.js';
import type { AgilToastAction, CallState } from '../types.js';
import type { ToastAction } from './toasts.js';
import type { ToastKind, WidgetUi } from './widget-ui.js';

export type HeadlessToastHandler = (message: string, kind: ToastKind, actions?: AgilToastAction[]) => void;

/** Headless payload mirrors the default-UI actions so the host can render buttons. */
export function headlessToastActions(actions?: ToastAction[]): AgilToastAction[] | undefined {
  if (!actions || actions.length === 0) return undefined;
  return actions.map((action) => ({ label: action.label, onClick: action.onClick }));
}

function phaseToState(state: CallState): string {
  if (state.phase === 'joined') return 'joined';
  if (state.phase === 'joining' || state.phase === 'loading') return 'joining';
  if (state.phase === 'lobby') return 'lobby';
  if (state.phase === 'left') return 'left';
  if (state.phase === 'error') return 'error';
  return 'idle';
}

export class HeadlessUi implements WidgetUi {
  readonly toasts = {
    clear: (): void => {
      /* no built-in toasts */
    },
  };

  private readonly root: HTMLElement;
  private readonly onToast: HeadlessToastHandler | null;
  private unsubscribe: (() => void) | null = null;

  constructor(root: HTMLElement, store: CallStore, onToast?: HeadlessToastHandler) {
    this.root = root;
    this.onToast = onToast ?? null;
    this.root.dataset.agilHeadless = 'true';
    this.unsubscribe = store.subscribe((state) => this.update(state));
    this.update(store.getState());
  }

  update(state: CallState): void {
    const root = this.root;
    root.dataset.phase = state.phase;
    root.dataset.state = phaseToState(state);
    root.dataset.agilQuality = state.quality.tier;
    root.dataset.agilMediaMode = state.settings.mediaMode;
    root.dataset.agilViewer = String(state.settings.viewer);
    root.dataset.agilChatMode = state.settings.chatMode;
    root.dataset.agilFullscreen = String(state.settings.fullscreen);
    root.dataset.agilRecording = String(state.recording.active);
    root.dataset.agilScreenSharing = String(state.settings.screenSharing);
    root.dataset.agilHandRaised = String(state.settings.handRaised);
    root.dataset.layout = state.settings.layoutMode;
    root.dataset.chrome = state.settings.chrome;
  }

  setSpotlightFollowSpeaker(_participantId: string): void {
    /* rendering is owned by the host */
  }

  setSpeaking(_participantId: string, _speaking: boolean): void {
    /* rendering is owned by the host */
  }

  showToast(message: string, kind: ToastKind = 'info', _timeoutMs?: number, actions?: ToastAction[]): void {
    this.onToast?.(message, kind, headlessToastActions(actions));
  }

  showJoinError(_code: string, _message?: string): void {
    /* lifecycle errors are emitted through the `error` event */
  }

  setJoinOffline(_offline: boolean): void {
    /* no join screen */
  }

  setJoinBusy(_busy: boolean): void {
    /* no join screen */
  }

  joinScreenName(_name: string): void {
    /* no join screen */
  }

  joinScreenServer(_text: string): void {
    /* no join screen */
  }

  focusJoin(): void {
    /* no join screen */
  }

  focusSettingsDevices(): void {
    /* no built-in settings */
  }

  showReaction(_emoji: string, _name: string): void {
    /* the `reaction` event carries this data */
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    delete this.root.dataset.agilHeadless;
  }
}
