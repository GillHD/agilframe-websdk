import { h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon, type IconName } from '../icons.js';

export function deviceField(name: IconName, select: HTMLSelectElement): HTMLElement {
  return h('label', { class: 'agil-device-field' }, icon(name, 17), select);
}

export function noiseSuppressionField(i18n: I18n, control: HTMLInputElement): HTMLElement {
  return h('label', { class: 'agil-device-noise' },
    h('span', {},
      h('strong', { text: i18n.t('microphoneNoiseSuppression') }),
      h('small', { text: i18n.t('settingsNoiseHint') }),
    ),
    control,
  );
}
