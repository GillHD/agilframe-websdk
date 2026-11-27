/**
 * Participant video tile: video element, name, role/country/verified/integrity
 * badges, mute/hand/screen indicators, speaking ring, pin button.
 *
 * Stable e2e hooks: `[data-agil-tile]`, `data-participant-id`, `data-self`.
 */
import type { Locale, Participant, ParticipantIntegrity } from '@agil/protocol';
import { h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';
import { integrityBadge } from './participant-integrity.js';

export interface TileState {
  participant: Participant;
  stream: MediaStream | null;
  isSelf: boolean;
  speaking: boolean;
  pinned: boolean;
  connection: RTCPeerConnectionState | 'self' | 'connecting' | 'unknown';
  /** Missing on the wire (older/synthetic payloads) is treated as `unknown`. */
  integrity: ParticipantIntegrity | undefined;
  mirrored: boolean;
  /** SFU mode: remote audio is played by dedicated elements, not the tile. */
  muteAudio?: boolean;
  /**
   * Gallery video budget left this tile on an avatar: it has no SFU video
   * subscription and must never show a (black/frozen) video element. When the
   * participant's camera is on, the tile offers “play video”.
   */
  videoSuppressed?: boolean;
  cachedFrame?: HTMLCanvasElement;
}

export interface TileActions {
  onPin: (participantId: string) => void;
  /** “Play video”: promote this tile into the gallery video budget. */
  onPlayVideo?: (participantId: string) => void;
  onFullscreen?: (participantId: string) => void;
  registerAudioOutput?: (element: HTMLMediaElement) => () => void;
  onVideoAspect?: (aspect: number) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return `${(parts[0] ?? '').slice(0, 1)}${(parts[1] ?? '').slice(0, 1)}`.toUpperCase();
}

function roleLabel(i18n: I18n, role: Participant['role']): string {
  switch (role) {
    case 'host':
      return i18n.t('roleHost');
    case 'moderator':
      return i18n.t('roleModerator');
    default:
      return i18n.t('roleGuest');
  }
}

export class VideoTile {
  readonly element: HTMLDivElement;
  /**
   * Grid child that reserves the tile's 16:9 slot. It never resizes while the
   * participant count stays inside the same slot bucket; the tile fills it.
   * In speaker/minimized modes the wrapper is `display: contents`, so the tile
   * itself becomes the grid item again.
   */
  readonly slot: HTMLDivElement;
  private readonly video: HTMLVideoElement;
  private readonly releaseAudioOutput?: () => void;
  private readonly placeholder: HTMLDivElement;
  private readonly framePreview: HTMLDivElement;
  private readonly placeholderText: HTMLSpanElement;
  private readonly playButton: HTMLButtonElement;
  private readonly avatar: HTMLDivElement;
  private readonly nameEl: HTMLSpanElement;
  private readonly roleEl: HTMLSpanElement;
  private readonly countryEl: HTMLSpanElement;
  private readonly stateBadges: HTMLDivElement;
  private readonly integrityEl: HTMLSpanElement;
  private readonly pinButton: HTMLButtonElement;
  private readonly i18n: I18n;
  private readonly participantId: string;
  private readonly isSelf: boolean;
  private currentStream: MediaStream | null = null;
  /** Camera state from the last `update`; stale media events must not re-show video. */
  private videoExpected = false;
  /** At least one decoded frame arrived for the current stream. */
  private hasFrames = false;
  private readonly actions: TileActions;

  constructor(options: TileState, i18n: I18n, actions: TileActions) {
    this.i18n = i18n;
    this.actions = actions;
    this.participantId = options.participant.id;
    this.isSelf = options.isSelf;

    this.video = h('video', { class: 'agil-tile-video' });
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = options.isSelf || Boolean(options.muteAudio);
    if (!options.isSelf) this.releaseAudioOutput = actions.registerAudioOutput?.(this.video);

    // A remote tile can receive frames before its participant state is applied;
    // hide the placeholder only once the element actually decoded a frame. A
    // subscribed-but-not-yet-decoding stream must not paint a black rectangle.
    const showVideoWhenFrames = (): void => {
      if (this.video.videoWidth > 0 && this.video.readyState >= 2) this.hasFrames = true;
      if (this.videoExpected && this.hasFrames) {
        this.video.style.display = '';
        this.placeholder.style.display = 'none';
        this.framePreview.hidden = true;
        this.element.dataset.videoState = 'live';
      }
    };
    this.video.addEventListener('playing', showVideoWhenFrames);
    this.video.addEventListener('loadeddata', showVideoWhenFrames);
    this.video.addEventListener('resize', showVideoWhenFrames);
    if (actions.onVideoAspect) {
      const reportAspect = (): void => {
        const { videoWidth, videoHeight } = this.video;
        if (videoWidth > 0 && videoHeight > 0) actions.onVideoAspect?.(videoWidth / videoHeight);
      };
      this.video.addEventListener('loadedmetadata', reportAspect);
      this.video.addEventListener('resize', reportAspect);
    }

    this.avatar = h('div', { class: 'agil-tile-avatar' });
    this.placeholderText = h('span', { class: 'agil-tile-placeholder-text', text: i18n.t('camOff') });
    this.playButton = h('button', {
      class: 'agil-tile-play',
      title: i18n.t('playVideo'),
      dataset: { agilPlayVideo: '' },
      attrs: { type: 'button', 'aria-label': i18n.t('playVideo') },
    });
    this.playButton.appendChild(icon('play', 16));
    this.playButton.hidden = true;
    this.playButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.actions.onPlayVideo?.(this.participantId);
    });
    this.placeholder = h(
      'div',
      { class: 'agil-tile-placeholder' },
      h('div', { class: 'agil-tile-placeholder-inner' }, this.avatar, this.placeholderText, this.playButton),
    );
    this.framePreview = h('div', { class: 'agil-tile-frame', attrs: { hidden: '', role: 'img', 'aria-label': i18n.t('lastCameraFrame') } },
      h('span', { class: 'agil-tile-frame-label', text: i18n.t('lastCameraFrame') }),
    );
    this.nameEl = h('span', { class: 'agil-tile-name-text' });
    this.roleEl = h('span', { class: 'agil-tile-role' });
    this.countryEl = h('span', { class: 'agil-tile-country' });
    this.stateBadges = h('div', { class: 'agil-tile-badges' });
    this.integrityEl = h('span', { class: 'agil-tile-integrity' });
    this.pinButton = h('button', { class: 'agil-tile-pin', title: i18n.t('pin') });
    this.pinButton.type = 'button';
    this.pinButton.setAttribute('aria-label', i18n.t('pin'));
    this.pinButton.appendChild(icon('pin', 16));
    this.pinButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.actions.onPin(this.participantId);
    });

    // The state badges are a sibling of the overlay, not a flex partner of the
    // name: on small tiles they collapse to corner dots and the name must get
    // the full row instead of sharing it with two 28 px chips (C-11).
    const overlay = h(
      'div',
      { class: 'agil-tile-overlay' },
      h('div', { class: 'agil-tile-info' }, this.nameEl, this.roleEl, this.countryEl, this.integrityEl),
    );

    this.element = h(
      'div',
      {
        class: 'agil-tile',
        dataset: {
          agilTile: '',
          participantId: this.participantId,
          self: String(options.isSelf),
        },
        attrs: { role: 'group' },
      },
      this.video,
      this.framePreview,
      this.placeholder,
      overlay,
      this.stateBadges,
      this.pinButton,
    );
    this.element.tabIndex = 0;
    // The slot is the actual grid child: it owns the stable geometry. Keeping
    // the tile inside it means a join can only replace an empty placeholder
    // with a same-sized slot, never move the existing tiles.
    this.slot = h(
      'div',
      {
        class: 'agil-slot',
        dataset: { agilSlot: 'tile', participantId: this.participantId },
      },
      this.element,
    );

    this.update(options);
  }

  get participantIdValue(): string {
    return this.participantId;
  }

  snapshotCamera(track: MediaStreamTrack): HTMLCanvasElement | null {
    const { videoWidth, videoHeight } = this.video;
    if (this.isSelf || !this.videoExpected || !this.hasFrames || this.video.readyState < 2 ||
        videoWidth <= 0 || videoHeight <= 0 || track.muted || track.readyState !== 'live' ||
        this.currentStream?.getVideoTracks()[0] !== track) return null;

    // A direct copy at thumbnail resolution avoids encoding and preserves the
    // original aspect ratio, including when the camera is vertical.
    const canvas = this.video.ownerDocument.createElement('canvas');
    const scale = Math.min(1, 192 / videoWidth, 108 / videoHeight);
    canvas.width = Math.max(1, Math.round(videoWidth * scale));
    canvas.height = Math.max(1, Math.round(videoHeight * scale));
    try {
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(this.video, 0, 0, canvas.width, canvas.height);
      return canvas;
    } catch {
      return null;
    }
  }

  /**
   * In SFU calls publication can arrive before the participant's `state.cam`
   * update. The live track allows the tile to render during that interval.
   */
  private hasLiveRemoteVideo(stream: MediaStream | null): boolean {
    if (!stream) return false;
    return stream.getVideoTracks().some((track) => track.readyState === 'live' && !track.muted);
  }

  private setStream(stream: MediaStream | null): void {
    if (stream === this.currentStream) return;
    this.currentStream = stream;
    this.hasFrames = false;
    this.video.srcObject = stream;
    if (stream) {
      void this.video.play().catch(() => {
        /* autoplay can be blocked until a gesture; join happens after one */
      });
    }
  }

  update(tile: TileState): void {
    const { participant, isSelf } = tile;
    const name = participant.name || this.i18n.t('guest');
    // A `cam: on` flag alone is not enough: when the track is missing (denied
    // permission, reconnecting peer) the tile must keep the avatar/placeholder
    // instead of showing an empty black stage (DC-24/DC-30). A tile outside the
    // gallery video budget is deliberately suppressed: its stream may be stale
    // or absent, but it must never paint a black/frozen rectangle.
    const suppressed = tile.videoSuppressed === true && !isSelf;
    const streamHasVideo = Boolean(tile.stream?.getVideoTracks().some((track) => track.readyState === 'live'));
    const hasVideo = !suppressed && (
      ((participant.state.cam === 'on' || participant.state.screen) && streamHasVideo) ||
      (!isSelf && tile.muteAudio === true && this.hasLiveRemoteVideo(tile.stream))
    );
    this.videoExpected = hasVideo;
    this.setStream(suppressed ? null : tile.stream);
    const showVideo = hasVideo && this.hasFrames;
    const cachedFrame = showVideo ? undefined : tile.cachedFrame;
    const previousFrame = this.framePreview.querySelector('canvas');
    if (previousFrame && previousFrame !== cachedFrame) previousFrame.remove();
    if (cachedFrame && previousFrame !== cachedFrame) this.framePreview.prepend(cachedFrame);
    this.framePreview.hidden = !cachedFrame;
    this.video.style.display = showVideo ? '' : 'none';
    this.video.style.transform = tile.mirrored && isSelf ? 'scaleX(-1)' : '';
    // A budgeted-out tile can still have a live screen share even when the
    // camera is off, so the “play video” affordance must cover both sources.
    const canPlayVideo = suppressed && (participant.state.cam === 'on' || participant.state.screen === true);
    this.placeholder.style.display = showVideo || (cachedFrame && !canPlayVideo) ? 'none' : '';
    this.playButton.hidden = !canPlayVideo;
    this.playButton.title = canPlayVideo
      ? `${this.i18n.t('playVideo')} — ${participant.name || this.i18n.t('guest')}`
      : this.i18n.t('playVideo');
    this.playButton.setAttribute('aria-label', `${this.i18n.t('playVideo')}: ${participant.name || this.i18n.t('guest')}`);
    this.placeholderText.textContent = canPlayVideo ? this.i18n.t('videoBudgetPaused') : this.i18n.t('camOff');
    this.avatar.textContent = initials(participant.name);
    this.nameEl.textContent = name;
    this.nameEl.title = name;
    this.element.setAttribute('aria-label', this.i18n.t('participantTile', { name }));
    // State stays discoverable even when small tiles collapse the mic/camera
    // chips into 8 px dots (C-11): the native title repeats both states.
    const stateTitle = [
      participant.name || this.i18n.t('guest'),
      this.i18n.t(participant.state.mic === 'off' ? 'micMuted' : 'micOn'),
      this.i18n.t(participant.state.cam === 'off' ? 'camOff' : 'cameraOn'),
    ].join(' · ');
    this.element.title = isSelf ? `${this.i18n.t('me')} · ${stateTitle}` : stateTitle;
    const role = roleLabel(this.i18n, participant.role);
    const repeatedRole = name.trim().toLocaleLowerCase() === role.toLocaleLowerCase();
    this.roleEl.textContent = role;
    this.roleEl.dataset.role = participant.role;
    this.roleEl.style.display = repeatedRole ? 'none' : '';
    this.nameEl.classList.toggle('is-only-label', repeatedRole);
    this.countryEl.textContent = participant.country ?? '';
    this.countryEl.style.display = participant.country ? '' : 'none';
    this.countryEl.title = participant.country ? `${this.i18n.t('country')}: ${participant.country}` : '';

    this.element.classList.toggle('agil-tile-speaking', tile.speaking);
    this.element.classList.toggle('agil-tile-pinned', tile.pinned);
    const reconnecting = !isSelf && participant.presence === 'reconnecting';
    // Presence is rendered, not just stored: peers inside the resume-grace
    // lease get a badge and a stable data hook while they reconnect.
    this.element.dataset.presence = participant.presence ?? 'online';
    this.element.classList.toggle('is-reconnecting', reconnecting);
    this.element.dataset.connection = tile.connection;
    this.element.dataset.mic = participant.state.mic;
    this.element.dataset.cam = participant.state.cam;
    this.element.dataset.videoState = cachedFrame ? 'cached' : showVideo ? 'live' : 'avatar';
    this.element.dataset.videoSuppressed = String(suppressed);
    this.element.classList.toggle('agil-tile-hand-raised', Boolean(participant.state.handRaised));
    this.element.setAttribute('data-hand', String(Boolean(participant.state.handRaised)));
    this.pinButton.classList.toggle('is-active', tile.pinned);
    this.pinButton.title = tile.pinned ? this.i18n.t('unpin') : this.i18n.t('pin');
    this.pinButton.setAttribute('aria-label', this.pinButton.title);

    this.renderBadges(tile);
    this.renderIntegrity(tile.integrity, participant);
  }

  private renderBadges(tile: TileState): void {
    this.stateBadges.replaceChildren();
    const { participant } = tile;
    if (!tile.isSelf && participant.presence === 'reconnecting') {
      this.stateBadges.appendChild(
        this.badge('refresh', this.i18n.t('presenceReconnecting'), 'agil-badge-warning agil-presence-badge'),
      );
    }
    if (participant.state.mic === 'off') {
      this.stateBadges.appendChild(this.badge('mic-off', this.i18n.t('micMuted'), 'agil-badge-danger'));
    }
    if (participant.state.cam === 'off') {
      this.stateBadges.appendChild(this.badge('camera-off', this.i18n.t('camOff'), 'agil-badge-muted'));
    }
    if (participant.state.handRaised) {
      this.stateBadges.appendChild(this.badge('hand', this.i18n.t('handIsRaised'), 'agil-badge-warning'));
    }
    if (participant.state.screen) {
      this.stateBadges.appendChild(this.badge('screen', this.i18n.t('screenSharing'), 'agil-badge-info'));
    }
    if (tile.connection === 'failed' || tile.connection === 'disconnected') {
      this.stateBadges.appendChild(this.badge('warning', this.i18n.t('connectionOffline'), 'agil-badge-danger'));
    }
  }

  private badge(iconName: Parameters<typeof icon>[0], label: string, className: string): HTMLSpanElement {
    const span = h('span', { class: `agil-badge ${className}`, title: label });
    span.appendChild(icon(iconName, 14));
    return span;
  }

  private renderIntegrity(integrity: ParticipantIntegrity | undefined, participant: Participant): void {
    // Only an explicit `suspicious` warrants the red triangle: a missing field
    // means “not checked”, not “spoofed”. Classes are reset on every render so
    // a recovered participant cannot keep a stale `is-suspicious` colour.
    this.integrityEl.classList.remove('is-verified', 'is-suspicious');
    const badge = integrityBadge(integrity, Boolean(participant.verified));
    if (badge === 'none') {
      this.integrityEl.replaceChildren();
      this.integrityEl.style.display = 'none';
      this.integrityEl.removeAttribute('title');
      return;
    }
    this.integrityEl.style.display = '';
    this.integrityEl.replaceChildren();
    if (badge === 'verified') {
      this.integrityEl.classList.add('is-verified');
      this.integrityEl.title = participant.verified ? this.i18n.t('verified') : this.i18n.t('integrityVerified');
      this.integrityEl.appendChild(icon(participant.verified ? 'user-check' : 'shield', 14));
      return;
    }
    this.integrityEl.classList.add('is-suspicious');
    this.integrityEl.title = this.i18n.t('integritySuspicious');
    this.integrityEl.appendChild(icon('warning', 14));
  }

  destroy(): void {
    this.releaseAudioOutput?.();
    this.video.srcObject = null;
    this.slot.remove();
  }
}
