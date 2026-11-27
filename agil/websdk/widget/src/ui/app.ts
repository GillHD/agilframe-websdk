/**
 * Main widget layout: header (brand/room/participants/quality/theme), video grid,
 * self-view, caption overlay, side panels, control bar, toasts.
 *
 * The app is a pure renderer of `CallState`: every change comes from the store,
 * every interaction is forwarded to `AppActions` (implemented in index.ts).
 * Stable e2e hooks required by the contract are emitted here and in the tiles.
 */
import type { FeatureKey, Locale, Participant } from '@agil/protocol';
import { formatDuration, h, setText, uid } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';
import {
  formatParticipantCount,
  galleryPageInfo,
  pageParticipants,
  planVideoSubscriptions,
  type GalleryPageInfo,
  type VideoQualityPreference,
} from '../call/large-room.js';
import { canFeature, canInviteFromCall } from '../permissions.js';
import { recordingIndicatorState } from '../call/recording-state.js';
import { resolveCallChrome } from './call-chrome.js';
import type { CallState, PanelKind } from '../types.js';
import type { CallStore } from '../state.js';
import { AssistantPanel } from './assistant-panel.js';
import { Banner } from './banner.js';
import { GalleryFrameCache } from './gallery-frame-cache.js';
import { BreakoutBanner } from './breakout-banner.js';
import { BreakoutPanel, type BreakoutStartOptions } from './breakout-panel.js';
import { ChatPanel } from './chat-panel.js';
import { ControlsBar, type ControlActions } from './controls.js';
import {
  controlDensity,
  isNarrowControlsViewport,
  callControlsWidth,
  compactControlKeys,
  usesCompactTouchControls,
  resolveControlsStyle,
} from './controls-density.js';
import { JoinScreen, type JoinInput } from './join-screen.js';
import { connectionInput, resolveConnectionStatus } from './connection-status.js';
import { LobbyPanel } from './lobby-panel.js';
import { LobbyScreen } from './lobby-screen.js';
import { resolveMediaBadge } from './media-badge.js';
import { NotesPanel } from './notes-panel.js';
import { ParticipantsPanel } from './participants-panel.js';
import { SecurityBadge } from './security-badge.js';
import { embeddedSlotLayout, fitSlotMatrix, resolveSlotLayout, slotLayout } from './slot-layout.js';
import { SettingsPanel } from './settings-panel.js';
import { ToastManager, type ToastAction } from './toasts.js';
import { TranscriptPanel } from './transcript-panel.js';
import { VideoTile, type TileState } from './video-tile.js';
import { reactionNode } from './emoji.js';
import type { DeviceLists } from '../call/media.js';

export interface AppActions extends ControlActions {
  onJoin: (input: JoinInput) => void;
  onOfflineDemo: () => void;
  onTogglePreviewMic: () => void;
  onTogglePreviewCamera: () => void;
  /** Guest waiting room: cancel the pending request. */
  onLobbyCancel: () => void;
  /** Guest waiting room: re-submit the join request. */
  onLobbyRetry: () => void;
  /** Guest waiting room: back to the join form. */
  onLobbyBack: () => void;
  /** Host waiting room: admit / reject one request. */
  onLobbyAdmit: (requestId: string) => Promise<void>;
  onLobbyReject: (requestId: string) => Promise<void>;
  /** Host waiting room: admit every queued request sequentially. */
  onLobbyAdmitAll: () => Promise<void>;
  /** Host waiting room: pull the queue (manual refresh / polling fallback). */
  onLobbyRefresh: () => Promise<void>;
  /** Host/moderator breakout rooms: start / close all / reload the plan. */
  onBreakoutStart: (input: BreakoutStartOptions) => Promise<void>;
  onBreakoutCloseAll: () => Promise<void>;
  onBreakoutRefresh: () => Promise<void>;
  /** Participant banner: return from the sub-room to the main call. */
  onBreakoutReturn: () => void;
  onClosePanel: () => void;
  onSendChat: (text: string) => Promise<void>;
  onAttachFile: (file: File) => void;
  onDownload: (url: string, name: string) => void;
  onSeek: (seconds: number) => void;
  onExportTranscript: () => void;
  onAskAssistant: (question: string) => void;
  onMicDevice: (deviceId: string) => void;
  onNoiseSuppression: (enabled: boolean) => Promise<boolean>;
  onCamDevice: (deviceId: string) => void;
  onSpeakerDevice: (deviceId: string) => Promise<boolean>;
  registerAudioOutput: (element: HTMLMediaElement) => () => void;
  onBlurMode: (mode: 'off' | 'blur' | 'image', imageUrl?: string) => void;
  onBlurStrength: (value: number) => void;
  onLanguage: (locale: Locale) => void;
  onThemeScheme: (scheme: 'light' | 'dark' | 'auto') => void;
  onFullscreen: () => void;
  onPip: () => void;
  onMinimize: () => void;
  onRestore: () => void;
  onRequestPip: () => void;
  onToggleFullscreen: () => void;
  onOpenNewTab: () => void;
  onCopyLink: () => void;
  onPin: (participantId: string | null) => void;
  /** Gallery video budget: promote a tile into the video set (“play video”). */
  onPlayVideo: (participantId: string) => void;
  onGalleryViewportChange: () => void;
  getGalleryCamera: (id: string) => { publicationId: string; track: MediaStreamTrack | undefined } | null;
  onManualGalleryScroll: () => void;
  /** Large-room gallery: auto-follow the active speaker. */
  onToggleFollowSpeaker: () => void;
  /** Toggle grid <-> speaker (spotlight) view. */
  onToggleSpeakerView: () => void;
  /**
   * Explicit view switch used by the gallery's segmented control: `true` selects
   * speaker view, `false` returns to the grid. “Сетка” is idempotent; “Спикер”
   * still toggles (clicking it while in speaker view returns to the grid, which
   * is what existing QA flows and user muscle memory expect).
   */
  onSetSpeakerView: (enabled: boolean) => void;
  /** Manual remote video quality for SFU rooms. */
  onVideoQuality: (quality: VideoQualityPreference) => void;
  /** Jump to a participant (pin + page). */
  onLocateParticipant: (participantId: string) => void;
  onLocationConsent: (consent: boolean) => void;
  getDevices: () => Promise<DeviceLists>;
}

export class WidgetApp {
  readonly root: HTMLElement;
  private readonly store: CallStore;
  private readonly i18n: I18n;
  private readonly actions: AppActions;
  private readonly embedded: boolean;
  /** Embedded chrome-less desktop: compact header and rectangular dock. */
  private desktopEmbedded = false;
  private readonly header: HTMLElement;
  private readonly roomNameEl: HTMLSpanElement;
  private readonly timerEl: HTMLSpanElement;
  private readonly participantsCountEl: HTMLSpanElement;
  private readonly mediaBadge: HTMLSpanElement;
  private readonly e2eeBadge: HTMLSpanElement;
  private readonly viewerHint: HTMLDivElement;
  /** Compact header slot that owns page nav + the Сетка/Спикер switch in embedded desktop. */
  private readonly headerView: HTMLDivElement;
  private readonly connectionEl: HTMLSpanElement;
  private readonly connectionDot: HTMLSpanElement;
  private readonly connectionText: HTMLSpanElement;
  private readonly qualityEl: HTMLSpanElement;
  private readonly qualityDot: HTMLSpanElement;
  private readonly qualityTrigger: HTMLButtonElement;
  private readonly qualityMenu: HTMLFieldSetElement;
  private readonly qualityOptions = new Map<VideoQualityPreference, HTMLInputElement>();
  private readonly recordingEl: HTMLDivElement;
  private readonly recordingTime: HTMLSpanElement;
  private readonly grid: HTMLDivElement;
  private readonly stageView: HTMLDivElement;
  private readonly viewSwitch: HTMLDivElement;
  private readonly gridViewButton: HTMLButtonElement;
  private readonly followButton: HTMLButtonElement;
  private readonly speakerButton: HTMLButtonElement;
  private readonly panelHost: HTMLElement;
  private readonly captionOverlay: HTMLDivElement;
  private readonly footer: HTMLElement;
  private readonly controlsLayer: HTMLDivElement;
  private autoHideTimer: ReturnType<typeof setTimeout> | null = null;
  private viewportVideoIds: string[] | undefined;
  private gridFrame: number | null = null;
  private gridWindow: Window | null = null;
  private galleryAnchor: { ids: string[]; columns: number; pitch: number; top: number } | null = null;
  private galleryDrag: { pointer: number; y: number; top: number; active: boolean } | null = null;
  private pendingGalleryTarget: string | null = null;
  private readonly onActivity = (): void => this.handleActivity();
  /**
   * Viewport changes only remount/refresh the chrome; the grid geometry itself
   * is CSS-driven. This is what makes the bar↔island collapse happen at the same
   * breakpoint as the CSS (ControlsBar no longer owns a resize listener).
   */
  private readonly onWindowResize = (): void => {
    this.syncVisualViewport();
    const state = this.store.getState();
    if (state.phase !== 'joined' || state.settings.minimized) return;
    // Crossing 760 px (or resizing the embedded card) can switch the chrome
    // between the standard toolbar and the compact dock. Re-evaluate before
    // re-mounting the toolbar so CSS and DOM agree.
    this.syncCallChrome(state, true, false);
    this.syncViewSwitchHome();
    const controlFocus = this.mountControls(state);
    this.controls.update(state, this.featureGate(state), this.desktopEmbedded, controlFocus);
    // The compact/desktop slot matrix is chosen from the viewport width, so a
    // resize across the 900 px boundary must re-pick the matrix, not just
    // re-fit the current one.
    this.renderGrid(state);
    this.syncDockSafeInset();
  };
  private readonly themeButton: HTMLButtonElement;
  private readonly restoreButton: HTMLButtonElement;
  private readonly participantsButton: HTMLButtonElement;
  private readonly lobbyButton: HTMLButtonElement;
  private readonly lobbyBadge: HTMLSpanElement;
  private readonly lobbyLabel: HTMLSpanElement;
  private readonly breakoutButton: HTMLButtonElement;
  private readonly breakoutLabel: HTMLSpanElement;
  private readonly waitingInvite: HTMLElement;
  private readonly waitingTitle: HTMLHeadingElement;
  private readonly waitingDescription: HTMLParagraphElement;
  private readonly waitingInviteAction: HTMLButtonElement;
  private readonly joinScreen: JoinScreen;
  private readonly lobbyScreen: LobbyScreen;
  private readonly controls: ControlsBar;
  private readonly chatPanel: ChatPanel;
  private readonly participantsPanel: ParticipantsPanel;
  private readonly lobbyPanel: LobbyPanel;
  private readonly breakoutPanel: BreakoutPanel;
  private readonly notesPanel: NotesPanel;
  private readonly transcriptPanel: TranscriptPanel;
  private readonly settingsPanel: SettingsPanel;
  private readonly mediaDevices = navigator.mediaDevices;
  private readonly onMediaDevicesChanged = () => this.refreshDeviceOptions();
  private readonly assistantPanel: AssistantPanel;
  private readonly banner: Banner;
  private readonly breakoutBanner: BreakoutBanner;
  private readonly securityBadge: SecurityBadge;
  readonly toasts: ToastManager;
  private readonly participantNotice: HTMLDivElement;
  private participantNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly tiles = new Map<string, VideoTile>();
  private readonly galleryFrames = new GalleryFrameCache(() => this.queueGalleryRender());
  private liveGalleryIds: ReadonlySet<string> = new Set();
  /** Neutral empty-slot elements, reused so joins/leaves never re-create DOM. */
  private readonly emptySlots: HTMLDivElement[] = [];
  private slotResizeObserver: ResizeObserver | null = null;
  private readonly videoTileDimensions = new Map<string, { width: number; height: number }>();
  private hostResizeObserver: ResizeObserver | null = null;
  private controlsWidthBucket = '';
  private readonly speaking = new Set<string>();
  private readonly panelElements = new Map<PanelKind, HTMLElement>();
  private readonly brandMarkEl: HTMLDivElement;
  private unsubscribe: (() => void) | null = null;
  private lastPhase = '';
  private lastChatRendered = -1;
  private lastPanel: PanelKind = 'none';
  private eventDocument: Document | null = null;

  private readonly syncVisualViewport = (): void => {
    const win = this.root.ownerDocument.defaultView;
    const viewport = win?.visualViewport;
    const host = this.root.parentElement ?? this.root;
    if (win && viewport && win.matchMedia('(pointer: coarse)').matches &&
      Math.abs(viewport.scale - 1) < 0.01 && viewport.height + 1 < win.innerHeight) {
      const bounds = host.getBoundingClientRect();
      const top = Math.max(bounds.top, viewport.offsetTop);
      const bottom = Math.min(bounds.bottom, viewport.offsetTop + viewport.height);
      if (bottom > top && bottom - top < bounds.height) {
        this.root.style.setProperty('--agil-visible-call-offset', `${top - bounds.top}px`);
        this.root.style.setProperty('--agil-visible-call-height', `${bottom - top}px`);
        return;
      }
    }
    this.root.style.removeProperty('--agil-visible-call-offset');
    this.root.style.removeProperty('--agil-visible-call-height');
  };

  private bindWindowEvents(doc: Document | null): void {
    if (this.eventDocument === doc) return;
    this.eventDocument?.removeEventListener('keydown', this.onDocumentKeyDown, true);
    this.eventDocument?.defaultView?.removeEventListener('resize', this.onWindowResize);
    this.eventDocument?.defaultView?.visualViewport?.removeEventListener('resize', this.syncVisualViewport);
    this.eventDocument?.defaultView?.visualViewport?.removeEventListener('scroll', this.syncVisualViewport);
    this.eventDocument = doc;
    doc?.addEventListener('keydown', this.onDocumentKeyDown, true);
    doc?.defaultView?.addEventListener('resize', this.onWindowResize);
    doc?.defaultView?.visualViewport?.addEventListener('resize', this.syncVisualViewport);
    doc?.defaultView?.visualViewport?.addEventListener('scroll', this.syncVisualViewport);
    if (doc) this.syncVisualViewport();
  }

  /** Escape closes the open side panel or reveals auto-hidden controls. */
  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (!this.qualityMenu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      this.closeQualityMenu(true);
      return;
    }
    const state = this.store.getState();
    if (state.settings.minimized) return;
    if (state.settings.panel === 'chat' && this.chatPanel.closeEmojiPicker(true)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (state.settings.panel !== 'none') {
      event.preventDefault();
      this.actions.onClosePanel();
      return;
    }
    if (this.controls.element.classList.contains('is-auto-hidden')) {
      event.preventDefault();
      this.handleActivity();
    }
  };

  closeControlPopovers(): void {
    this.controls.closeAllPopovers();
    this.closeQualityMenu();
  }

  private readonly onQualityOutsidePress = (event: PointerEvent): void => {
    const path = event.composedPath();
    if (!path.includes(this.qualityMenu) && !path.includes(this.qualityTrigger)) this.closeQualityMenu();
  };

  private closeQualityMenu(restoreFocus = false): void {
    if (this.qualityMenu.hidden) return;
    this.qualityMenu.hidden = true;
    this.qualityTrigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.qualityTrigger.focus({ preventScroll: true });
  }

  constructor(host: HTMLElement, store: CallStore, i18n: I18n, actions: AppActions, embedded: boolean, roomId: string) {
    this.store = store;
    this.i18n = i18n;
    this.actions = actions;
    this.embedded = embedded;

    this.roomNameEl = h('span', { class: 'agil-header-room-name', dataset: { agilRoom: '' } });
    this.brandMarkEl = h('div', { class: 'agil-brand-mark' }, icon('grid', 18));
    this.timerEl = h('span', { class: 'agil-header-timer' });
    this.mediaBadge = h('span', { class: 'agil-pill agil-media-mode' });
    this.mediaBadge.dataset.agilMediaModeBadge = '';
    this.e2eeBadge = h('span', { class: 'agil-pill agil-e2ee-badge', text: 'E2EE' });
    this.e2eeBadge.dataset.agilE2ee = '';
    this.e2eeBadge.hidden = true;
    this.e2eeBadge.title = `${i18n.t('e2eeTitle')}. ${i18n.t('e2eeChatNote')}`;
    this.viewerHint = h('div', { class: 'agil-viewer-hint', attrs: { role: 'status' } });
    this.viewerHint.hidden = true;
    this.participantsCountEl = h('span', {
      class: 'agil-participants-badge',
      dataset: { agilParticipantsCount: '' },
      attrs: { 'aria-hidden': 'true' },
    });
    // One participants affordance (C-14): the numeric count is a badge inside
    // the participants button, not a separate pill that duplicates it 126 px
    // away. `data-agil-participants-count` stays for QA/e2e readers.
    this.connectionDot = h('span', { class: 'agil-connection-dot', attrs: { 'aria-hidden': 'true' } });
    this.connectionText = h('span', { class: 'agil-connection-label' });
    this.connectionEl = h('span', {
      class: 'agil-pill agil-connection',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    this.connectionEl.dataset.agilConnection = '';
    this.connectionEl.append(this.connectionDot, this.connectionText);
    this.qualityDot = h('span', { class: 'agil-quality-dot' });
    this.qualityEl = h('span', { class: 'agil-pill agil-quality' });
    this.qualityEl.dataset.agilQualityIndicator = '';
    this.qualityEl.appendChild(this.qualityDot);
    const qualityMenuId = uid('agil-quality');
    this.qualityTrigger = h('button', {
      class: 'agil-pill agil-quality-trigger', dataset: { agilAction: 'video-quality' },
      attrs: { type: 'button', 'aria-label': i18n.t('videoQuality'), 'aria-expanded': 'false', 'aria-controls': qualityMenuId },
    }, icon('quality', 18), h('span', { text: i18n.t('videoQualityShort') }));
    this.qualityTrigger.hidden = true;
    this.qualityMenu = h('fieldset', { class: 'agil-quality-menu', attrs: { id: qualityMenuId } },
      h('legend', { text: i18n.t('videoQuality') }),
    );
    this.qualityMenu.hidden = true;
    for (const [value, label, description] of [
      ['auto', 'videoQualityAuto', 'videoQualityAutoHint'],
      ['high', 'videoQualityHigh', 'videoQualityHighHint'],
      ['medium', 'videoQualityMedium', 'videoQualityMediumHint'],
      ['low', 'videoQualityLow', 'videoQualityLowHint'],
    ] as const) {
      const input = h('input', { attrs: { type: 'radio', name: qualityMenuId, value } });
      input.addEventListener('change', () => this.actions.onVideoQuality(value));
      this.qualityOptions.set(value, input);
      this.qualityMenu.appendChild(h('label', { class: 'agil-quality-option' }, input,
        h('span', {}, h('strong', { text: i18n.t(label) }), h('small', { text: i18n.t(description) })),
      ));
    }
    this.qualityTrigger.addEventListener('click', () => {
      if (!this.qualityMenu.hidden) { this.closeQualityMenu(true); return; }
      this.controls.closeAllPopovers();
      this.actions.onOpenPopover?.();
      this.qualityMenu.hidden = false;
      this.qualityTrigger.setAttribute('aria-expanded', 'true');
      this.qualityMenu.querySelector<HTMLInputElement>(':checked')?.focus({ preventScroll: true });
    });
    this.qualityMenu.addEventListener('focusout', (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && next !== this.qualityTrigger && !this.qualityMenu.contains(next)) this.closeQualityMenu();
    });
    this.securityBadge = new SecurityBadge(i18n);

    this.recordingTime = h('span', { class: 'agil-rec-time', attrs: { 'aria-hidden': 'true' } });
    this.recordingEl = h(
      'div',
      {
        class: 'agil-rec-indicator',
        role: 'status',
        attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' },
      },
      h('span', { class: 'agil-rec-dot', attrs: { 'aria-hidden': 'true' } }),
      h('span', { text: i18n.t('recIndicator') }),
      this.recordingTime,
    );
    this.recordingEl.setAttribute('aria-label', i18n.t('recIndicator'));
    this.recordingEl.hidden = true;

    this.themeButton = h('button', { class: 'agil-icon-btn agil-theme-toggle', title: i18n.t('settingsTheme') });
    this.themeButton.type = 'button';
    this.themeButton.setAttribute('aria-label', i18n.t('settingsTheme'));
    this.themeButton.appendChild(icon('sun', 18));
    this.themeButton.addEventListener('click', () => this.cycleTheme());

    this.restoreButton = h('button', {
      class: 'agil-minimized-restore',
      dataset: { agilAction: 'restore' },
      title: i18n.t('restore'),
    });
    this.restoreButton.type = 'button';
    this.restoreButton.setAttribute('aria-label', i18n.t('restore'));
    this.restoreButton.appendChild(icon('restore', 18));
    this.restoreButton.hidden = true;
    this.restoreButton.addEventListener('click', () => this.actions.onRestore());

    this.participantsButton = h('button', { class: 'agil-icon-btn agil-participants-button', title: i18n.t('participantsTitle') });
    this.participantsButton.type = 'button';
    this.participantsButton.setAttribute('aria-label', i18n.t('participantsTitle'));
    this.participantsButton.appendChild(icon('users', 18));
    this.participantsButton.appendChild(this.participantsCountEl);
    this.participantsButton.addEventListener('click', () => this.actions.onOpenPanel('participants'));

    // Waiting-room control (host/moderator): count badge + panel entry point.
    this.lobbyBadge = h('span', { class: 'agil-lobby-badge', dataset: { agilLobbyBadge: '' }, attrs: { 'aria-hidden': 'true' } });
    this.lobbyBadge.hidden = true;
    this.lobbyLabel = h('span', { class: 'agil-lobby-label', text: i18n.t('lobbyHostButton') });
    this.lobbyButton = h(
      'button',
      {
        class: 'agil-icon-btn agil-lobby-button',
        title: i18n.t('lobbyHostButton'),
        dataset: { agilAction: 'lobby' },
        attrs: { 'aria-label': i18n.t('lobbyHostButton'), 'aria-haspopup': 'dialog', 'aria-controls': 'agil-lobby-panel' },
      },
      icon('user-check', 18),
      this.lobbyLabel,
      this.lobbyBadge,
    );
    this.lobbyButton.type = 'button';
    this.lobbyButton.hidden = true;
    this.lobbyButton.addEventListener('click', () => this.actions.onOpenPanel('lobby'));

    // Breakout rooms (host/moderator): header entry point + panel.
    this.breakoutLabel = h('span', { class: 'agil-breakout-label', text: i18n.t('breakoutButton') });
    this.breakoutButton = h(
      'button',
      {
        class: 'agil-icon-btn agil-breakout-button',
        title: i18n.t('breakoutButton'),
        dataset: { agilAction: 'breakout' },
        attrs: {
          'aria-label': i18n.t('breakoutButton'),
          'aria-haspopup': 'dialog',
          'aria-controls': 'agil-breakout-panel',
        },
      },
      icon('rooms', 18),
      this.breakoutLabel,
    );
    this.breakoutButton.type = 'button';
    this.breakoutButton.hidden = true;
    this.breakoutButton.addEventListener('click', () => this.actions.onOpenPanel('breakout'));

    this.participantsButton.dataset.agilAction = 'participants';

    // Embedded desktop owns a compact header: room/status/count on the left and
    // the Сетка/Спикер switch + page nav on the right (call-ui-v3 §9).
    this.headerView = h('div', {
      class: 'agil-header-view',
      dataset: { agilHeaderView: '' },
    });
    this.headerView.hidden = true;

    this.header = h(
      'header',
      { class: 'agil-header' },
      h(
        'div',
        { class: 'agil-brand' },
        this.brandMarkEl,
        h('div', { class: 'agil-brand-text' }, h('div', { class: 'agil-brand-name' }), h('div', { class: 'agil-brand-org' })),
      ),
      h('div', { class: 'agil-header-room' }, this.roomNameEl, this.timerEl),
      h(
        'div',
        { class: 'agil-header-status' },
        this.mediaBadge,
        this.e2eeBadge,
        this.recordingEl,
        this.connectionEl,
        this.qualityEl,
        this.qualityTrigger,
        // The participant count lives *inside* the participants button now
        // (C-14): it must not be re-appended to the status row.
        this.participantsButton,
        this.lobbyButton,
        this.breakoutButton,
        this.securityBadge.element,
        this.themeButton,
        this.headerView,
      ),
    );

    this.grid = h('div', { class: 'agil-grid' });
    if (typeof ResizeObserver !== 'undefined') {
      this.slotResizeObserver = new ResizeObserver((entries) => {
        let tilesResized = false;
        for (const { target, contentRect } of entries) {
          if (target === this.grid) {
            if (this.grid.dataset.virtualized === 'true') this.queueGalleryRender();
            else {
              this.syncSlotGeometry();
              this.syncDockSafeInset();
            }
            continue;
          }
          const tile = target as HTMLElement;
          const id = tile.dataset.participantId;
          if (!id || this.tiles.get(id)?.element !== tile) continue;
          const width = Math.round(contentRect.width);
          const height = Math.round(contentRect.height);
          if (width <= 0 || height <= 0) continue;
          const previous = this.videoTileDimensions.get(id);
          if (previous?.width === width && previous.height === height) continue;
          this.videoTileDimensions.set(id, { width, height });
          tilesResized = true;
        }
        if (tilesResized) {
          this.syncDockSafeInset();
          this.actions.onGalleryViewportChange();
        }
      });
      this.slotResizeObserver.observe(this.grid);
    }
    this.grid.addEventListener('scroll', () => this.queueGalleryRender(), { passive: true });
    for (const event of ['wheel', 'touchmove'] as const) {
      this.grid.addEventListener(event, () => this.manualGalleryScroll(), { passive: true });
    }
    this.grid.addEventListener('keydown', (event) => {
      if (event.target !== this.grid || this.grid.dataset.virtualized !== 'true' || event.defaultPrevented) return;
      const page = this.grid.clientHeight;
      const movement: Record<string, number> = {
        ArrowUp: -40, ArrowDown: 40, PageUp: -page, PageDown: page,
        Home: -this.grid.scrollHeight, End: this.grid.scrollHeight, ' ': event.shiftKey ? -page : page,
      };
      const offset = movement[event.key];
      if (offset === undefined) return;
      event.preventDefault();
      this.manualGalleryScroll();
      this.grid.scrollTop += offset;
    });
    this.grid.addEventListener('pointerdown', (event) => {
      if (this.grid.dataset.virtualized !== 'true' || event.pointerType !== 'mouse' || event.button !== 0 ||
          (event.target as Element).closest('button, a, input, select, textarea')) return;
      this.galleryDrag = { pointer: event.pointerId, y: event.clientY, top: this.grid.scrollTop, active: false };
    });
    this.grid.addEventListener('pointermove', (event) => {
      const drag = this.galleryDrag;
      if (!drag || drag.pointer !== event.pointerId || !(event.buttons & 1)) return;
      const distance = event.clientY - drag.y;
      if (!drag.active && Math.abs(distance) < 5) return;
      if (!drag.active) {
        drag.active = true;
        this.grid.setPointerCapture(event.pointerId);
        this.grid.dataset.dragging = 'true';
        this.manualGalleryScroll();
      }
      this.grid.scrollTop = drag.top - distance;
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      this.grid.addEventListener(event, () => {
        this.galleryDrag = null;
        delete this.grid.dataset.dragging;
      });
    }
    this.gridViewButton = h('button', {
      class: 'agil-gallery-toggle',
      dataset: { agilGallery: 'grid' },
      attrs: { 'aria-pressed': 'true', 'aria-label': i18n.t('galleryGridView') },
    });
    this.gridViewButton.type = 'button';
    this.gridViewButton.appendChild(icon('grid', 16));
    this.gridViewButton.appendChild(
      h('span', { class: 'agil-gallery-toggle-label', text: i18n.t('galleryGridView') }),
    );
    this.gridViewButton.addEventListener('click', () => this.actions.onSetSpeakerView(false));
    this.followButton = h('button', {
      class: 'agil-gallery-toggle agil-gallery-follow',
      dataset: { agilGallery: 'follow' },
      attrs: { 'aria-pressed': 'false', 'aria-label': i18n.t('galleryFollowSpeaker') },
    });
    this.followButton.type = 'button';
    this.followButton.appendChild(icon('target', 16));
    this.followButton.appendChild(
      h('span', { class: 'agil-gallery-toggle-label', text: i18n.t('galleryFollowSpeaker') }),
    );
    this.followButton.addEventListener('click', () => this.actions.onToggleFollowSpeaker());
    this.speakerButton = h('button', {
      class: 'agil-gallery-toggle',
      dataset: { agilGallery: 'speaker' },
      attrs: { 'aria-pressed': 'false', 'aria-label': i18n.t('gallerySpeakerView') },
    });
    this.speakerButton.type = 'button';
    this.speakerButton.appendChild(icon('speaker', 16));
    this.speakerButton.appendChild(
      h('span', { class: 'agil-gallery-toggle-label', text: i18n.t('gallerySpeakerView') }),
    );
    this.speakerButton.addEventListener('click', () => this.actions.onToggleSpeakerView());
    this.viewSwitch = h(
      'div',
      {
        class: 'agil-gallery-view',
        dataset: { agilGallery: 'view' },
        attrs: { role: 'group', 'aria-label': i18n.t('galleryViewMode') },
      },
      this.gridViewButton,
      this.speakerButton,
    );
    // Live captions: a named, polite status region so screen readers announce
    // the speaker + line and can identify the region by name (WCAG 1.3.1/4.1.2).
    this.captionOverlay = h('div', {
      class: 'agil-captions-overlay',
      attrs: {
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        'aria-label': i18n.t('captions'),
      },
    });
    this.captionOverlay.hidden = true;
    this.panelHost = h('aside', { class: 'agil-panel-host' });
    this.panelHost.hidden = true;

    this.joinScreen = new JoinScreen(i18n, {
      onJoin: (input) => this.actions.onJoin(input),
      onOfflineDemo: () => this.actions.onOfflineDemo(),
      onToggleMic: () => this.actions.onTogglePreviewMic(),
      onToggleCamera: () => this.actions.onTogglePreviewCamera(),
    });
    this.lobbyScreen = new LobbyScreen(i18n, roomId, {
      onCancel: () => this.actions.onLobbyCancel(),
      onRetry: () => this.actions.onLobbyRetry(),
      onBack: () => this.actions.onLobbyBack(),
    });

    this.controls = new ControlsBar(i18n, {
      onToggleMic: () => this.actions.onToggleMic(),
      onToggleCamera: () => this.actions.onToggleCamera(),
      onToggleScreen: () => this.actions.onToggleScreen(),
      onCycleBlur: () => this.actions.onCycleBlur(),
      onToggleChat: () => this.actions.onToggleChat(),
      onCopyLink: () => this.actions.onCopyLink(),
      onOpenPanel: (panel) => this.actions.onOpenPanel(panel),
      onToggleHand: () => this.actions.onToggleHand(),
      onReaction: (emoji) => this.actions.onReaction(emoji),
      onMicDevice: (id) => this.actions.onMicDevice(id),
      onNoiseSuppression: (enabled) => this.actions.onNoiseSuppression(enabled),
      onToggleSettings: () => this.actions.onToggleSettings(),
      onOpenPopover: () => {
        this.closeQualityMenu();
        this.actions.onOpenPopover?.();
      },
      onToggleRecording: () => this.actions.onToggleRecording(),
      onToggleCaptions: () => this.actions.onToggleCaptions(),
      onToggleAssistant: () => this.actions.onToggleAssistant(),
      onTogglePolls: () => this.actions.onTogglePolls?.(),
      onToggleBreakout: () => this.actions.onOpenPanel('breakout'),
      onToggleWhiteboard: () => this.actions.onToggleWhiteboard?.(),
      onToggleAnnotations: () => this.actions.onToggleAnnotations?.(),
      onCamDevice: (deviceId) => this.actions.onCamDevice(deviceId),
      onMirrorSelfView: (enabled) => this.actions.onMirrorSelfView(enabled),
      onBlurMode: (mode, imageUrl) => this.actions.onBlurMode(mode, imageUrl),
      onLeave: () => this.actions.onLeave(),
      onVideoQuality: (quality) => this.actions.onVideoQuality(quality),
      onMinimize: () => this.actions.onMinimize(),
      onRestore: () => this.actions.onRestore(),
      onRequestPip: () => this.actions.onRequestPip(),
      onToggleFullscreen: () => this.actions.onToggleFullscreen(),
      onOpenNewTab: () => this.actions.onOpenNewTab(),
    });

    this.chatPanel = new ChatPanel(i18n, {
      onSend: (text) => this.actions.onSendChat(text),
      onAttach: (file) => this.actions.onAttachFile(file),
      onDownload: (url, name) => this.actions.onDownload(url, name),
      onClose: () => this.actions.onClosePanel(),
      canFileShare: () => {
        const state = this.store.getState();
        return canFeature(state, 'fileShare');
      },
    });
    this.participantsPanel = new ParticipantsPanel(i18n, {
      onClose: () => this.actions.onClosePanel(),
      onLocate: (participantId) => this.actions.onLocateParticipant(participantId),
    });
    this.lobbyPanel = new LobbyPanel(i18n, {
      onAdmit: (requestId) => this.actions.onLobbyAdmit(requestId),
      onReject: (requestId) => this.actions.onLobbyReject(requestId),
      onAdmitAll: () => this.actions.onLobbyAdmitAll(),
      onRefresh: () => this.actions.onLobbyRefresh(),
      onClose: () => this.actions.onClosePanel(),
    });
    this.lobbyPanel.element.id = 'agil-lobby-panel';
    this.breakoutPanel = new BreakoutPanel(i18n, {
      onStart: (input) => this.actions.onBreakoutStart(input),
      onCloseAll: () => this.actions.onBreakoutCloseAll(),
      onRefresh: () => this.actions.onBreakoutRefresh(),
      onClosePanel: () => this.actions.onClosePanel(),
      canManage: () => {
        const role = this.store.getState().self?.role;
        return role === 'host' || role === 'moderator';
      },
    });
    this.breakoutPanel.element.id = 'agil-breakout-panel';
    this.notesPanel = new NotesPanel(i18n, {
      onClose: () => this.actions.onClosePanel(),
      onSeek: (seconds) => this.actions.onSeek(seconds),
    });
    this.transcriptPanel = new TranscriptPanel(i18n, {
      onClose: () => this.actions.onClosePanel(),
      onExport: () => this.actions.onExportTranscript(),
    });
    this.settingsPanel = new SettingsPanel(i18n, {
      onClose: () => this.actions.onClosePanel(),
      onMicDevice: (id) => this.actions.onMicDevice(id),
      onCamDevice: (id) => this.actions.onCamDevice(id),
      onSpeakerDevice: (id) => this.actions.onSpeakerDevice(id),
      onNoiseSuppression: (enabled) => this.actions.onNoiseSuppression(enabled),
      onBlurMode: (mode, url) => this.actions.onBlurMode(mode, url),
      onBlurStrength: (value) => this.actions.onBlurStrength(value),
      onLanguage: (locale) => this.actions.onLanguage(locale),
      onThemeScheme: (scheme) => this.actions.onThemeScheme(scheme),
      onLocationConsent: (consent) => this.actions.onLocationConsent(consent),
      getDevices: () => this.actions.getDevices(),
    });
    this.assistantPanel = new AssistantPanel(i18n, {
      onClose: () => this.actions.onClosePanel(),
      onAsk: (question) => this.actions.onAskAssistant(question),
    });
    this.panelElements.set('chat', this.chatPanel.element);
    this.panelElements.set('participants', this.participantsPanel.element);
    this.panelElements.set('lobby', this.lobbyPanel.element);
    this.panelElements.set('breakout', this.breakoutPanel.element);
    this.panelElements.set('notes', this.notesPanel.element);
    this.panelElements.set('transcript', this.transcriptPanel.element);
    this.panelElements.set('settings', this.settingsPanel.element);
    this.panelElements.set('assistant', this.assistantPanel.element);
    for (const element of this.panelElements.values()) {
      element.hidden = true;
      this.panelHost.appendChild(element);
    }

    this.banner = new Banner();
    this.breakoutBanner = new BreakoutBanner(i18n, { onReturn: () => this.actions.onBreakoutReturn() });
    this.footer = h('footer', { class: 'agil-footer' }, this.viewerHint, this.breakoutBanner.element);
    this.controlsLayer = h('div', { class: 'agil-controls-layer' });
    this.controlsLayer.hidden = true;
    this.controlsLayer.appendChild(this.controls.element);
    this.toasts = new ToastManager();
    this.participantNotice = h('div', {
      class: 'agil-participant-notice', dataset: { agilParticipantNotice: '' }, attrs: { role: 'status', 'aria-atomic': 'true' },
    });

    this.waitingTitle = h('h2');
    this.waitingDescription = h('p');
    this.waitingInviteAction = h('button', { class: 'agil-btn agil-btn-primary agil-waiting-invite-action', text: i18n.t('copyLink'), attrs: { type: 'button' } });
    this.waitingInviteAction.addEventListener('click', () => this.actions.onCopyLink());
    this.waitingInvite = h('section', { class: 'agil-waiting-invite', dataset: { agilWaitingInvite: '' } },
      h('span', { class: 'agil-waiting-icon', attrs: { 'aria-hidden': 'true' } }, icon('users', 16)),
      this.waitingTitle,
      this.waitingDescription,
      this.waitingInviteAction,
    );
    this.waitingInvite.hidden = true;
    const gallery = h('div', { class: 'agil-gallery-surface' }, this.grid, this.waitingInvite);
    this.stageView = h('div', { class: 'agil-stage-view' });
    this.stageView.hidden = true;
    const stage = h('div', { class: 'agil-stage' }, gallery, this.captionOverlay, this.stageView);
    // The degradation banner lives at the top-left of the stage (below the
    // header) so it never covers participant labels or the island controls.
    const main = h(
      'main',
      { class: 'agil-main' },
      this.joinScreen.element,
      this.lobbyScreen.element,
      this.banner.element,
      this.participantNotice,
      stage,
    );
    const body = h('div', { class: 'agil-body' }, main, this.panelHost);
    this.root = h('div', { class: `agil-app${embedded ? ' is-embedded' : ''}` }, this.header, body, this.controlsLayer, this.footer, this.restoreButton, this.qualityMenu);
    this.root.addEventListener('pointerdown', this.onQualityOutsidePress);
    host.appendChild(this.root);
    host.appendChild(this.toasts.element);
    this.mediaDevices?.addEventListener?.('devicechange', this.onMediaDevicesChanged);
    // The embedded card can resize without a window resize (split view, panel,
    // host layout). Re-evaluate both the chrome mode and the compact/wide header
    // bucket from the measured host width.
    if (typeof ResizeObserver !== 'undefined') {
      this.hostResizeObserver = new ResizeObserver(() => {
        const state = this.store.getState();
        if (state.phase !== 'joined' || state.settings.minimized) return;
        const root = this.root.parentElement ?? this.root;
        const width = this.root.clientWidth;
        const controlsWidth = callControlsWidth(this.root);
        const touch = usesCompactTouchControls(this.root, controlsWidth);
        const nextBucket = `${isNarrowControlsViewport(controlsWidth)}:${compactControlKeys(controlsWidth, touch).length}`;
        const toolbarChanged = nextBucket !== this.controlsWidthBucket;
        this.controlsWidthBucket = nextBucket;
        const nextSize = width > 0 && width <= 620 ? 'compact' : 'wide';
        const nextDesktop =
          resolveCallChrome({
            embedded: this.embedded,
            chrome: state.settings.chrome,
            pointerFine:
              this.root.ownerDocument.defaultView?.matchMedia('(pointer: fine)').matches ?? false,
            viewportWidth: this.root.ownerDocument.defaultView?.innerWidth ?? 0,
            hostWidth: width,
          }) === 'embedded-desktop';
        if (toolbarChanged || root.dataset.agilEmbedSize !== nextSize || root.dataset.agilEmbeddedDesktop !== String(nextDesktop)) {
          this.update(state);
        }
      });
      this.hostResizeObserver.observe(this.root);
    }
    for (const type of ['pointermove', 'pointerdown', 'touchstart', 'focusin', 'keydown'] as const) {
      this.root.addEventListener(type, this.onActivity, { passive: true });
    }
    this.root.addEventListener('click', (event) => {
      if (!this.store.getState().settings.minimized) return;
      const target = event.target;
      if (target instanceof Element && target.closest('button')) return;
      this.actions.onRestore();
    });

    this.unsubscribe = store.subscribe((state) => this.update(state));
    this.update(store.getState());
  }

  private cycleTheme(): void {
    const scheme = this.store.getState().settings.scheme;
    const next = scheme === 'light' ? 'dark' : scheme === 'dark' ? 'auto' : 'light';
    this.actions.onThemeScheme(next);
  }

  private featureGate(state: CallState): (feature: FeatureKey) => boolean {
    return (feature: FeatureKey) => canFeature(state, feature);
  }

  update(state: CallState): void {
    this.bindWindowEvents(this.root.ownerDocument);
    const root = this.root.parentElement ?? this.root;
    root.dataset.state = this.phaseToState(state);
    root.dataset.agilQuality = state.quality.tier;
    const joined = state.phase === 'joined';
    const minimized = joined && state.settings.minimized;
    this.syncCallChrome(state, joined, minimized);
    const chrome = state.settings.chrome;
    root.dataset.agilChatMode = state.settings.chatMode;
    root.dataset.agilAssistantReady = String(state.inCallAssistant.available);
    root.dataset.agilMediaMode = state.settings.mediaMode;
    root.dataset.agilViewer = String(state.settings.viewer);
    const breakoutView = state.breakout.assignment
      ? 'child'
      : state.breakout.plan?.status === 'active'
        ? 'active'
        : state.breakout.plan
          ? 'closed'
          : 'none';
    root.dataset.agilBreakout = breakoutView;
    this.root.dataset.agilBreakout = breakoutView;
    root.dataset.agilBreakoutSwitching = String(state.breakout.switching);
    this.root.dataset.agilBreakoutSwitching = String(state.breakout.switching);
    const totalParticipants = state.participants.length + (state.self ? 1 : 0);
    root.dataset.agilControlsAnchor = state.config.layout.controlsAnchor ?? 'bottom-center';
    root.dataset.agilDensity = controlDensity(totalParticipants);
    root.dataset.agilMinimized = String(minimized);
    root.dataset.chrome = chrome;
    root.dataset.inheritHost = String(state.config.layout.inheritHostStyles);
    root.dataset.layout = state.settings.layoutMode;
    const layoutExtra = state.config.layout as unknown as {
      header?: 'full' | 'compact' | 'hidden';
      videoFit?: 'contain' | 'cover';
      immersiveVideo?: boolean;
    };
    root.dataset.agilHeader = layoutExtra.header ?? 'full';
    root.dataset.agilVideoFit = layoutExtra.videoFit ?? 'contain';
    root.dataset.agilImmersive = String(Boolean(layoutExtra.immersiveVideo));
    root.dataset.minimizedPosition = state.config.layout.minimized.position;
    root.dataset.minimizedMode = state.config.layout.minimized.mode;
    this.root.dataset.phase = state.phase;
    this.root.dataset.layout = state.settings.layoutMode;
    this.root.dataset.minimized = String(minimized);
    this.root.dataset.chrome = chrome;
    this.root.dataset.agilFullscreen = String(state.settings.fullscreen);
    this.root.dataset.minimizedPosition = state.config.layout.minimized.position;
    this.root.dataset.minimizedMode = state.config.layout.minimized.mode;
    const lobbyEntered = state.phase === 'lobby' && this.lastPhase !== 'lobby';
    if (this.lastPhase !== state.phase) {
      this.root.classList.toggle('is-joined', joined);
      this.root.classList.toggle('is-minimized', minimized);
      this.root.classList.toggle('is-lobby', state.phase === 'lobby');
      this.lastPhase = state.phase;
    }
    this.root.classList.toggle('is-minimized', minimized);

    this.header.hidden = !joined || minimized;
    this.footer.hidden = !joined || minimized;
    this.grid.hidden = !joined;
    this.joinScreen.element.hidden = joined || state.phase === 'error' || state.phase === 'lobby';
    this.lobbyScreen.update(state);
    // Focus after the lobby subtree is visible (a hidden element cannot take focus).
    if (lobbyEntered) this.lobbyScreen.focus();
    this.panelHost.hidden = !joined || minimized || state.settings.panel === 'none';
    this.restoreButton.hidden = !minimized;
    this.renderJoin(state);
    if (!joined) {
      this.galleryFrames.clear();
      if (state.phase === 'left' && this.tiles.size > 0) this.releaseGalleryTiles();
      this.liveGalleryIds = new Set();
      this.captionOverlay.hidden = true;
      this.waitingInvite.hidden = true;
      this.galleryAnchor = null;
      this.pendingGalleryTarget = null;
      this.setViewportVideoIds(undefined);
      this.stageView.hidden = true;
      // The floating island/dock must not hover over the join screen: after
      // «Покинуть звонок» its buttons covered «Войти» until auto-hide fired.
      this.controlsLayer.hidden = true;
      this.controlsLayer.inert = true;
      // Cancel the idle countdown as well: otherwise it can fire right after
      // the next join and hide the fresh dock under the pointer (QA P1-4).
      this.controls.element.classList.remove('is-auto-hidden');
      this.controls.element.inert = false;
      if (this.autoHideTimer) {
        clearTimeout(this.autoHideTimer);
        this.autoHideTimer = null;
      }
      // Leaving/reloading a call must not restore an old video menu or "⋯".
      this.controls.closeAllPopovers();
      this.closeQualityMenu();
      return;
    }

    this.syncViewSwitchHome();
    this.renderHeader(state);
    this.renderGrid(state, minimized);
    this.renderPanels(state);
    this.renderCaptionOverlay(state);
    this.renderBanner(state);
    this.renderViewerHint(state);
    this.renderRecording(state);
    const controlFocus = this.mountControls(state);
    this.applyAutoHide(state);
    const can = this.featureGate(state);
    this.controls.update(state, can, this.desktopEmbedded, controlFocus);
    this.syncDockSafeInset();
    this.joinScreen.update(state);
    this.securityBadge.update(state);
    this.themeButton.replaceChildren(icon(state.settings.scheme === 'light' ? 'sun' : state.settings.scheme === 'dark' ? 'moon' : 'monitor', 18));
    this.themeButton.title = state.settings.scheme;
  }

  /**
   * Resolve and publish the call chrome mode (default vs embedded desktop).
   *
   * The decision needs the measured host width, not only `window.innerWidth`:
   * the embedded call page embeds the call in a ~648 px card even at 1440 px. It is
   * therefore recomputed on every store update and on window resize.
   */
  private syncCallChrome(state: CallState, joined: boolean, minimized: boolean): void {
    const pointerFine = this.root.ownerDocument.defaultView?.matchMedia('(pointer: fine)').matches ?? false;
    const mode = !joined || minimized
      ? 'default'
      : resolveCallChrome({
          embedded: this.embedded,
          chrome: state.settings.chrome,
          pointerFine,
          viewportWidth: this.root.ownerDocument.defaultView?.innerWidth ?? 0,
          hostWidth: this.root.clientWidth,
        });
    this.desktopEmbedded = mode === 'embedded-desktop';
    const root = this.root.parentElement ?? this.root;
    const hostWidth = this.root.clientWidth;
    root.dataset.agilEmbedSize = hostWidth > 0 && hostWidth <= 620 ? 'compact' : 'wide';
    root.dataset.agilEmbeddedDesktop = String(this.desktopEmbedded);
    root.dataset.agilCallChrome = this.desktopEmbedded ? 'embedded-desktop' : 'default';
    root.dataset.agilPointer = pointerFine ? 'fine' : 'coarse';
    root.dataset.agilControlsStyle = this.controlsStyle(state);
    this.header.hidden = !joined || minimized;
  }

  private syncViewSwitchHome(): void {
    const outer = this.root.parentElement ?? this.root;
    const inHeader = !this.header.hidden && outer.dataset.agilHeader !== 'hidden';
    this.headerView.hidden = !inHeader;
    const home = inHeader ? this.headerView : this.stageView;
    if (this.viewSwitch.parentElement !== home) home.appendChild(this.viewSwitch);
    if (this.followButton.parentElement !== home) home.appendChild(this.followButton);
  }

  /** Renders the tenant logo in the header (theme.logo or branding.logoUrl). */
  private renderBrandLogo(state: CallState): void {
    const logoUrl = state.config.theme.logo.url || state.config.branding.logoUrl;
    const heightPx = state.config.theme.logo.heightPx || state.config.branding.logoHeightPx || 24;
    if (!logoUrl) {
      if (this.brandMarkEl.classList.contains('has-logo')) {
        this.brandMarkEl.classList.remove('has-logo');
        delete this.brandMarkEl.dataset.agilLogo;
        this.brandMarkEl.replaceChildren(icon('grid', 18));
      }
      return;
    }
    if (this.brandMarkEl.dataset.agilLogo === logoUrl) {
      const img = this.brandMarkEl.querySelector('img');
      if (img) img.style.height = `${heightPx}px`;
      return;
    }
    const img = document.createElement('img');
    img.src = logoUrl;
    img.alt = state.config.theme.logo.alt || state.config.branding.productName;
    img.decoding = 'async';
    img.loading = 'eager';
    img.referrerPolicy = 'no-referrer';
    img.style.height = `${heightPx}px`;
    img.addEventListener(
      'error',
      () => {
        this.brandMarkEl.classList.remove('has-logo');
        delete this.brandMarkEl.dataset.agilLogo;
        this.brandMarkEl.replaceChildren(icon('grid', 18));
      },
      { once: true },
    );
    this.brandMarkEl.dataset.agilLogo = logoUrl;
    this.brandMarkEl.classList.add('has-logo');
    this.brandMarkEl.replaceChildren(img);
  }

  private phaseToState(state: CallState): string {
    if (state.phase === 'joined') return 'joined';
    if (state.phase === 'joining' || state.phase === 'loading') return 'joining';
    if (state.phase === 'lobby') return 'lobby';
    if (state.phase === 'left') return 'left';
    if (state.phase === 'error') return 'error';
    return 'idle';
  }

  private renderJoin(state: CallState): void {
    if (state.phase === 'joined' || state.phase === 'lobby') return;
    const showPreview = state.settings.camEnabled && !state.mediaError && state.localStream;
    this.joinScreen.setStream(showPreview ? state.localStream : null);
    this.joinScreen.update(state);
    this.joinScreen.setBusy(state.phase === 'loading' || state.phase === 'joining');
    this.joinScreen.setOffline(!state.serverOnline);
  }

  private renderHeader(state: CallState): void {
    const brandName = state.config.branding.productName || this.i18n.t('appName');
    this.renderBrandLogo(state);
    const brandNameEl = this.header.querySelector('.agil-brand-name');
    if (brandNameEl) brandNameEl.textContent = brandName;
    const orgEl = this.header.querySelector('.agil-brand-org');
    const room = state.room;
    const directPeer = room?.mode === 'direct' ? state.participants[0] : undefined;
    const contextualTitle = room?.context?.title?.trim();
    const org =
      state.config.branding.organizationName ||
      (contextualTitle && directPeer ? directPeer.name : '') ||
      (room?.mode === 'direct' ? this.i18n.t('messengerDirect') : room?.name ?? '');
    if (orgEl) {
      orgEl.textContent = org;
      (orgEl as HTMLElement).style.display = org ? '' : 'none';
    }
    const roomTitle = contextualTitle || (directPeer ? directPeer.name : room?.name ?? state.config.room.name);
    this.roomNameEl.textContent = roomTitle;
    this.roomNameEl.title = room?.name ?? '';
    this.roomNameEl.style.display = state.config.layout.showRoomName ? '' : 'none';
    // In a joined call the room name is the only visible page-level heading:
    // expose it as h1 so screen-reader users get a document outline.
    if (state.phase === 'joined') {
      this.roomNameEl.setAttribute('role', 'heading');
      this.roomNameEl.setAttribute('aria-level', '1');
    } else {
      this.roomNameEl.removeAttribute('role');
      this.roomNameEl.removeAttribute('aria-level');
    }
    this.timerEl.textContent = state.config.layout.showTimer ? formatDuration(state.durationSec) : '';
    this.timerEl.style.display = state.config.layout.showTimer ? '' : 'none';
    const total = state.participants.length + (state.self ? 1 : 0);
    const mode = state.settings.mediaMode;
    const mediaBadge = resolveMediaBadge({
      mediaMode: mode,
      roomMode: room?.mode,
      maxParticipants: room?.maxParticipants,
    });
    // Text is user-facing (P2P, not "mesh"); data-mode keeps the technical mode.
    this.mediaBadge.textContent = mediaBadge.text;
    this.mediaBadge.dataset.mode = mode;
    this.mediaBadge.dataset.transport = mediaBadge.transport;
    this.mediaBadge.dataset.status = state.settings.sfuStatus ?? 'off';
    (this.root.parentElement ?? this.root).dataset.agilTransport = mediaBadge.transport;
    const modeTitle = this.i18n.t(mediaBadge.titleKey);
    this.mediaBadge.title = `${this.i18n.t('mediaModeTitle')}: ${modeTitle}`;
    // A grouped mesh call hides the technical pill; a direct 1:1 shows one P2P
    // badge and nothing else (no extra "mesh" label).
    this.mediaBadge.hidden = mediaBadge.hidden;
    this.mediaBadge.style.display = mediaBadge.hidden ? 'none' : '';
    const e2ee = state.e2ee?.status;
    this.e2eeBadge.hidden = e2ee !== 'enabled' && e2ee !== 'enabling';
    this.e2eeBadge.textContent = e2ee === 'enabled' ? 'E2EE' : 'E2EE…';
    this.e2eeBadge.dataset.state = e2ee ?? 'disabled';
    this.e2eeBadge.title = `${this.i18n.t('e2eeTitle')}. ${this.i18n.t('e2eeChatNote')}`;
    const countLabel = formatParticipantCount(total);
    this.participantsCountEl.textContent = countLabel;
    // The count is now a badge inside the participants button (C-14): one
    // target, one number. The button title carries the full sentence.
    const participantsLabel =
      mode === 'broadcast'
        ? `${countLabel} ${this.i18n.t('viewersLabel')}`
        : `${this.i18n.t('participantsTitle')}: ${countLabel}`;
    this.participantsButton.title = participantsLabel;
    this.participantsButton.setAttribute('aria-label', participantsLabel);
    this.participantsCountEl.hidden = !state.config.layout.showParticipantCount;
    this.participantsCountEl.dataset.count = String(total);
    this.participantsCountEl.dataset.badge = countLabel;
    const roomLimit = state.room?.maxParticipants;
    if (roomLimit && roomLimit > 0) {
      this.participantsButton.title = `${participantsLabel} · ${this.i18n.t('galleryRoomLimit', { count: total, limit: roomLimit })}`;
    }
    const connection = resolveConnectionStatus(connectionInput(state));
    this.connectionText.textContent = this.i18n.t(connection.labelKey);
    this.connectionEl.dataset.connection = connection.status;
    this.connectionEl.dataset.label = this.i18n.t(connection.labelKey);
    // Text and colour both come from `connection.status`: an offline server can
    // never render a green “connected” pill again (C-02).
    this.connectionEl.title = this.i18n.t(connection.titleKey);
    this.connectionEl.setAttribute('aria-label', this.i18n.t(connection.titleKey));
    this.connectionDot.dataset.connection = connection.status;
    const canSetQuality = state.config.layout.showQualityIndicator && !state.settings.minimized
      && state.settings.mediaMode !== 'mesh' && state.settings.sfuStatus === 'connected';
    this.qualityTrigger.hidden = !canSetQuality;
    if (!canSetQuality) this.closeQualityMenu();
    const selectedQuality = state.settings.videoQuality ?? 'auto';
    for (const [value, input] of this.qualityOptions) input.checked = selectedQuality === value;
    this.qualityEl.style.display = state.config.layout.showQualityIndicator && !canSetQuality ? '' : 'none';
    this.qualityEl.title = this.qualityLabel(state);
    this.qualityEl.dataset.tier = state.quality.tier;
    this.qualityDot.dataset.tier = state.quality.tier;
    const qualityText = this.qualityEl.querySelector('.agil-quality-text');
    if (qualityText) qualityText.textContent = this.qualityLabel(state);
    else {
      const span = h('span', { class: 'agil-quality-text', text: this.qualityLabel(state) });
      this.qualityEl.appendChild(span);
    }
    const hiddenControls = new Set(state.config.layout.hiddenControls ?? []);
    // The participants button is the *only* participants affordance now (the
    // separate count pill is gone), so it must survive the island collapse on
    // phones instead of disappearing with the rest of the “bar only” entries.
    this.participantsButton.hidden = hiddenControls.has('participants') || !canFeature(state, 'participantList');
    const lobbyRole = state.self?.role === 'host' || state.self?.role === 'moderator';
    const lobbyVisible = lobbyRole && (state.config.security.waitingRoom || state.lobbyQueue.length > 0);
    this.lobbyButton.hidden = !lobbyVisible;
    this.lobbyButton.style.display = lobbyVisible ? '' : 'none';
    const queueCount = state.lobbyQueue.length;
    this.lobbyBadge.textContent = queueCount > 9 ? '9+' : String(queueCount);
    this.lobbyBadge.hidden = queueCount === 0;
    this.lobbyButton.title = queueCount > 0 ? `${this.i18n.t('lobbyHostButton')} (${queueCount})` : this.i18n.t('lobbyHostButton');
    this.lobbyButton.setAttribute(
      'aria-label',
      queueCount > 0 ? this.i18n.t('lobbyBadgeLabel', { n: queueCount }) : this.i18n.t('lobbyHostButton'),
    );
    this.lobbyButton.setAttribute('aria-expanded', String(state.settings.panel === 'lobby'));
    this.lobbyButton.classList.toggle('has-items', queueCount > 0);
    this.lobbyButton.classList.toggle('is-active', state.settings.panel === 'lobby');
    const breakoutRole = state.self?.role === 'host' || state.self?.role === 'moderator';
    this.breakoutButton.hidden = !breakoutRole;
    this.breakoutButton.style.display = breakoutRole ? '' : 'none';
    this.breakoutButton.classList.toggle('is-active', state.settings.panel === 'breakout');
    this.breakoutButton.classList.toggle('has-breakout', state.breakout.plan?.status === 'active');
    this.breakoutButton.setAttribute('aria-expanded', String(state.settings.panel === 'breakout'));
    this.breakoutButton.title =
      state.breakout.plan?.status === 'active'
        ? `${this.i18n.t('breakoutButton')} · ${this.i18n.t('breakoutActive')}`
        : this.i18n.t('breakoutButton');
    this.breakoutLabel.textContent = this.i18n.t('breakoutButton');
  }

  private qualityLabel(state: CallState): string {
    switch (state.quality.tier) {
      case 'good':
        return this.i18n.t('connectionGood');
      case 'fair':
        return this.i18n.t('connectionFair');
      case 'poor':
        return this.i18n.t('connectionPoor');
      case 'critical':
        return this.i18n.t('connectionCritical');
      default:
        return this.i18n.t('connectionOffline');
    }
  }

  private selfTileState(state: CallState): TileState {
    const participant: Participant = state.self ?? {
      id: 'self',
      name: this.i18n.t('you'),
      role: 'guest',
      joinedAt: Date.now(),
      state: { mic: 'on', cam: 'on', screen: false, handRaised: false, network: 'good' },
      verified: false,
      integrity: 'unknown',
    };
    const derived: Participant = {
      ...participant,
      state: {
        ...participant.state,
        mic: state.settings.micEnabled ? 'on' : 'off',
        cam: state.settings.camEnabled ? 'on' : 'off',
        handRaised: state.settings.handRaised,
        screen: state.settings.screenSharing,
      },
    };
    const stream = state.settings.screenSharing ? state.screenStream ?? state.localStream : state.localStream;
    return {
      participant: derived,
      stream,
      isSelf: true,
      speaking: this.speaking.has(participant.id),
      pinned: state.settings.pinnedId === participant.id,
      connection: 'self',
      integrity: state.integrity[participant.id]?.status ?? participant.integrity,
      mirrored: !state.settings.screenSharing && (state.settings.mirrorSelfView ?? state.config.session.mirrorSelfView),
    };
  }

  /** Remote participants rendered on the current page (self is separate). */
  private pageInfo(state: CallState): GalleryPageInfo {
    // The self tile occupies one slot of every page; a full desktop page is
    // 35 remote tiles + self = 36, a phone page is 24 + self = 25.
    return galleryPageInfo(state.participants.length, Boolean(state.self), state.gallery.pageSize, state.gallery.page);
  }

  private spotlightId(state: CallState, page: readonly Participant[]): string | null {
    const pinned = state.settings.pinnedId;
    if (pinned && (pinned === state.self?.id || state.participants.some((participant) => participant.id === pinned))) {
      return pinned;
    }
    if (state.settings.layoutMode !== 'spotlight') return null;
    if (state.gallery.followSpeaker && state.gallery.speakerId) return state.gallery.speakerId;
    return state.participants[0]?.id ?? page[0]?.id ?? state.self?.id ?? null;
  }

  getGalleryViewportIds(): readonly string[] | undefined {
    return this.viewportVideoIds;
  }

  getVideoTileDimensions(): ReadonlyMap<string, { width: number; height: number }> {
    return this.videoTileDimensions;
  }

  revealGalleryParticipant(id: string, focus = false): void {
    const state = this.store.getState();
    if (state.phase !== 'joined' || state.settings.minimized || state.settings.layoutMode === 'spotlight') return;
    this.pendingGalleryTarget = id;
    this.renderGrid(state);
    if (focus) this.tiles.get(id)?.element.querySelector<HTMLElement>('.agil-tile-pin')?.focus({ preventScroll: true });
  }

  private setViewportVideoIds(ids: string[] | undefined): void {
    const previous = this.viewportVideoIds;
    if (previous === ids || (previous && ids && previous.length === ids.length && previous.every((id, index) => id === ids[index]))) return;
    this.viewportVideoIds = ids;
    queueMicrotask(() => this.actions.onGalleryViewportChange());
  }

  private queueGalleryRender(): void {
    const view = this.grid.ownerDocument.defaultView;
    if (!view || this.gridFrame !== null || this.grid.dataset.virtualized !== 'true') return;
    this.gridWindow = view;
    this.gridFrame = view.requestAnimationFrame(() => {
      this.gridFrame = null;
      const state = this.store.getState();
      if (state.phase === 'joined' && !state.settings.minimized) this.renderGrid(state);
    });
  }

  private manualGalleryScroll(): void {
    if (this.grid.dataset.virtualized === 'true' && this.store.getState().gallery.followSpeaker) {
      this.actions.onManualGalleryScroll();
    }
  }

  private galleryWindow(members: readonly Participant[], returning: boolean) {
    const style = this.grid.ownerDocument.defaultView?.getComputedStyle(this.grid);
    const pixels = (value?: string) => Number.parseFloat(value ?? '') || 0;
    const gap = pixels(style?.rowGap);
    const padTop = pixels(style?.paddingTop);
    const width = Math.max(1, this.grid.clientWidth - pixels(style?.paddingLeft) - pixels(style?.paddingRight));
    const columns = Math.max(1, Math.min(5, Math.floor((width + gap) / (142 + gap))));
    const tileHeight = Math.max(1, Math.round(((width - (columns - 1) * gap) / columns) * 9 / 16));
    const rows = Math.ceil(members.length / columns);
    const pitch = tileHeight + gap;
    this.grid.style.setProperty('--agil-scroll-columns', String(columns));
    this.grid.style.setProperty('--agil-scroll-rows', String(rows));
    this.grid.style.setProperty('--agil-scroll-tile-height', `${tileHeight}px`);
    const ids = members.map((member) => member.id);
    const previous = this.galleryAnchor;
    const targetIndex = this.pendingGalleryTarget === null ? -1 : ids.indexOf(this.pendingGalleryTarget);
    this.pendingGalleryTarget = null;
    if (targetIndex >= 0) {
      const rowTop = Math.floor(targetIndex / columns) * pitch + padTop;
      const top = this.grid.scrollTop;
      const unobscuredBottom = top + this.grid.clientHeight - pixels(style?.scrollPaddingBottom);
      if (rowTop < top || rowTop + tileHeight > unobscuredBottom) this.grid.scrollTop = rowTop - padTop;
    } else if (previous && (this.grid.scrollTop === previous.top || this.grid.scrollTop === 0)) {
      const formerIndex = Math.floor(previous.top / previous.pitch) * previous.columns;
      const id = previous.ids[formerIndex];
      const index = id ? ids.indexOf(id) : -1;
      if (index >= 0 && (returning || index !== formerIndex || columns !== previous.columns || pitch !== previous.pitch)) {
        this.grid.scrollTop = Math.floor(index / columns) * pitch + (previous.top % previous.pitch) * pitch / previous.pitch;
      }
    }
    const top = this.grid.scrollTop;
    this.galleryAnchor = { ids, columns, pitch, top };
    const first = Math.max(0, Math.min(rows - 1, Math.floor((top - padTop + gap) / pitch)));
    const end = Math.min(rows, Math.max(first + 1, Math.ceil((top + this.grid.clientHeight - padTop) / pitch)));
    return {
      columns,
      start: Math.max(0, first - 1) * columns,
      end: (end + 1) * columns,
      visibleStart: first * columns,
      visibleEnd: end * columns,
    };
  }

  private renderGrid(state: CallState, minimized = false): void {
    const canInvite = canInviteFromCall(state);
    this.waitingInvite.hidden = state.phase !== 'joined' || minimized || !state.self || state.participants.length !== 0;
    if (!this.waitingInvite.hidden) {
      setText(this.waitingTitle, this.i18n.t(canInvite ? 'waitingInviteTitle' : 'waitingGuestTitle'));
      setText(this.waitingDescription, this.i18n.t(canInvite ? 'waitingInviteDescription' : 'waitingGuestDescription'));
      this.waitingInviteAction.hidden = !canInvite;
      this.waitingInvite.dataset.inviteAvailable = String(canInvite);
    }
    const selfState = this.selfTileState(state);
    const info = this.pageInfo(state);
    const pageRemotes = pageParticipants(state.participants, info);
    const spotlightId = this.spotlightId(state, pageRemotes);
    const speakerView = state.settings.layoutMode === 'spotlight' && Boolean(spotlightId);
    const scrolling = info.pageCount > 1 && !speakerView && !minimized;
    const returning = this.grid.dataset.virtualized !== 'true';
    this.grid.dataset.virtualized = String(scrolling);
    this.grid.tabIndex = scrolling ? 0 : -1;
    if (scrolling) {
      this.grid.setAttribute('role', 'region');
      this.grid.setAttribute('aria-label', this.i18n.t('galleryParticipants'));
    } else {
      this.grid.removeAttribute('role');
      this.grid.removeAttribute('aria-label');
    }
    const members = state.self ? [state.self, ...state.participants] : state.participants;
    this.renderGalleryControls(state, scrolling);
    const scrollWindow = scrolling ? this.galleryWindow(members, returning) : null;
    if (!scrolling) this.grid.scrollTop = 0;
    const mounted = scrollWindow ? members.slice(scrollWindow.start, scrollWindow.end) : null;
    const viewportIds = scrollWindow
      ? members.slice(scrollWindow.visibleStart, scrollWindow.visibleEnd).filter((member) => member.id !== state.self?.id).map((member) => member.id)
      : undefined;
    this.setViewportVideoIds(viewportIds);
    const plan = speakerView
      ? null
      : planVideoSubscriptions({
          participants: state.participants,
          page: state.gallery.page,
          pageSize: state.gallery.pageSize,
          hasSelf: Boolean(state.self),
          pinnedId: state.settings.pinnedId,
          speakerId: state.gallery.followSpeaker ? state.gallery.speakerId : null,
          maxVideoSubscriptions: state.gallery.maxVideoSubscriptions,
          promotedIds: state.gallery.promotedVideoIds,
          galleryVideoBudget: state.config.limits.galleryVideoBudget,
          maxVisibleVideos: state.config.scale.maxVisibleVideos,
          capacityProfile: state.config.scale.sfu.capacityProfile,
          viewportIds,
        });
    const byId = new Map(state.participants.map((participant) => [participant.id, participant] as const));
    const remotes = mounted
      ? mounted.filter((member) => member.id !== state.self?.id)
      : (plan?.visible ?? (spotlightId ? [spotlightId] : [])).flatMap((id) => {
          const participant = byId.get(id);
          return participant ? [participant] : [];
        });
    const videoIds =
      plan?.submit ?? (spotlightId && spotlightId !== selfState.participant.id ? [spotlightId] : []);
    const videoIdSet = new Set(videoIds);
    const caching = scrolling && state.settings.sfuStatus === 'connected' && state.connection === 'connected';
    if (caching) {
      const cameraFor = (id: string) => {
        const participant = byId.get(id);
        return participant?.state.cam === 'on' && !participant.state.screen && participant.presence !== 'reconnecting'
          ? this.actions.getGalleryCamera(id) : null;
      };
      this.galleryFrames.retain((id, publicationId) => cameraFor(id)?.publicationId === publicationId);
      for (const id of this.liveGalleryIds) {
        if (videoIdSet.has(id)) continue;
        const camera = cameraFor(id);
        if (!camera?.track) continue;
        const snapshot = this.tiles.get(id)?.snapshotCamera(camera.track);
        if (snapshot) this.galleryFrames.save(id, camera.publicationId, snapshot);
      }
    } else {
      this.galleryFrames.clear();
    }
    this.liveGalleryIds = caching ? videoIdSet : new Set();
    const videoBudget = plan?.budget ?? 1;
    const wanted = new Map<string, TileState>();
    const showSelf = scrollWindow ? Boolean(state.self) && scrollWindow.start === 0 : !speakerView || spotlightId === selfState.participant.id;
    if (showSelf) {
      wanted.set(selfState.participant.id, selfState);
    }
    for (const participant of remotes) {
      const connection: TileState['connection'] =
        state.connection === 'connected' ? 'connected' : state.connection === 'reconnecting' ? 'connecting' : 'unknown';
      wanted.set(participant.id, {
        participant,
        stream: state.remoteStreams[participant.id] ?? null,
        isSelf: false,
        speaking: this.speaking.has(participant.id),
        pinned: state.settings.pinnedId === participant.id,
        connection,
        integrity: state.integrity[participant.id]?.status ?? participant.integrity,
        mirrored: false,
        muteAudio: Boolean(state.settings.sfuStatus && state.settings.sfuStatus !== 'off'),
        videoSuppressed: !videoIdSet.has(participant.id),
        cachedFrame: caching ? this.galleryFrames.get(participant.id) : undefined,
      });
    }
    for (const [id, tile] of this.tiles) {
      if (wanted.has(id)) continue;
      if (tile.slot.contains(this.grid.ownerDocument.activeElement)) this.grid.focus({ preventScroll: true });
      this.slotResizeObserver?.unobserve(tile.element);
      this.videoTileDimensions.delete(id);
      tile.destroy();
      this.tiles.delete(id);
    }
    const ordered = [...wanted.values()];
    if (spotlightId && state.settings.layoutMode === 'spotlight') {
      ordered.sort((a, b) =>
        a.participant.id === spotlightId ? -1 : b.participant.id === spotlightId ? 1 : 0,
      );
    }
    // Re-append only when the DOM order actually differs. The old loop called
    // `appendChild` for every tile on every store tick, which moved focused
    // elements and forced needless relayouts (the "jumpy" call screen).
    ordered.forEach((tileState) => {
      let tile = this.tiles.get(tileState.participant.id);
      if (!tile) {
        tile = new VideoTile(tileState, this.i18n, {
          onVideoAspect: (aspect) => {
            if (tileState.isSelf) this.grid.parentElement?.style.setProperty('--agil-solo-media-aspect', String(aspect));
            this.syncDockSafeInset();
          },
          registerAudioOutput: (element) => this.actions.registerAudioOutput(element),
          onPin: (participantId) => {
            const current = this.store.getState().settings.pinnedId;
            this.actions.onPin?.(current === participantId ? null : participantId);
          },
          onPlayVideo: (participantId) => this.actions.onPlayVideo(participantId),
        });
        this.tiles.set(tileState.participant.id, tile);
        if (!tileState.isSelf) this.slotResizeObserver?.observe(tile.element);
      }
      tile.update(tileState);
    });
    this.grid.classList.toggle('agil-grid-pinned', state.settings.layoutMode === 'spotlight' && Boolean(spotlightId));
    this.grid.dataset.count = String(minimized ? Math.min(1, ordered.length) : ordered.length);
    this.grid.dataset.page = String(info.page);
    this.grid.dataset.pageCount = String(info.pageCount);
    this.grid.dataset.agilDensity = controlDensity(state.participants.length + (state.self ? 1 : 0));
    // Many small tiles (25/36 per page) need a denser avatar/play layout on
    // phones; on desktop the same 25 tiles are large enough for the full tile.
    this.grid.classList.toggle('agil-grid-dense', ordered.length > 8 && !speakerView);
    // Stable hooks for the video-budget acceptance harness: how many tiles may
    // decode video, which participants got the slots, and the adaptive budget.
    this.grid.dataset.videoBudget = String(videoBudget);
    this.grid.dataset.videoCount = String(videoIds.length);
    this.grid.dataset.videoIds = videoIds.join(',');
    const tileSpotlightId = state.settings.layoutMode === 'spotlight' ? spotlightId : null;
    for (const [id, tile] of this.tiles) tile.element.classList.toggle('is-spotlight', id === tileSpotlightId);

    // Fixed slot matrix: within a bucket the grid template never changes, so a
    // join/leave only swaps an empty placeholder for a same-sized tile. On
    // narrow stages the matrix is the compact fill variant instead (four ~90 px
    // columns at 390, never five 70 px ones — C-01). Speaker and minimized
    // modes keep the legacy single-tile layout (`display:contents` wrappers).
    const slotMode = !speakerView && !minimized && !scrolling;
    let layout = slotLayout(ordered.length);
    if (slotMode) {
      const view = this.grid.ownerDocument.defaultView ?? window;
      const gridStyle = view.getComputedStyle(this.grid);
      const padX = (Number.parseFloat(gridStyle.paddingLeft) || 0) + (Number.parseFloat(gridStyle.paddingRight) || 0);
      const padY = (Number.parseFloat(gridStyle.paddingTop) || 0) + (Number.parseFloat(gridStyle.paddingBottom) || 0);
      const gap = Number.parseFloat(gridStyle.columnGap || gridStyle.rowGap || '0') || 0;
      // Measured stage when mounted; a viewport estimate before the first
      // layout pass, so the column count is never decided from a 0×0 box.
      const width = this.grid.clientWidth > 1 ? this.grid.clientWidth - padX : Math.max(0, view.innerWidth - 24);
      const height = this.grid.clientHeight > 1 ? this.grid.clientHeight - padY : Math.max(0, view.innerHeight * 0.7);
      layout = this.desktopEmbedded
        ? embeddedSlotLayout(ordered.length, { width, height, gap })
        : resolveSlotLayout(ordered.length, view.innerWidth, { width, height, gap });
    }
    if (slotMode) {
      this.grid.dataset.slotLayout = `${layout.columns}x${layout.rows}`;
      this.grid.dataset.slotCols = String(layout.columns);
      this.grid.dataset.slotRows = String(layout.rows);
      this.grid.dataset.slotCapacity = String(layout.capacity);
      this.grid.dataset.slotEmpty = String(layout.empty);
      this.grid.dataset.slotFill = String(layout.fill);
      this.grid.dataset.slotCompact = String(layout.compact);
      this.grid.dataset.slotBucket = `${layout.bucket.min}-${layout.bucket.max}`;
      this.grid.style.setProperty('--agil-slot-cols', String(layout.columns));
      this.grid.style.setProperty('--agil-slot-rows', String(layout.rows));
      // Compact (fill) matrices end with a partial row; dashed “reserved” cells
      // there would read like missing participants on a phone, so only the
      // desktop 16:9 bucket matrix renders neutral placeholders.
      const placeholderCount = layout.fill ? 0 : layout.empty;
      while (this.emptySlots.length < placeholderCount) {
        const empty = h(
          'div',
          { class: 'agil-slot', dataset: { agilSlot: 'empty' }, attrs: { 'aria-hidden': 'true' } },
          h('div', { class: 'agil-slot-empty' }),
        );
        this.emptySlots.push(empty);
      }
      // Remove *and* drop the surplus entries. Keeping detached nodes in the
      // array made `desiredSlots` re-append one stale placeholder after a
      // transition into a count with no empty cells (3 → 4, 25 → 4, 3 → 2),
      // which created an implicit third grid row: the first row slid above the
      // stage and the grid became scrollable. The matrix must contain exactly
      // `tiles + layout.empty` children.
      for (let index = placeholderCount; index < this.emptySlots.length; index += 1) this.emptySlots[index]?.remove();
      this.emptySlots.length = placeholderCount;
    } else {
      delete this.grid.dataset.slotLayout;
      delete this.grid.dataset.slotCols;
      delete this.grid.dataset.slotRows;
      delete this.grid.dataset.slotCapacity;
      delete this.grid.dataset.slotEmpty;
      delete this.grid.dataset.slotFill;
      delete this.grid.dataset.slotCompact;
      delete this.grid.dataset.slotBucket;
      for (const empty of this.emptySlots) empty.remove();
      // Speaker/minimized mode has no placeholders; do not resurrect them when
      // the grid comes back.
      this.emptySlots.length = 0;
    }
    const desiredSlots: HTMLElement[] = ordered.map((tileState) => {
      const tile = this.tiles.get(tileState.participant.id);
      return tile ? tile.slot : null;
    }).filter((slot): slot is HTMLDivElement => Boolean(slot));
    if (slotMode) {
      for (let index = 0; index < this.emptySlots.length; index += 1) {
        const empty = this.emptySlots[index];
        if (empty) desiredSlots.push(empty);
      }
    }
    desiredSlots.forEach((slot, index) => {
      const position = (scrollWindow?.start ?? 0) + index;
      slot.style.gridRow = scrollWindow ? String(Math.floor(position / scrollWindow.columns) + 1) : '';
      slot.style.gridColumn = scrollWindow ? String(position % scrollWindow.columns + 1) : '';
      const expected = this.grid.children[index];
      if (expected !== slot) this.grid.insertBefore(slot, expected ?? null);
    });

    // Mini window shows one tile only (self view or the current spotlight).
    if (minimized) {
      const showSelf = state.config.layout.minimized.showSelfView && this.tiles.has(selfState.participant.id);
      const selected = showSelf
        ? selfState.participant.id
        : spotlightId ?? ordered.find((tileState) => !tileState.isSelf)?.participant.id ?? selfState.participant.id;
      for (const [id, tile] of this.tiles) tile.element.hidden = id !== selected;
      this.grid.dataset.minimized = 'true';
    } else {
      for (const tile of this.tiles.values()) tile.element.hidden = false;
      this.grid.dataset.minimized = 'false';
    }
    this.syncSlotGeometry();
  }

  /**
   * Fit the fixed 16:9 slot matrix into the current stage. Pure geometry lives
   * in `slot-layout.ts`; this method only reads the resolved padding/gap and
   * writes two CSS variables. It runs after every render and on stage resize.
   */
  private syncSlotGeometry(): void {
    if (!this.grid.dataset.slotLayout) return;
    const columns = Number(this.grid.dataset.slotCols) || 2;
    const rows = Number(this.grid.dataset.slotRows) || 2;
    if (this.grid.clientWidth <= 0 || this.grid.clientHeight <= 0) return;
    const style = getComputedStyle(this.grid);
    const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const padY = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const gap = Number.parseFloat(style.columnGap || style.rowGap || '0') || 0;
    const fit = fitSlotMatrix({
      columns,
      rows,
      width: this.grid.clientWidth - padX,
      height: this.grid.clientHeight - padY,
      gap,
      // Compact phone/tablet matrices fill their cell; desktop keeps the exact
      // 16:9 box (the documented 2/4/8/36 composition).
      fill: this.grid.dataset.slotFill === 'true',
    });
    if (fit.tileWidth < 1 || fit.tileHeight < 1) return;
    this.grid.style.setProperty('--agil-slot-w', `${fit.tileWidth.toFixed(2)}px`);
    this.grid.style.setProperty('--agil-slot-h', `${fit.tileHeight.toFixed(2)}px`);
    // Test/debug hook: the exact fitted matrix without parsing CSS.
    this.grid.dataset.slotTile = `${fit.tileWidth.toFixed(1)}x${fit.tileHeight.toFixed(1)}`;
  }

  /** Keep labels and contained frames clear of the visible floating dock. */
  private syncDockSafeInset(): void {
    const dock = !this.controlsLayer.hidden && !this.controls.element.inert &&
      !this.store.getState().settings.minimized && this.grid.dataset.virtualized !== 'true' &&
      this.controlsLayer.dataset.anchor?.startsWith('bottom')
      ? this.controls.element.getBoundingClientRect() : null;
    const compact = this.embedded && (this.root.parentElement ?? this.root).dataset.agilEmbedSize === 'compact'
      && this.grid.dataset.virtualized !== 'true' && !this.store.getState().settings.minimized;
    const viewSwitch = compact && !this.stageView.hidden ? this.stageView.getBoundingClientRect() : null;
    for (const tile of this.tiles.values()) {
      const { element } = tile;
      const label = dock?.height || compact ? element.querySelector('.agil-tile-info') : null;
      const name = label?.getBoundingClientRect();
      const rect = dock?.height || compact ? element.getBoundingClientRect() : null;
      let labelInset = 0;
      let videoInset = 0;
      let videoTopInset = 0;
      if (dock?.height && rect) {
        if (rect.height > 0 && rect.top < dock.bottom && rect.bottom > dock.top) {
          if (name && name.right > dock.left && name.left < dock.right) {
            labelInset = Math.min(rect.bottom - dock.top + 4, Math.max(0, rect.height - name.height - 12));
          }
        }
      }
      if (dock?.height || viewSwitch?.height || (compact && name?.height)) {
        const video = element.querySelector('video');
        if (video?.videoWidth && video.videoHeight && video.ownerDocument.defaultView?.getComputedStyle(video).objectFit === 'contain') {
          const box = video.getBoundingClientRect();
          if (viewSwitch?.height) {
            const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
            const top = box.top + (box.height - video.videoHeight * scale) / 2;
            const left = box.left + (box.width - video.videoWidth * scale) / 2;
            if (scale > 0 && top < viewSwitch.bottom + 4 && top + video.videoHeight * scale > viewSwitch.top
              && left < viewSwitch.right && left + video.videoWidth * scale > viewSwitch.left) {
              videoTopInset = Math.max(0, Math.min(box.height - 1, viewSwitch.bottom - box.top + 4));
            }
          }
          // Keep the video border box fixed. Its bottom padding moves only the contained picture.
          const clearOverlay = (leftEdge: number, rightEdge: number, topEdge: number, bottomEdge: number): void => {
            const height = box.height - videoInset - videoTopInset;
            const scale = Math.min(box.width / video.videoWidth, height / video.videoHeight);
            const frameWidth = scale * video.videoWidth;
            const frameHeight = scale * video.videoHeight;
            const left = box.left + (box.width - frameWidth) / 2;
            const top = box.top + videoTopInset + (height - frameHeight) / 2;
            if (scale > 0 && top < bottomEdge && top + frameHeight > topEdge - 4 &&
                left < rightEdge && left + frameWidth > leftEdge) {
              videoInset = Math.max(videoInset, Math.min(box.height - videoTopInset - 1, box.bottom - topEdge + 4));
            }
          };
          if (dock?.height) clearOverlay(dock.left, dock.right, dock.top, dock.bottom);
          if (compact && rect && name?.height && label?.parentElement) {
            const labelPadding = Number.parseFloat(video.ownerDocument.defaultView.getComputedStyle(label.parentElement).paddingBottom) || 0;
            const labelBottom = rect.bottom - labelInset - labelPadding;
            clearOverlay(name.left, name.right, labelBottom - name.height, labelBottom);
          }
        }
      }
      if (labelInset > 0) element.style.setProperty('--agil-tile-dock-inset', `${labelInset}px`);
      else element.style.removeProperty('--agil-tile-dock-inset');
      if (videoInset > 0) element.style.setProperty('--agil-video-dock-inset', `${videoInset}px`);
      else element.style.removeProperty('--agil-video-dock-inset');
      if (videoTopInset > 0) element.style.setProperty('--agil-video-top-inset', `${videoTopInset}px`);
      else element.style.removeProperty('--agil-video-top-inset');
    }
  }

  private renderGalleryControls(state: CallState, scrolling: boolean): void {
    const visible = state.phase === 'joined' && !state.settings.minimized;
    this.stageView.hidden = !visible || this.viewSwitch.parentElement !== this.stageView;
    if (!visible) return;
    const speakerView = state.settings.layoutMode === 'spotlight';
    this.followButton.hidden = !scrolling;
    const follow = state.gallery.followSpeaker;
    this.followButton.setAttribute('aria-pressed', String(follow));
    this.followButton.classList.toggle('is-active', follow);
    this.followButton.title = follow ? this.i18n.t('galleryFollowSpeakerOn') : this.i18n.t('galleryFollowSpeakerOff');

    // One view control: two explicit segments, each with a pressed state. The
    // old control flipped its own label between “Спикер” and “Сетка”; a
    // segmented switch states both options at once and never moves.
    this.gridViewButton.setAttribute('aria-pressed', String(!speakerView));
    this.gridViewButton.classList.toggle('is-active', !speakerView);
    this.gridViewButton.title = this.i18n.t('galleryGridView');
    this.speakerButton.setAttribute('aria-pressed', String(speakerView));
    this.speakerButton.classList.toggle('is-active', speakerView);
    this.speakerButton.title = this.i18n.t('gallerySpeakerViewHint');
  }

  private renderPanels(state: CallState): void {
    if (state.settings.minimized) return;
    const panel = state.settings.panel;
    const can = this.featureGate(state);
    let allowed = panel;
    if (panel === 'participants' && !can('participantList')) allowed = 'none';
    if (panel === 'chat' && (!can('chat') || state.settings.chatMode !== 'builtin')) allowed = 'none';
    if (panel === 'notes' && !can('meetingNotes') && !can('aiCompliance')) allowed = 'none';
    if (panel === 'transcript' && (!can('captions') || !state.config.session.transcription.saveTranscript)) allowed = 'none';
    if (panel === 'assistant' && !state.inCallAssistant.available && !state.assistant.available) {
      allowed = 'none';
    }
    if (panel === 'breakout' && !(state.self?.role === 'host' || state.self?.role === 'moderator')) allowed = 'none';
    for (const [kind, element] of this.panelElements) element.hidden = kind !== allowed;
    this.panelHost.hidden = allowed === 'none';
    this.panelHost.dataset.dockedParticipants = String(state.settings.layoutMode === 'sidebar' && allowed === 'participants');
    this.participantsButton.setAttribute('aria-expanded', String(allowed === 'participants'));
    const previousPanel = this.lastPanel;
    if (previousPanel === 'chat' && allowed !== 'chat') this.chatPanel.closeEmojiPicker();
    const panelJustOpened = allowed !== 'none' && allowed !== previousPanel;
    const panelJustClosed = allowed === 'none' && previousPanel !== 'none';
    const lobbyJustOpened = allowed === 'lobby' && previousPanel !== 'lobby';
    const breakoutJustOpened = allowed === 'breakout' && previousPanel !== 'breakout';
    this.lastPanel = allowed;
    const outerRoot = this.root.parentElement ?? this.root;
    outerRoot.dataset.agilLobbySheet = String(allowed === 'lobby');
    outerRoot.dataset.agilBreakoutSheet = String(allowed === 'breakout');
    if (allowed === 'none') {
      // Keep the built-in chat log mounted while the panel is closed: unread
      // previews and host pages (e2e/postMessage observers) can read messages.
      if (state.settings.chatMode === 'builtin' && state.chat.length !== this.lastChatRendered) {
        this.chatPanel.update(state);
        this.lastChatRendered = state.chat.length;
      }
      if (panelJustClosed) this.restorePanelFocus(previousPanel);
      return;
    }
    // Non-modal side panels: move keyboard focus into the opened panel, and
    // return it to the trigger when the panel closes (WCAG 2.4.3).
    if (panelJustOpened && allowed !== 'lobby' && allowed !== 'breakout') this.focusPanel(allowed);
    switch (allowed) {
      case 'chat':
        this.chatPanel.update(state);
        this.lastChatRendered = state.chat.length;
        break;
      case 'participants':
        this.participantsPanel.update(state, this.speaking);
        break;
      case 'lobby':
        this.lobbyPanel.update(state);
        if (lobbyJustOpened) this.lobbyPanel.focus();
        break;
      case 'breakout':
        this.breakoutPanel.update(state);
        if (breakoutJustOpened) this.breakoutPanel.focus();
        break;
      case 'notes':
        this.notesPanel.update(state);
        break;
      case 'transcript':
        this.transcriptPanel.update(state);
        break;
      case 'settings':
        this.settingsPanel.update(state);
        break;
      case 'assistant':
        this.assistantPanel.update(state);
        break;
      default:
        break;
    }
  }

  /** Focus the first control inside a just-opened side panel (chat, settings…). */
  private focusPanel(kind: PanelKind): void {
    const panel = this.panelElements.get(kind);
    if (!panel || panel.hidden) return;
    const target = panel.querySelector<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
    target?.focus({ preventScroll: true });
  }

  /** Return focus to the control that opened the panel. */
  private restorePanelFocus(kind: PanelKind): void {
    if (kind === 'none') return;
    const triggers = kind === 'participants'
      ? [this.participantsButton]
      : Array.from(this.root.querySelectorAll<HTMLElement>(`[data-agil-action="${kind}"]`));
    const fallback = ['[data-agil-more]', '[data-agil-action="leave"]']
      .map((selector) => this.root.querySelector<HTMLElement>(selector));
    const target = [...triggers, ...fallback].find((control) =>
      control?.getClientRects().length && !control.closest('[inert], [hidden]') && !control.matches(':disabled'));
    target?.focus({ preventScroll: true });
  }

  private renderCaptionOverlay(state: CallState): void {
    const last = state.captions[state.captions.length - 1];
    const visible = state.settings.captionsVisible && Boolean(last);
    this.captionOverlay.hidden = !visible;
    if (!last || !visible) return;
    const children = [
      h('span', { class: 'agil-captions-speaker', text: last.participantName || this.i18n.t('you') }),
      h('span', { class: 'agil-captions-text', text: last.text }),
    ];
    if (last.translation) {
      // Machine translation is announced as such and in the target language.
      children.push(
        h('span', {
          class: 'agil-captions-translation',
          attrs: { lang: last.translationLang ?? 'en' },
          text: `${this.i18n.t('transcriptTranslation')}: ${last.translation}`,
        }),
      );
    }
    this.captionOverlay.replaceChildren(...children);
  }

  private renderBanner(state: CallState): void {
    const assignment = state.breakout.assignment;
    if (assignment) {
      const plan = state.breakout.plan;
      this.banner.hide();
      this.breakoutBanner.show({
        index: assignment.index,
        name: assignment.name,
        remainingSec: state.breakout.remainingSec,
        hasDeadline: Boolean(plan?.endsAt) && plan?.status === 'active',
        allowReturn: plan ? plan.allowReturn !== false : true,
        switching: state.breakout.switching,
      });
      return;
    }
    this.breakoutBanner.hide();
    if (state.settings.sfuStatus === 'failed') {
      this.banner.show(this.i18n.t('sfuUnavailable'), 'critical');
      return;
    }
    if (state.settings.sfuStatus === 'reconnecting') {
      this.banner.show(this.i18n.t('sfuReconnecting'), 'warning');
      return;
    }
    if (state.wsState === 'reconnecting') {
      this.banner.show(this.i18n.t('reconnecting'), 'warning');
      return;
    }
    this.banner.hide();
  }

  /** Moves the control bar into the footer or the floating island/dock layer. */
  private controlsStyle(state: CallState): ReturnType<typeof resolveControlsStyle> {
    // Keep the mount layer and the rendered controls style in sync. The
    // minimised window always renders the compact “minimal” island (see
    // ControlsBar.resolveLayoutStyle); mounting it in the footer would put the
    // row at the top of the bubble and leave the video 8 px tall (QA P1-5).
    return state.settings.minimized
      ? 'minimal'
      : resolveControlsStyle(
          state.config.layout.controlsStyle,
          isNarrowControlsViewport(callControlsWidth(this.root)),
          this.desktopEmbedded,
        );
  }

  private mountControls(state: CallState): Element | null {
    // Moving the toolbar between the footer and island blurs its active element.
    const active = this.root.ownerDocument.activeElement;
    const style = this.controlsStyle(state);
    if (style === 'bar') {
      if (this.controls.element.parentElement !== this.footer) this.footer.appendChild(this.controls.element);
      this.controlsLayer.hidden = true;
      this.controlsLayer.inert = true;
    } else {
      if (this.controls.element.parentElement !== this.controlsLayer) this.controlsLayer.appendChild(this.controls.element);
      this.controlsLayer.hidden = false;
      this.controlsLayer.inert = false;
    }
    this.controlsLayer.dataset.anchor = state.config.layout.controlsAnchor ?? 'bottom-center';
    return this.controls.element.contains(active) ? active : null;
  }

  private handleActivity(): void {
    const state = this.store.getState();
    if (!this.autoHideEnabled(state)) return;
    const wasHidden = this.controls.element.inert;
    this.controls.element.classList.remove('is-auto-hidden');
    this.controls.element.inert = false;
    if (wasHidden) this.syncDockSafeInset();
    if (this.autoHideTimer) {
      clearTimeout(this.autoHideTimer);
      this.autoHideTimer = null;
    }
    this.applyAutoHide(state);
  }

  private autoHideEnabled(state: CallState): boolean {
    const touch = this.root.ownerDocument.defaultView?.matchMedia?.('(pointer: coarse)').matches ?? false;
    if (state.phase !== 'joined' || state.settings.minimized) return false;
    return touch ? state.settings.fullscreen : state.config.layout.autoHideControls && !state.settings.fullscreen;
  }

  private applyAutoHide(state: CallState): void {
    if (!this.autoHideEnabled(state)) {
      if (this.autoHideTimer) {
        clearTimeout(this.autoHideTimer);
        this.autoHideTimer = null;
      }
      this.controls.element.classList.remove('is-auto-hidden');
      this.controls.element.inert = false;
      return;
    }
    // Do not restart the idle countdown on every store update (quality/ticks) —
    // only user activity or enabling the feature starts a new timer.
    if (this.autoHideTimer) return;
    const delay = Math.max(1, state.config.layout.autoHideDelaySec ?? 5) * 1000;
    this.autoHideTimer = setTimeout(() => {
      this.autoHideTimer = null;
      const current = this.store.getState();
      if (!this.autoHideEnabled(current)) return;
      const active = this.root.ownerDocument.activeElement;
      if (this.controls.element.querySelector('[aria-expanded="true"]')) return;
      if (this.controls.element.contains(active) && (!current.settings.fullscreen || active?.matches(':focus-visible'))) return;
      this.controls.element.classList.add('is-auto-hidden');
      // WCAG 2.4.7: controls that are invisible must not stay in the Tab order.
      this.controls.element.inert = true;
      this.syncDockSafeInset();
    }, delay);
  }

  private renderViewerHint(state: CallState): void {
    if (!state.settings.viewer) {
      this.viewerHint.hidden = true;
      return;
    }
    const webinar = state.config.scale.webinar;
    const hint = webinar.raiseHandQueue ? this.i18n.t('viewerHintRaise') : this.i18n.t('viewerHintMuted');
    this.viewerHint.replaceChildren(
      h('span', { class: 'agil-viewer-badge', text: this.i18n.t('viewerBadge') }),
      h('span', { class: 'agil-viewer-text', text: hint }),
    );
    this.viewerHint.hidden = false;
  }

  private renderRecording(state: CallState): void {
    const view = recordingIndicatorState(state.recording);
    this.recordingEl.hidden = !view.active;
    if (!view.active) {
      this.recordingTime.textContent = '';
      return;
    }
    if (view.startedAt) {
      this.recordingTime.textContent = formatDuration((Date.now() - view.startedAt) / 1000);
    }
    const label = view.byName
      ? `${this.i18n.t('recIndicator')} — ${view.byName}`
      : this.i18n.t('recIndicator');
    this.recordingEl.title = label;
    this.recordingEl.setAttribute('aria-label', label);
  }

  setSpotlightFollowSpeaker(participantId: string): void {
    this.root.dataset.agilSpotlightFollow = participantId;
  }

  setSpeaking(participantId: string, speaking: boolean): void {
    if (this.speaking.has(participantId) === speaking) return;
    if (speaking) this.speaking.add(participantId);
    else this.speaking.delete(participantId);
    const tile = this.tiles.get(participantId);
    tile?.element.classList.toggle('agil-tile-speaking', speaking);
    if (speaking) this.root.dataset.agilFollowSpeaker = participantId;
    else if (this.root.dataset.agilFollowSpeaker === participantId) delete this.root.dataset.agilFollowSpeaker;
    const row = this.panelElements.get('participants')?.querySelector(`.agil-participant-row[data-participant-id="${CSS.escape(participantId)}"]`);
    row?.classList.toggle('is-speaking', speaking);
  }

  showToast(
    message: string,
    kind: 'info' | 'success' | 'warning' | 'error' = 'info',
    timeoutMs = 4200,
    actions?: ToastAction[],
  ): void {
    this.toasts.show(message, kind, timeoutMs, actions);
  }

  showParticipantNotice(name: string, joined: boolean): void {
    this.clearParticipantNotice();
    const activity = this.i18n.t(joined ? 'participantJoined' : 'participantLeft');
    this.participantNotice.replaceChildren(
      h('span', { class: 'agil-participant-notice-name', text: name, title: name }),
      h('span', { text: ` ${activity}` }),
    );
    this.participantNoticeTimer = setTimeout(() => this.clearParticipantNotice(), 2600);
  }

  clearParticipantNotice(): void {
    clearTimeout(this.participantNoticeTimer);
    this.participantNoticeTimer = undefined;
    this.participantNotice.replaceChildren();
  }

  showJoinError(code: string, message?: string): void {
    this.joinScreen.showError(code, message);
  }

  setJoinOffline(offline: boolean): void {
    this.joinScreen.setOffline(offline);
  }

  setJoinBusy(busy: boolean): void {
    this.joinScreen.setBusy(busy);
  }

  joinScreenName(name: string): void {
    this.joinScreen.setName(name);
  }

  joinScreenServer(text: string): void {
    this.joinScreen.setServerLine(text);
  }

  /** Focuses the name field when returning from the waiting room. */
  focusJoin(): void {
    this.joinScreen.focus();
  }

  focusChat(): void {
    this.chatPanel.focusInput();
  }

  setChatUploading(uploading: boolean): void {
    this.chatPanel.setUploading(uploading);
  }

  focusSettingsDevices(): void {
    void this.settingsPanel.refreshDevices();
  }

  refreshDeviceOptions(): void {
    void this.settingsPanel.refreshDevices(true);
    this.controls.refreshDeviceOptions();
  }

  showReaction(emoji: string, name: string): void {
    const emojiSlot = h('span', { class: 'agil-reaction-emoji' });
    emojiSlot.appendChild(reactionNode(emoji, 28));
    const bubble = h('div', { class: 'agil-reaction-float' }, emojiSlot, h('span', { class: 'agil-reaction-name', text: name }));
    this.root.appendChild(bubble);
    setTimeout(() => bubble.remove(), 3200);
  }

  private releaseGalleryTiles(): void {
    for (const tile of this.tiles.values()) {
      this.slotResizeObserver?.unobserve(tile.element);
      tile.destroy();
    }
    this.tiles.clear();
    this.videoTileDimensions.clear();
    this.emptySlots.length = 0;
    this.grid.replaceChildren();
    this.speaking.clear();
    delete this.root.dataset.agilFollowSpeaker;
  }

  destroy(): void {
    this.mediaDevices?.removeEventListener?.('devicechange', this.onMediaDevicesChanged);
    this.bindWindowEvents(null);
    if (this.gridFrame !== null) this.gridWindow?.cancelAnimationFrame(this.gridFrame);
    this.galleryFrames.clear();
    this.slotResizeObserver?.disconnect();
    this.slotResizeObserver = null;
    this.hostResizeObserver?.disconnect();
    this.hostResizeObserver = null;
    if (this.autoHideTimer) clearTimeout(this.autoHideTimer);
    for (const type of ['pointermove', 'pointerdown', 'touchstart', 'focusin', 'keydown'] as const) {
      this.root.removeEventListener(type, this.onActivity);
    }
    this.unsubscribe?.();
    this.controls.destroy();
    this.releaseGalleryTiles();
    this.joinScreen.destroy();
    this.lobbyScreen.destroy();
    this.chatPanel.destroy();
    this.participantsPanel.destroy();
    this.lobbyPanel.destroy();
    this.breakoutPanel.destroy();
    this.notesPanel.destroy();
    this.transcriptPanel.destroy();
    this.settingsPanel.destroy();
    this.assistantPanel.destroy();
    this.toasts.clear();
    this.clearParticipantNotice();
    this.root.remove();
    this.toasts.element.remove();
  }
}
