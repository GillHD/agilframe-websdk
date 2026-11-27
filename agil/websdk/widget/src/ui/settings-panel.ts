/** Settings panel: devices, background, language, theme, diagnostics. */
import { tierLabel, type Locale } from '@agil/protocol';
import { formatDuration, h, uid } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';
import type { BlurMode, CallState } from '../types.js';
import type { DeviceLists } from '../call/media.js';
import { currentEncodingInfo, refreshEncodingInfo } from '../call/encoding.js';
import { BackgroundPicker } from './background-picker.js';
import { deviceField, noiseSuppressionField } from './device-fields.js';
import { canFeature } from '../permissions.js';

export interface SettingsActions {
  onClose: () => void;
  onMicDevice: (deviceId: string) => void;
  onCamDevice: (deviceId: string) => void;
  onSpeakerDevice: (deviceId: string) => Promise<boolean>;
  onNoiseSuppression: (enabled: boolean) => Promise<boolean>;
  onBlurMode: (mode: BlurMode, imageUrl?: string) => void;
  onBlurStrength: (value: number) => void;
  onLanguage: (locale: Locale) => void;
  onThemeScheme: (scheme: 'light' | 'dark' | 'auto') => void;
  onLocationConsent: (consent: boolean) => void;
  getDevices: () => Promise<DeviceLists>;
}

export class SettingsPanel {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly actions: SettingsActions;
  private readonly cameraSelect: HTMLSelectElement;
  private readonly micSelect: HTMLSelectElement;
  private readonly speakerSelect: HTMLSelectElement;
  private readonly devicesSection: HTMLElement;
  private readonly backgroundSection: HTMLElement;
  private readonly noiseSuppression: HTMLInputElement;
  private readonly blurRadios = new Map<BlurMode, HTMLInputElement>();
  private readonly blurStrength: HTMLInputElement;
  private readonly blurStrengthField: HTMLElement;
  private readonly backgroundPicker: BackgroundPicker;
  private readonly languageSelect: HTMLSelectElement;
  private readonly themeSelect: HTMLSelectElement;
  private readonly statsList: HTMLDListElement;
  private readonly locationSection: HTMLElement;
  private readonly locationCheckbox: HTMLInputElement;
  private devices: DeviceLists = { microphones: [], cameras: [], speakers: [] };
  private state: CallState | null = null;
  private encodingProbeStarted = false;
  private devicesLoaded = false;
  private refreshing = false;
  private deviceRequest = 0;
  private speakerSelection?: Promise<void>;

  constructor(i18n: I18n, actions: SettingsActions) {
    this.i18n = i18n;
    this.actions = actions;
    this.cameraSelect = this.makeSelect(i18n.t('settingsCamera'), (value) => actions.onCamDevice(value));
    this.micSelect = this.makeSelect(i18n.t('settingsMic'), (value) => actions.onMicDevice(value));
    this.speakerSelect = this.makeSelect(i18n.t('settingsSpeaker'), (value) => this.selectSpeaker(value));
    this.noiseSuppression = h('input', { attrs: { type: 'checkbox', role: 'switch' }, dataset: { agilDeviceNoise: '' } });
    this.noiseSuppression.addEventListener('change', async () => {
      const selected = this.noiseSuppression.checked;
      this.noiseSuppression.disabled = true;
      try { await actions.onNoiseSuppression(selected); }
      finally {
        this.noiseSuppression.disabled = false;
        if (this.state) this.noiseSuppression.checked = this.state.settings.noiseSuppression ?? this.state.config.audio.noiseSuppression;
      }
    });
    this.blurStrength = h('input', { class: 'agil-range', attrs: { type: 'range', min: '1', max: '40', step: '1' } });
    this.blurStrength.type = 'range';
    this.blurStrength.addEventListener('input', () => actions.onBlurStrength(Number(this.blurStrength.value)));
    const backgroundRow = h('div', { class: 'agil-bg-options' });
    this.backgroundPicker = new BackgroundPicker(i18n, (url) => actions.onBlurMode(url ? 'image' : 'off', url ?? undefined));
    this.languageSelect = h('select', { class: 'agil-select', attrs: { 'aria-label': i18n.t('settingsLanguage') } });
    this.languageSelect.addEventListener('change', () => actions.onLanguage(this.languageSelect.value as Locale));
    this.themeSelect = h('select', { class: 'agil-select', attrs: { 'aria-label': i18n.t('settingsTheme') } });
    this.themeSelect.addEventListener('change', () => actions.onThemeScheme(this.themeSelect.value as 'light' | 'dark' | 'auto'));
    this.statsList = h('dl', { class: 'agil-stats-list' });
    this.locationCheckbox = h('input', { attrs: { type: 'checkbox' } });
    this.locationCheckbox.type = 'checkbox';
    this.locationCheckbox.addEventListener('change', () => actions.onLocationConsent(this.locationCheckbox.checked));
    this.locationSection = this.section(
      i18n.t('locationTitle'),
      h(
        'label',
        { class: 'agil-radio-label agil-consent' },
        this.locationCheckbox,
        h('span', { text: i18n.t('locationConsent') }),
      ),
      h('p', { class: 'agil-settings-hint', text: i18n.t('locationConsentHint') }),
    );
    this.locationSection.hidden = true;

    const close = h('button', { class: 'agil-icon-btn', title: i18n.t('close') });
    close.type = 'button';
    close.setAttribute('aria-label', i18n.t('close'));
    close.appendChild(icon('close', 18));
    close.addEventListener('click', () => actions.onClose());
    const header = h('div', { class: 'agil-panel-header' }, h('h2', { class: 'agil-panel-title', text: i18n.t('settingsTitle') }), close);

    const body = h('div', { class: 'agil-settings-body' });
    const noiseRow = noiseSuppressionField(i18n, this.noiseSuppression);
    noiseRow.hidden = !navigator.mediaDevices?.getSupportedConstraints?.().noiseSuppression;
    const speakerRow = deviceField('volume', this.speakerSelect);
    speakerRow.hidden = typeof HTMLMediaElement.prototype.setSinkId !== 'function';
    this.devicesSection = this.section(i18n.t('settingsDevices'), deviceField('mic', this.micSelect), noiseRow,
      deviceField('camera', this.cameraSelect), speakerRow);
    body.appendChild(this.devicesSection);

    const blurGroup = h('div', { class: 'agil-radio-group' });
    const blurModeName = uid('agil-blur-mode');
    for (const mode of ['off', 'blur'] as const) {
      const radio = h('input', { class: 'agil-radio', attrs: { type: 'radio', name: blurModeName } });
      radio.addEventListener('change', () => {
        if (radio.checked) actions.onBlurMode(mode);
      });
      this.blurRadios.set(mode, radio);
      const label = h(
        'label',
        { class: 'agil-radio-label' },
        radio,
        h('span', { text: mode === 'off' ? i18n.t('settingsBlurOff') : i18n.t('settingsBlurOn') }),
      );
      blurGroup.appendChild(label);
    }
    backgroundRow.append(blurGroup, this.backgroundPicker.element);
    this.blurStrengthField = this.field(i18n.t('settingsBlurStrength'), this.blurStrength);
    this.blurStrengthField.hidden = true;
    this.backgroundSection = this.section(i18n.t('settingsBlur'), backgroundRow, this.blurStrengthField);
    body.appendChild(this.backgroundSection);

    this.languageSelect.appendChild(h('option', { attrs: { value: 'ru' }, text: 'Русский' }));
    this.languageSelect.appendChild(h('option', { attrs: { value: 'en' }, text: 'English' }));
    this.themeSelect.appendChild(h('option', { attrs: { value: 'light' }, text: i18n.t('settingsThemeLight') }));
    this.themeSelect.appendChild(h('option', { attrs: { value: 'dark' }, text: i18n.t('settingsThemeDark') }));
    this.themeSelect.appendChild(h('option', { attrs: { value: 'auto' }, text: i18n.t('settingsThemeAuto') }));
    body.appendChild(h('details', { class: 'agil-settings-more' },
      h('summary', { text: i18n.t('settingsMore') }),
      this.section(i18n.t('settingsLanguage'), this.field(i18n.t('settingsLanguage'), this.languageSelect), this.field(i18n.t('settingsTheme'), this.themeSelect)),
      this.locationSection,
    ));
    this.element = h('section', { class: 'agil-panel agil-settings-panel', attrs: { 'aria-label': i18n.t('settingsTitle') } }, header, body);
  }

  private section(title: string, ...children: HTMLElement[]): HTMLElement {
    return h('div', { class: 'agil-settings-section' }, h('h3', { class: 'agil-settings-section-title', text: title }), ...children);
  }

  private field(label: string, control: HTMLElement): HTMLElement {
    return h('label', { class: 'agil-field' }, h('span', { class: 'agil-field-label', text: label }), control);
  }

  private makeSelect(label: string, onChange: (value: string) => void): HTMLSelectElement {
    const select = h('select', { class: 'agil-select', attrs: { 'aria-label': label } });
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  async refreshDevices(replacePending = false): Promise<void> {
    if (this.refreshing && !replacePending) return;
    this.refreshing = true;
    const request = ++this.deviceRequest;
    const devices = await this.actions.getDevices().catch(() => null);
    if (request !== this.deviceRequest) return;
    this.devicesLoaded = true;
    this.refreshing = false;
    if (!devices) return;
    this.devices = devices;
    this.renderDeviceOptions();

    await this.speakerSelection;
    if (request !== this.deviceRequest) return;
    const selected = this.state?.settings.speakerDeviceId;
    if (selected && !devices.speakers.some(({ deviceId }) => deviceId === selected)) {
      await this.selectSpeaker('');
    }
  }

  private selectSpeaker(value: string): Promise<void> {
    this.speakerSelect.disabled = true;
    this.speakerSelection = this.actions.onSpeakerDevice(value).then(() => undefined).finally(() => {
      this.speakerSelection = undefined;
      this.speakerSelect.disabled = false;
      this.syncDeviceSelection();
    });
    return this.speakerSelection;
  }

  private renderDeviceOptions(): void {
    const fill = (select: HTMLSelectElement, devices: MediaDeviceInfo[], label: string): void => {
      select.replaceChildren(h('option', { attrs: { value: '' }, text: `${label} · ${this.i18n.t('settingsDefault')}` }));
      devices.filter((device) => device.deviceId).forEach((device, index) => {
        const option = h('option', {
          attrs: { value: device.deviceId },
          text: device.label || `${label} ${index + 1}`,
        });
        select.appendChild(option);
      });
    };
    fill(this.cameraSelect, this.devices.cameras, this.i18n.t('settingsCamera'));
    fill(this.micSelect, this.devices.microphones, this.i18n.t('settingsMic'));
    fill(this.speakerSelect, this.devices.speakers, this.i18n.t('settingsSpeaker'));
    this.syncDeviceSelection();
  }

  private syncDeviceSelection(): void {
    const settings = this.state?.settings;
    for (const [select, id] of [[this.micSelect, settings?.micDeviceId], [this.cameraSelect, settings?.camDeviceId], [this.speakerSelect, settings?.speakerDeviceId]] as const) {
      select.value = id ?? '';
      if (select.selectedIndex < 0) select.selectedIndex = 0;
    }
  }

  update(state: CallState): void {
    this.state = state;
    const settings = state.settings;
    this.devicesSection.hidden = settings.viewer || !canFeature(state, 'deviceSettings');
    this.backgroundSection.hidden = settings.viewer || !canFeature(state, 'backgroundBlur') && !canFeature(state, 'backgroundReplace');
    this.syncDeviceSelection();
    this.noiseSuppression.checked = settings.noiseSuppression ?? state.config.audio.noiseSuppression;
    this.blurStrength.value = String(settings.blurStrength);
    for (const [mode, radio] of this.blurRadios) radio.checked = settings.blurMode === mode;
    this.backgroundPicker.element.hidden = settings.viewer || !canFeature(state, 'backgroundReplace');
    const blurRadio = this.blurRadios.get('blur');
    if (blurRadio) blurRadio.disabled = !canFeature(state, 'backgroundBlur');
    this.blurStrengthField.hidden = this.blurStrength.disabled = settings.blurMode !== 'blur';

    this.backgroundPicker.update(state.backgrounds, settings.blurMode === 'image' ? settings.backgroundImageUrl : '');
    const decimal = new Intl.NumberFormat(this.i18n.current, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

    const geo = state.config.security.geo;
    this.locationSection.hidden = !(geo.enabled && geo.gpsEnabled);
    if (!this.locationSection.hidden) this.locationSection.dataset.selfLocation = state.self?.location?.source ?? 'none';
    this.languageSelect.value = settings.locale;
    this.languageSelect.disabled = !state.config.session.allowLocaleSwitch;
    this.themeSelect.value = settings.scheme;

    const encoding = currentEncodingInfo(state.config);
    const hardware =
      encoding.hardware === 'hardware'
        ? this.i18n.t('encodingHardware')
        : encoding.hardware === 'software'
          ? this.i18n.t('encodingSoftware')
          : this.i18n.t('encodingUnknown');
    if (!this.encodingProbeStarted) {
      this.encodingProbeStarted = true;
      void refreshEncodingInfo(state.config).then(() => {
        if (this.state) this.update(this.state);
      });
    }
    const stats: Array<[string, string]> = [
      [this.i18n.t('statsQuality'), `${state.quality.score}/100 · ${tierLabel(state.quality.tier, this.i18n.current)}`],
      [this.i18n.t('statsRtt'), `${Math.round(state.quality.rttMs)} ${this.i18n.t('msUnit')}`],
      [this.i18n.t('statsLoss'), `${decimal.format(state.quality.packetLossPct)} %`],
      [this.i18n.t('statsJitter'), `${Math.round(state.quality.jitterMs)} ${this.i18n.t('msUnit')}`],
      [this.i18n.t('statsBitrate'), `${state.quality.inboundBitrateKbps} ${this.i18n.t('kbpsUnit')}`],
      [this.i18n.t('statsResolution'), state.quality.width > 0 ? `${state.quality.width}×${state.quality.height}` : '—'],
      [this.i18n.t('statsFps'), String(Math.round(state.quality.fps))],
      [this.i18n.t('statsBlur'), (state.settings.blurMode === 'off' ? this.i18n.t('statsBlurOff') : state.settings.blurMode === 'blur' ? this.i18n.t('statsBlurOn') : this.i18n.t('statsBlurImage')) + (state.settings.blurDegraded ? ' (' + this.i18n.t('degradedShort') + ')' : '')],
      [this.i18n.t('statsPeers'), String(state.participants.length)],
      [this.i18n.t('statsDuration'), formatDuration(state.durationSec)],
      [this.i18n.t('statsIceRestarts'), String(state.config.fallback.lowBandwidth.autoReconnect.attempts)],
      [this.i18n.t('statsServer'), state.serverOnline ? this.i18n.t('connected') : this.i18n.t('offline')],
      [this.i18n.t('statsCodec'), encoding.codec ? encoding.codec.toUpperCase() : '—'],
      [this.i18n.t('statsHardware'), hardware],
      [this.i18n.t('statsLayer'), state.config.video.simulcast ? this.i18n.t('statsLayerSimulcast') : this.i18n.t('statsLayerSingle')],
      [this.i18n.t('statsProcessing'), this.i18n.t('statsProcessingOnDevice')],
      [this.i18n.t('statsE2EE'), state.e2ee?.status === 'enabled' ? this.i18n.t('e2eeEnabled') : state.e2ee?.status === 'failed' ? this.i18n.t('e2eeFailed') : this.i18n.t('e2eeDisabled')],
      ...(state.e2ee?.status === 'enabled' ? [[this.i18n.t('e2eeTitle'), this.i18n.t('e2eeNote')] as [string, string]] : []),
      [this.i18n.t('statsIcePath'), state.iceInfo ? `${state.iceInfo.local ?? '—'} → ${state.iceInfo.remote ?? '—'} · ${(state.iceInfo.protocol ?? 'udp').toUpperCase()}` : '—'],
    ];
    this.statsList.replaceChildren();
    for (const [term, value] of stats) {
      this.statsList.appendChild(h('div', { class: 'agil-stats-row' }, h('dt', { text: term }), h('dd', { text: value })));
    }
    if (!this.devicesLoaded && !this.devicesSection.hidden) void this.refreshDevices();
  }

  destroy(): void {
    ++this.deviceRequest;
    this.element.remove();
  }
}
