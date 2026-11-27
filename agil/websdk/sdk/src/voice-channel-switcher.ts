import type { AgilCallOptions, AgilWidgetInstance } from '@agil/calls-widget';

export interface VoiceChannelGrant {
  roomId: string;
  token: string;
}

export interface VoiceChannelSwitcherOptions {
  call?: Omit<AgilCallOptions, 'room' | 'token' | 'resume' | 'audioOnly' | 'initialLobby' | 'initialServerConfig'>;
  getGrant(channelId: string, signal: AbortSignal): Promise<VoiceChannelGrant>;
}

export interface VoiceChannelSession {
  channelId: string;
  call: AgilWidgetInstance;
}

export interface VoiceChannelSwitcher {
  /** Obtain a fresh grant before releasing the previous call. Superseded requests resolve to null. */
  switchTo(channelId: string): Promise<VoiceChannelSession | null>;
  getCurrent(): VoiceChannelSession | null;
  leave(): Promise<void>;
}

type Mount = (container: HTMLElement | string, options: AgilCallOptions) => Promise<AgilWidgetInstance>;

export function makeVoiceChannelSwitcher(mount: Mount, container: HTMLElement | string, options: VoiceChannelSwitcherOptions): VoiceChannelSwitcher {
  let current: VoiceChannelSession | null = null;
  let queue = Promise.resolve();
  let sequence = 0;
  let pendingGrant: AbortController | undefined;

  function schedule<T>(work: () => T | Promise<T>): Promise<T> {
    const operation = queue.then(work);
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function closeCurrent(): void {
    const previous = current;
    current = null;
    previous?.call.destroy();
  }

  function switchTo(channelId: string): Promise<VoiceChannelSession | null> {
    const requested = ++sequence;
    pendingGrant?.abort();
    return schedule(async () => {
      if (requested !== sequence) return null;
      const grantRequest = new AbortController();
      pendingGrant = grantRequest;
      let grant: VoiceChannelGrant;
      try {
        const signal = grantRequest.signal;
        const aborted = new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        grant = await Promise.race([options.getGrant(channelId, signal), aborted]);
      } catch (error) {
        if (requested !== sequence) return null;
        throw error;
      } finally {
        pendingGrant = undefined;
      }
      if (requested !== sequence) return null;
      if (typeof grant?.roomId !== 'string' || !grant.roomId.trim() || typeof grant?.token !== 'string' || !grant.token.trim()) {
        throw new TypeError('The voice channel backend must return a roomId and a join token');
      }

      closeCurrent();
      const config = options.call?.config;
      const call = await mount(container, {
        ...options.call,
        room: grant.roomId,
        token: grant.token,
        resume: false,
        audioOnly: false,
        config: { ...config, session: { ...config?.session, joinWithCamOff: true } },
      });
      const state = call.getState();
      if (requested === sequence && state.phase === 'joined' && state.serverOnline && state.room?.id === grant.roomId) {
        current = { channelId, call };
        return current;
      }
      call.destroy();
      if (requested !== sequence) return null;
      throw new Error(state.error?.message ?? 'The voice channel could not be joined');
    });
  }

  return {
    switchTo,
    getCurrent: () => current,
    leave: () => {
      sequence += 1;
      pendingGrant?.abort();
      return schedule(closeCurrent);
    },
  };
}
