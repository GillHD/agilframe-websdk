/**
 * Control bar with tenant-customisable layout (contract: docs/layout.md).
 *
 * - `bar`     — classic bottom bar (all controls in a row);
 * - `island`  — floating pill with key buttons + "⋯" popover for the rest;
 * - `minimal` — mic/camera/leave + "⋯".
 *
 * `hiddenControls` hides buttons visually only (API and shortcuts still work),
 * `controlOrder` sorts them, `controlsAnchor` positions the island, and the app
 * layer implements `autoHideControls` (idle hide/show).
 *
 * Stable e2e hooks: `data-agil-action`, `data-agil-control`, `[data-agil-more]`;
 * the container exposes `data-agil-controls-style` / `data-agil-controls-anchor`.
 */
import { browserRecordingEnabled, type ControlId, type FeatureKey } from '@agil/protocol';
import { h } from '../dom.js';
import { BackgroundPicker } from './background-picker.js';
import { deviceField, noiseSuppressionField } from './device-fields.js';
import type { I18n, I18nKey } from '../i18n.js';
import { icon, type IconName } from '../icons.js';
import { canFeature, canInviteFromCall } from '../permissions.js';
import { REACTION_LIST, reactionSvg } from './emoji.js';
import type { CallState, PanelKind } from '../types.js';
import {
  BAR_CENTER,
  BAR_LEFT,
  BAR_RIGHT,
  CONTROLS_WIDE_INVITE_MIN_WIDTH,
  HEADER_OWNED_CONTROLS,
  MINIMAL_KEYS,
  OVERFLOW_GROUP_LABEL_KEYS,
  controlDensity,
  callControlsWidth,
  compactControlKeys,
  fillQuickAccess,
  groupOverflowControls,
  isNarrowControlsViewport,
  overflowBarControls,
  resolveControlsStyle,
  usesCompactTouchControls,
  type ControlButtonId,
  type ControlDensity,
  type ControlsStyle,
} from './controls-density.js';

export interface ControlActions {
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreen: () => void;
  onCycleBlur: () => void;
  onToggleChat: () => void;
  onCopyLink: () => void;
  onOpenPanel: (panel: PanelKind) => void;
  onToggleHand: () => void;
  onReaction: (emoji: string) => void;
  onToggleSettings: () => void;
  onOpenPopover?: () => void;
  onToggleRecording: () => void;
  onToggleCaptions: () => void;
  onToggleAssistant: () => void;
  onLeave: () => void;
  onMinimize: () => void;
  onRestore: () => void;
  onRequestPip: () => void;
  onToggleFullscreen: () => void;
  onOpenNewTab: () => void;
  onTogglePolls?: () => void;
  onToggleBreakout?: () => void;
  onToggleWhiteboard?: () => void;
  onToggleAnnotations?: () => void;
  onMicDevice?: (deviceId: string) => void;
  onNoiseSuppression?: (enabled: boolean) => Promise<boolean>;
  onCamDevice?: (deviceId: string) => void;
  onMirrorSelfView: (enabled: boolean) => void;
  onBlurMode?: (mode: 'off' | 'blur' | 'image', imageUrl?: string) => void;
  /** Large-room/manual remote video quality (`auto` = adaptive stream). */
  onVideoQuality?: (quality: 'auto' | 'high' | 'medium' | 'low') => void;
}

/**
 * Short chip labels for the embedded desktop horizontal overflow tray.
 *
 * The tray is icon-over-label in ~50 px chips, so the full action name cannot
 * fit visually. The full label remains the button's `title` and `aria-label`;
 * these are display-only strings. Controls not listed here fall back to their
 * normal label (and the chip clips it with ellipsis if it is still too long).
 */
const OVERFLOW_SHORT_LABEL_KEYS: Partial<Record<ControlButtonId, I18nKey>> = {
  pip: 'moreShortPip',
  fullscreen: 'moreShortFullscreen',
  newtab: 'moreShortNewTab',
  minimize: 'moreShortMinimize',
  hand: 'moreShortHand',
  reactions: 'moreShortReactions',
  polls: 'moreShortPolls',
  settings: 'moreShortSettings',
  whiteboard: 'moreShortWhiteboard',
  annotate: 'moreShortAnnotate',
  captions: 'moreShortCaptions',
  recording: 'moreShortRecording',
  assistant: 'moreShortAssistant',
  invite: 'moreShortInvite',
  notes: 'notes',
};

const DEFAULT_ORDER: ControlButtonId[] = [
  'mic',
  'camera',
  'video-menu',
  'screen',
  'blur',
  'chat',
  'hand',
  'reactions',
  'invite',
  'participants',
  'polls',
  'whiteboard',
  'annotate',
  'breakout',
  'notes',
  'transcript',
  'assistant',
  'recording',
  'captions',
  'pip',
  'fullscreen',
  'newtab',
  'minimize',
  'settings',
  'leave',
];

interface ButtonSpec {
  id: ControlButtonId;
  icon: (state: CallState) => IconName;
  label: (state: CallState) => string;
  handler: () => void;
  feature?: FeatureKey;
  visible?: (state: CallState) => boolean;
}



export class ControlsBar {
  readonly element: HTMLDivElement;
  private readonly i18n: I18n;
  private readonly actions: ControlActions;
  private readonly specs = new Map<ControlButtonId, ButtonSpec>();
  private buttons = new Map<ControlButtonId, HTMLButtonElement>();
  private reactionMenu: HTMLDivElement | null = null;
  private morePopover: HTMLDivElement | null = null;
  private moreButton: HTMLButtonElement | null = null;
  private videoMenu: HTMLDivElement | null = null;
  private backgroundPicker: BackgroundPicker | null = null;
  private audioMenu: HTMLDivElement | null = null;
  private audioButton: HTMLButtonElement | null = null;
  private videoButton: HTMLButtonElement | null = null;
  private videoCameraSelect: HTMLSelectElement | null = null;
  private readonly deviceRequests = { audio: 0, video: 0 };
  private videoQualitySelect: HTMLSelectElement | null = null;
  private videoBgButtons: HTMLButtonElement[] = [];
  private videoMirrorButton: HTMLButtonElement | null = null;
  private layoutSignature = '';
  private state: CallState | null = null;
  private density: ControlDensity = 'solo';
  private effectiveStyle: ControlsStyle = 'bar';
  /** Embedded desktop chrome active (header view switch + rectangular dock). */
  private embeddedDesktop = false;
  private eventDocument: Document | null = null;
  private readonly onDocumentInteraction = (event: Event): void => this.closeOutsidePopovers(event);
  private readonly onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    // Escape closes whichever transient popover/picker is open. The poll
    // overlay and side panels own their own Escape handler; none of them can
    // be open together with these popovers, so there is no double close.
    let handled = false;
    if (this.videoMenu && !this.videoMenu.hidden) {
      this.toggleVideoMenu(false);
      this.deviceMenuAnchor(this.videoButton)?.focus({ preventScroll: true });
      handled = true;
    }
    if (this.audioMenu && !this.audioMenu.hidden) {
      this.toggleAudioMenu(false);
      this.deviceMenuAnchor(this.audioButton)?.focus({ preventScroll: true });
      handled = true;
    }
    if (this.morePopover && !this.morePopover.hidden) {
      this.toggleMore(false);
      this.moreButton?.focus({ preventScroll: true });
      handled = true;
    }
    if (this.reactionMenu && !this.reactionMenu.hidden) {
      this.toggleReactions(false, true);
      handled = true;
    }
    if (handled) event.preventDefault();
  };
  private readonly onViewportChange = (): void => {
    this.positionDeviceMenu(this.videoMenu, this.videoButton);
    this.positionDeviceMenu(this.audioMenu, this.audioButton);
    this.fitToolbarMenu(this.morePopover);
    this.fitToolbarMenu(this.reactionMenu);
  };

  constructor(i18n: I18n, actions: ControlActions) {
    this.i18n = i18n;
    this.actions = actions;
    this.element = h('div', {
      class: 'agil-controls',
      role: 'toolbar',
      attrs: { 'aria-label': i18n.t('callControls') },
    });
    this.registerSpecs();
    this.bindEvents(this.element.ownerDocument);
  }

  private bindEvents(doc: Document | null): void {
    if (this.eventDocument === doc) return;
    this.eventDocument?.removeEventListener('click', this.onDocumentInteraction, true);
    this.eventDocument?.removeEventListener('focusin', this.onDocumentInteraction);
    this.eventDocument?.removeEventListener('keydown', this.onDocumentKeydown);
    this.eventDocument?.defaultView?.removeEventListener('resize', this.onViewportChange);
    this.eventDocument?.defaultView?.removeEventListener('scroll', this.onViewportChange);
    this.eventDocument = doc;
    doc?.addEventListener('click', this.onDocumentInteraction, true);
    doc?.addEventListener('focusin', this.onDocumentInteraction);
    doc?.addEventListener('keydown', this.onDocumentKeydown);
    doc?.defaultView?.addEventListener('resize', this.onViewportChange, { passive: true });
    doc?.defaultView?.addEventListener('scroll', this.onViewportChange, { passive: true });
  }

  private get availableWidth(): number {
    return callControlsWidth(this.element.closest<HTMLElement>('.agil-app') ?? this.element);
  }

  private get touchIsland(): boolean {
    return this.effectiveStyle === 'island' && usesCompactTouchControls(this.element, this.availableWidth);
  }

  private get islandKeys(): readonly ControlButtonId[] {
    return compactControlKeys(this.availableWidth, this.touchIsland);
  }

  /** Effective (post-narrow-collapse) style, exposed for the app mount layer. */
  get style(): ControlsStyle {
    return this.effectiveStyle;
  }

  /** Current toolbar density bucket (2/4/8+ policy), exposed for QA hooks. */
  get densityBucket(): ControlDensity {
    return this.density;
  }

  private registerSpecs(): void {
    const i18n = this.i18n;
    const specs: ButtonSpec[] = [
      { id: 'mic', icon: (s) => (s.settings.micEnabled ? 'mic' : 'mic-off'), label: (s) => (s.settings.micEnabled ? i18n.t('micOn') : i18n.t('micOff')), handler: () => this.actions.onToggleMic() },
      { id: 'camera', icon: (s) => (s.settings.camEnabled ? 'camera' : 'camera-off'),
        label: (s) => s.videoUpgrade?.direction === 'incoming' ? i18n.t('videoUpgradeAccept') : s.audioOnly
          ? i18n.t(s.videoUpgrade ? 'videoUpgradeWaiting' : 'videoUpgradeRequest')
          : i18n.t(s.settings.camEnabled ? 'cameraOn' : 'cameraOff'),
        handler: () => this.actions.onToggleCamera(),
        visible: (s) => !s.audioOnly || (s.room?.mode === 'direct' && s.settings.mediaMode === 'mesh') },
      { id: 'screen', icon: (s) => (s.settings.screenSharing ? 'screen-off' : 'screen'), label: (s) => (s.settings.screenSharing ? i18n.t('stopScreenShare') : i18n.t('screenShare')), handler: () => this.actions.onToggleScreen(), feature: 'screenShare' },
      { id: 'blur', icon: () => 'blur', label: () => i18n.t('blur'), handler: () => this.actions.onCycleBlur(), visible: (s) => s.config.features.backgroundBlur || s.config.features.backgroundReplace },
      { id: 'mic-settings', icon: () => 'mic', label: () => i18n.t('audioSettings'), handler: () => this.toggleAudioMenu() },
      { id: 'video-menu', icon: () => 'camera', label: () => i18n.t('cameraSettings'), handler: () => this.toggleVideoMenu() },
      { id: 'chat', icon: () => 'chat', label: () => i18n.t('chat'), handler: () => this.actions.onToggleChat(), feature: 'chat' },
      { id: 'invite', icon: () => 'copy', label: () => i18n.t('copyLink'), handler: () => this.actions.onCopyLink(), visible: canInviteFromCall },
      { id: 'hand', icon: () => 'hand', label: (s) => (s.settings.handRaised ? i18n.t('handLower') : i18n.t('handRaise')), handler: () => this.actions.onToggleHand(), feature: 'handRaise' },
      { id: 'reactions', icon: () => 'smile', label: () => i18n.t('reactions'), handler: () => this.toggleReactions(), feature: 'reactions' },
      { id: 'polls', icon: () => 'poll', label: () => i18n.t('pollsTitle'), handler: () => this.actions.onTogglePolls?.(), feature: 'polls' },
      {
        id: 'whiteboard',
        icon: () => 'whiteboard',
        label: () => i18n.t('whiteboardTitle'),
        handler: () => this.actions.onToggleWhiteboard?.(),
        feature: 'whiteboard',
      },
      {
        id: 'annotate',
        icon: () => 'pen',
        label: () => i18n.t('annotationsToggle'),
        handler: () => this.actions.onToggleAnnotations?.(),
        feature: 'annotations',
        // Only meaningful while a screen share is on stage.
        visible: (s) => Boolean(s.annotation.presenterId),
      },
      // Breakout rooms live in the header for hosts/moderators (one entry point,
      // 44 px). The old phone-only duplicate inside “⋯” made the same action
      // appear twice on the exact screen that has the least room (C-08).
      { id: 'participants', icon: () => 'users', label: () => i18n.t('participantsTitle'), handler: () => this.actions.onOpenPanel('participants'), feature: 'participantList' },
      { id: 'notes', icon: () => 'note', label: () => i18n.t('notesTitle'), handler: () => this.actions.onOpenPanel('notes') },
      { id: 'transcript', icon: () => 'transcript', label: () => i18n.t('transcriptTitle'), handler: () => this.actions.onOpenPanel('transcript') },
      { id: 'assistant', icon: () => 'sparkles', label: () => i18n.t('assistantOpen'), handler: () => this.actions.onToggleAssistant() },
      { id: 'recording', icon: () => 'record', label: (s) => (s.recording.active ? i18n.t('recStop') : i18n.t('recStart')), handler: () => this.actions.onToggleRecording(), feature: 'recording' },
      { id: 'captions', icon: () => 'transcript', label: () => i18n.t('captions'), handler: () => this.actions.onToggleCaptions(), feature: 'captions' },
      { id: 'pip', icon: () => 'pip', label: () => i18n.t('pip'), handler: () => this.actions.onRequestPip(), feature: 'pictureInPicture' },
      { id: 'fullscreen', icon: (s) => (s.settings.fullscreen ? 'fullscreen' : 'fullscreen'), label: (s) => (s.settings.fullscreen ? i18n.t('exitFullscreen') : i18n.t('fullscreen')), handler: () => this.actions.onToggleFullscreen(), feature: 'fullscreen' },
      { id: 'newtab', icon: () => 'external', label: () => i18n.t('openInNewTab'), handler: () => this.actions.onOpenNewTab() },
      { id: 'minimize', icon: (s) => (s.settings.minimized ? 'restore' : 'minimize'), label: (s) => (s.settings.minimized ? i18n.t('restore') : i18n.t('minimize')), handler: () => (this.state?.settings.minimized ? this.actions.onRestore() : this.actions.onMinimize()) },
      { id: 'settings', icon: () => 'settings', label: () => i18n.t('settings'), handler: () => this.actions.onToggleSettings() },
      { id: 'leave', icon: () => 'leave', label: () => i18n.t('leave'), handler: () => this.actions.onLeave() },
    ];
    for (const spec of specs) this.specs.set(spec.id, spec);
  }

  /** Total participants including self: drives the toolbar density bucket. */
  private totalParticipants(state: CallState): number {
    return state.participants.length + (state.self ? 1 : 0);
  }

  /**
   * Full re-render (style/anchor/order/hidden/density changed).
   */
  private rebuild(state: CallState): void {
    const layout = state.config.layout;
    const style = this.resolveLayoutStyle(state);
    const density = controlDensity(this.totalParticipants(state));
    this.density = density;
    this.effectiveStyle = style;
    const order = this.buildOrder(layout.controlOrder ?? []);
    const visible = (id: ControlButtonId): boolean => this.isActionAvailable(id, state);
    this.element.replaceChildren();
    this.buttons = new Map();
    this.videoMenu = null;
    this.backgroundPicker = null;
    this.audioMenu = null;
    this.audioButton = null;
    this.videoButton = null;
    this.videoCameraSelect = null;
    this.videoQualitySelect = null;
    this.videoBgButtons = [];
    this.reactionMenu = null;
    this.morePopover = null;
    this.moreButton = null;
    this.element.dataset.agilControlsStyle = style;
    this.element.dataset.agilControlsAnchor = layout.controlsAnchor ?? 'bottom-center';
    this.element.dataset.agilDensity = density;
    const touchIsland = this.touchIsland;
    this.element.toggleAttribute('data-agil-touch-island', touchIsland);

    if (style === 'bar' || style === 'dock') {
      this.rebuildThreeZone(state, style, visible, order, density);
      return;
    }

    const keys = fillQuickAccess(style === 'island' ? this.islandKeys : MINIMAL_KEYS, order, visible);
    const mainRow = h('div', { class: 'agil-controls-main' });
    for (const id of order) {
      if (!keys.includes(id) || !visible(id)) continue;
      if (id === 'camera' && !touchIsland) {
        mainRow.appendChild(this.makeCameraGroup(state));
        continue;
      }
      if (id === 'mic' && !touchIsland) {
        mainRow.appendChild(this.makeMicGroup(state));
        continue;
      }
      if (id === 'video-menu') continue;
      mainRow.appendChild(this.makeButton(id, state));
    }
    // Everything else is one overflow entry, followed by the destructive action:
    // never in the middle of the island where it is easy to hit by accident.
    //
    // The island/minimal row renders only its key buttons, so the bar's
    // “primary action” rule must not drop the rest: at 3+ participants
    // `hand`/`reactions` are primary for the bar, are not in `ISLAND_KEYS`,
    // and would become unreachable on a phone. Every visible action that is
    // not on the row (and not a header-owned panel) belongs in the overflow.
    const moreIds: ControlButtonId[] = [];
    if (touchIsland) {
      if (visible('mic')) moreIds.push('mic-settings');
      if (visible('camera') && visible('video-menu')) moreIds.push('video-menu');
    }
    for (const id of order) {
      if (moreIds.includes(id) || keys.includes(id)) continue;
      if (id === 'video-menu' || id === 'leave') continue;
      if (HEADER_OWNED_CONTROLS.includes(id)) continue;
      if (visible(id)) moreIds.push(id);
    }
    if (moreIds.length > 0) {
      const more = this.makeMore(state, moreIds);
      mainRow.appendChild(more.button);
      this.element.appendChild(mainRow);
      this.element.appendChild(more.popover);
    } else {
      this.element.appendChild(mainRow);
    }
    if (visible('leave')) mainRow.appendChild(this.makeButton('leave', state));
    if (touchIsland) {
      this.audioButton = this.buttons.get('mic-settings') ?? null;
      this.videoButton = this.buttons.get('video-menu') ?? null;
      if (this.audioButton) this.element.appendChild(this.makeAudioMenu(state));
    }
    this.appendVideoMenu(state);
    this.appendReactionMenu();
  }

  /**
   * Three-zone toolbar shared by the classic bar and the embedded desktop dock.
   *
   * left = mic + camera/chevron, centre = the density-dependent call actions,
   * right = leave. The bar keeps `⋯` on the right (next to leave); the dock puts
   * it at the end of the centre group, so the compact row reads
   * “mic / camera · screen / chat / more · leave” (call-ui-v3 §9).
   */
  private rebuildThreeZone(
    state: CallState,
    style: 'bar' | 'dock',
    visible: (id: ControlButtonId) => boolean,
    order: readonly ControlButtonId[],
    density: ControlDensity,
  ): void {
    const left = h('div', { class: 'agil-controls-group agil-controls-left' });
    for (const id of BAR_LEFT) {
      if (!visible(id)) continue;
      left.appendChild(
        id === 'camera'
          ? this.makeCameraGroup(state)
          : id === 'mic'
            ? this.makeMicGroup(state)
            : this.makeButton(id, state),
      );
    }
    const showInvite = visible('invite') && this.availableWidth >= CONTROLS_WIDE_INVITE_MIN_WIDTH;
    const overflow = overflowBarControls(order, density, visible).filter((id) => !BAR_RIGHT.includes(id) && (id !== 'invite' || !showInvite));
    const primary = [...BAR_LEFT, ...BAR_CENTER[density], ...BAR_RIGHT];
    if (showInvite) primary.push('invite');
    const centreIds = new Set(fillQuickAccess(primary, overflow, visible)
      .filter((id) => !BAR_LEFT.includes(id) && !BAR_RIGHT.includes(id)));
    const centre = h('div', { class: 'agil-controls-group agil-controls-center' });
    for (const id of order) {
      if (!centreIds.has(id)) continue;
      centre.appendChild(this.makeButton(id, state));
    }
    const right = h('div', { class: 'agil-controls-group agil-controls-right' });
    const moreIds = overflow.filter((id) => !centreIds.has(id));
    let popover: HTMLDivElement | null = null;
    if (moreIds.length > 0) {
      const more = this.makeMore(state, moreIds);
      (style === 'dock' ? centre : right).appendChild(more.button);
      popover = more.popover;
    }
    for (const id of BAR_RIGHT) {
      if (visible(id)) right.appendChild(this.makeButton(id, state));
    }
    for (const group of [left, centre, right]) {
      if (group.childElementCount) this.element.appendChild(group);
    }
    if (popover) this.element.appendChild(popover);
    this.appendVideoMenu(state);
    this.appendReactionMenu();
  }

  /**
   * Effective controls style for the current state.
   *
   * The minimized mini-window always uses the compact “minimal” island: the
   * desktop bar's three zones do not fit in a 300–400 px bubble and used to
   * lay `screen`/`chat` on top of the camera chevron (QA P1-5). The window
   * width cannot decide this — a browser at 1440 px still minimizes into a
   * 300 px bubble.
   */
  private resolveLayoutStyle(state: CallState): ControlsStyle {
    if (state.settings.minimized) return 'minimal';
    const narrow = isNarrowControlsViewport(this.availableWidth);
    return resolveControlsStyle(state.config.layout.controlsStyle, narrow, this.embeddedDesktop);
  }

  /** Mic + audio-settings chevron share one visual unit. */
  private makeMicGroup(state: CallState): HTMLDivElement {
    const group = h('div', {
      class: 'agil-control-group agil-mic-group',
      dataset: { agilMicGroup: '' },
    });
    group.appendChild(this.makeButton('mic', state));
    const settings = h('button', {
      class: 'agil-control agil-control-mic-settings',
      title: this.i18n.t('audioSettings'),
      dataset: { agilAction: 'mic-settings' },
      attrs: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': this.i18n.t('audioSettings') },
    });
    settings.type = 'button';
    settings.appendChild(icon('chevron-up', 18));
    settings.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleAudioMenu();
    });
    group.append(settings, this.makeAudioMenu(state));
    this.audioButton = settings;
    return group;
  }

  private makeAudioMenu(state: CallState): HTMLDivElement {
    const menu = h('div', {
      class: 'agil-video-menu agil-audio-menu',
      attrs: { role: 'dialog', 'aria-label': this.i18n.t('audioSettings') },
    });
    menu.hidden = true;
    const title = h('strong', { class: 'agil-video-title', text: this.i18n.t('settingsMic') });
    const select = h('select', { class: 'agil-select', attrs: { 'aria-label': this.i18n.t('settingsMic') } });
    select.appendChild(h('option', { attrs: { value: '' }, text: this.i18n.t('settingsDefault') }));
    select.addEventListener('change', () => this.actions.onMicDevice?.(select.value));
    const all = h('button', { class: 'agil-video-chip agil-audio-all-settings' }, icon('settings', 16), this.i18n.t('settingsAll'));
    all.type = 'button';
    all.addEventListener('click', () => {
      this.toggleAudioMenu(false);
      this.actions.onToggleSettings();
    });
    menu.append(title, deviceField('mic', select));
    if (navigator.mediaDevices?.getSupportedConstraints?.().noiseSuppression && this.actions.onNoiseSuppression) {
      const noise = h('input', { attrs: { type: 'checkbox', role: 'switch' }, dataset: { agilNoiseSuppression: '' } });
      noise.checked = state.settings.noiseSuppression ?? state.config.audio.noiseSuppression;
      noise.addEventListener('change', async () => {
        noise.disabled = true;
        try { await this.actions.onNoiseSuppression?.(noise.checked); }
        finally {
          noise.disabled = false;
          if (this.state) noise.checked = this.state.settings.noiseSuppression ?? this.state.config.audio.noiseSuppression;
        }
      });
      menu.append(noiseSuppressionField(this.i18n, noise));
    }
    menu.append(all);
    this.audioMenu = menu;
    return menu;
  }

  /** Camera + device chevron share one visual unit. */
  private makeCameraGroup(state: CallState): HTMLDivElement {
    const group = h('div', {
      class: 'agil-control-group agil-camera-group',
      dataset: { agilCameraGroup: '' },
    });
    group.appendChild(this.makeButton('camera', state));
    group.appendChild(this.makeVideoButton(state));
    return group;
  }

  /** Overflow «⋯» trigger + popover; shared by the bar, island and minimal. */
  private makeMore(
    state: CallState,
    ids: readonly ControlButtonId[],
  ): { button: HTMLButtonElement; popover: HTMLDivElement } {
    const button = h('button', {
      class: 'agil-control agil-control-more',
      title: this.i18n.t('moreControls'),
      dataset: { agilMore: '' },
      attrs: {
        'aria-label': this.i18n.t('moreControls'),
        'aria-expanded': 'false',
        'aria-controls': 'agil-more-popover',
      },
    });
    button.type = 'button';
    button.appendChild(icon('more', 20));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleMore();
    });
    const popover = h('div', {
      class: 'agil-controls-more-popover',
      dataset: { agilMorePopover: '' },
      attrs: { id: 'agil-more-popover', role: 'group', 'aria-label': this.i18n.t('moreControls') },
    });
    popover.hidden = true;
    // 7–10 icon-only glyphs were indistinguishable at 20 px (C-08). Every
    // overflow action now carries a visible label and the list is split into
    // “Медиа / Встреча / Настройки” groups.
    //
    // Each group is wrapped in `.agil-overflow-group` so the embedded desktop
    // tray can lay the groups out side by side with 1 px dividers. The wrapper
    // is `display: contents` everywhere else: the default/touch popover still
    // sees the same heading + button grid items as before.
    const groups = groupOverflowControls(ids);
    const showHeadings = groups.length > 1;
    for (const entry of groups) {
      const group = h('div', {
        class: 'agil-overflow-group',
        dataset: { agilOverflowGroup: entry.group },
      });
      if (showHeadings) {
        group.appendChild(
          h('div', { class: 'agil-overflow-group-label', text: this.i18n.t(OVERFLOW_GROUP_LABEL_KEYS[entry.group]) }),
        );
      }
      for (const id of entry.ids) group.appendChild(this.makeButton(id, state, true));
      popover.appendChild(group);
    }
    popover.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.toggleMore(false);
      button.focus();
    });
    this.moreButton = button;
    this.morePopover = popover;
    return { button, popover };
  }

  /** Chevron next to the camera: camera/background/blur/mirror/quality/stats. */
  private makeVideoButton(state: CallState): HTMLButtonElement {
    const button = h('button', {
      class: 'agil-control agil-control-video',
      title: this.i18n.t('videoMenu'),
      dataset: { agilControl: 'video-menu', agilAction: 'video-menu' },
      attrs: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': this.i18n.t('videoMenu') },
    });
    button.type = 'button';
    button.dataset.agilVideoMenuButton = '';
    button.appendChild(icon('chevron-up', 20));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleVideoMenu();
    });
    this.videoButton = button;
    void state;
    return button;
  }

  private appendVideoMenu(state: CallState): void {
    const menu = h('div', {
      class: 'agil-video-menu',
      attrs: { role: 'dialog', 'aria-label': this.i18n.t(this.touchIsland ? 'cameraSettings' : 'videoMenu') },
    });
    menu.hidden = true;

    const cameraLabel = h('label', { class: 'agil-video-row', text: this.i18n.t('videoCamera') });
    const cameraSelect = h('select', { class: 'agil-video-select', dataset: { agilVideoCamera: '' } });
    this.videoCameraSelect = cameraSelect;
    this.videoBgButtons = [];
    cameraSelect.setAttribute('aria-label', this.i18n.t('videoCamera'));
    cameraSelect.appendChild(h('option', { text: this.i18n.t('videoCameraAuto'), attrs: { value: '' } }));
    cameraSelect.value = state.settings.camDeviceId || '';
    cameraSelect.addEventListener('change', () => {
      this.actions.onCamDevice?.(cameraSelect.value);
    });
    menu.appendChild(cameraLabel);
    menu.appendChild(cameraSelect);
    void this.fillDeviceOptions('video');

    const bg = h('div', { class: 'agil-video-row agil-video-bg' }, h('span', { text: this.i18n.t('videoBackground') }));
    const picker = new BackgroundPicker(this.i18n, (url) => this.actions.onBlurMode?.(url ? 'image' : 'off', url ?? undefined),
      () => this.positionDeviceMenu(this.videoMenu, this.videoButton));
    picker.element.hidden = state.settings.blurMode !== 'image';
    picker.update(state.backgrounds, state.settings.blurMode === 'image' ? state.settings.backgroundImageUrl : '');
    this.backgroundPicker = picker;
    for (const mode of ['off', 'blur', 'image'] as const) {
      const label =
        mode === 'off'
          ? this.i18n.t('videoBackgroundOff')
          : mode === 'blur'
            ? this.i18n.t('videoBackgroundBlur')
            : this.i18n.t('videoBackgroundImage');
      const button = h('button', {
        class: 'agil-video-chip',
        text: label,
        dataset: { agilVideoBg: mode },
      });
      button.type = 'button';
      button.setAttribute('aria-pressed', String(state.settings.blurMode === mode));
      button.classList.toggle('is-active', state.settings.blurMode === mode);
      this.videoBgButtons.push(button);
      button.addEventListener('click', () => {
        if (mode === 'image') {
          picker.element.hidden = false;
          this.positionDeviceMenu(this.videoMenu, this.videoButton);
          picker.element.querySelector('button')?.focus();
          return;
        }
        picker.element.hidden = true;
        this.toggleVideoMenu(false);
        this.deviceMenuAnchor(this.videoButton)?.focus({ preventScroll: true });
        this.actions.onBlurMode?.(mode);
      });
      bg.appendChild(button);
    }
    menu.appendChild(bg);
    menu.appendChild(picker.element);

    const mirror = h(
      'button',
      { class: 'agil-video-row agil-video-mirror', dataset: { agilVideoMirror: '' } },
      h('span', { text: this.i18n.t('videoMirror') }),
      h('span', { class: 'agil-switch', attrs: { 'aria-hidden': 'true' } }),
    );
    mirror.type = 'button';
    mirror.setAttribute('role', 'switch');
    mirror.addEventListener('click', () => {
      this.actions.onMirrorSelfView(mirror.getAttribute('aria-checked') !== 'true');
    });
    this.videoMirrorButton = mirror;
    menu.appendChild(mirror);

    const quality = h('label', { class: 'agil-video-row agil-video-quality', text: this.i18n.t('videoQuality') });
    const qualitySelect = h('select', { class: 'agil-video-select', dataset: { agilVideoQuality: '' } });
    this.videoQualitySelect = qualitySelect;
    qualitySelect.setAttribute('aria-label', this.i18n.t('videoQuality'));
    qualitySelect.appendChild(h('option', { text: this.i18n.t('videoQualityAuto'), attrs: { value: 'auto' } }));
    qualitySelect.appendChild(h('option', { text: this.i18n.t('videoQualityHigh'), attrs: { value: 'high' } }));
    qualitySelect.appendChild(h('option', { text: this.i18n.t('videoQualityMedium'), attrs: { value: 'medium' } }));
    qualitySelect.appendChild(h('option', { text: this.i18n.t('videoQualityLow'), attrs: { value: 'low' } }));
    qualitySelect.value = state.settings.videoQuality ?? 'auto';
    // The selector is meaningful only for SFU rooms (mesh tiles are P2P).
    qualitySelect.disabled = state.settings.mediaMode === 'mesh';
    qualitySelect.addEventListener('change', () => {
      this.actions.onVideoQuality?.(qualitySelect.value as 'auto' | 'high' | 'medium' | 'low');
    });
    quality.appendChild(qualitySelect);
    quality.hidden = qualitySelect.disabled;
    menu.appendChild(quality);

    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.toggleVideoMenu(false);
        this.deviceMenuAnchor(this.videoButton)?.focus({ preventScroll: true });
      }
    });
    this.videoMenu = menu;
    // Anchor the menu to the camera group itself (C-07). Previously it was a
    // child of `.agil-controls` and centred on the viewport: at 1440 its left
    // edge sat at x=580 while the camera group ended at x=156, so the menu
    // covered the middle of the 2×2 gallery and the participant names.
    const cameraGroup = this.element.querySelector<HTMLElement>('.agil-camera-group');
    (cameraGroup ?? this.element).appendChild(menu);
  }

  private toggleAudioMenu(force?: boolean): void {
    if (!this.audioMenu) return;
    const next = force !== undefined ? force : this.audioMenu.hidden;
    if (next) this.actions.onOpenPopover?.();
    this.audioMenu.hidden = !next;
    this.audioButton?.setAttribute('aria-expanded', String(next));
    if (next) {
      this.toggleVideoMenu(false);
      this.toggleMore(false);
      this.toggleReactions(false);
      this.positionDeviceMenu(this.audioMenu, this.audioButton);
      this.audioMenu.querySelector('select')?.focus({ preventScroll: true });
      void this.fillDeviceOptions('audio');
    }
  }

  refreshDeviceOptions(): void {
    if (this.audioMenu && !this.audioMenu.hidden) void this.fillDeviceOptions('audio');
    void this.fillDeviceOptions('video');
  }

  private async fillDeviceOptions(kind: 'audio' | 'video'): Promise<void> {
    const video = kind === 'video';
    const getSelect = () => video ? this.videoCameraSelect : this.audioMenu?.querySelector<HTMLSelectElement>('select');
    const select = getSelect();
    if (!select || !navigator.mediaDevices?.enumerateDevices) return;
    const request = ++this.deviceRequests[kind];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (request !== this.deviceRequests[kind] || select !== getSelect()) return;
      const label = this.i18n.t(video ? 'videoCamera' : 'settingsMic');
      select.replaceChildren(h('option', { attrs: { value: '' }, text: this.i18n.t(video ? 'videoCameraAuto' : 'settingsDefault') }));
      for (const device of devices.filter((item) => item.kind === (video ? 'videoinput' : 'audioinput') && item.deviceId)) {
        select.appendChild(
          h('option', {
            attrs: { value: device.deviceId },
            text: device.label || `${label} ${select.options.length}`,
          }),
        );
      }
      const current = video ? this.state?.settings.camDeviceId : this.state?.settings.micDeviceId;
      this.syncDeviceSelection(select, current);
    } catch {
      /* device labels require permission; the default option remains */
    }
  }

  private syncDeviceSelection(select: HTMLSelectElement, deviceId?: string | null): void {
    const selected = deviceId && Array.from(select.options).some((option) => option.value === deviceId) ? deviceId : '';
    if (select.value !== selected) select.value = selected;
  }

  private toggleVideoMenu(force?: boolean): void {
    if (!this.videoMenu || !this.videoButton) return;
    const next = force !== undefined ? force : this.videoMenu.hidden;
    if (next) this.actions.onOpenPopover?.();
    this.videoMenu.hidden = !next;
    this.videoButton.setAttribute('aria-expanded', String(next));
    if (next) {
      this.toggleAudioMenu(false);
      this.toggleMore(false);
      this.toggleReactions(false);
      // Measure only once the menu is visible (`hidden` = display:none).
      this.positionDeviceMenu(this.videoMenu, this.videoButton);
      this.videoMenu.querySelector<HTMLSelectElement>('[data-agil-video-camera]')?.focus({ preventScroll: true });
    }
  }

  /**
   * Keep the camera menu inside the call surface.
   *
   * The menu used to be anchored above the camera group unconditionally and was
   * clipped by `.agil-root { overflow:hidden }` / the viewport: at 1024/390 its
   * top 87–174 px (the camera select and the first chips) were cut away and at
   * 390 it also ran 30–53 px past the right edge. It now:
   *  - flips below the trigger when there is not enough room above,
   *  - is clamped to the call root (and the viewport) with a 12 px margin,
   *  - is capped to the available height and scrolls internally when tall.
   */
  private positionDeviceMenu(menu: HTMLDivElement | null, trigger: HTMLButtonElement | null): void {
    trigger = this.deviceMenuAnchor(trigger);
    const root = this.element.closest<HTMLElement>('.agil-root');
    if (!menu || !trigger || !root || menu.hidden) return;
    const margin = 12;
    const viewport = menu.ownerDocument.defaultView;
    if (!viewport) return;
    const viewportWidth = viewport.innerWidth;
    const viewportHeight = viewport.innerHeight;
    const rootRect = root.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    // Horizontal anchor is the whole camera split (camera + chevron), exactly
    // like the CSS `left:0` it replaces; the chevron alone sits 44 px right of
    // it and broke the camera alignment check.
    const cameraGroup = trigger.closest<HTMLElement>('.agil-camera-group, .agil-mic-group');
    const anchorRect = (cameraGroup ?? trigger).getBoundingClientRect();
    // The call area is the intersection of the root and the viewport; the
    // menu may never leave it (12 px breathing room on every side).
    const minX = Math.max(rootRect.left, 0) + margin;
    const maxX = Math.min(rootRect.right, viewportWidth) - margin;
    const minY = Math.max(rootRect.top, 0) + margin;
    const maxY = Math.min(rootRect.bottom, viewportHeight) - margin;
    const availableWidth = Math.max(1, maxX - minX);
    const width = Math.min(300, availableWidth);
    // Reset the inline box before measuring, so a previous placement (below
    // the trigger, with a scrolled/capped height) cannot influence the size.
    menu.style.width = `${width}px`;
    menu.style.maxHeight = 'none';
    menu.style.overflowY = 'visible';
    const naturalHeight = Math.ceil(menu.getBoundingClientRect().height);
    // The menu keeps its documented 320 px cap; a taller stack scrolls inside
    // the panel instead of growing over the call controls.
    const preferredHeight = Math.min(naturalHeight, 320);
    const gap = 10;
    // Cap the anchor itself to the visible call area: a card partially below
    // the fold still has its dock outside the viewport, and opening from that
    // y coordinate would push the menu past the bottom edge.
    const aboveLimit = Math.min(triggerRect.top - gap, maxY);
    const belowStart = triggerRect.bottom + gap;
    const spaceAbove = aboveLimit - minY;
    const spaceBelow = maxY - belowStart;
    // Prefer above (the historic direction) and flip below only when the menu
    // does not fit above and there is more room below.
    const placeAbove = preferredHeight <= spaceAbove || spaceAbove >= spaceBelow;
    const availableHeight = Math.max(1, Math.floor(placeAbove ? spaceAbove : spaceBelow));
    const height = Math.min(preferredHeight, availableHeight);
    const top = placeAbove
      ? aboveLimit - height
      : Math.min(belowStart, maxY - height);
    let left = anchorRect.left;
    if (left + width > maxX) left = maxX - width;
    if (left < minX) left = minX;
    // Absolute child of the camera group (or of the controls element when the
    // camera group is not rendered); coordinates are relative to that box.
    const origin = (menu.offsetParent as HTMLElement | null) ?? this.element;
    const originRect = origin.getBoundingClientRect();
    menu.style.left = `${Math.round(left - originRect.left)}px`;
    menu.style.right = 'auto';
    menu.style.top = `${Math.round(top - originRect.top)}px`;
    menu.style.bottom = 'auto';
    menu.style.maxHeight = `${Math.round(height)}px`;
    menu.style.overflowY = naturalHeight > height ? 'auto' : 'visible';
  }

  private deviceMenuAnchor(trigger: HTMLButtonElement | null): HTMLButtonElement | null {
    return trigger && this.morePopover?.contains(trigger) ? this.moreButton : trigger;
  }

  private fitToolbarMenu(menu: HTMLDivElement | null): void {
    if (!menu || menu.hidden) return;
    const root = this.element.closest<HTMLElement>('.agil-root');
    const viewport = menu.ownerDocument.defaultView;
    if (!root || !viewport) return;
    menu.style.removeProperty('max-height');
    menu.style.removeProperty('overflow-y');
    const area = root.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    const topAnchored = this.element.closest<HTMLElement>('.agil-controls-layer')?.dataset.anchor?.startsWith('top');
    const available = topAnchored
      ? Math.min(viewport.innerHeight, area.bottom) - bounds.top
      : bounds.bottom - Math.max(0, area.top);
    const cssMaximum = Number.parseFloat(viewport.getComputedStyle(menu).maxHeight);
    const cap = Math.floor(Math.max(1, Math.min(available - 8, Number.isFinite(cssMaximum) ? cssMaximum : Infinity)));
    if (bounds.height > cap) {
      menu.style.maxHeight = `${cap}px`;
      menu.style.overflowY = 'auto';
    }
  }

  private appendReactionMenu(): void {
    const menu = h('div', {
      class: 'agil-reactions-menu',
      attrs: { role: 'group', 'aria-label': this.i18n.t('reactions') },
    });
    menu.hidden = true;
    for (const reaction of REACTION_LIST) {
      const button = h('button', { class: 'agil-reaction', dataset: { agilReaction: reaction.id } });
      button.type = 'button';
      button.setAttribute('aria-label', this.i18n.t(reaction.labelKey));
      button.title = this.i18n.t(reaction.labelKey);
      button.appendChild(reactionSvg(reaction.id, 20));
      button.addEventListener('click', () => {
        this.toggleReactions(false, true);
        this.actions.onReaction(reaction.char);
      });
      menu.appendChild(button);
    }
    this.reactionMenu = menu;
    this.element.appendChild(menu);
  }

  private buildOrder(configured: readonly ControlId[]): ControlButtonId[] {
    const result: ControlButtonId[] = [...new Set(configured)];
    for (const id of DEFAULT_ORDER) if (!result.includes(id)) result.push(id);
    return result;
  }

  private featureAllowed(state: CallState, feature: FeatureKey): boolean {
    return canFeature(state, feature);
  }

  private recordingAvailable(state: CallState): boolean {
    return state.recording.active || (
      this.featureAllowed(state, 'recording') && browserRecordingEnabled(state.config) && state.e2ee?.status !== 'enabled'
    );
  }

  private isActionAvailable(id: ControlButtonId, state: CallState): boolean {
    const spec = this.specs.get(id);
    if (!spec || state.config.layout.hiddenControls?.includes(id as ControlId) || id === 'blur') return false;
    if (id === 'fullscreen') return state.settings.fullscreen || (state.config.features.fullscreen && this.featureAllowed(state, 'fullscreen'));
    if (id === 'recording') return this.recordingAvailable(state);
    if ((spec.feature && !this.featureAllowed(state, spec.feature)) || spec.visible?.(state) === false) return false;
    switch (id) {
      case 'mic':
      case 'camera':
        return !state.settings.viewer;
      case 'screen': return state.capabilities.screenShare && !state.settings.viewer && !state.audioOnly;
      case 'video-menu': return !state.settings.viewer && !state.audioOnly;
      case 'chat': return state.settings.chatMode === 'builtin';
      case 'assistant': return state.inCallAssistant.available || state.assistant.available;
      case 'captions': return state.config.session.transcription.enabled && state.config.session.transcription.provider !== 'off' && state.e2ee?.status !== 'enabled';
      case 'notes': return this.featureAllowed(state, 'meetingNotes') || this.featureAllowed(state, 'aiCompliance');
      case 'transcript': return state.config.session.transcription.saveTranscript && this.featureAllowed(state, 'captions');
      case 'reactions': return !state.config.scale.webinar.enabled || state.config.scale.webinar.reactions;
      case 'settings': return state.config.features.deviceSettings || state.config.features.statsPanel;
      case 'minimize': return state.config.layout.minimized.enabled;
      default: return true;
    }
  }

  /**
   * Display-only short label for an overflow chip. The full action name stays
   * on the button (`title`/`aria-label`), so the compact label never hides the
   * meaning from assistive tech or a hover tooltip.
   */
  private shortLabel(id: ControlButtonId, state: CallState): string {
    // Collapse/restore share a chip; the short verb follows the state.
    if (id === 'minimize') {
      return this.i18n.t(state.settings.minimized ? 'moreShortRestore' : 'moreShortMinimize');
    }
    const key = OVERFLOW_SHORT_LABEL_KEYS[id];
    if (key) return this.i18n.t(key);
    const spec = this.specs.get(id);
    return spec ? spec.label(state) : id;
  }

  private makeButton(id: ControlButtonId, state: CallState, inPopover = false): HTMLButtonElement {
    const spec = this.specs.get(id);
    const label = spec ? spec.label(state) : id;
    const button = h('button', {
      class: `agil-control agil-control-${id}`,
      title: label,
      dataset: { agilAction: id, agilControl: id },
    });
    button.type = 'button';
    button.setAttribute('aria-label', label);
    if (id === 'reactions') button.setAttribute('aria-expanded', 'false');
    if (id === 'mic-settings' || id === 'video-menu') {
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-expanded', 'false');
      if (id === 'video-menu') button.dataset.agilVideoMenuButton = '';
    }
    if (inPopover) button.dataset.agilOverflow = 'true';
    if (id === 'leave') button.classList.add('is-danger');
    const iconName: IconName = spec ? spec.icon(state) : 'info';
    this.setButtonIcon(button, iconName);
    if (inPopover) {
      const shortLabel = this.shortLabel(id, state);
      button.classList.add('agil-control-labelled');
      button.dataset.agilOverflowLabel = label;
      button.dataset.agilOverflowShort = shortLabel;
      // Both labels exist in the DOM: the default/touch popover shows the full
      // two-line label, the embedded desktop tray hides it and shows the short
      // chip label (see style.css). title/aria-label always carry the full one.
      button.append(
        h('span', { class: 'agil-control-label', text: label }),
        h('span', { class: 'agil-control-label agil-control-label-short', text: shortLabel, attrs: { 'aria-hidden': 'true' } }),
      );
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.morePopover && !this.morePopover.hidden && id !== 'reactions') {
        this.toggleMore(false);
        if (inPopover) this.moreButton?.focus({ preventScroll: true });
      }
      spec?.handler();
    });
    this.buttons.set(id, button);
    return button;
  }

  /**
   * One icon size for every control (20 px inside a 44×44 target). The old
   * code used 22/20/18 depending on where the button lived and replaced the
   * icon subtree on every state tick; that caused visible size jumps and lost
   * DOM identity for focus/assistive tech.
   */
  private setButtonIcon(button: HTMLButtonElement, name: IconName): void {
    if (button.dataset.agilIcon === name && button.firstElementChild) return;
    button.dataset.agilIcon = name;
    // Overflow buttons keep their visible label(s) when the icon swaps state
    // (hand raised/lowered, recording on/off). Both the full label and the
    // embedded-desktop short label must survive.
    const labels = Array.from(button.querySelectorAll('.agil-control-label'));
    button.replaceChildren(icon(name, 20), ...labels);
  }

  private toggleMore(force?: boolean): void {
    if (!this.morePopover || !this.moreButton) return;
    const next = force !== undefined ? force : this.morePopover.hidden;
    if (next) this.actions.onOpenPopover?.();
    this.morePopover.hidden = !next;
    this.moreButton.setAttribute('aria-expanded', String(next));
    // Only *opening* “⋯” dismisses the other transient popovers. Closing it
    // must not dismiss the reactions picker that was opened from inside it:
    // `toggleReactions()` opens the picker and then closes the tray, so the
    // unconditional call here re-hid the picker in the same tick and the
    // feature was a no-op (QA P1-1 / G-4).
    if (next) {
      this.toggleVideoMenu(false);
      this.toggleAudioMenu(false);
      this.toggleReactions(false);
      this.fitToolbarMenu(this.morePopover);
      this.morePopover.scrollTop = 0;
      Array.from(this.morePopover.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        .find((button) => button.getClientRects().length > 0)?.focus({ preventScroll: true });
    }
  }

  private toggleReactions(force?: boolean, restoreFocus = false): void {
    if (!this.reactionMenu) return;
    const next = force !== undefined ? force : this.reactionMenu.hidden;
    if (next) this.actions.onOpenPopover?.();
    const trigger = this.buttons.get('reactions');
    this.reactionMenu.hidden = !next;
    trigger?.setAttribute('aria-expanded', String(next));
    if (next) {
      this.toggleVideoMenu(false);
      this.toggleAudioMenu(false);
      this.toggleMore(false);
      this.fitToolbarMenu(this.reactionMenu);
      this.reactionMenu.querySelector('button')?.focus({ preventScroll: true });
    } else if (restoreFocus && trigger) {
      // The picker replaces the overflow tray. Its own trigger is then hidden.
      const target = this.morePopover?.contains(trigger) ? this.moreButton : trigger;
      target?.focus({ preventScroll: true });
    }
  }

  private closeOutsidePopovers(event: Event): void {
    const target = event.composedPath()[0];
    if (!target || !('nodeType' in target)) return;
    const node = target as Node;
    if (this.morePopover && !this.morePopover.hidden) {
      if (!this.morePopover.contains(node) && !this.moreButton?.contains(node)) this.toggleMore(false);
    }
    if (this.videoMenu && !this.videoMenu.hidden) {
      if (!this.videoMenu.contains(node) && !this.videoButton?.contains(node)) this.toggleVideoMenu(false);
    }
    if (this.audioMenu && !this.audioMenu.hidden) {
      if (!this.audioMenu.contains(node) && !this.audioButton?.contains(node)) this.toggleAudioMenu(false);
    }
    if (this.reactionMenu && !this.reactionMenu.hidden) {
      if (!this.reactionMenu.contains(node) && !this.buttons.get('reactions')?.contains(node)) {
        this.toggleReactions(false);
      }
    }
  }

  /** Closes every transient control popover (leave/route change/reset). */
  closeAllPopovers(): void {
    this.toggleVideoMenu(false);
    this.toggleAudioMenu(false);
    this.toggleMore(false);
    this.toggleReactions(false);
  }

  update(state: CallState, can: (feature: FeatureKey) => boolean, embeddedDesktop = false, previousFocus?: Element | null): void {
    this.bindEvents(this.element.ownerDocument);
    this.state = state;
    this.backgroundPicker?.update(state.backgrounds, state.settings.blurMode === 'image' ? state.settings.backgroundImageUrl : '');
    this.embeddedDesktop = embeddedDesktop;
    const layout = state.config.layout;
    const density = controlDensity(this.totalParticipants(state));
    const style = this.resolveLayoutStyle(state);
    this.density = density;
    this.effectiveStyle = style;
    const signature = [
      layout.controlsStyle,
      layout.controlsAnchor,
      layout.hiddenControls?.join(',') ?? '',
      layout.controlOrder?.join(',') ?? '',
      layout.minimized.enabled,
      state.settings.minimized ? 'minimized' : 'full',
      style === 'island' ? this.islandKeys.length : 0,
      this.touchIsland,
      (style === 'bar' || style === 'dock') && this.availableWidth >= CONTROLS_WIDE_INVITE_MIN_WIDTH,
      style,
      embeddedDesktop ? 'embedded-desktop' : 'default',
      density,
      state.settings.viewer,
      state.settings.chatMode,
      state.permissions?.join(',') ?? '',
      state.config.features.captions,
      state.config.features.pictureInPicture,
      state.config.features.fullscreen,
      state.config.features.recording,
      state.whiteboard.visible,
      state.annotation.presenterId ?? '',
      DEFAULT_ORDER.filter((id) => this.isActionAvailable(id, state)).join(','),
    ].join('|');
    const rebuild = signature !== this.layoutSignature;
    const active = previousFocus ?? this.element.ownerDocument.activeElement;
    const restoreFocus = rebuild && active !== null && this.element.contains(active);
    const focusedInOverflow = restoreFocus && this.morePopover && !this.morePopover.hidden && this.morePopover.contains(active);
    const focusedAction = restoreFocus
      ? active?.closest<HTMLElement>('[data-agil-action]')?.dataset.agilAction
        ?? (this.videoMenu?.contains(active) ? this.videoButton : this.audioMenu?.contains(active) ? this.audioButton : null)?.dataset.agilAction
      : undefined;
    if (rebuild) {
      this.layoutSignature = signature;
      this.rebuild(state);
    }
    this.applyStates(state, can);
    this.syncVideoMenu(state);
    const micSelect = this.audioMenu?.querySelector<HTMLSelectElement>('select');
    if (micSelect) this.syncDeviceSelection(micSelect, state.settings.micDeviceId);
    if (restoreFocus) {
      const next = Array.from(this.element.querySelectorAll<HTMLButtonElement>('[data-agil-action]'))
        .find((button) => button.dataset.agilAction === focusedAction && !button.disabled && button.style.display !== 'none');
      if (next && focusedInOverflow && this.morePopover?.contains(next)) this.toggleMore(true);
      const visible = next?.getClientRects().length && next.ownerDocument.defaultView?.getComputedStyle(next).visibility === 'visible';
      const target = visible ? next : this.moreButton ?? this.buttons.get('mic') ?? this.buttons.get('leave');
      target?.focus({ preventScroll: true });
      if (target && this.morePopover?.contains(target)) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  /**
   * Keeps the camera chevron menu truthful after state changes. The menu is
   * rebuilt only when the layout changes, so without this the blur chip and the
   * camera select would keep the values captured when the menu was created
   * (QA round 15 P1-1: chip stayed aria-pressed="false" after a working blur).
   */
  private syncVideoMenu(state: CallState): void {
    if (this.videoMirrorButton) {
      const mirrored = state.settings.mirrorSelfView ?? state.config.session.mirrorSelfView;
      this.videoMirrorButton.setAttribute('aria-checked', String(mirrored));
      this.videoMirrorButton.classList.toggle('is-active', mirrored);
    }
    if (this.videoCameraSelect) {
      this.syncDeviceSelection(this.videoCameraSelect, state.settings.camDeviceId);
    }
    for (const button of this.videoBgButtons) {
      const mode = button.dataset.agilVideoBg;
      const active = mode === state.settings.blurMode;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
    }
    if (this.videoQualitySelect) {
      const quality = state.settings.videoQuality ?? 'auto';
      if (this.videoQualitySelect.value !== quality) this.videoQualitySelect.value = quality;
      this.videoQualitySelect.disabled = state.settings.mediaMode === 'mesh';
      const qualityRow = this.videoQualitySelect.closest<HTMLElement>('.agil-video-quality');
      if (qualityRow) qualityRow.hidden = this.videoQualitySelect.disabled;
    }
    const noise = this.audioMenu?.querySelector<HTMLInputElement>('[data-agil-noise-suppression]');
    if (noise && !noise.disabled) noise.checked = state.settings.noiseSuppression ?? state.config.audio.noiseSuppression;
  }

  private applyStates(state: CallState, can: (feature: FeatureKey) => boolean): void {
    const settings = state.settings;
    const viewer = settings.viewer;
    const set = (
      id: ControlButtonId,
      options: { enabled?: boolean; active?: boolean; disabled?: boolean; iconName?: IconName; label?: string },
    ): void => {
      const button = this.buttons.get(id);
      if (!button) return;
      // Reserved centre slots stay invisible/disabled placeholders: a state
      // update must not re-enable them or inject them into the tab order.
      if (button.dataset.agilReserved === 'true') return;
      if (options.iconName) this.setButtonIcon(button, options.iconName);
      if (options.label) {
        button.title = options.label;
        button.setAttribute('aria-label', options.label);
        const fullLabel = button.querySelector<HTMLElement>('.agil-control-label:not(.agil-control-label-short)');
        if (fullLabel) fullLabel.textContent = options.label;
      }
      // Keep the embedded-desktop chip label in sync with the state (collapse
      // vs restore) without touching the full title/aria label.
      const shortLabel = button.querySelector<HTMLElement>('.agil-control-label-short');
      if (shortLabel) {
        const nextShort = this.shortLabel(id, state);
        if (shortLabel.textContent !== nextShort) shortLabel.textContent = nextShort;
        button.dataset.agilOverflowShort = nextShort;
      }
      button.classList.toggle('is-active', Boolean(options.active));
      button.disabled = options.disabled ?? false;
      button.style.display = options.enabled === false ? 'none' : '';
      button.setAttribute('aria-pressed', String(Boolean(options.active)));
    };
    set('mic', { iconName: settings.micEnabled ? 'mic' : 'mic-off', label: settings.micEnabled ? this.i18n.t('micOn') : this.i18n.t('micOff'), active: !settings.micEnabled, disabled: state.phase !== 'joined', enabled: !viewer });
    set('camera', { iconName: settings.camEnabled ? 'camera' : 'camera-off', label: this.specs.get('camera')!.label(state),
      active: !settings.camEnabled, disabled: state.phase !== 'joined' || state.videoUpgrade?.direction === 'outgoing', enabled: !viewer });
    set('screen', { iconName: settings.screenSharing ? 'screen-off' : 'screen', label: settings.screenSharing ? this.i18n.t('stopScreenShare') : this.i18n.t('screenShare'), active: settings.screenSharing, enabled: !viewer && this.featureAllowed(state, 'screenShare') });
    set('blur', { iconName: 'blur', label: this.i18n.t('blur'), active: settings.blurMode !== 'off', enabled: !viewer && (this.featureAllowed(state, 'backgroundBlur') || this.featureAllowed(state, 'backgroundReplace')) });
    set('chat', { active: settings.panel === 'chat' || state.chatUnread > 0, enabled: this.featureAllowed(state, 'chat') && settings.chatMode === 'builtin' });
    set('whiteboard', { iconName: 'whiteboard', label: this.i18n.t('whiteboardTitle'), active: state.whiteboard.visible, enabled: this.featureAllowed(state, 'whiteboard') });
    set('annotate', { iconName: 'pen', label: this.i18n.t('annotationsToggle'), active: state.annotation.active, enabled: this.featureAllowed(state, 'annotations') && Boolean(state.annotation.presenterId) });
    set('hand', { iconName: 'hand', label: settings.handRaised ? this.i18n.t('handLower') : this.i18n.t('handRaise'), active: settings.handRaised, enabled: this.featureAllowed(state, 'handRaise') });
    const webinar = state.config.scale.webinar;
    set('reactions', { enabled: this.featureAllowed(state, 'reactions') && (!webinar.enabled || webinar.reactions) });
    {
      const knowledgeConfigured = state.config.session.knowledgeAgent.enabled;
      const assistantEnabled = state.inCallAssistant.available || state.assistant.available;
      set('assistant', {
        active: assistantEnabled && settings.panel === 'assistant',
        enabled: assistantEnabled || knowledgeConfigured,
        disabled: !assistantEnabled,
        label: assistantEnabled ? this.i18n.t('assistantOpen') : this.i18n.t('noKnowledgeAccess'),
      });
    }
    set('recording', { iconName: 'record', label: state.recording.active ? this.i18n.t('recStop') : this.i18n.t('recStart'), active: state.recording.active, enabled: this.recordingAvailable(state) });
    set('captions', { iconName: 'transcript', label: this.i18n.t('captions'), active: settings.captionsVisible, enabled: this.featureAllowed(state, 'captions') && state.config.session.transcription.enabled && state.e2ee?.status !== 'enabled' });
    const inDocumentPip = this.element.closest<HTMLElement>('.agil-root')?.dataset.agilDocumentPip === 'true';
    set('pip', { iconName: inDocumentPip ? 'restore' : 'pip', label: this.i18n.t(inDocumentPip ? 'restore' : 'pip'), enabled: state.config.features.pictureInPicture });
    set('fullscreen', { iconName: 'fullscreen', label: settings.fullscreen ? this.i18n.t('exitFullscreen') : this.i18n.t('fullscreen'), active: settings.fullscreen, enabled: this.isActionAvailable('fullscreen', state) });
    set('newtab', { iconName: 'external', label: this.i18n.t('openInNewTab'), enabled: true });
    set('minimize', { iconName: settings.minimized ? 'restore' : 'minimize', label: settings.minimized ? this.i18n.t('restore') : this.i18n.t('minimize'), active: settings.minimized, enabled: state.config.layout.minimized.enabled });
    set('settings', { iconName: 'settings', label: this.i18n.t('settings'), enabled: state.config.features.deviceSettings || state.config.features.statsPanel });
    set('leave', { iconName: 'leave', label: this.i18n.t('leave'), enabled: state.phase === 'joined', disabled: state.phase !== 'joined' });
    set('participants', { iconName: 'users', enabled: this.featureAllowed(state, 'participantList'), label: this.i18n.t('participantsTitle') });
    set('notes', { iconName: 'note', enabled: this.featureAllowed(state, 'meetingNotes') || this.featureAllowed(state, 'aiCompliance'), label: this.i18n.t('notesTitle') });
    set('transcript', { iconName: 'transcript', enabled: this.isActionAvailable('transcript', state), label: this.i18n.t('transcriptTitle') });
    if (this.moreButton) {
      this.moreButton.style.display = '';
      this.moreButton.disabled = state.phase !== 'joined';
    }
    // Viewer banner hint is rendered by the app; keep toolbar semantically disabled
    // for controls that are hidden, but the DOM keeps them for e2e/debug.
    void can;
  }

  destroy(): void {
    this.bindEvents(null);
    this.element.remove();
  }
}
