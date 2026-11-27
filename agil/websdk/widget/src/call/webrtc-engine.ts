/**
 * WebRTC mesh engine (contract §5).
 *
 * One `RTCPeerConnection` per remote participant. Negotiation follows the
 * contract: the peer with the lexicographically smaller `participantId` is the
 * initiator; renegotiation uses the "perfect negotiation" pattern (polite peer
 * rolls back on glare).
 *
 * Also implements: simulcast, codec preferences, degradation preference,
 * content hints, playout delay / jitter buffer tuning, statistics sampling
 * (`getStats` → `QualitySnapshot` → `evaluateQuality`) and ICE restart.
 */
import {
  evaluateQuality,
  type IceServerConfig,
  type Participant,
  type QualityDecision,
  type QualitySnapshot,
  type QualityTier,
  type TenantConfig,
} from '@agil/protocol';
import type { SignalingClient } from './signaling-client.js';
import { applyCodecPreferencesToTransceiver, currentEncodingInfo } from './encoding.js';
import { hasTurnServer } from './turn.js';

interface CodecCapabilityLike {
  mimeType: string;
  clockRate?: number;
  channels?: number;
  sdpFmtpLine?: string;
}

const MAX_MESH_PEERS = 8;
const STATS_INTERVAL_MS = 2000;
const ICE_RESTART_COOLDOWN_MS = 12_000;

interface PeerHandle {
  participant: Participant;
  pc: RTCPeerConnection;
  stream: MediaStream;
  /** Polite peer rolls back its offer when both sides negotiate at once. */
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** True until the first remote offer arrives: suppresses our startup offer. */
  suppressNegotiation: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  videoSender: RTCRtpSender | null;
  audioSender: RTCRtpSender | null;
  videoTransceiver: RTCRtpTransceiver | null;
  iceRestarts: number;
  connectionState: RTCPeerConnectionState;
  relayAttempted: boolean;
  relayTimer: ReturnType<typeof setTimeout> | null;
  /** Track-set signature of the last emitted `remote-stream`, used to dedupe `ontrack`. */
  lastStreamSignature: string;
  // stats delta bookkeeping
  lastBytesReceived: number;
  lastBytesSent: number;
  lastPacketsLost: number;
  lastPacketsReceived: number;
  lastFramesDecoded: number;
  lastStatsAt: number;
}

export interface EngineCallbacks {
  onRemoteStream(participantId: string, stream: MediaStream): void;
  onPeerRemoved(participantId: string): void;
  onConnectionState(overall: RTCPeerConnectionState | 'idle', perPeer: Record<string, RTCPeerConnectionState>): void;
  onQuality(decision: QualityDecision, snapshot: QualitySnapshot): void;
  onNegotiationError(participantId: string, error: Error): void;
  onIceRestart(participantId: string): void;
  onRelayStatus?: (status: 'connecting' | 'active' | 'failed') => void;
  onIceInfo?: (info: { local?: string; remote?: string; protocol?: string }) => void;
}

export interface EngineOptions {
  selfId: string;
  config: TenantConfig;
  iceServers: IceServerConfig[];
  iceTransportPolicy?: 'all' | 'relay';
  signaling: SignalingClient;
  callbacks: EngineCallbacks;
}

export interface AggregateStats {
  snapshot: QualitySnapshot;
  outboundBitrateKbps: number;
  peers: number;
  iceRestarts: number;
}

interface InboundRtpStats extends RTCStats {
  kind?: string;
  bytesReceived?: number;
  packetsLost?: number;
  packetsReceived?: number;
  jitter?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  framesDecoded?: number;
}

interface OutboundRtpStats extends RTCStats {
  kind?: string;
  bytesSent?: number;
  packetsSent?: number;
}

interface CandidatePairStats extends RTCStats {
  nominated?: boolean;
  state?: string;
  currentRoundTripTime?: number;
  availableOutgoingBitrate?: number;
}

interface CodecStat extends RTCStats {
  mimeType?: string;
}

function transceiverInit(config: TenantConfig, kind: 'audio' | 'video', track: MediaStreamTrack | null, stream: MediaStream | null): RTCRtpTransceiverInit {
  // Mesh receivers have no SFU layer selector. A single encoding avoids
  // negotiating a low simulcast layer that can stall after track replacement.
  const init: RTCRtpTransceiverInit = {
    direction: 'sendrecv',
    streams: stream ? [stream] : [],
  };
  if (track) init.streams = stream ? [stream] : [];
  return init;
}

function desiredCodecMimes(config: TenantConfig, kind: 'audio' | 'video'): string[] {
  const codecs = kind === 'video' ? config.video.codecs : config.audio.codecs;
  return codecs.map((codec) => `${kind}/${codec}`.toLowerCase());
}

function mimeRank(mime: string, desired: string[]): number {
  const normalized = mime.toLowerCase();
  const base = normalized.split(';')[0] ?? normalized;
  const index = desired.indexOf(base);
  return index === -1 ? 999 : index;
}

/**
 * Identity of the remote track set. `ontrack` fires once per track (audio and
 * video), so the first join used to emit two `remote-stream` events for the
 * same stream. Emitting only when this signature changes keeps the contract
 * one event per actual stream update and still reports added/removed tracks.
 */
function streamSignature(stream: MediaStream): string {
  const tracks = stream.getTracks().map((track) => track.id).sort();
  return `${stream.id}:${tracks.join(',')}`;
}

export class WebRtcEngine {
  private readonly callbacks: EngineCallbacks;
  private readonly signaling: SignalingClient;
  private config: TenantConfig;
  private iceServers: IceServerConfig[];
  private readonly iceTransportPolicy: 'all' | 'relay';
  private hasTurn: boolean;
  private selfId: string;
  private readonly peers = new Map<string, PeerHandle>();
  private readonly orphanCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly orphanSdp = new Map<string, { type: 'offer' | 'answer'; sdp: string }>();
  private localStream: MediaStream | null = null;
  private videoOverride: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private screenAudioTrack: MediaStreamTrack | null = null;
  private screenAudioMix: { context: AudioContext; microphone: MediaStreamTrack; track: MediaStreamTrack } | null = null;
  private videoSuspended = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastTier: QualityTier | undefined;
  private lastRestartAt = 0;
  private closed = false;
  private lastReport: AggregateStats = {
    snapshot: {
      rttMs: 0,
      packetLossPct: 0,
      jitterMs: 0,
      inboundBitrateKbps: 0,
      availableOutgoingBitrateKbps: 0,
      fps: 0,
      width: 0,
      height: 0,
    },
    outboundBitrateKbps: 0,
    peers: 0,
    iceRestarts: 0,
  };

  constructor(options: EngineOptions) {
    this.selfId = options.selfId;
    this.config = options.config;
    this.iceServers = options.iceServers;
    this.iceTransportPolicy = options.iceTransportPolicy ?? 'all';
    this.hasTurn = hasTurnServer(options.iceServers);
    this.signaling = options.signaling;
    this.callbacks = options.callbacks;
  }

  /** Update future ICE allocations without restarting active peers. */
  setIceServers(iceServers: IceServerConfig[]): void {
    this.iceServers = iceServers;
    this.hasTurn = hasTurnServer(iceServers);
    for (const { pc } of this.peers.values()) {
      if (pc.signalingState === 'closed') continue;
      try {
        pc.setConfiguration({ ...pc.getConfiguration(), iceServers });
      } catch {
        console.warn('[agil] Could not apply refreshed ICE configuration to a peer');
      }
    }
  }

  get peersCount(): number {
    return this.peers.size;
  }

  get peerIds(): string[] {
    return [...this.peers.keys()];
  }

  get local(): MediaStream | null {
    return this.localStream;
  }

  get currentScreenTrack(): MediaStreamTrack | null {
    return this.screenTrack;
  }

  get currentVideoSuspended(): boolean {
    return this.videoSuspended;
  }

  setConfig(config: TenantConfig): void {
    this.config = config;
    for (const peer of this.peers.values()) {
      void this.configureSenders(peer);
    }
  }

  setSelfId(id: string): void {
    this.selfId = id;
  }

  setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream;
    this.updateScreenAudioMix();
    for (const peer of this.peers.values()) {
      void this.syncSenders(peer);
    }
  }

  /** Overrides the outgoing camera track (used by the background-blur pipeline). */
  setVideoOverride(track: MediaStreamTrack | null): void {
    this.videoOverride = track;
    this.refreshVideoSenders();
  }

  setScreenTrack(track: MediaStreamTrack | null, audio: MediaStreamTrack | null = null): void {
    this.screenTrack = track;
    const screenAudio = track ? audio : null;
    if (this.screenAudioTrack !== screenAudio) {
      this.clearScreenAudioMix();
      this.screenAudioTrack = screenAudio;
      this.updateScreenAudioMix();
    }
    this.refreshVideoSenders();
  }

  /** Replaces outgoing video tracks on all peers (camera switch, blur toggle, screen share). */
  refreshVideoSenders(): void {
    for (const peer of this.peers.values()) void this.syncSenders(peer);
  }

  refreshAudioSenders(): void {
    for (const peer of this.peers.values()) void this.syncSenders(peer);
  }

  private effectiveVideoTrack(): MediaStreamTrack | null {
    if (this.screenTrack) return this.screenTrack;
    const camera = this.localStream?.getVideoTracks()[0];
    if (this.videoSuspended || !camera?.enabled || camera.readyState !== 'live') return null;
    return this.videoOverride ?? camera;
  }

  private effectiveAudioTrack(): MediaStreamTrack | null {
    if (this.screenAudioTrack?.readyState === 'live') return this.screenAudioMix?.track ?? this.screenAudioTrack;
    return this.localStream?.getAudioTracks()[0] ?? null;
  }

  private updateScreenAudioMix(): void {
    const microphone = this.localStream?.getAudioTracks()[0];
    const screen = this.screenAudioTrack;
    if (microphone && this.screenAudioMix?.microphone === microphone) return;
    this.clearScreenAudioMix();
    if (!microphone || !screen || typeof AudioContext === 'undefined') return;
    const context = new AudioContext();
    const output = context.createMediaStreamDestination();
    // A mono mix can replace the existing microphone sender without negotiation.
    output.channelCount = 1;
    for (const track of [microphone, screen]) context.createMediaStreamSource(new MediaStream([track])).connect(output);
    this.screenAudioMix = { context, microphone, track: output.stream.getAudioTracks()[0]! };
    void context.resume().catch(() => undefined);
  }

  private clearScreenAudioMix(): void {
    const mix = this.screenAudioMix;
    this.screenAudioMix = null;
    if (!mix) return;
    mix.track.stop();
    void mix.context.close().catch(() => undefined);
  }

  private async syncSenders(peer: PeerHandle): Promise<void> {
    if (peer.suppressNegotiation) return;
    const video = this.effectiveVideoTrack();
    try {
      if (peer.videoSender) await peer.videoSender.replaceTrack(video);
      else if (video) {
        const transceiver = peer.pc.addTransceiver(video, transceiverInit(this.config, 'video', video, this.localStream));
        peer.videoTransceiver = transceiver;
        peer.videoSender = transceiver.sender;
        this.applyCodecPreferences(transceiver, 'video');
        await this.configureSenders(peer);
      }
      const audio = this.effectiveAudioTrack();
      if (peer.audioSender) await peer.audioSender.replaceTrack(audio);
      else if (audio) {
        const transceiver = peer.pc.addTransceiver(audio, transceiverInit(this.config, 'audio', audio, this.localStream));
        peer.audioSender = transceiver.sender;
        this.applyCodecPreferences(transceiver, 'audio');
        await this.configureSenders(peer);
      }
    } catch (error) {
      console.warn('[agil] could not sync sender tracks', error);
    }
  }

  async addPeer(participant: Participant, options: { relayAttempted?: boolean; relayOnly?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    if (this.peers.has(participant.id)) return;
    if (this.peers.size >= MAX_MESH_PEERS) {
      console.warn(`[agil] mesh limit reached (${MAX_MESH_PEERS} peers), ignoring ${participant.id}`);
      return;
    }
    const polite = this.selfId.localeCompare(participant.id) > 0;
    const relayOnly = options.relayOnly || this.iceTransportPolicy === 'relay';
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: 'max-bundle',
      ...(relayOnly ? { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } : {}),
    });
    const peer: PeerHandle = {
      participant,
      pc,
      stream: new MediaStream(),
      polite,
      makingOffer: false,
      ignoreOffer: false,
      // The initiator (smaller id) starts negotiation; the polite peer answers.
      suppressNegotiation: polite,
      pendingCandidates: [],
      videoSender: null,
      audioSender: null,
      videoTransceiver: null,
      iceRestarts: 0,
      connectionState: 'new',
      relayAttempted: Boolean(options.relayAttempted),
      relayTimer: null,
      lastStreamSignature: '',
      lastBytesReceived: 0,
      lastBytesSent: 0,
      lastPacketsLost: 0,
      lastPacketsReceived: 0,
      lastFramesDecoded: 0,
      lastStatsAt: 0,
    };
    this.peers.set(participant.id, peer);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.send({
          type: 'ice',
          to: participant.id,
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment,
          },
        });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      const target = stream ?? peer.stream;
      if (stream && peer.stream.id !== stream.id) {
        for (const track of peer.stream.getTracks()) peer.stream.removeTrack(track);
        for (const track of stream.getTracks()) peer.stream.addTrack(track);
      }
      if (!target.getTracks().some((track) => track.id === event.track.id)) target.addTrack(event.track);
      event.track.addEventListener('ended', () => {
        // An emptied stream must still reach the host as `stream: null` (via the
        // controller's empty-stream guard), but only once per track-set change.
        const signature = streamSignature(target);
        if (target.getTracks().length === 0 && signature !== peer.lastStreamSignature) {
          peer.lastStreamSignature = signature;
          this.callbacks.onRemoteStream(participant.id, target);
        }
      });
      this.tuneReceiver(event.receiver);
      const signature = streamSignature(target);
      if (signature === peer.lastStreamSignature) return;
      peer.lastStreamSignature = signature;
      this.callbacks.onRemoteStream(participant.id, target);
    };

    pc.onconnectionstatechange = () => {
      peer.connectionState = pc.connectionState;
      this.emitConnectionState();
      if (pc.connectionState === 'connected') {
        if (peer.relayTimer) { clearTimeout(peer.relayTimer); peer.relayTimer = null; }
        if (peer.relayAttempted) this.callbacks.onRelayStatus?.('active');
      }
      if (pc.connectionState === 'failed' && this.config.fallback.lowBandwidth.iceRestartOnFailure) {
        this.restartIce(participant.id);
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.scheduleRelayFallback(peer);
      }
    };

    pc.onnegotiationneeded = () => {
      if (peer.suppressNegotiation) return;
      void this.negotiate(peer);
    };

    // Stable m-lines for later replaceTrack (camera on/off, blur, screen share).
    if (!polite) {
      const videoTrack = this.effectiveVideoTrack();
      const videoTx = pc.addTransceiver(videoTrack ?? 'video', transceiverInit(this.config, 'video', videoTrack, this.localStream));
      peer.videoTransceiver = videoTx;
      peer.videoSender = videoTx.sender;
      this.applyCodecPreferences(videoTx, 'video');

      const audioTrack = this.effectiveAudioTrack();
      const audioTx = pc.addTransceiver(audioTrack ?? 'audio', transceiverInit(this.config, 'audio', audioTrack, this.localStream));
      peer.audioSender = audioTx.sender;
      this.applyCodecPreferences(audioTx, 'audio');
      void this.configureSenders(peer);
    }

    if (relayOnly) {
      setTimeout(() => {
        const current = this.peers.get(participant.id);
        if (current && current.connectionState !== 'connected') this.callbacks.onRelayStatus?.('failed');
      }, 12_000);
    }

    const orphans = this.orphanCandidates.get(participant.id);
    if (orphans) {
      peer.pendingCandidates.push(...orphans);
      this.orphanCandidates.delete(participant.id);
    }

    const orphanedOffer = this.orphanSdp.get(participant.id);
    if (orphanedOffer) {
      this.orphanSdp.delete(participant.id);
      await this.handleSdp(participant.id, orphanedOffer);
    } else if (!polite) await this.negotiate(peer);
  }

  /** TURN relay fallback: one recreation per peer after 6.5s of failed media. */
  private scheduleRelayFallback(peer: PeerHandle): void {
    if (peer.relayAttempted || peer.relayTimer || !this.hasTurn || this.iceTransportPolicy === 'relay') return;
    peer.relayTimer = setTimeout(() => {
      peer.relayTimer = null;
      const current = this.peers.get(peer.participant.id);
      if (!current || current !== peer) return;
      if (peer.connectionState === 'connected') return;
      peer.relayAttempted = true;
      const participant = peer.participant;
      this.callbacks.onRelayStatus?.('connecting');
      this.removePeer(participant.id);
      void this.addPeer(participant, { relayAttempted: true, relayOnly: true });
      setTimeout(() => {
        const relayed = this.peers.get(participant.id);
        if (relayed && relayed.connectionState !== 'connected') this.callbacks.onRelayStatus?.('failed');
      }, 12_000);
    }, 6_500);
  }

  private emitConnectionState(): void {
    const perPeer: Record<string, RTCPeerConnectionState> = {};
    let overall: RTCPeerConnectionState | 'idle' = 'idle';
    for (const [id, peer] of this.peers) {
      perPeer[id] = peer.connectionState;
      if (peer.connectionState === 'failed') overall = 'failed';
      else if (peer.connectionState === 'disconnected') overall = 'disconnected';
      else if (peer.connectionState === 'connecting' && overall !== 'failed' && overall !== 'disconnected') overall = 'connecting';
      else if (peer.connectionState === 'connected' && overall === 'idle') overall = 'connected';
      else if (peer.connectionState === 'new' && overall === 'idle') overall = 'new';
    }
    this.callbacks.onConnectionState(overall, perPeer);
  }

  private applyCodecPreferences(transceiver: RTCRtpTransceiver, kind: 'audio' | 'video'): void {
    // Mesh path: preferences for each transceiver are limited to its media kind.
    applyCodecPreferencesToTransceiver(transceiver, kind, this.config);
  }

  private async attachAnswerTracks(peer: PeerHandle): Promise<void> {
    // The remote offer creates the answering transceivers. Pre-creating them
    // with addTransceiver leaves the local senders on unassociated m-lines.
    for (const transceiver of peer.pc.getTransceivers()) {
      const kind = transceiver.receiver.track.kind;
      if (transceiver.mid === null || (kind !== 'audio' && kind !== 'video')) continue;
      if (kind === 'video' ? peer.videoSender : peer.audioSender) continue;
      transceiver.direction = 'sendrecv';
      if (this.localStream) transceiver.sender.setStreams?.(this.localStream);
      this.applyCodecPreferences(transceiver, kind);
      await transceiver.sender.replaceTrack(kind === 'video' ? this.effectiveVideoTrack() : this.effectiveAudioTrack());
      if (kind === 'video') {
        peer.videoTransceiver = transceiver;
        peer.videoSender = transceiver.sender;
      } else {
        peer.audioSender = transceiver.sender;
      }
    }
  }

  /** Selected codec/hardware diagnostics for the settings panel. */
  getEncodingInfo() {
    return currentEncodingInfo(this.config);
  }

  private async configureSenders(peer: PeerHandle): Promise<void> {
    await this.tuneVideoSender(peer);
    await this.tuneAudioSender(peer);
  }

  private async tuneVideoSender(peer: PeerHandle, target?: { bitrateKbps: number; fps: number }): Promise<void> {
    const sender = peer.videoSender;
    if (!sender) return;
    const config = this.config;
    const maxBitrateKbps = target?.bitrateKbps ?? config.video.maxBitrateKbps;
    const maxFps = target?.fps ?? config.video.maxFps;
    try {
      if (typeof sender.getParameters !== 'function') return;
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) return;
      parameters.encodings.forEach((encoding, index, list) => {
        const layerWeight = list.length > 1 ? [0.2, 0.5, 1][index] ?? 1 : 1;
        encoding.maxBitrate = Math.round(maxBitrateKbps * 1000 * layerWeight);
        encoding.maxFramerate = maxFps;
        if (index === list.length - 1) encoding.scaleResolutionDownBy = 1;
      });
      if (sender.track) sender.track.contentHint = this.config.video.contentHint;
      if (parameters.degradationPreference !== undefined) {
        parameters.degradationPreference = config.video.degradationPreference;
      }
      await sender.setParameters(parameters);
    } catch {
      /* browsers differ; parameters are best-effort */
    }
  }

  private async tuneAudioSender(peer: PeerHandle): Promise<void> {
    const sender = peer.audioSender;
    if (!sender || this.config.audio.preferredCodec !== 'opus' || typeof sender.getParameters !== 'function') return;
    try {
      const parameters = sender.getParameters();
      const encoding = parameters.encodings?.[0] as (RTCRtpEncodingParameters & { dtx?: boolean }) | undefined;
      if (encoding) {
        encoding.maxBitrate = this.config.audio.opusBitrateKbps * 1000;
        encoding.dtx = this.config.audio.dtx;
      }
      await sender.setParameters(parameters);
    } catch {
      /* ignore */
    }
  }

  private tuneReceiver(receiver: RTCRtpReceiver): void {
    const target = receiver as RTCRtpReceiver & { playoutDelayHint?: number; jitterBufferTarget?: number };
    try {
      if ('playoutDelayHint' in receiver) target.playoutDelayHint = 0;
      if ('jitterBufferTarget' in receiver) target.jitterBufferTarget = this.config.audio.jitterBufferTargetMs;
    } catch {
      /* unsupported in this browser */
    }
  }

  private async negotiate(peer: PeerHandle): Promise<void> {
    if (this.closed || peer.pc.connectionState === 'closed') return;
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription();
      const description = peer.pc.localDescription;
      if (description?.sdp) {
        this.signaling.send({
          type: 'sdp',
          to: peer.participant.id,
          description: { type: description.type as 'offer' | 'answer', sdp: description.sdp },
        });
      }
    } catch (error) {
      this.callbacks.onNegotiationError(peer.participant.id, error instanceof Error ? error : new Error(String(error)));
    } finally {
      peer.makingOffer = false;
    }
  }

  /** Handles `sdp` from the signaling relay (perfect negotiation). */
  async handleSdp(from: string, description: { type: 'offer' | 'answer'; sdp: string }): Promise<void> {
    const peer = this.peers.get(from);
    if (!peer) {
      // `peer-joined` may still be in flight; replay the offer once the peer exists.
      this.orphanSdp.set(from, description);
      return;
    }
    const pc = peer.pc;
    const offerCollision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = peer.polite && offerCollision;
    if (peer.ignoreOffer) return;
    try {
      if (offerCollision) {
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          pc.setRemoteDescription({ type: description.type, sdp: description.sdp }),
        ]);
      } else {
        await pc.setRemoteDescription({ type: description.type, sdp: description.sdp });
      }
      if (description.type === 'offer') {
        await this.attachAnswerTracks(peer);
        await this.flushCandidates(peer);
        await pc.setLocalDescription();
        peer.suppressNegotiation = false;
        const local = pc.localDescription;
        if (local?.sdp) {
          this.signaling.send({
            type: 'sdp',
            to: from,
            description: { type: local.type as 'offer' | 'answer', sdp: local.sdp },
          });
        }
      } else {
        await this.flushCandidates(peer);
      }
      void this.configureSenders(peer);
    } catch (error) {
      this.callbacks.onNegotiationError(from, error instanceof Error ? error : new Error(String(error)));
    }
  }

  async handleIce(from: string, candidate: RTCIceCandidateInit): Promise<void> {
    const peer = this.peers.get(from);
    if (!peer) {
      const list = this.orphanCandidates.get(from) ?? [];
      list.push(candidate);
      this.orphanCandidates.set(from, list);
      return;
    }
    if (peer.ignoreOffer) return;
    peer.pendingCandidates.push(candidate);
    await this.flushCandidates(peer);
  }

  private async flushCandidates(peer: PeerHandle): Promise<void> {
    if (!peer.pc.remoteDescription) return;
    const pending = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const candidate of pending) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch (error) {
        if (!peer.ignoreOffer) console.warn('[agil] addIceCandidate failed', error);
      }
    }
  }

  removePeer(id: string, reason?: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    if (peer.relayTimer) { clearTimeout(peer.relayTimer); peer.relayTimer = null; }
    try {
      peer.pc.close();
    } catch {
      /* ignore */
    }
    this.callbacks.onPeerRemoved(id);
    // `onPeerRemoved` is the single removal signal: emitting `onRemoteStream`
    // with an empty stream here used to resurrect the departed id as a ghost
    // 0-track tile after `remote-stream {stream:null}`.
    this.emitConnectionState();
    if (reason) console.info(`[agil] peer ${id} left: ${reason}`);
  }

  removeAllPeers(): void {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  hasConnectedPeers(): boolean {
    return [...this.peers.values()].some(({ pc }) => pc.connectionState === 'connected');
  }

  /** Reconcile a resumed room without tearing down peers that stayed connected. */
  reconcilePeers(participants: readonly Participant[]): void {
    const present = new Set(participants.map(({ id }) => id));
    for (const id of this.peers.keys()) {
      if (!present.has(id)) this.removePeer(id);
    }
    for (const participant of participants) {
      const peer = this.peers.get(participant.id);
      if (!peer) {
        void this.addPeer(participant);
        continue;
      }
      peer.participant = participant;
      if (peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'disconnected') {
        this.restartIce(participant.id, true);
      }
    }
    this.emitConnectionState();
  }

  updateParticipant(participant: Participant): void {
    const peer = this.peers.get(participant.id);
    if (peer) peer.participant = participant;
  }

  /** Restarts ICE for one peer (or all) — used on network degradation. */
  restartIce(peerId?: string, force = false): void {
    if (!force && Date.now() - this.lastRestartAt < ICE_RESTART_COOLDOWN_MS) return;
    this.lastRestartAt = Date.now();
    const targets = peerId ? [this.peers.get(peerId)].filter((peer): peer is PeerHandle => Boolean(peer)) : [...this.peers.values()];
    for (const peer of targets) {
      try {
        peer.iceRestarts += 1;
        peer.pc.restartIce();
        this.callbacks.onIceRestart(peer.participant.id);
      } catch (error) {
        console.warn('[agil] restartIce failed', error);
      }
    }
  }

  startStatsLoop(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      void this.sampleStats(true);
    }, STATS_INTERVAL_MS);
  }

  stopStatsLoop(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /** One-shot aggregated stats (also used by `getStats()` of the public API). */
  async collectStats(): Promise<AggregateStats> {
    return this.sampleStats(false);
  }

  private async sampleStats(emit: boolean): Promise<AggregateStats> {
    if (this.closed) return this.lastReport;
    const snapshots: QualitySnapshot[] = [];
    let outboundKbps = 0;
    let iceRestarts = 0;
    for (const peer of this.peers.values()) {
      iceRestarts += peer.iceRestarts;
      const snapshot = await this.collectPeerSnapshot(peer);
      if (!snapshot) continue;
      snapshots.push(snapshot);
      outboundKbps += snapshot.__outboundKbps ?? 0;
    }
    const bandwidthEstimates = snapshots.map((snapshot) => snapshot.availableOutgoingBitrateKbps ?? 0).filter((kbps) => kbps > 0);
    const aggregate: QualitySnapshot = {
      connectionState: this.aggregateConnectionState(),
      iceConnectionState: this.aggregateConnectionState(),
      rttMs: Math.max(0, ...snapshots.map((snapshot) => snapshot.rttMs)),
      packetLossPct: Math.max(0, ...snapshots.map((snapshot) => snapshot.packetLossPct)),
      jitterMs: Math.max(0, ...snapshots.map((snapshot) => snapshot.jitterMs)),
      inboundBitrateKbps: snapshots.reduce((sum, snapshot) => sum + snapshot.inboundBitrateKbps, 0),
      availableOutgoingBitrateKbps: bandwidthEstimates.length > 0 ? Math.min(...bandwidthEstimates) : 0,
      fps: Math.min(
        120,
        Math.max(0, ...snapshots.map((snapshot) => snapshot.fps || 0).filter((fps) => fps > 0)),
      ),
      width: Math.max(0, ...snapshots.map((snapshot) => snapshot.width)),
      height: Math.max(0, ...snapshots.map((snapshot) => snapshot.height)),
    };
    if (snapshots.length === 0) {
      aggregate.connectionState = this.peers.size === 0 ? 'connected' : 'connecting';
    }
    this.lastReport = {
      snapshot: aggregate,
      outboundBitrateKbps: Math.round(outboundKbps),
      peers: this.peers.size,
      iceRestarts,
    };
    if (emit) {
      const decision = evaluateQuality(aggregate, this.config.fallback.lowBandwidth, this.lastTier);
      const tierChanged = decision.tier !== this.lastTier;
      this.lastTier = decision.tier;
      this.callbacks.onQuality(decision, aggregate);
      // Hysteresis can hold video off on the first recovered sample while
      // already publishing its improved tier. Apply the next sample's video
      // action even if the displayed tier stays the same.
      if (tierChanged || (decision.actions.video === 'off') !== this.videoSuspended) this.applyQualityActions(decision);
    }
    return this.lastReport;
  }

  private aggregateConnectionState(): string {
    if (this.peers.size === 0) return 'connected';
    let state = 'connected';
    for (const peer of this.peers.values()) {
      if (peer.connectionState === 'failed') return 'failed';
      if (peer.connectionState === 'disconnected') state = 'disconnected';
      else if (peer.connectionState === 'connecting' && state === 'connected') state = 'connecting';
    }
    return state;
  }

  private async collectPeerSnapshot(peer: PeerHandle): Promise<(QualitySnapshot & { __outboundKbps?: number }) | null> {
    let report: RTCStatsReport;
    try {
      report = await peer.pc.getStats();
    } catch {
      return null;
    }
    const now = performance.now();
    const deltaSec = peer.lastStatsAt > 0 ? Math.max(0.5, (now - peer.lastStatsAt) / 1000) : 2;
    let bytesReceived = 0;
    let bytesSent = 0;
    let packetsLost = 0;
    let packetsReceived = 0;
    let jitterMs = 0;
    let fps = 0;
    let width = 0;
    let height = 0;
    let framesDecoded: number | undefined;
    let rttMs = 0;
    let availableOutgoing = 0;
    const candidates = new Map<string, { type?: string; protocol?: string }>();
    let selectedPair: CandidatePairStats & { localCandidateId?: string; remoteCandidateId?: string } | null = null;

    for (const stat of report.values()) {
      if (stat.type === 'inbound-rtp') {
        const inbound = stat as InboundRtpStats;
        bytesReceived += inbound.bytesReceived ?? 0;
        packetsLost += inbound.packetsLost ?? 0;
        packetsReceived += inbound.packetsReceived ?? 0;
        if (inbound.kind === 'audio' && inbound.jitter) jitterMs = Math.max(jitterMs, inbound.jitter * 1000);
        if (inbound.kind === 'video') {
          if (inbound.jitter) jitterMs = Math.max(jitterMs, inbound.jitter * 1000);
          if (inbound.framesDecoded !== undefined) framesDecoded = (framesDecoded ?? 0) + inbound.framesDecoded;
          if (inbound.frameWidth) width = Math.max(width, inbound.frameWidth);
          if (inbound.frameHeight) height = Math.max(height, inbound.frameHeight);
          if (inbound.framesPerSecond) fps = Math.max(fps, inbound.framesPerSecond);
        }
      } else if (stat.type === 'outbound-rtp') {
        const outbound = stat as OutboundRtpStats;
        bytesSent += outbound.bytesSent ?? 0;
      } else if (stat.type === 'candidate-pair') {
        const pair = stat as CandidatePairStats & { localCandidateId?: string; remoteCandidateId?: string };
        if (pair.nominated || pair.state === 'succeeded') {
          selectedPair = pair;
          if (pair.currentRoundTripTime) rttMs = Math.max(rttMs, pair.currentRoundTripTime * 1000);
          if (pair.availableOutgoingBitrate) availableOutgoing = Math.max(availableOutgoing, pair.availableOutgoingBitrate);
        }
      } else if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') {
        const candidate = stat as RTCStats & { candidateType?: string; protocol?: string };
        candidates.set(stat.id, { type: candidate.candidateType, protocol: candidate.protocol });
      }
    }

    if (selectedPair) {
      const local = candidates.get(selectedPair.localCandidateId ?? '');
      const remote = candidates.get(selectedPair.remoteCandidateId ?? '');
      this.callbacks.onIceInfo?.({ local: local?.type, remote: remote?.type, protocol: local?.protocol ?? remote?.protocol });
    }
    const receivedDelta = Math.max(0, bytesReceived - peer.lastBytesReceived);
    const sentDelta = Math.max(0, bytesSent - peer.lastBytesSent);
    const lostDelta = Math.max(0, packetsLost - peer.lastPacketsLost);
    const packetsDelta = Math.max(0, packetsReceived - peer.lastPacketsReceived);
    const totalDelta = lostDelta + packetsDelta;
    peer.lastBytesReceived = bytesReceived;
    peer.lastBytesSent = bytesSent;
    peer.lastPacketsLost = packetsLost;
    peer.lastPacketsReceived = packetsReceived;
    if (framesDecoded !== undefined && framesDecoded === peer.lastFramesDecoded) {
      // RTCStats retains the dimensions of the last frame after video stops.
      width = height = fps = 0;
    }
    peer.lastFramesDecoded = framesDecoded ?? 0;
    peer.lastStatsAt = now;

    return {
      connectionState: peer.pc.connectionState,
      iceConnectionState: peer.pc.iceConnectionState,
      rttMs: Math.round(rttMs),
      packetLossPct: totalDelta > 0 ? Math.round((lostDelta / totalDelta) * 1000) / 10 : 0,
      jitterMs: Math.round(jitterMs),
      inboundBitrateKbps: Math.round((receivedDelta * 8) / 1000 / deltaSec),
      availableOutgoingBitrateKbps: Math.round(availableOutgoing / 1000),
      fps: Math.round(fps),
      width,
      height,
      __outboundKbps: Math.round((sentDelta * 8) / 1000 / deltaSec),
    };
  }

  private applyQualityActions(decision: QualityDecision): void {
    const actions = decision.actions;
    const suspend = actions.video === 'off';
    if (suspend !== this.videoSuspended) {
      this.videoSuspended = suspend;
      this.refreshVideoSenders();
    }
    if (!suspend) {
      const target = { bitrateKbps: actions.videoTarget.bitrateKbps, fps: actions.videoTarget.fps };
      for (const peer of this.peers.values()) void this.tuneVideoSender(peer, target);
    }
    if (actions.reconnect && this.config.fallback.lowBandwidth.iceRestartOnFailure) {
      this.restartIce(undefined);
    }
  }

  close(): void {
    this.closed = true;
    this.clearScreenAudioMix();
    this.stopStatsLoop();
    this.removeAllPeers();
    this.orphanCandidates.clear();
    this.orphanSdp.clear();
  }
}
