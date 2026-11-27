export type WhepFailure = 'access' | 'unavailable' | 'disconnected';

const RTP_POLL_MS = 1000;
const RTP_TIMEOUT_MS = 8000;

/** Receive an external WebRTC stream over WHEP using a complete ICE offer. */
export function startWhep(endpoint: string, onStream: (stream: MediaStream) => void, onError: (failure: WhepFailure) => void): () => void {
  const source = new URL(endpoint);
  if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) {
    throw new Error('Укажите HTTP(S)-адрес WHEP без логина и пароля.');
  }
  const abort = new AbortController();
  const connection = new RTCPeerConnection();
  let resource: URL | undefined;
  let closed = false;
  let wasConnected = false;
  const timeout = window.setTimeout(() => report('unavailable'), 12_000);
  let activityTimer: number | undefined;
  let packetsReceived = 0;
  let lastPacketAt = 0;

  function removeResource(): void {
    if (!resource) return;
    void fetch(resource, { method: 'DELETE', credentials: 'omit', keepalive: true, redirect: 'error' }).catch(() => {});
    resource = undefined;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    clearTimeout(activityTimer);
    abort.abort();
    connection.close();
    removeResource();
  }

  function report(failure: WhepFailure): void {
    if (closed) return;
    close();
    onError(failure);
  }

  // A media server can keep ICE connected even after its publisher stops sending RTP.
  async function checkActivity(): Promise<void> {
    const stats = await connection.getStats().catch(() => null);
    if (closed) return;
    if (stats) {
      let packetCount = 0;
      stats.forEach((entry) => {
        if (entry.type === 'inbound-rtp') packetCount += entry.packetsReceived ?? 0;
      });
      const now = performance.now();
      if (packetCount !== packetsReceived) {
        packetsReceived = packetCount;
        lastPacketAt = now;
      } else if (now - lastPacketAt >= RTP_TIMEOUT_MS) {
        report(packetsReceived > 0 ? 'disconnected' : 'unavailable');
        return;
      }
    }
    activityTimer = window.setTimeout(() => void checkActivity(), RTP_POLL_MS);
  }

  const stream = new MediaStream();
  connection.addTransceiver('video', { direction: 'recvonly' });
  connection.addTransceiver('audio', { direction: 'recvonly' });
  connection.addEventListener('track', ({ track }) => {
    stream.addTrack(track);
    if (stream.getTracks().length === 1) onStream(stream);
  });
  connection.addEventListener('connectionstatechange', () => {
    if (connection.connectionState === 'connected' && !wasConnected) {
      wasConnected = true;
      clearTimeout(timeout);
      lastPacketAt = performance.now();
      activityTimer = window.setTimeout(() => void checkActivity(), RTP_POLL_MS);
    }
    if (connection.connectionState === 'failed') report(wasConnected ? 'disconnected' : 'unavailable');
  });

  void (async () => {
    await connection.setLocalDescription(await connection.createOffer());
    if (connection.iceGatheringState !== 'complete' && !abort.signal.aborted) {
      await new Promise<void>((resolve) => {
        const gathered = () => {
          if (connection.iceGatheringState !== 'complete' && !abort.signal.aborted) return;
          connection.removeEventListener('icegatheringstatechange', gathered);
          abort.signal.removeEventListener('abort', gathered);
          resolve();
        };
        connection.addEventListener('icegatheringstatechange', gathered);
        abort.signal.addEventListener('abort', gathered, { once: true });
        gathered();
      });
    }
    abort.signal.throwIfAborted();
    const answer = await fetch(source, {
      method: 'POST', headers: { 'Content-Type': 'application/sdp' },
      body: connection.localDescription?.sdp, signal: abort.signal, credentials: 'omit', redirect: 'error',
    });
    if (answer.status === 401 || answer.status === 403) {
      report('access');
      return;
    }
    if (answer.status !== 201) {
      report('unavailable');
      return;
    }
    const resourcePath = answer.headers.get('Location');
    if (resourcePath) {
      const candidate = new URL(resourcePath, source);
      if (candidate.origin === source.origin && !candidate.username && !candidate.password) resource = candidate;
    }
    if (closed) { removeResource(); return; }
    await connection.setRemoteDescription({ type: 'answer', sdp: await answer.text() });
  })().catch(() => report('unavailable'));
  return close;
}
